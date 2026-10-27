// The secure phone ↔ Mac link, shared by both ends: handshake, then an encrypted request/response +
// event channel over any WebSocket-like socket (a LAN WebSocket, or one stream through the relay).
import {
  b64u, deriveLinkKey, deriveSessionKeys, FrameCipher, fromUtf8, openPairBox, randomBytes, sealPairBox, utf8,
  type Identity,
} from "./crypto";
import {
  HANDSHAKE_MESSAGES, PING_INTERVAL_MS, PROTOCOL_VERSION, isMethod, normalizeCode,
  type HandshakeError, type HostEvent, type HostHandshake, type Message, type Method, type Methods, type PhoneHandshake,
} from "./protocol";

/** The minimum a transport must offer. Text = handshake JSON; binary = sealed frames. */
export interface LinkSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
}

/** Adapt a browser/WebView WebSocket (also Node 22's global WebSocket). */
export function browserSocket(ws: WebSocket): LinkSocket {
  ws.binaryType = "arraybuffer";
  return {
    send: (d) => ws.send(d as any),
    close: (c, r) => { try { ws.close(c, r); } catch { /* already closed */ } },
    onMessage: (cb) => ws.addEventListener("message", (e: MessageEvent) => cb(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer))),
    onClose: (cb) => ws.addEventListener("close", (e: CloseEvent) => cb(e.code, e.reason)),
  };
}

/** Handshake failure with a code the UI can act on (e.g. unknown_device → offer to pair again). */
export class HandshakeFailed extends Error {
  constructor(readonly code: HandshakeError | "timeout" | "closed" | "protocol", message: string) { super(message); }
}

const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_PENDING = 64;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class SecureLink {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private requestHandler: ((m: Method, p: unknown) => Promise<unknown>) | null = null;
  private eventHandlers: ((e: HostEvent, d: unknown) => void)[] = [];
  private closeHandlers: ((reason: string) => void)[] = [];
  private closed = false;
  private pinger: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly sock: LinkSocket, private readonly cipher: FrameCipher, readonly role: "phone" | "host") {}

  /** @internal — called once by the handshake with the socket's later messages. */
  receive(data: string | Uint8Array): void {
    if (this.closed) return;
    if (typeof data === "string") { this.close("unexpected text frame"); return; }
    this.recvChain = this.recvChain.then(async () => {
      let msg: Message;
      try { msg = JSON.parse(fromUtf8(await this.cipher.open(data))); } catch { this.close("bad frame"); return; }
      await this.dispatch(msg);
    });
  }

  private async dispatch(msg: Message): Promise<void> {
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.r); else p.reject(new Error(msg.e));
    } else if (msg.t === "req") {
      // Run requests concurrently, but don't block the receive chain on them.
      void this.serve(msg.id, msg.m, msg.p);
    } else if (msg.t === "evt") {
      for (const h of this.eventHandlers) { try { h(msg.e, msg.d); } catch { /* listener bug */ } }
    }
  }

  private async serve(id: number, m: unknown, p: unknown): Promise<void> {
    if (!isMethod(m)) { await this.post({ t: "res", id, ok: false, e: "Unknown request." }); return; }
    if (!this.requestHandler) { await this.post({ t: "res", id, ok: false, e: "Not accepting requests." }); return; }
    try { await this.post({ t: "res", id, ok: true, r: (await this.requestHandler(m, p)) ?? null }); }
    catch (e) { await this.post({ t: "res", id, ok: false, e: String((e as Error)?.message ?? e).slice(0, 2000) }); }
  }

  private post(msg: Message): Promise<void> {
    if (this.closed) return Promise.resolve();
    // Frames must leave in counter order, so sealing + sending is serialized.
    this.sendChain = this.sendChain.then(async () => {
      if (this.closed) return;
      const frame = await this.cipher.seal(utf8(JSON.stringify(msg)));
      try { this.sock.send(frame); } catch { this.close("send failed"); }
    });
    return this.sendChain;
  }

  request<M extends Method>(m: M, p: Methods[M]["p"], timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Methods[M]["r"]> {
    if (this.closed) return Promise.reject(new Error("Not connected to your Mac."));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error("Too many requests in flight."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Your Mac took too long to answer.")); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      void this.post({ t: "req", id, m, p });
    });
  }

  onRequest(handler: (m: Method, p: unknown) => Promise<unknown>): void { this.requestHandler = handler; }
  emit(e: HostEvent, d: unknown = null): Promise<void> { return this.post({ t: "evt", e, d }); }
  onEvent(h: (e: HostEvent, d: unknown) => void): () => void {
    this.eventHandlers.push(h);
    return () => { this.eventHandlers = this.eventHandlers.filter((x) => x !== h); };
  }
  onClose(h: (reason: string) => void): void { if (this.closed) h("closed"); else this.closeHandlers.push(h); }
  get isOpen(): boolean { return !this.closed; }

  /** Phone side: ping now and then so a dead route is noticed (and NATs keep the socket open). */
  startKeepalive(intervalMs = PING_INTERVAL_MS): void {
    if (this.pinger) return;
    this.pinger = setInterval(() => {
      this.request("ping", {}, intervalMs).catch(() => this.close("no answer"));
    }, intervalMs);
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("Lost the connection to your Mac.")); }
    this.pending.clear();
    try { this.sock.close(1000, reason.slice(0, 100)); } catch { /* ignore */ }
    for (const h of this.closeHandlers) { try { h(reason); } catch { /* ignore */ } }
    this.closeHandlers = [];
  }
}

