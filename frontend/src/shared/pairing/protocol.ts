// Phone ↔ Mac pairing protocol, shared by both ends. PURE (no I/O).
//
// Pairing: the Mac shows a QR holding a PairOffer — its id, name, public key, a one-time code and the
// routes it can be reached on (LAN WebSocket addresses and, if set up, the user's own Cloudflare relay).
// The phone connects on any route and sends `pair` (its public key + the code sealed to the Mac's key).
// From then on it reconnects with `hello`. Both handshake frames and the Mac's `welcome` are plain JSON
// TEXT messages; everything after the welcome is a sealed BINARY frame (see crypto.ts FrameCipher)
// holding one JSON Message.
import type { AgentId } from "../agentProtocol";

export const PROTOCOL_VERSION = 1;
export const PAIR_LINK_PREFIX = "sutra-pair:1:";
export const PAIR_CODE_TTL_MS = 5 * 60_000;
export const PAIR_CODE_LENGTH = 12;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I — easy to read aloud or type
/** Wrong codes allowed against one offer before it is burned. */
export const PAIR_MAX_ATTEMPTS = 8;

/** Audio and other large payloads move in chunks small enough for the relay (Durable Object WebSocket
 *  messages are capped at 1 MiB; a 192 KiB chunk is ~256 KiB base64 inside its sealed frame). */
export const BLOB_CHUNK_BYTES = 192 * 1024;
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
/** Default LAN port of the Mac's pairing server (falls back to a free port when taken). */
export const DEFAULT_PAIR_PORT = 47321;
export const PING_INTERVAL_MS = 20_000;

export type Route = { kind: "lan"; url: string } | { kind: "relay"; url: string };

export interface PairOffer {
  v: 1;
  hostId: string;
  hostName: string;
  hostKey: string;   // the Mac's ECDH P-256 public key (base64url raw)
  code: string;      // one-time, PAIR_CODE_TTL_MS
  exp: number;       // ms epoch
  routes: Route[];
}

/** A random one-time code from `random` bytes (rejection sampling keeps it uniform). */
export function makePairCode(random: (n: number) => Uint8Array): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = "";
  while (out.length < PAIR_CODE_LENGTH) {
    for (const b of random(PAIR_CODE_LENGTH * 2)) {
      if (b < limit && out.length < PAIR_CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}
/** Case/spacing-insensitive form, for codes typed by hand ("abcd-efgh-jkmn"). */
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");
/** "ABCD-EFGH-JKMN" for display. */
export const formatCode = (s: string) => normalizeCode(s).replace(/(.{4})(?=.)/g, "$1-");

const b64uJson = (o: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64uJson = (s: string) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)))));

export function encodePairLink(o: PairOffer): string { return PAIR_LINK_PREFIX + b64uJson(o); }

