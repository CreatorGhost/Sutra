// Capture seam for online-meeting two-channel capture (ticket F2, approach #2:
// "one shared StereoCaptureCore + thin source adapters"). The CaptureProvider interface is the
// contract both shells implement; the factory selects the concrete provider from the SAME capability
// probe that gates the /meeting route — Electron when the preload bridge is present (native
// loopback), the browser path otherwise (getUserMedia + getDisplayMedia).
//
// Both providers acquire their two tracks (mic = "Me" → ch0, system/remotes → ch1) differently but
// hand them to the SAME StereoCaptureCore, which owns the Web Audio graph + ~90s in-RAM windowing.
//
// Invariant preserved from the existing pipeline: audio is NEVER persisted — windows are passed only
// to the onWindow callback (see stereoCore.ts StereoWindowBuffer). Importing this module has zero
// side effects; constructing a provider never touches Web Audio — only start() does.
import { detectCaptureCapability, type CaptureCapability } from "../local/captureCapability";
import {
  CAPTURE_SAMPLE_RATE,
  StereoWindowBuffer,
  hasAudioTrack,
  resolveEchoPolicy,
  NO_AUDIO_TRACK_MESSAGE,
  type AudioOutputKind,
} from "./stereoCore";

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
  /** Output device kind for the echo policy (spec §6). Defaults to "headphones" (the ideal,
   *  no-bleed case); the capture UI passes the detected value. */
  output?: AudioOutputKind;
  /** Optional input levels in [0,1] for the mic and the system channel, emitted ~10×/s. */
  onLevel?: (me: number, them: number) => void;
  /** Desktop: keep the display stream's video track (for screenshots) instead of dropping it. */
  keepVideo?: boolean;
  /** Desktop: the live streams once capture starts — the screen track only when `keepVideo`. */
  onStreams?: (mic: MediaStream, system: MediaStream, video: MediaStreamTrack | null) => void;
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

/** The worklet module served from public/, resolved against the document so it works from the dev
 *  server AND from file:// in the packaged desktop app (an absolute "/worklets/…" path resolves to the
 *  filesystem root there and fails to load). */
function workletUrl(): string {
  try { return new URL("worklets/pcm-encoder.js", document.baseURI).href; } catch { return "worklets/pcm-encoder.js"; }
}

/** Accumulates per-channel energy from the worklet's interleaved chunks and reports RMS ~10×/s. */
class LevelMeter {
  private sum0 = 0; private sum1 = 0; private n = 0; private last = 0;
  constructor(private readonly sink: (me: number, them: number) => void, private readonly everyMs = 100) {}
  push(pcm: Int16Array): void {
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const a = pcm[i] / 32768, b = pcm[i + 1] / 32768;
      this.sum0 += a * a; this.sum1 += b * b;
    }
    this.n += pcm.length >> 1;
    const now = Date.now();
    if (now - this.last >= this.everyMs && this.n > 0) {
      this.sink(Math.sqrt(this.sum0 / this.n), Math.sqrt(this.sum1 / this.n));
      this.sum0 = this.sum1 = this.n = 0;
      this.last = now;
    }
  }
}

/**
 * StereoCaptureCore — the shared Web Audio engine. Given an already-acquired mic track and system
 * track it builds AudioContext(48k) → ChannelMerger(2) → AudioWorklet(pcm-encoder) and routes the
 * worklet's interleaved linear16 stereo PCM into a StereoWindowBuffer (in-RAM only).
 *
 * Source adapters (Browser/Electron) own track acquisition + the no-audio-track guard; this core is
 * source-agnostic and never persists audio. stop() is idempotent and releases everything.
 */
class StereoCaptureCore {
  private ctx: AudioContext | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private sysSource: MediaStreamAudioSourceNode | null = null;
  private merger: ChannelMergerNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private buffer: StereoWindowBuffer | null = null;
  private tracks: MediaStreamTrack[] = [];
  private stopped = false;

