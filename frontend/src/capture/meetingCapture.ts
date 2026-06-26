// F6 — meeting capture controller (the "controller-mirror" of Capture.tsx, but for two-channel
// online-meeting capture). Mirrors Capture.tsx's start → window→ingest → stop(drain → close → process)
// flow exactly, adapted for the StereoCaptureCore provider (CaptureProvider) instead of the mic-only
// CaptureController, and for WAV-at-the-edge windows tagged multichannel for per-channel diarization.
//
// Framework-agnostic on purpose: Meeting.tsx wires it to React state via callbacks, and the unit
// tests drive it directly with a mocked provider + api (no DOM, no Web Audio) to assert the wiring,
// the WAV multichannel ingest, the in-flight count, and the error/stop flows.
//
// AUDIO NEVER PERSISTED: a window's PCM is turned into a WAV Blob ONLY for the in-flight
// api.ingestWindow() call (windowToWavBlob) — nothing here writes it to storage. Mirrors stereoCore.

import type { CaptureProvider, CaptureWindow, CaptureStartOptions } from "./CaptureProvider";
import type { AudioOutputKind } from "./stereoCore";
import { windowToWavBlob } from "./wav";

/** The slice of `api` this controller needs — injected so tests can mock it without the DB. */
export interface MeetingApi {
  createSession(): Promise<{ id: number }>;
  ingestWindow(
    sid: number,
    blob: Blob,
    index: number,
    filename?: string,
    windowStartMs?: number,
    multichannel?: boolean,
  ): Promise<{ turns?: any[] } | undefined>;
  closeSession(sid: number): Promise<unknown>;
  processSession(sid: number): Promise<any>;
}

/** Reactive surface the controller reports through (Meeting.tsx maps these to setState). */
export interface MeetingCallbacks {
  onError?: (message: string | null) => void;
  /** Live in-flight upload count (increments on send, decrements on settle). */
  onInflight?: (n: number) => void;
  /** Count of windows emitted so far (one per completed capture window). */
  onWindows?: (n: number) => void;
  /** New turns appended from a window's transcription. */
  onTurns?: (turns: any[]) => void;
  /** Capture lifecycle for the UI: idle ↔ capturing, plus processing + ended-recovery. */
  onPhase?: (phase: MeetingPhase) => void;
}

export type MeetingPhase = "idle" | "capturing" | "processing" | "ended";

export interface MeetingControllerOptions extends MeetingCallbacks {
  provider: CaptureProvider;
  api: MeetingApi;
  /** Selected mic deviceId from the picker (undefined → system default). */
  micDeviceId?: string;
  /** Output kind from the headphones/speakers toggle → echo policy. */
  output?: AudioOutputKind;
}

/** The re-share prompt message for the missed "share audio" checkbox (re-exported for the UI/tests). */
export { NO_AUDIO_TRACK_MESSAGE } from "./stereoCore";
export const STREAM_ENDED_MESSAGE = "Capture stream ended.";

/**
 * Drives one meeting-capture lifecycle. Construct, call start(); each completed CaptureWindow is
 * wrapped to a 2-channel WAV and ingested (multichannel=true); stop() drains in-flight uploads then
 * closes + processes the session, exactly mirroring Capture.tsx. Idempotent stop()/teardown().
 */
export class MeetingController {
  private readonly provider: CaptureProvider;
  private readonly api: MeetingApi;
  private readonly cb: MeetingCallbacks;
  private readonly micDeviceId?: string;
  private readonly output?: AudioOutputKind;

  private sid: number | null = null;
  private inflight = 0;
  private windows = 0;
  private uploads: Promise<unknown>[] = [];
  private capturing = false;
  private stopping = false;

  constructor(opts: MeetingControllerOptions) {
    this.provider = opts.provider;
    this.api = opts.api;
    this.micDeviceId = opts.micDeviceId;
    this.output = opts.output;
    this.cb = opts;
  }