/** Wait for the first message of a fresh socket, wiring later ones to `rest` once the link exists. */
function firstMessage(sock: LinkSocket, timeoutMs: number): { first: Promise<string | Uint8Array>; setRest: (fn: (d: string | Uint8Array) => void) => void } {
  let rest: ((d: string | Uint8Array) => void) | null = null;
  const early: (string | Uint8Array)[] = [];
  let resolveFirst!: (d: string | Uint8Array) => void;
  let rejectFirst!: (e: Error) => void;
  let got = false;
  const first = new Promise<string | Uint8Array>((res, rej) => { resolveFirst = res; rejectFirst = rej; });
  const timer = setTimeout(() => { if (!got) { rejectFirst(new HandshakeFailed("timeout", "Your Mac didn't answer.")); sock.close(4000, "handshake timeout"); } }, timeoutMs);
  sock.onMessage((d) => {
    if (!got) { got = true; clearTimeout(timer); resolveFirst(d); return; }
    if (rest) rest(d); else early.push(d);
  });
  sock.onClose(() => { if (!got) { clearTimeout(timer); rejectFirst(new HandshakeFailed("closed", "Couldn't reach your Mac on this route.")); } });
  return { first, setRest: (fn) => { rest = fn; for (const d of early.splice(0)) fn(d); } };
}

// ---- phone side ----
export interface PhoneConnectOpts {
  hostId: string;
  hostKey: string;
  identity: Identity;
  /** First time only: the scanned code and how this phone introduces itself. */
  pairing?: { code: string; deviceName: string; platform: string };
  /** Later connections: what pairing returned. */
  deviceId?: string;
  linkKey?: string;
  timeoutMs?: number;
}
export interface PhoneConnection { link: SecureLink; deviceId: string; linkKey: string; hostName: string }

