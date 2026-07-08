// Outbound WebSocket bridge (mcp-plan.md §3). The WebView can't host an inbound listener, so the app
// dials OUT to the one local process the user runs (the MCP server on their laptop). Mutual-auth with
// one pairing token: the server proves it knows the token first; we verify (constant-time) before
// serving anything, then echo proof back so the server won't accept an impostor "phone".
//
// Privacy-true: connects ONLY when External access is enabled in Settings (mcp_enabled === true), and
// re-checks that flag on EVERY request. Read-only. The token is never logged. All request handling
// flows through mcpHandlers, which whitelist every field. Runs on web AND native (outbound is safe).
//
// LOCKED exports (mcp-plan.md §3): initMcpBridge, restartMcpBridge, getMcpBridgeStatus.
import { api } from "../local/sutra";
import { mcpHandlers } from "../local/mcp/handlers";
import { SafeError } from "../local/mcp/serializers";

type BridgeState = "disabled" | "connecting" | "connected" | "auth_failed" | "error";

const DEFAULT_URL = "ws://localhost:8765";
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 30000;

// Module-level singleton: React StrictMode double-mounts the app effect, so guard against a second
// socket. All mutable state lives here, not on the function, so restart can tear it all down.
let ws: WebSocket | null = null;
let state: BridgeState = "disabled";
let detail: string | undefined;
let authed = false; // server proved the token AND we sent ready
let backoff = BACKOFF_MIN;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connecting = false; // a connect attempt is in flight (open pending) — StrictMode re-entry guard
let stopped = false; // auth_failed → don't reconnect-loop; wait for restartMcpBridge
let visListener: (() => void) | null = null;

function setState(s: BridgeState, d?: string) { state = s; detail = d; }

/** Constant-time equality over the two token strings (TextEncoder bytes, XOR-fold). Length mismatch
 *  short-circuits to false — but only AFTER reading both so the early exit doesn't itself leak length
 *  via timing in the equal-length case. Never logs either value. */
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function settings(): Promise<Record<string, unknown>> {
  try { return (await api.getSettings()) || {}; } catch { return {}; }
}
function bridgeUrl(s: Record<string, unknown>): string {
  return String(s["mcp_bridge_url"] || DEFAULT_URL);
}

function clearReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }

/** Schedule a reconnect with exponential backoff (1s,2s,4s…30s) + small jitter. No-op when stopped
 *  (auth failure) or disabled — those wait for restartMcpBridge / re-enable. */
function scheduleReconnect() {
  if (stopped) return;
  clearReconnect();
  const jitter = Math.floor(Math.random() * 250);
  const wait = Math.min(backoff, BACKOFF_MAX) + jitter;
  backoff = Math.min(backoff * 2, BACKOFF_MAX);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, wait);
}