  /** Wire the graph and start emitting windows. The two streams must already be live. */
  async run(
    micStream: MediaStream,
    sysStream: MediaStream,
    onWindow: ((w: CaptureWindow) => void) | undefined,
    onEnded: (err: Error) => void,
    onLevel?: (me: number, them: number) => void,
  ): Promise<void> {
    this.tracks = [...micStream.getAudioTracks(), ...sysStream.getAudioTracks()];

    const ctx = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(workletUrl());

    const merger = ctx.createChannelMerger(2);
    this.merger = merger;

    this.micSource = ctx.createMediaStreamSource(micStream);
    this.sysSource = ctx.createMediaStreamSource(sysStream);
    // mic → channel 0 ("Me"), system → channel 1 (remotes). Never a single mixed channel.
    this.micSource.connect(merger, 0, 0);
    this.sysSource.connect(merger, 0, 1);

    const worklet = new AudioWorkletNode(ctx, "pcm-encoder", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: "explicit",
    });
    this.worklet = worklet;

    const buffer = new StereoWindowBuffer((w) => onWindow?.(w));
    this.buffer = buffer;
    const meter = onLevel ? new LevelMeter(onLevel) : null;
    worklet.port.onmessage = (e: MessageEvent) => {
      // The worklet posts the interleaved Int16 buffer; wrap and feed the in-RAM ring buffer.
      const chunk = new Int16Array(e.data as ArrayBuffer);
      meter?.push(chunk);
      buffer.push(chunk);
    };

    merger.connect(worklet);

