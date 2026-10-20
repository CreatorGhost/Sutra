// Meeting capture controller — framework-agnostic lifecycle for one two-channel recording:
//   start → (each ~90s window) transcribe → stop: drain uploads → close → process into notes.
// The React recorder (src/app/recorder.tsx) wires it to state via callbacks; unit tests drive it
// directly with a mocked provider + api (no DOM, no Web Audio, no DB).
//
// Channel strategy ("split", the default): each window's stereo PCM is split into your mic (ch0) and the
// meeting audio (ch1); each channel with actual speech is downsampled to 16 kHz mono and transcribed on
// its own, tagged with its channel. That gives exact "Me" vs remote attribution with ANY speech provider
// (the default OpenAI STT ignores stereo) and skips paying for a silent channel. "stereo" keeps the
// older behaviour: one 2-channel WAV with the provider asked to split channels itself.
//
// AUDIO NEVER PERSISTED: PCM becomes a WAV Blob only for the in-flight api.ingestWindow() call.

import { MeetingMedia, type MediaSink } from "./meetingMedia";
import type { CaptureProvider, CaptureWindow, CaptureStartOptions } from "./CaptureProvider";
import type { AudioOutputKind } from "./stereoCore";
import { windowToWavBlob } from "./wav";
import { MIN_VOICED_SECONDS, STT_SAMPLE_RATE, deinterleave, downsample, voicedSeconds } from "./channels";
import type { IngestChannelOpts } from "../local/ingest";

/** The slice of `api` this controller needs — injected so tests can mock it without the DB. */
export interface MeetingApi {
  createSession(device?: string, kind?: "meeting" | "ambient", sourceApp?: string | null): Promise<{ id: number }>;
  ingestWindow(
    sid: number,
    blob: Blob,
    index: number,
    filename?: string,
    windowStartMs?: number,
    channelOpts?: boolean | IngestChannelOpts,
  ): Promise<{ turns?: any[] } | undefined>;
  closeSession(sid: number): Promise<unknown>;
  processSession(sid: number, projectId?: number | null): Promise<any>;
}

/** Reactive surface the controller reports through. */
export interface MeetingCallbacks {
  onError?: (message: string | null) => void;
  /** Live in-flight upload count (increments on send, decrements on settle). */
  onInflight?: (n: number) => void;
  /** Count of windows emitted so far (one per completed capture window). */
  onWindows?: (n: number) => void;
  /** New turns appended from a window's transcription. */
  onTurns?: (turns: any[]) => void;
  /** Capture lifecycle: idle ↔ capturing, plus processing + ended-recovery. */
  onPhase?: (phase: MeetingPhase) => void;
  /** Input levels in [0,1] for the mic ("me") and the meeting audio ("them"), ~10×/s. */
  onLevel?: (me: number, them: number) => void;
  /** The session finished processing (result of api.processSession, plus the session id). */
  onProcessed?: (result: any, sessionId: number) => void | Promise<void>;
  /** Asked once capture has stopped, before the notes are written: the project this meeting is for
   *  (null = none, undefined = let Sutra decide). */
  chooseProject?: () => Promise<number | null | undefined>;
}

export type MeetingPhase = "idle" | "capturing" | "processing" | "ended";
export type ChannelMode = "split" | "stereo";

export interface MeetingControllerOptions extends MeetingCallbacks {
  provider: CaptureProvider;
  api: MeetingApi;
  /** Desktop, "Take screenshots during meetings": where screenshots + audio go until confirmed. */
  media?: MediaSink | null;
  /** Selected mic deviceId (undefined → system default). */
  micDeviceId?: string;
  /** Output kind (headphones/speakers) → echo policy. */
  output?: AudioOutputKind;
  /** The detected meeting app ("Google Chrome", "Zoom"), stored on the session for the notes header. */
  sourceApp?: string | null;
  /** See file header. Defaults to "split". */
  channelMode?: ChannelMode;
}

/** The re-share prompt message for the missed "share audio" checkbox (re-exported for the UI/tests). */
export { NO_AUDIO_TRACK_MESSAGE } from "./stereoCore";
export const STREAM_ENDED_MESSAGE = "Capture stream ended.";
/** Call-audio level that counts as someone talking, and the pause before it that makes it a new turn. */
const VOICE_LEVEL = 0.015, VOICE_GAP_MS = 1500; // raw RMS, like channels.voicedSeconds's 0.012

/**
 * Drives one meeting-capture lifecycle. Construct, call start(); each completed CaptureWindow is
 * transcribed (per channel by default); stop() drains in-flight uploads then closes + processes the
 * session. Idempotent stop()/teardown().
 */
export class MeetingController {
  private readonly provider: CaptureProvider;
  private readonly api: MeetingApi;
  private readonly cb: MeetingCallbacks;
  private readonly opts: MeetingControllerOptions;

  private sid: number | null = null;
  private inflight = 0;
  private windows = 0;
  private uploads: Promise<unknown>[] = [];
  private capturing = false;
  private stopping = false;
  /** Wall-clock start of the capture and the running audio offset, so each window's turns get the
   *  real time they were SPOKEN (not the time the window finished). */
  private media: MeetingMedia | null = null;
  private startedAt = 0;
  private offsetMs = 0;

  constructor(opts: MeetingControllerOptions) {
    this.provider = opts.provider;
    this.api = opts.api;
    this.cb = opts;
    this.opts = opts;
  }

  get sessionId(): number | null {
    return this.sid;
  }