/** Tear down the current socket + its listeners (without scheduling a reconnect). */
function teardownSocket() {
  if (ws) {
    try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  authed = false;
  connecting = false;
}

/** Build a safe error string for the wire (plan §3: no SQL, no stacks, no vendor/model names, no token).
 *  Only CURATED SafeError messages (thrown by the handlers themselves) are forwarded verbatim; any other
 *  error — e.g. a raw SQLite exception from q() or a provider/network error from api.search/api.chat —
 *  may leak schema/endpoint detail, so it is collapsed to a generic message. */
function safeError(e: unknown): string {
  if (e instanceof SafeError) {
    const m = e.message;
    return m.length > 300 ? m.slice(0, 300) : m;
  }
  return "request failed";
}

async function handleReq(msg: any): Promise<void> {
  const id = msg?.id;
  const send = (body: Record<string, unknown>) => {
    try { ws?.send(JSON.stringify({ type: "res", id, ...body })); } catch { /* socket gone */ }
  };
  // Master gate re-checked per request (not just at connect): a user can disable mid-session.
  const s = await settings();
  if (s["mcp_enabled"] !== true) { send({ ok: false, error: "MCP sharing is disabled in Settings." }); return; }
  const method = String(msg?.method ?? "");
  const handler = mcpHandlers[method];
  if (!handler) { send({ ok: false, error: "unknown method" }); return; }
  try {
    const result = await handler(msg?.params ?? {});
    send({ ok: true, result });
  } catch (e) {
    send({ ok: false, error: safeError(e) });
  }
}

async function onMessage(ev: MessageEvent): Promise<void> {
  let msg: any;
  try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
  const type = msg?.type;
  if (type === "auth") {
    // Server presents the token first. Verify constant-time vs our pairing token.
    const s = await settings();
    const ours = String(s["mcp_token"] ?? "");
    const theirs = String(msg?.token ?? "");
    if (!ours || !constantTimeEqual(theirs, ours)) {
      // Impostor server (or stale token). Do NOT reconnect-loop on auth failure.
      try { ws?.send(JSON.stringify({ type: "auth_error" })); } catch { /* ignore */ }
      stopped = true;
      setState("auth_failed", "pairing token did not match");
      teardownSocket();
      return;
    }
    // Pass: echo proof so the server rejects an impostor "phone", then we're connected.
    try { ws?.send(JSON.stringify({ type: "ready", app: "sutra", v: 1, token: ours })); } catch { /* ignore */ }
    authed = true;
    backoff = BACKOFF_MIN; // healthy connection resets the backoff ladder
    setState("connected");
    return;
  }
  if (type === "req") {
    if (!authed) return; // ignore requests before the handshake completes
    await handleReq(msg);
    return;
  }
  // Unknown frame types are ignored (forward-compatible).
}

async function connect(): Promise<void> {
  if (stopped) return;
  if (connecting || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;

  const s = await settings();
  if (s["mcp_enabled"] !== true) { teardownSocket(); setState("disabled"); return; }

  let sock: WebSocket;
  try {
    sock = new WebSocket(bridgeUrl(s));
  } catch (e) {
    // Local-only status detail (never sent on the wire) — surface the constructor message so a bad
    // Connection address is diagnosable in Settings.
    setState("error", e instanceof Error ? e.message : "invalid bridge URL");
    scheduleReconnect();
    return;
  }
  ws = sock;
  connecting = true;
  setState("connecting");

  sock.onopen = () => { connecting = false; /* await server "auth" frame before we trust it */ };
  sock.onmessage = (ev) => { void onMessage(ev); };
  sock.onerror = () => { /* surfaced via onclose; ws.onerror carries no useful detail in browsers */ };
  sock.onclose = () => {
    const wasThis = ws === sock;
    if (wasThis) {
      authed = false; connecting = false; ws = null;
      if (stopped) { setState("auth_failed", detail); return; }
      setState("connecting", "reconnecting");
      scheduleReconnect();
    }
  };
}

function ensureVisibilityListener() {
  if (visListener || typeof document === "undefined") return;
  visListener = () => {
    if (document.visibilityState !== "visible" || stopped) return;
    // Coming back to foreground: retry immediately rather than waiting out the backoff.
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      clearReconnect();
      backoff = BACKOFF_MIN;
      void connect();
    }
  };
  document.addEventListener("visibilitychange", visListener);
}

/** Idempotent. Start the bridge if External access is enabled; otherwise stay disabled (no socket).
 *  Safe to call repeatedly (StrictMode double-mount) — the singleton guards prevent a double connect. */
export async function initMcpBridge(): Promise<void> {
  ensureVisibilityListener();
  const s = await settings();
  if (s["mcp_enabled"] !== true) {
    teardownSocket();
    clearReconnect();
    setState("disabled");
    return;
  }
  stopped = false;
  await connect();
}

/** Full teardown (socket + timers + auth_failed latch) then re-init. Call from Settings on any
 *  mcp_* change (enable/disable, token rotate, URL edit). */
export async function restartMcpBridge(): Promise<void> {
  stopped = false;
  clearReconnect();
  teardownSocket();
  backoff = BACKOFF_MIN;
  setState("disabled");
  await initMcpBridge();
}

/** Current bridge status for the Settings status chip. Never exposes the token. */
export function getMcpBridgeStatus(): { state: BridgeState; detail?: string } {
  return { state, detail };
}
