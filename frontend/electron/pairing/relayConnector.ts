// "Reach from anywhere": ONE outbound WebSocket from this Mac to the user's own Cloudflare relay
// (`/host/<hostId>`, Authorization: Bearer <host secret>). Each phone that dials the relay becomes a
// numbered stream on it (relayFrames.ts); every stream is handed out as an ordinary LinkSocket, so it
// goes through exactly the same encrypted handshake as a LAN connection — the relay only ever sees
// handshake JSON and sealed frames.
//
// The connection is kept up with jittered backoff (1–30 s), pinged every PING_INTERVAL_MS and dropped
// after two unanswered pings. A 401/403 on the upgrade means the secret is wrong: we stop retrying
// until the settings change.
import { WebSocket } from "ws";
import type { LinkSocket } from "../../src/shared/pairing/link";
import { PING_INTERVAL_MS, relayHostUrl } from "../../src/shared/pairing/protocol";
import {
  closePayload, decodeRelayFrame, encodeRelayFrame, readClosePayload, RELAY_MAX_PAYLOAD, RELAY_MAX_STREAMS, RELAY_OP, type RelayOp,
} from "../../src/shared/pairing/relayFrames";

import type { RelayState } from "../../src/shared/pairing/hostApi";

export type { RelayState };
export interface RelayConfig { url: string; hostId: string; hostSecret: string }

export interface RelayOptions {
  onSocket(sock: LinkSocket): void;
  onState(s: RelayState): void;
  pingMs?: number;
  /** Delay before reconnect attempt `n` (0-based). */
  backoff?: (n: number) => number;
}

const MISSED_PONGS = 2;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const jitteredBackoff = (n: number, random = Math.random): number => {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(n, 5));
  return Math.max(1000, Math.round(base * (0.5 + random() * 0.5)));
};

/** One phone's socket, carried as a stream on the relay connection. */
class RelayStream implements LinkSocket {
  private msg: ((d: string | Uint8Array) => void)[] = [];
  private closers: ((code?: number, reason?: string) => void)[] = [];
  private early: (string | Uint8Array)[] = [];
  private open = true;

  constructor(private readonly frame: (op: RelayOp, payload: Uint8Array) => boolean, private readonly forget: () => void) {}

  send(d: string | Uint8Array): void {
    if (!this.open) return;
    const payload = typeof d === "string" ? enc.encode(d) : d;
    if (payload.length > RELAY_MAX_PAYLOAD) { this.close(1009, "message too big for the relay"); return; }
    if (!this.frame(typeof d === "string" ? RELAY_OP.TEXT : RELAY_OP.BIN, payload)) this.end(1006, "relay lost");
  }
  close(code = 1000, reason = ""): void {
    if (!this.open) return;
    this.frame(RELAY_OP.CLOSE, closePayload(code, reason));
    this.end(code, reason);
  }
  onMessage(cb: (d: string | Uint8Array) => void): void {
    this.msg.push(cb);
    for (const d of this.early.splice(0)) cb(d);
  }
  onClose(cb: (code?: number, reason?: string) => void): void { this.closers.push(cb); }

  /** @internal a frame from the phone */
  deliver(d: string | Uint8Array): void {
    if (!this.open) return;
    if (!this.msg.length) { this.early.push(d); return; }
    for (const h of this.msg) h(d);
  }
  /** @internal the phone (or the relay) went away */
  end(code: number, reason: string): void {
    if (!this.open) return;
    this.open = false;
    this.forget();
    queueMicrotask(() => { for (const h of this.closers) { try { h(code, reason); } catch { /* listener bug */ } } });
  }
}

export class RelayConnector {
  private _state: RelayState = "off";
  private cfg: RelayConfig | null = null;
  private ws: WebSocket | null = null;
  private streams = new Map<number, RelayStream>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private missed = 0;

  constructor(private readonly o: RelayOptions) {}

