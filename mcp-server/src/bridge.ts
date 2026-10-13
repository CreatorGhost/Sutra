import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

// Per-call timeout. Most reads are fast; the two network/RAG-backed tools get a longer budget.
const DEFAULT_TIMEOUT_MS = Number(process.env.SUTRA_REQUEST_TIMEOUT_MS) || 30000;
const LONG_TIMEOUT_MS = 120000;
const LONG_METHODS = new Set(["ask_memory", "search_memory"]);
// Ceiling on concurrent in-flight calls (plan §6: prevent request-flooding / unbounded pending map).
// Far above any sane MCP client's parallelism; a misbehaving/looping client is rejected, not OOM'd.
const MAX_PENDING = 256;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** sha256 both sides then constant-time compare — normalizes length so timingSafeEqual is safe. */
function tokensMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Reverse WebSocket bridge: we LISTEN, the app dials in. On connect we prove knowledge of the
 * pairing token; the app echoes proof back. Exactly one authenticated device socket is kept
 * (newest wins). `call()` correlates request/response by id with a per-call timeout.
 *
 * Several AI tools (or several sessions of one) each launch their own copy of this server, but only
 * one can own the port. The first becomes the PRIMARY; later copies find the port taken and join it
 * as PEERS: they dial the primary, pass the same token handshake as the app, and relay their calls
 * through it. When the primary exits, a peer takes the port over and the app reconnects to it.
 */
