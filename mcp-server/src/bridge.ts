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
 * Reverse WebSocket bridge: we LISTEN, the phone dials in. On connect we prove knowledge of the
 * pairing token; the phone echoes proof back. Exactly one authenticated device socket is kept
 * (newest wins). `call()` correlates request/response by id with a per-call timeout.
 */
export class Bridge {
  private wss: WebSocketServer | null = null;
  private device: WebSocket | null = null; // the one authenticated phone socket
  private pending = new Map<string, Pending>();
  private pairingFailed = false;

  constructor(
    private token: string,
    private host = process.env.SUTRA_BRIDGE_HOST || "127.0.0.1",
    private port = Number(process.env.SUTRA_BRIDGE_PORT) || 8765,
  ) {}

  start(): void {
    // Cap inbound frames (plan §6: prevent the "missing maxPayload / JSON.parse bomb" class). ws
    // otherwise inherits a 100MB default; 1 MiB is far above any legitimate ready/res frame.
    this.wss = new WebSocketServer({ host: this.host, port: this.port, maxPayload: 1 << 20 });
    this.wss.on("listening", () => {
      console.error(`[sutra-mcp] bridge listening on ws://${this.host}:${this.port} — waiting for your phone to connect.`);
    });
    this.wss.on("error", (e) => console.error("[sutra-mcp] bridge server error:", (e as Error).message));
    this.wss.on("connection", (ws) => this.onConnection(ws));
  }

  isConnected(): boolean {
    return !!this.device && this.device.readyState === WebSocket.OPEN;
  }

  private onConnection(ws: WebSocket): void {
    let authed = false;

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
        if (msg?.type === "ready" && msg?.app === "sutra" && typeof msg?.token === "string" && tokensMatch(msg.token, this.token)) {
          authed = true;
          this.pairingFailed = false;
          // Newest authenticated socket wins — drop any previous device.
          if (this.device && this.device !== ws) {
            try { this.device.close(); } catch { /* ignore */ }
          }
          this.device = ws;
          console.error("[sutra-mcp] phone connected and paired.");
        } else if (msg?.type === "auth_error") {
          this.pairingFailed = true;
          console.error("[sutra-mcp] pairing failed: the phone rejected this token. Make sure SUTRA_MCP_TOKEN matches the pairing token shown in Sutra → Settings → External access.");
          try { ws.close(); } catch { /* ignore */ }
        } else {
          // A `ready` frame that failed tokensMatch is the reverse mismatch (phone's token ≠ ours):
          // record it as a pairing failure so call() reports the accurate "pairing failed" diagnostic
          // (mirrors the auth_error branch) instead of the generic "phone disconnected".
          if (msg?.type === "ready") {
            this.pairingFailed = true;
            console.error("[sutra-mcp] pairing failed: the phone sent a token that does not match SUTRA_MCP_TOKEN. Make sure it matches the pairing token shown in Sutra → Settings → External access.");
          }
          // Unauthenticated socket sent something other than a valid ready/auth_error — drop it.
          try { ws.close(); } catch { /* ignore */ }
        }
        return;
      }

      if (msg?.type === "res" && typeof msg?.id === "string") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "request failed"));
      }
    });

    ws.on("close", () => {
      if (this.device === ws) {
        this.device = null;
        console.error("[sutra-mcp] phone disconnected.");
        this.failAll("phone disconnected");
      }
    });
    ws.on("error", (e) => console.error("[sutra-mcp] socket error:", (e as Error).message));
  }

  private failAll(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Send a request to the phone and resolve with its result (or reject on error/timeout/disconnect). */
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.isConnected() || !this.device) {
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
        this.device!.send(JSON.stringify({ type: "req", id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("failed to reach phone"));
      }
    });
  }
}
