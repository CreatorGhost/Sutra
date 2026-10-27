// What the Mac's main process (electron/pairing/*) and its renderer (Settings → Phones, the host
// executor) tell each other about pairing. Types only.
import type { Route } from "./protocol";

export type RelayState = "off" | "connecting" | "online" | "auth_failed" | "offline";
export type Via = "lan" | "relay";

export interface PairedPhone {
  id: string;
  name: string;
  platform: string;
  pairedAt: number;
  lastSeenAt: number | null;
  connected: boolean;
  via: Via[];
}

export interface PairingStatus {
  hostId: string;
  hostName: string;
  /** Secrets on disk are protected by the OS keychain. */
  sealed: boolean;
  lan: { enabled: boolean; listening: boolean; port: number | null; addresses: string[]; error: string | null };
  relay: { url: string; hasSecret: boolean; enabled: boolean; state: RelayState };
  devices: PairedPhone[];
  /** The open pairing offer: `link` is the QR text. */
  offer: { link: string; exp: number; routes: Route[] } | null;
}
/** Pushed on every change; `paired` once, right after a phone pairs. */
export type PairingUpdate = PairingStatus & { paired?: { id: string; name: string } };

/** A phone request main forwards to the renderer (`sutra:pair:exec`), and its answer (`sutra:pair:result`). */
export interface ExecDevice { id: string; name: string; platform: string }
export interface ExecMessage { reqId: number; method: string; params: unknown; device: ExecDevice; blob?: ArrayBuffer }
export interface ExecResult { reqId: number; ok: boolean; result?: unknown; error?: string }