  get state(): RelayState { return this._state; }
  /** Phones currently connected through the relay. */
  get streamCount(): number { return this.streams.size; }

  /** Apply new settings (null = off). The same settings again only reconnect after a wrong secret. */
  configure(cfg: RelayConfig | null): void {
    const same = !!cfg && !!this.cfg && cfg.url === this.cfg.url && cfg.hostId === this.cfg.hostId && cfg.hostSecret === this.cfg.hostSecret;
    if (same && this._state !== "auth_failed") return;
    this.teardown();
    this.cfg = cfg;
    this.attempt = 0;
    if (cfg) this.connect();
    else this.setState("off");
  }

  stop(): void { this.configure(null); }

  private setState(s: RelayState): void {
    if (s === this._state) return;
    this._state = s;
    this.o.onState(s);
  }

  private teardown(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const ws = this.ws;
    this.ws = null;
    this.dropLink();
    if (ws) { ws.removeAllListeners(); ws.on("error", () => {}); ws.terminate(); }
  }

  private dropLink(): void {
    if (this.pinger) { clearInterval(this.pinger); this.pinger = null; }
    for (const s of [...this.streams.values()]) s.end(1001, "relay lost");
    this.streams.clear();
  }

  private connect(): void {
    const cfg = this.cfg!;
    this.setState("connecting");
    let authFailed = false;
    const ws = new WebSocket(relayHostUrl(cfg.url, cfg.hostId), {
      headers: { Authorization: `Bearer ${cfg.hostSecret}` },
      maxPayload: 2 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 15_000,
    });
    this.ws = ws;
    ws.on("unexpected-response", (_req, res) => {
      authFailed = res.statusCode === 401 || res.statusCode === 403;
      res.resume();
      ws.terminate();
    });
    ws.on("error", () => { /* followed by close */ });
    ws.on("open", () => {
      this.attempt = 0;
      this.missed = 0;
      this.setState("online");
      this.pinger = setInterval(() => {
        if (this.missed >= MISSED_PONGS) { ws.terminate(); return; }
        this.missed++;
        this.send(ws, RELAY_OP.PING, 0);
      }, this.o.pingMs ?? PING_INTERVAL_MS);
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      const f = decodeRelayFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      if (f) this.onFrame(ws, f.op, f.stream, f.payload.slice());
    });
    ws.on("close", () => {
      if (this.ws !== ws) return; // replaced or stopped
      this.ws = null;
      this.dropLink();
      if (authFailed) { this.setState("auth_failed"); return; }
      this.setState("offline");
      this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.cfg) this.connect(); }, (this.o.backoff ?? jitteredBackoff)(this.attempt++));
    });
  }

  private send(ws: WebSocket, op: RelayOp, stream: number, payload?: Uint8Array): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(encodeRelayFrame(op, stream, payload));
    return true;
  }

  private onFrame(ws: WebSocket, op: RelayOp, id: number, payload: Uint8Array): void {
    switch (op) {
      case RELAY_OP.OPEN: {
        this.streams.get(id)?.end(1001, "replaced");
        if (this.streams.size >= RELAY_MAX_STREAMS) { this.send(ws, RELAY_OP.CLOSE, id, closePayload(1013, "busy")); return; }
        const s = new RelayStream((o, p) => this.send(ws, o, id, p), () => { if (this.streams.get(id) === s) this.streams.delete(id); });
        this.streams.set(id, s);
        this.o.onSocket(s);
        return;
      }
      case RELAY_OP.TEXT: this.streams.get(id)?.deliver(dec.decode(payload)); return;
      case RELAY_OP.BIN: this.streams.get(id)?.deliver(payload); return;
      case RELAY_OP.CLOSE: {
        const { code, reason } = readClosePayload(payload);
        this.streams.get(id)?.end(code, reason);
        return;
      }
      case RELAY_OP.PING: this.send(ws, RELAY_OP.PONG, 0, payload); return;
      case RELAY_OP.PONG: this.missed = 0; return;
    }
  }
}