/** Parse a scanned/pasted pairing link. Throws a user-facing message when it isn't one. */
export function decodePairLink(text: string, now = Date.now()): PairOffer {
  const t = text.trim();
  const at = t.indexOf(PAIR_LINK_PREFIX);
  if (at < 0) throw new Error("That isn't a Sutra pairing code. Open Settings → Phones on your Mac and scan the code shown there.");
  let o: any;
  try { o = fromB64uJson(t.slice(at + PAIR_LINK_PREFIX.length).split(/\s/)[0]); } catch { throw new Error("The pairing code is damaged — show a fresh one on your Mac."); }
  if (!o || o.v !== 1 || typeof o.hostId !== "string" || typeof o.hostKey !== "string" || typeof o.code !== "string" || !Array.isArray(o.routes))
    throw new Error("This pairing code is from a different version of Sutra — update both apps.");
  if (typeof o.exp === "number" && o.exp < now) throw new Error("This pairing code has expired — show a fresh one on your Mac.");
  const routes: Route[] = o.routes.filter((r: any) => r && (r.kind === "lan" || r.kind === "relay") && /^wss?:\/\//.test(String(r.url)));
  if (!routes.length) throw new Error("Your Mac didn't list any way to reach it. Check its network, then show a fresh code.");
  return { v: 1, hostId: o.hostId, hostName: String(o.hostName ?? "Mac"), hostKey: o.hostKey, code: normalizeCode(o.code), exp: Number(o.exp) || 0, routes };
}

/** Relay URL a phone dials for a given Mac, and the one the Mac dials as host. The relay base is
 *  "https://<name>.<account>.workers.dev" (or any wss/https URL). */
export function relayPhoneUrl(base: string, hostId: string): string { return wsBase(base) + `/phone/${encodeURIComponent(hostId)}`; }
export function relayHostUrl(base: string, hostId: string): string { return wsBase(base) + `/host/${encodeURIComponent(hostId)}`; }
function wsBase(base: string): string {
  const u = base.trim().replace(/\/+$/, "");
  if (/^wss?:\/\//.test(u)) return u;
  if (/^https:\/\//.test(u)) return "wss://" + u.slice(8);
  if (/^http:\/\//.test(u)) return "ws://" + u.slice(7);
  return "wss://" + u;
}

// ---- handshake (plain JSON text frames) ----
export type PhoneHandshake =
  | { t: "pair"; v: 1; hostId: string; deviceKey: string; deviceName: string; platform: string; nonce: string; box: string /* sealPairBox({ code }) */ }
  | { t: "hello"; v: 1; hostId: string; deviceId: string; nonce: string };

export type HostHandshake =
  | { t: "welcome"; v: 1; deviceId: string; hostName: string; nonce: string }
  | { t: "error"; v: 1; code: HandshakeError; message: string };

export type HandshakeError = "bad_code" | "expired" | "unknown_device" | "version" | "busy" | "host_mismatch";

export const HANDSHAKE_MESSAGES: Record<HandshakeError, string> = {
  bad_code: "That pairing code didn't match. Show a fresh code on your Mac and scan it again.",
  expired: "That pairing code has expired. Show a fresh code on your Mac.",
  unknown_device: "Your Mac no longer recognises this phone. Pair it again from Settings → Phones on the Mac.",
  version: "Your phone and Mac are on different versions of Sutra. Update both apps.",
  busy: "Your Mac is busy pairing another phone. Try again in a moment.",
  host_mismatch: "This address belongs to a different Mac.",
};

// ---- sealed messages (JSON inside FrameCipher frames) ----
export type Message =
  | { t: "req"; id: number; m: Method; p: unknown }
  | { t: "res"; id: number; ok: true; r: unknown }
  | { t: "res"; id: number; ok: false; e: string }
  | { t: "evt"; e: HostEvent; d: unknown };

export type HostEvent = "host.changed" | "revoked";

export interface EngineSummary {
  id: AgentId;
  label: string;
  ready: boolean;            // installed and signed in (as far as the Mac can tell)
  account: string | null;
  models: string[];
  defaultModel: string | null;
}

export interface HostInfo {
  hostName: string;
  appVersion: string;
  engines: EngineSummary[];
  /** The engine the Mac itself uses (Settings → Intelligence), or the automatic pick. */
  activeEngine: AgentId | null;
  activeModel: string | null;
  speech: { ready: boolean; model: string | null; error: string | null };
}

/** Every request the phone can make, with its params and result. */
export interface Methods {
  "ping": { p: Record<string, never>; r: { t: number } };
  "host.info": { p: Record<string, never>; r: HostInfo };
  /** Upload one chunk of a blob; chunks of one blob arrive in order (`seq` from 0). */
  "blob.put": { p: { id: string; seq: number; last: boolean; data: string /* base64url */ }; r: { received: number } };
  /** Transcribe + diarize an uploaded blob on the Mac (any audio the Mac's browser engine decodes). */
  "stt.transcribe": { p: { blobId: string; mime: string; filename: string; opts?: Record<string, unknown> }; r: unknown /* Transcription & { translated?: boolean } */ };
  /** Run a text job through the Mac's AI engine (Provider.extract/chat/translate/refine/rerank). */
  "ai.call": { p: { fn: AiFn; args: unknown[]; engine?: AgentId | null; model?: string | null }; r: unknown };
  /** Save a finished phone meeting on the Mac too (idempotent by the bundle's uid). A bundle too big
   *  for one message (over ~512 KiB of JSON) is uploaded with blob.put first and named by `blobId`. */
  "meetings.put": { p: { bundle: unknown } | { blobId: string }; r: { conversationId: number; created: boolean } };
}
export type Method = keyof Methods;
export type AiFn = "extract" | "chat" | "translate" | "refine" | "rerank";
export const AI_FNS: readonly AiFn[] = ["extract", "chat", "translate", "refine", "rerank"];

export const isMethod = (m: unknown): m is Method =>
  m === "ping" || m === "host.info" || m === "blob.put" || m === "stt.transcribe" || m === "ai.call" || m === "meetings.put";