  /** Begin capture: open a session, then start the provider once with the wired options. */
  async start(): Promise<void> {
    if (this.capturing) return;
    this.cb.onError?.(null);
    this.windows = 0;
    this.cb.onWindows?.(0);
    try {
      const s = await this.api.createSession();
      this.sid = s.id;
      const startOpts: CaptureStartOptions = {
        micDeviceId: this.micDeviceId,
        output: this.output,
        onWindow: (w) => this.handleWindow(w),
        onError: (err) => this.handleCaptureError(err),
      };
      await this.provider.start(startOpts);
      this.capturing = true;
      this.cb.onPhase?.("capturing");
    } catch (err: any) {
      // A failed start (permission denial, runtime guard) must leave NO open session and stay usable.
      await this.discardSession();
      this.capturing = false;
      this.cb.onPhase?.("idle");
      this.cb.onError?.(errMessage(err));
    }
  }

  /** Wrap a completed window to 2-channel WAV and ingest it (multichannel). Never persists the PCM. */
  private handleWindow(w: CaptureWindow): void {
    this.windows += 1;
    this.cb.onWindows?.(this.windows);
    const blob = windowToWavBlob(w.pcm, w.sampleRate, w.channels);
    const startMs = Date.now();
    this.bumpInflight(1);
    const p = (async () => {
      try {
        const sid = this.sid;
        if (sid == null) return; // session already torn down — drop (audio is never stored anyway)
        const res = await this.api.ingestWindow(sid, blob, w.index, `window-${w.index}.wav`, startMs, true);
        if (res?.turns?.length) this.cb.onTurns?.(res.turns);
      } catch (e: any) {
        this.cb.onError?.(errMessage(e));
      } finally {
        this.bumpInflight(-1);
      }
    })();
    this.uploads.push(p);
  }

  /** Surface a fatal capture error from the provider and unwind to a usable state. */
  private handleCaptureError(err: Error): void {
    const msg = errMessage(err);
    this.cb.onError?.(msg);
    if (msg === STREAM_ENDED_MESSAGE) {
      // Mid-capture stream loss ("stop sharing" / device unplug): graceful stop, offer a Restart.
      void this.finishSession("ended");
    } else {
      // No-audio-track / permission error before/at start: tear down, return to idle, no dangling session.
      this.capturing = false;
      void this.discardSession();
      this.cb.onPhase?.("idle");
    }
  }

  /**
   * Stop the user requested: stop the provider, drain all in-flight uploads, close + process the
   * session, returning to idle. Mirrors Capture.tsx.stop() — processSession only after every window's
   * turns are inserted. The stream-ended recovery path calls finishSession("ended") instead.
   */
  async stop(): Promise<void> {
    await this.finishSession("idle");
  }

  /** Drain → close → process, then settle on finalPhase ("idle" for a user stop, "ended" for a
   *  stream-ended recovery → Restart affordance). Idempotent; mirrors Capture.tsx.stop(). */
  private async finishSession(finalPhase: "idle" | "ended"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.capturing = false;
    try {
      await this.provider.stop();
    } catch {
      /* ignore — still drain + process below */
    }
    const sid = this.sid;
    if (sid == null) {
      this.cb.onPhase?.(finalPhase);
      this.stopping = false;
      return;
    }
    this.cb.onPhase?.("processing");
    try {
      await Promise.allSettled(this.uploads);
      await this.api.closeSession(sid);
      const r: any = await this.api.processSession(sid);
      if (r?.failed > 0) {
        this.cb.onError?.(`Processed with issues — ${r.failed} part(s) failed${r.lastError ? ": " + r.lastError : ""}.`);
      }
    } catch (e: any) {
      this.cb.onError?.(errMessage(e));
    } finally {
      this.uploads = [];
      this.sid = null;
      this.cb.onPhase?.(finalPhase);
      this.stopping = false;
    }
  }

  /** Close a session opened but never used (failed start / pre-window error). Never processes. */
  private async discardSession(): Promise<void> {
    const sid = this.sid;
    this.sid = null;
    if (sid != null) {
      try {
        await this.api.closeSession(sid);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Fire-and-forget teardown for unmount: if still capturing, stop the provider so no MediaStream /
   * AudioContext is orphaned. Does NOT process (the page is gone). Idempotent.
   */
  teardown(): void {
    if (this.stopping) return;
    void this.provider.stop().catch(() => {});
    this.capturing = false;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  private bumpInflight(d: number): void {
    this.inflight += d;
    this.cb.onInflight?.(this.inflight);
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
