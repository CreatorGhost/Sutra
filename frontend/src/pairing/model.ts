// What the phone remembers about the Mac it's paired with. PURE (no I/O): stored as one value in the
// encrypted app DB's settings (SQLCipher, Keystore-held key) so resolveProvider can decide
// synchronously whether the Mac does the work.
import type { Identity } from "../shared/pairing/crypto";
import type { Route } from "../shared/pairing/protocol";
import { isAgentId, safeModel, type AgentId } from "../shared/agentProtocol";

export const PAIRING_KEY = "paired_mac";
/** The AI engine/model the phone asks the Mac to use. Unset = the Mac's own choice. */
export const PAIRED_ENGINE_KEY = "paired_ai_engine";
export const PAIRED_MODEL_KEY = "paired_ai_model";

export interface Pairing {
  hostId: string;
  hostName: string;
  hostKey: string;
  routes: Route[];
  deviceId: string;
  linkKey: string;
  identity: Identity;
  /** Encrypts recordings waiting on the phone for the Mac (see outbox.ts). */
  storageKey: string;
  pairedAt: string;
  /** Set when the Mac removed this phone; the queue is kept until the user unpairs or pairs again. */
  revokedAt: string | null;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function readPairing(s: Record<string, unknown>): Pairing | null {
  const p = s[PAIRING_KEY] as Partial<Pairing> | null | undefined;
  if (!p || typeof p !== "object") return null;
  if (!str(p.hostId) || !str(p.hostKey) || !str(p.deviceId) || !str(p.linkKey) || !str(p.storageKey)) return null;
  if (!p.identity || !str(p.identity.publicKey) || typeof p.identity.privateJwk !== "object") return null;
  const routes = Array.isArray(p.routes) ? p.routes.filter((r) => r && (r.kind === "lan" || r.kind === "relay") && str(r.url)) : [];
  return {
    hostId: p.hostId, hostName: str(p.hostName) ? p.hostName : "your Mac", hostKey: p.hostKey, routes,
    deviceId: p.deviceId, linkKey: p.linkKey, identity: p.identity, storageKey: p.storageKey,
    pairedAt: String(p.pairedAt ?? ""), revokedAt: str(p.revokedAt) ? p.revokedAt : null,
  };
}

/** Paired and not removed by the Mac: the Mac does transcription and AI. */
export function pairingActive(s: Record<string, unknown>): boolean {
  const p = readPairing(s);
  return !!p && !p.revokedAt;
}

export function pairedAiChoice(s: Record<string, unknown>): { engine: AgentId | null; model: string | null } {
  const engine = isAgentId(s[PAIRED_ENGINE_KEY]) ? (s[PAIRED_ENGINE_KEY] as AgentId) : null;
  return { engine, model: engine ? safeModel(s[PAIRED_MODEL_KEY]) : null };
}

/** How this phone introduces itself to the Mac ("Pixel 8", else "Android phone"). */
export function thisDevice(nav: { userAgent?: string } | undefined = typeof navigator !== "undefined" ? navigator : undefined,
  platform = (globalThis as any).Capacitor?.getPlatform?.() ?? "web"): { deviceName: string; platform: string } {
  const ua = nav?.userAgent ?? "";
  // "Linux; Android 14; Pixel 8 Build/…" — newer WebViews reduce the model to "K", which says nothing.
  const model = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(ua)?.[1]?.trim();
  const fallback = platform === "android" ? "Android phone" : platform === "ios" ? "iPhone" : "Phone";
  return { deviceName: model && model.length > 1 ? model : fallback, platform };
}