export async function connectPhone(sock: LinkSocket, o: PhoneConnectOpts): Promise<PhoneConnection> {
  const { first, setRest } = firstMessage(sock, o.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  const nonce = b64u(randomBytes(16));
  let hello: PhoneHandshake;
  if (o.pairing) {
    const box = await sealPairBox(o.identity.privateJwk, o.hostKey, { code: normalizeCode(o.pairing.code) });
    hello = { t: "pair", v: PROTOCOL_VERSION, hostId: o.hostId, deviceKey: o.identity.publicKey, deviceName: o.pairing.deviceName.slice(0, 80), platform: o.pairing.platform.slice(0, 40), nonce, box };
  } else {
    if (!o.deviceId || !o.linkKey) throw new HandshakeFailed("protocol", "This phone isn't paired yet.");
    hello = { t: "hello", v: PROTOCOL_VERSION, hostId: o.hostId, deviceId: o.deviceId, nonce };
  }
  sock.send(JSON.stringify(hello));
  const reply = await first;
  let msg: HostHandshake;
  try { msg = JSON.parse(typeof reply === "string" ? reply : fromUtf8(reply)); } catch { sock.close(4002, "bad handshake"); throw new HandshakeFailed("protocol", "Unexpected answer from your Mac."); }
  if (msg.t === "error") { sock.close(1000, msg.code); throw new HandshakeFailed(msg.code, HANDSHAKE_MESSAGES[msg.code] ?? msg.message); }
  if (msg.t !== "welcome" || typeof msg.nonce !== "string" || typeof msg.deviceId !== "string") { sock.close(4002, "bad handshake"); throw new HandshakeFailed("protocol", "Unexpected answer from your Mac."); }
  const linkKey = o.pairing ? await deriveLinkKey(o.identity.privateJwk, o.hostKey, o.hostId, o.identity.publicKey) : o.linkKey!;
  const link = new SecureLink(sock, new FrameCipher(await deriveSessionKeys(linkKey, nonce, msg.nonce, "phone")), "phone");
  setRest((d) => link.receive(d));
  sock.onClose(() => link.close("socket closed"));
  return { link, deviceId: msg.deviceId, linkKey, hostName: msg.hostName };
}

// ---- Mac side ----
export interface HostAuth {
  hostId: string;
  hostName: string;
  identity: Identity;
  /** Check (and on success burn) a one-time pairing code. */
  consumeCode(code: string): "ok" | "bad_code" | "expired" | "busy";
  /** Remember a newly paired phone; returns its device id. */
  registerDevice(d: { deviceKey: string; deviceName: string; platform: string; linkKey: string }): Promise<string>;
  /** The stored link key of a paired phone, or null when unknown/removed. */
  linkKeyFor(deviceId: string): Promise<string | null>;
}
export interface HostConnection { link: SecureLink; deviceId: string; paired: boolean; deviceName?: string }

export async function acceptPhone(sock: LinkSocket, auth: HostAuth, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<HostConnection> {
  const { first, setRest } = firstMessage(sock, timeoutMs);
  const fail = (code: HandshakeError): never => {
    const reply: HostHandshake = { t: "error", v: PROTOCOL_VERSION, code, message: HANDSHAKE_MESSAGES[code] };
    try { sock.send(JSON.stringify(reply)); } catch { /* ignore */ }
    sock.close(1000, code);
    throw new HandshakeFailed(code, HANDSHAKE_MESSAGES[code]);
  };
  const raw = await first;
  let hello: PhoneHandshake;
  try { hello = JSON.parse(typeof raw === "string" ? raw : fromUtf8(raw)); } catch { sock.close(4002, "bad handshake"); throw new HandshakeFailed("protocol", "Malformed handshake."); }
  if (!hello || hello.v !== PROTOCOL_VERSION) return fail("version");
  if (hello.hostId !== auth.hostId) return fail("host_mismatch");
  if (typeof hello.nonce !== "string" || hello.nonce.length < 16) { sock.close(4002, "bad handshake"); throw new HandshakeFailed("protocol", "Malformed handshake."); }

  let linkKey: string;
  let deviceId: string;
  let paired = false;
  let deviceName: string | undefined;
  if (hello.t === "pair") {
    let code = "";
    try { code = String(((await openPairBox(auth.identity.privateJwk, hello.deviceKey, hello.box)) as any)?.code ?? ""); } catch { /* wrong key / tampered */ }
    const verdict = auth.consumeCode(code);
    if (verdict !== "ok") return fail(verdict);
    linkKey = await deriveLinkKey(auth.identity.privateJwk, hello.deviceKey, auth.hostId, hello.deviceKey);
    deviceName = String(hello.deviceName || "Phone").slice(0, 80);
    deviceId = await auth.registerDevice({ deviceKey: hello.deviceKey, deviceName, platform: String(hello.platform || "").slice(0, 40), linkKey });
    paired = true;
  } else if (hello.t === "hello") {
    const k = await auth.linkKeyFor(String(hello.deviceId));
    if (!k) return fail("unknown_device");
    linkKey = k;
    deviceId = hello.deviceId;
  } else {
    sock.close(4002, "bad handshake");
    throw new HandshakeFailed("protocol", "Malformed handshake.");
  }
  const nonce = b64u(randomBytes(16));
  const link = new SecureLink(sock, new FrameCipher(await deriveSessionKeys(linkKey, hello.nonce, nonce, "host")), "host");
  setRest((d) => link.receive(d));
  sock.onClose(() => link.close("socket closed"));
  const welcome: HostHandshake = { t: "welcome", v: PROTOCOL_VERSION, deviceId, hostName: auth.hostName, nonce };
  sock.send(JSON.stringify(welcome));
  return { link, deviceId, paired, deviceName };
}