    // If any track ends (user clicks "stop sharing", device unplugged), surface it once.
    let endedFired = false;
    for (const t of this.tracks) {
      t.addEventListener("ended", () => {
        if (endedFired || this.stopped) return; // our own stop() also ends tracks — not an error
        endedFired = true;
        onEnded(new Error("Capture stream ended."));
      }, { once: true });
    }
  }

  /** Idempotent teardown: flush the tail window, stop tracks, close the context, release the buffer. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.buffer?.flush();
    } finally {
      this.buffer = null;
      try {
        this.worklet?.port.close();
      } catch {
        /* ignore */
      }
      this.worklet?.disconnect();
      this.merger?.disconnect();
      this.micSource?.disconnect();
      this.sysSource?.disconnect();
      for (const t of this.tracks) t.stop();
      this.tracks = [];
      const ctx = this.ctx;
      this.ctx = null;
      if (ctx && ctx.state !== "closed") {
        try {
          await ctx.close();
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/** Stop every track in a list, swallowing errors — used to clean up after a failed start(). */
function stopAll(tracks: readonly MediaStreamTrack[]): void {
  for (const t of tracks) {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }
}

/** Build mic getUserMedia constraints from the start options + echo policy. */
function micConstraints(options?: CaptureStartOptions): MediaStreamConstraints {
  const policy = resolveEchoPolicy(options?.output ?? "headphones");
  const audio: MediaTrackConstraints = {
    echoCancellation: policy.micEchoCancellation,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (options?.micDeviceId) audio.deviceId = { exact: options.micDeviceId };
  return { audio };
}

/**
 * Desktop shell: the system loopback source is granted by the Electron main process
 * (setDisplayMediaRequestHandler({ audio: 'loopback' })) — the renderer still calls getDisplayMedia,
 * which the handler intercepts and fulfils with the loopback track (no screen-picker). The mic comes
 * from getUserMedia. Both feed the shared StereoCaptureCore.
 */
export class ElectronCapture implements CaptureProvider {
  readonly kind = "electron" as const;
  private core: StereoCaptureCore | null = null;
  private video: MediaStreamTrack[] = [];

  async start(options?: CaptureStartOptions): Promise<void> {
    const acquired: MediaStreamTrack[] = [];
    try {
      const md = navigator?.mediaDevices;
      if (!md?.getUserMedia || !md.getDisplayMedia) {
        throw new Error("Audio capture is unavailable in this runtime.");
      }
      const micStream = await md.getUserMedia(micConstraints(options));
      acquired.push(...micStream.getTracks());

      // Electron's loopback handler supplies the system audio; a video track is requested per spec
      // (display-media requires it) and dropped — we only keep audio.
      const policy = resolveEchoPolicy(options?.output ?? "headphones");
      const sysStream = await md.getDisplayMedia({
        video: true,
        audio: { suppressLocalAudioPlayback: policy.suppressLocalAudioPlayback } as MediaTrackConstraints,
      });
      acquired.push(...sysStream.getTracks());

      if (!hasAudioTrack(sysStream)) {
        stopAll(acquired);
        const err = new Error(NO_AUDIO_TRACK_MESSAGE);
        if (options?.onError) return void options.onError(err);
        throw err;
      }
      // The video track is dropped (audio only) unless screenshots are on.
      if (options?.keepVideo) this.video = sysStream.getVideoTracks();
      else for (const v of sysStream.getVideoTracks()) v.stop();
      options?.onStreams?.(micStream, sysStream, this.video[0] ?? null);

      this.core = new StereoCaptureCore();
      await this.core.run(micStream, sysStream, options?.onWindow, (err) => options?.onError?.(err), options?.onLevel);
    } catch (err) {
      stopAll(acquired);
      this.core = null;
      this.video = [];
      const e = err instanceof Error ? err : new Error(String(err));
      if (options?.onError && e.message !== NO_AUDIO_TRACK_MESSAGE) {
        return void options.onError(e);
      }
      throw e;
    }
  }

  async stop(): Promise<void> {
    const core = this.core;
    this.core = null;
    for (const v of this.video) v.stop();
    this.video = [];
    await core?.stop();
  }
}

/**
 * Web shell (Chrome/Edge PWA): mic via getUserMedia + system/tab audio via getDisplayMedia, merged
 * to 2-channel PCM through the shared StereoCaptureCore. The no-audio-track guard catches a skipped
 * "share audio" checkbox before any one-channel window is produced.
 */
export class BrowserCapture implements CaptureProvider {
  readonly kind = "browser" as const;
  private core: StereoCaptureCore | null = null;

  async start(options?: CaptureStartOptions): Promise<void> {
    const acquired: MediaStreamTrack[] = [];
    try {
      const md = navigator?.mediaDevices;
      if (!md?.getUserMedia || !md.getDisplayMedia) {
        throw new Error("This browser can't capture meeting audio. Use the desktop app or Chrome/Edge.");
      }
      const micStream = await md.getUserMedia(micConstraints(options));
      acquired.push(...micStream.getTracks());

      const policy = resolveEchoPolicy(options?.output ?? "headphones");
      const sysStream = await md.getDisplayMedia({
        video: true,
        audio: {
          // systemAudio:'include' asks Chrome to offer the system/tab audio checkbox.
          systemAudio: "include",
          suppressLocalAudioPlayback: policy.suppressLocalAudioPlayback,
        } as MediaTrackConstraints,
      });
      acquired.push(...sysStream.getTracks());

      // Hard guard: a display stream with no audio track means the user skipped the checkbox — never
      // proceed with a one-channel window; stop the acquired tracks and prompt a re-share.
      if (!hasAudioTrack(sysStream)) {
        stopAll(acquired);
        const err = new Error(NO_AUDIO_TRACK_MESSAGE);
        if (options?.onError) return void options.onError(err);
        throw err;
      }
      for (const v of sysStream.getVideoTracks()) v.stop(); // drop the mandatory video track

      this.core = new StereoCaptureCore();
      await this.core.run(micStream, sysStream, options?.onWindow, (err) => options?.onError?.(err), options?.onLevel);
    } catch (err) {
      stopAll(acquired);
      this.core = null;
      const e = err instanceof Error ? err : new Error(String(err));
      if (options?.onError && e.message !== NO_AUDIO_TRACK_MESSAGE) {
        return void options.onError(e);
      }
      throw e;
    }
  }

  async stop(): Promise<void> {
    const core = this.core;
    this.core = null;
    await core?.stop();
  }
}

/**
 * Select the capture provider for the current runtime from the shared capability contract:
 * Electron renderer → ElectronCapture, everything else → BrowserCapture. Importing/calling this in a
 * plain browser or jsdom test env does NOT crash — constructing a provider never touches Web Audio;
 * only start() does. An optional capability can be injected (tests / to reuse the gate's probe).
 */
export function createCaptureProvider(capability?: CaptureCapability): CaptureProvider {
  const cap = capability ?? detectCaptureCapability();
  return cap.isElectron ? new ElectronCapture() : new BrowserCapture();
}
