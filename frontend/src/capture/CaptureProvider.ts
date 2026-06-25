// Capture seam for online-meeting two-channel capture (ticket F1, approach #3).
// The CaptureProvider interface is the contract both shells implement; the factory selects the
// concrete provider from the SAME capability probe that gates the /meeting route — Electron when the
// preload bridge is present (native loopback), the browser path otherwise (getUserMedia +
// getDisplayMedia). Real capture lands in F2; these are deliberately stubs.
//
// Invariant preserved from the existing pipeline: audio is NEVER persisted — providers stream
// in-RAM ~90s windows only. The window shape is intentionally not modeled yet (F2).
import { detectCaptureCapability, type CaptureCapability } from "../local/captureCapability";

/** A captured ~90s window of interleaved 2-channel PCM (mic→ch0 "Me", system→ch1 remotes).
 *  In-RAM only, handed straight to the transcription router — never written to disk. */
export interface CaptureWindow {
  /** Interleaved linear16 stereo PCM for this window. */
  pcm: Int16Array;
  sampleRate: number;
  channels: 2;
  /** Monotonic window index since start (0-based). */
  index: number;
}

export interface CaptureStartOptions {
  /** Preferred microphone deviceId; undefined → system default. */
  micDeviceId?: string;
  /** Callback invoked per completed in-RAM window. */
  onWindow?: (w: CaptureWindow) => void;
  /** Callback for a fatal capture error (stream ended, permission denied, no-audio-track). */
  onError?: (err: Error) => void;
}

/** The single capture contract. Both ElectronCapture and BrowserCapture implement it. */
export interface CaptureProvider {
  /** Which runtime this provider targets — for diagnostics / UI copy. */
  readonly kind: "electron" | "browser";
  /** Begin two-channel capture. Resolves once streams are live; rejects if capture can't start. */
  start(options?: CaptureStartOptions): Promise<void>;
  /** Stop capture and release all audio resources. Idempotent. */
  stop(): Promise<void>;
}

const NOT_IMPLEMENTED =
  "Meeting capture is not implemented yet (ticket F2 — two-channel capture engine).";

/** Desktop shell: real capture goes through the Electron main-process loopback via the preload
 *  bridge (electron/main.ts setDisplayMediaRequestHandler({ audio: 'loopback' })). Stub for F1. */
export class ElectronCapture implements CaptureProvider {
  readonly kind = "electron" as const;

  async start(_options?: CaptureStartOptions): Promise<void> {
    // TODO(F2): IPC to the main process for system loopback + getUserMedia(mic) → 2-ch encode.
    throw new Error(NOT_IMPLEMENTED);
  }

  async stop(): Promise<void> {
    // TODO(F2): tear down IPC capture session; no-op while unimplemented.
  }
}

/** Web shell (Chrome/Edge PWA): real capture is getUserMedia(mic) + getDisplayMedia(system/tab)
 *  merged to 2-channel PCM. Stub for F1. */
export class BrowserCapture implements CaptureProvider {
  readonly kind = "browser" as const;

  async start(_options?: CaptureStartOptions): Promise<void> {
    // TODO(F2): getUserMedia + getDisplayMedia → AudioContext(48k) → ChannelMerger(2) → worklet.
    throw new Error(NOT_IMPLEMENTED);
  }

  async stop(): Promise<void> {
    // TODO(F2): stop all tracks, close the AudioContext; no-op while unimplemented.
  }
}

/**
 * Select the capture provider for the current runtime from the shared capability contract:
 * Electron renderer → ElectronCapture, everything else → BrowserCapture. Importing/calling this in a
 * plain browser or jsdom test env does NOT crash — it returns a stub whose start() throws only when
 * invoked. An optional capability can be injected (tests / to reuse a probe done by the gate).
 */
export function createCaptureProvider(capability?: CaptureCapability): CaptureProvider {
  const cap = capability ?? detectCaptureCapability();
  return cap.isElectron ? new ElectronCapture() : new BrowserCapture();
}