  /** Begin capture: open a session, then start the provider once with the wired options. */
  async start(): Promise<void> {
    if (this.capturing) return;
    this.cb.onError?.(null);
    this.windows = 0;
    this.offsetMs = 0;
    this.cb.onWindows?.(0);
    try {
      const s = await this.api.createSession(this.provider.kind, "meeting", this.opts.sourceApp ?? null);
      this.sid = s.id;
      this.startedAt = Date.now();
      const sink = this.opts.media;
      const startOpts: CaptureStartOptions = {
        micDeviceId: this.opts.micDeviceId,
        output: this.opts.output,
        onWindow: (w) => this.handleWindow(w),
        onError: (err) => this.handleCaptureError(err),
        onLevel: (me: number, them: number) => { this.cb.onLevel?.(me, them); this.watchVoice(them); },
        ...(sink ? {
          keepVideo: true,
          onStreams: (mic: MediaStream, sys: MediaStream, video: MediaStreamTrack | null) => {
            if (this.sid == null) return;
            this.media = new MeetingMedia(this.sid, sink, (m) => this.cb.onError?.(m));
            void this.media.start(video, [mic, sys]);
          },
        } : {}),
      };
      await this.provider.start(startOpts);
      if (this.sid == null) return; // a synchronous onError during start already unwound us
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

  /** Transcribe a completed window. Never persists the PCM. */
  private handleWindow(w: CaptureWindow): void {
    this.windows += 1;
    this.cb.onWindows?.(this.windows);
    const windowStartMs = this.startedAt + this.offsetMs;
    this.offsetMs += Math.round(((w.pcm.length / w.channels) / w.sampleRate) * 1000);

    if ((this.opts.channelMode ?? "split") === "stereo") {
      this.send(windowToWavBlob(w.pcm, w.sampleRate, w.channels), w.index, `window-${w.index}.wav`, windowStartMs, true);
      return;
    }
    for (const channel of [0, 1] as const) {
      const mono = deinterleave(w.pcm, channel);
      if (voicedSeconds(mono, w.sampleRate) < MIN_VOICED_SECONDS) continue; // silence on this side
      const pcm16k = downsample(mono, w.sampleRate, STT_SAMPLE_RATE);
      const name = `window-${w.index}-${channel === 0 ? "me" : "them"}.wav`;
      this.send(windowToWavBlob(pcm16k, STT_SAMPLE_RATE, 1), w.index, name, windowStartMs, { channel });
    }
  }

  private send(blob: Blob, index: number, filename: string, startMs: number, channelOpts: boolean | IngestChannelOpts): void {
    this.bumpInflight(1);
    const p = (async () => {
      try {
        const sid = this.sid;
        if (sid == null) return; // session already torn down — drop (audio is never stored anyway)
        const res = await this.api.ingestWindow(sid, blob, index, filename, startMs, channelOpts);
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
      // Mid-capture stream loss ("stop sharing" / device unplug): keep what we have, offer a Restart.
      void this.finishSession("ended");
    } else {
      // No-audio-track / permission error before/at start: tear down, return to idle, no dangling session.
      this.capturing = false;
      void this.discardSession();
      this.cb.onPhase?.("idle");
    }
  }

  /** The call's audio coming back after a pause = someone (else) started talking: a screenshot then
   *  catches the call app highlighting who. Levels arrive ~10×/s. */
  private quietSince = 0;
  private watchVoice(them: number): void {
    const now = Date.now();
    if (them < VOICE_LEVEL) { if (!this.quietSince) this.quietSince = now; return; }
    if (this.quietSince && now - this.quietSince >= VOICE_GAP_MS) this.media?.voiceStarted();
    this.quietSince = 0;
  }

  /** Screenshots from another screen (a fresh screen track); ignored when screenshots are off. */
  async useScreen(track: MediaStreamTrack): Promise<void> {
    if (this.media) await this.media.useScreen(track);
    else track.stop();
  }

  /** User stop: stop the provider, drain all in-flight uploads, close + process, return to idle. */
  async stop(): Promise<void> {
    await this.finishSession("idle");
  }

  /** Drain → close → process, then settle on finalPhase. Idempotent. */
  private async finishSession(finalPhase: "idle" | "ended"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.capturing = false;
    // Ask right away, while the last audio is still being transcribed (that can take a minute).
    const project = this.sid != null ? this.cb.chooseProject?.().catch(() => undefined) : undefined;
    try {
      await this.provider.stop(); // flushes the tail window through handleWindow
      await this.media?.stop();   // every screenshot + audio chunk saved before the notes pass reads them
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
      const projectId = await project;
      const r: any = await (projectId === undefined ? this.api.processSession(sid) : this.api.processSession(sid, projectId));
      if (r?.failed > 0) {
        this.cb.onError?.(`Processed with issues — ${r.failed} part(s) failed${r.lastError ? ": " + r.lastError : ""}.`);
      }
      await this.cb.onProcessed?.(r, sid);
    } catch (e: any) {
      this.cb.onError?.(errMessage(e));
    } finally {
      this.uploads = [];
      this.sid = null;
      this.media = null;
      this.cb.onPhase?.(finalPhase);
      this.stopping = false;
    }
  }

  /** Close a session opened but never used (failed start / pre-window error). Never processes. */
  private async discardSession(): Promise<void> {
    const sid = this.sid;
    this.sid = null;
    if (this.media) { await this.media.stop().catch(() => {}); this.media = null; }
    if (sid != null) {
      try {
        await this.api.closeSession(sid);
      } catch {
        /* ignore */
      }
    }
  }

  /** Fire-and-forget teardown: stop the provider so no MediaStream/AudioContext is orphaned. Does NOT
   *  process. Idempotent. */
  teardown(): void {
    if (this.stopping) return;
    void this.provider.stop().catch(() => {});
    void this.media?.stop().catch(() => {});
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