export class Bridge {
  private wss: WebSocketServer | null = null;
  private device: WebSocket | null = null; // the one authenticated app socket (primary only)
  private upstream: WebSocket | null = null; // our paired link to the primary (peer only)
  private pending = new Map<string, Pending>();
  private pairingFailed = false;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private token: string,
    private host = process.env.SUTRA_BRIDGE_HOST || "127.0.0.1",
    private port = Number(process.env.SUTRA_BRIDGE_PORT) || 8765,
  ) {}

  start(): void {
    if (this.stopped) return;
    // Cap inbound frames (plan §6: prevent the "missing maxPayload / JSON.parse bomb" class). ws
    // otherwise inherits a 100MB default; 1 MiB is far above any legitimate ready/res frame.
    const wss = new WebSocketServer({ host: this.host, port: this.port, maxPayload: 1 << 20 });
    this.wss = wss;
    wss.on("listening", () => {
      console.error(`[sutra-mcp] bridge listening on ws://${this.host}:${this.port} — waiting for Sutra to connect.`);
    });
    wss.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        // Another copy (another AI tool / session) owns the port — join it instead of failing.
        if (this.wss === wss) this.wss = null;
        try { wss.close(); } catch { /* ignore */ }
        this.joinPrimary();
        return;
      }
      console.error("[sutra-mcp] bridge server error:", e.message);
    });
    wss.on("connection", (ws) => this.onConnection(ws));
  }

  /** Close the listener / links and stop retrying (tests, clean shutdown). */
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    try { this.upstream?.close(); } catch { /* ignore */ }
    // ws v8's server.close() leaves accepted sockets open; drop them (app + peers) like an exit would.
    for (const s of this.wss?.clients ?? []) { try { s.terminate(); } catch { /* ignore */ } }
    try { this.wss?.close(); } catch { /* ignore */ }
    this.failAll("bridge stopped");
  }

  isConnected(): boolean {
    if (this.upstream) return this.upstream.readyState === WebSocket.OPEN;
    return !!this.device && this.device.readyState === WebSocket.OPEN;
  }

  /** "primary" owns the port, "peer" relays through the copy that does. For diagnostics/tests. */
  role(): "primary" | "peer" | "starting" {
    return this.wss ? "primary" : this.upstream ? "peer" : "starting";
  }

  /** Become the primary again, or re-join whichever copy now owns the port. */
  private scheduleRestart(ms: number): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.start(); }, ms);
  }

  /** PEER mode: dial the primary on the same port and authenticate just like the app does. */
  private joinPrimary(): void {
    if (this.stopped) return;
    const host = this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host;
    const ws = new WebSocket(`ws://${host}:${this.port}`, { maxPayload: 1 << 20 });
    let authed = false;
    ws.on("message", (data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!authed) {
        if (msg?.type === "auth" && typeof msg?.token === "string" && tokensMatch(msg.token, this.token)) {
          authed = true;
          this.pairingFailed = false;
          this.upstream = ws;
          ws.send(JSON.stringify({ type: "ready", app: "sutra-peer", v: 1, token: this.token }));
          console.error("[sutra-mcp] another Sutra MCP server owns the port — relaying through it.");
        } else {
          // The primary runs with a different token: one of the AI tools has a stale SUTRA_MCP_TOKEN.
          this.pairingFailed = true;
          console.error("[sutra-mcp] the Sutra MCP server already running uses a different pairing token. Set SUTRA_MCP_TOKEN in every AI tool to the token shown in Sutra → Settings → Connections.");
          try { ws.close(); } catch { /* ignore */ }
        }
        return;
      }
      if (msg?.type === "res" && typeof msg?.id === "string") this.settle(msg);
    });
    ws.on("close", () => {
      if (this.upstream === ws) {
        this.upstream = null;
        this.failAll("phone disconnected");
      }
      // The primary went away (or refused us): try to take the port over.
      this.scheduleRestart(authed ? 300 : 3000);
    });
    ws.on("error", () => { /* surfaced via close */ });
  }

  private onConnection(ws: WebSocket): void {
    let authed = false;
    let peer = false;

    // Prove ourselves first: the app verifies this before serving anything.
    ws.send(JSON.stringify({ type: "auth", token: this.token }));

    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // ignore malformed frames
      }

      if (!authed) {
        if (msg?.type === "ready" && msg?.app === "sutra-peer" && typeof msg?.token === "string" && tokensMatch(msg.token, this.token)) {
          // Another copy of this server (a second AI tool) relaying through us — never the device.
          authed = true;
          peer = true;
        } else if (msg?.type === "ready" && msg?.app === "sutra" && typeof msg?.token === "string" && tokensMatch(msg.token, this.token)) {
          authed = true;
          this.pairingFailed = false;
          // Newest authenticated socket wins — drop any previous device.
          if (this.device && this.device !== ws) {
            try { this.device.close(); } catch { /* ignore */ }
          }
          this.device = ws;
          console.error("[sutra-mcp] Sutra connected and paired.");
        } else if (msg?.type === "auth_error") {
          this.pairingFailed = true;
          console.error("[sutra-mcp] pairing failed: Sutra rejected this token. Make sure SUTRA_MCP_TOKEN matches the pairing token shown in Sutra → Settings → Connections.");
          try { ws.close(); } catch { /* ignore */ }
        } else {
          // A `ready` frame that failed tokensMatch is the reverse mismatch (app's token ≠ ours):
          // record it as a pairing failure so call() reports the accurate "pairing failed" diagnostic
          // (mirrors the auth_error branch) instead of the generic "phone disconnected".
          if (msg?.type === "ready") {
            this.pairingFailed = true;
            console.error("[sutra-mcp] pairing failed: Sutra sent a token that does not match SUTRA_MCP_TOKEN. Make sure it matches the pairing token shown in Sutra → Settings → Connections.");
          }
          // Unauthenticated socket sent something other than a valid ready/auth_error — drop it.
          try { ws.close(); } catch { /* ignore */ }
        }
        return;
      }

      if (peer) { this.servePeer(ws, msg); return; }
      if (msg?.type === "res" && typeof msg?.id === "string") this.settle(msg);
    });

    ws.on("close", () => {
      if (this.device === ws) {
        this.device = null;
        console.error("[sutra-mcp] Sutra disconnected.");
        this.failAll("phone disconnected");
      }
    });
    ws.on("error", (e) => console.error("[sutra-mcp] socket error:", (e as Error).message));
  }

  private settle(msg: any): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "request failed"));
  }

  /** PRIMARY side of a peer link: forward its request to the app and answer with the app's reply.
   *  Errors keep their message so the peer maps "phone disconnected" etc. exactly like we do. */
  private servePeer(ws: WebSocket, msg: any): void {
    if (msg?.type !== "req" || typeof msg?.id !== "string") return;
    const reply = (body: Record<string, unknown>) => {
      try { ws.send(JSON.stringify({ type: "res", id: msg.id, ...body })); } catch { /* peer gone */ }
    };
    const params = msg.params && typeof msg.params === "object" ? msg.params : {};
    this.call(String(msg.method ?? ""), params).then(
      (result) => reply({ ok: true, result }),
      (e: Error) => reply({ ok: false, error: e.message }),
    );
  }

  private failAll(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Send a request to the app (directly, or via the primary when we're a peer) and resolve with its
   *  result (or reject on error/timeout/disconnect). */
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const target = this.upstream ?? this.device;
    if (!this.isConnected() || !target) {
      return Promise.reject(new Error(this.pairingFailed ? "pairing failed" : "phone disconnected"));
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(new Error("too many in-flight requests"));
    }
    const id = randomUUID();
    const ms = LONG_METHODS.has(method) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("request timed out"));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      try {
        target.send(JSON.stringify({ type: "req", id, method, params }));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("failed to reach phone"));
      }
    });
  }
}
