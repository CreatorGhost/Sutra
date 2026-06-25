// Shared two-channel capture core + PURE helpers (ticket F2, approach #2:
// "one shared StereoCaptureCore + thin source adapters"). Both BrowserCapture and ElectronCapture
// acquire their two MediaStreamTracks (mic = "Me" → ch0, system = remotes → ch1) differently, then
// hand them to the SAME core here, which owns the Web Audio graph, the in-RAM ring buffer and the
// ~90s windowing. The Web-Audio-free parts (windowing math, channel-merge config, echo policy, the
// no-audio-track guard) are extracted as pure functions so they're unit-testable with no live
// devices and no DOM — see src/capture/__tests__.
//
// INVARIANT (audio-never-persisted): completed windows are passed ONLY to the onWindow callback.
// Nothing here writes PCM to disk, IndexedDB, localStorage, sql.js, or any storage adapter — the
// ring buffer lives in RAM and is released on stop().
import type { CaptureWindow } from "./CaptureProvider";

/** Common sample rate forced on the shared AudioContext so mic+system align with no resampling. */
export const CAPTURE_SAMPLE_RATE = 48000;
/** Window length in seconds (~90s, matching the existing phone capture / auto-chunker model). */
export const WINDOW_SECONDS = 90;
/** Frames (per channel) in a full window at the capture rate. */
export const FRAMES_PER_WINDOW = CAPTURE_SAMPLE_RATE * WINDOW_SECONDS;

// ---------------------------------------------------------------------------
// Pure: echo / bleed policy (spec §6)
// ---------------------------------------------------------------------------

export type AudioOutputKind = "headphones" | "speakers";

/** Resolved capture constraints derived from the output device. Pure helper output. */
export interface EchoPolicy {
  /** Mic getUserMedia constraint. Headphones = no acoustic bleed → AEC off for a pristine "Me".
   *  Speakers = mic would re-record remotes → AEC on. */
  micEchoCancellation: boolean;
  /** On the system-capture track: kill the local acoustic source so speakers don't double-capture. */
  suppressLocalAudioPlayback: boolean;
}

/**
 * Echo policy from the detected output device (spec §6). PURE — no live devices.
 *   headphones → mic echoCancellation:false (no bleed; pristine Me), no local-playback suppression.
 *   speakers   → mic echoCancellation:true  AND suppressLocalAudioPlayback:true on the system track.
 */
export function resolveEchoPolicy(output: AudioOutputKind): EchoPolicy {
  if (output === "headphones") {
    return { micEchoCancellation: false, suppressLocalAudioPlayback: false };
  }
  return { micEchoCancellation: true, suppressLocalAudioPlayback: true };
}

// ---------------------------------------------------------------------------
// Pure: no-audio-track guard (spec §7 step 2)
// ---------------------------------------------------------------------------

/** A re-share-prompt message used when the display stream carries no audio track (the user skipped
 *  the "share audio"/"share tab audio" checkbox). Surfaced via onError; capture must NOT proceed
 *  with a one-channel window. */
export const NO_AUDIO_TRACK_MESSAGE =
  "No meeting audio was shared. Re-share and tick the “Share tab audio” / “Share system audio” box so we capture the other participants.";

/** Minimal shape of the bits of a MediaStream this guard inspects (so it's testable without DOM). */
export interface AudioTrackSource {
  getAudioTracks(): readonly unknown[];
}

/** True when the display stream actually carries at least one audio track. Pure. */
export function hasAudioTrack(stream: AudioTrackSource): boolean {
  return stream.getAudioTracks().length > 0;
}

// ---------------------------------------------------------------------------
// Pure: ring buffer + windowing
// ---------------------------------------------------------------------------

/**
 * In-RAM ring buffer that accumulates interleaved stereo Int16 samples and emits a CaptureWindow
 * every framesPerWindow*2 samples. PURE: no Web Audio, no storage — it only buffers numbers and
 * calls the supplied sink. The sink is the ONLY exit for audio (audio-never-persisted).
 *
 * Source adapters feed it with push(); the worklet's interleaved linear16 output goes straight here.
 */
export class StereoWindowBuffer {
  private readonly capacity: number; // interleaved samples per full window (frames * 2)
  private readonly sampleRate: number;
  private buf: Int16Array;
  private len = 0;
  private index = 0;
  private released = false;

  constructor(
    private readonly emit: (w: CaptureWindow) => void,
    framesPerWindow = FRAMES_PER_WINDOW,
    sampleRate = CAPTURE_SAMPLE_RATE,
  ) {
    this.capacity = framesPerWindow * 2;
    this.sampleRate = sampleRate;
    this.buf = new Int16Array(this.capacity);
  }

  /** Append interleaved stereo Int16 samples; emit full windows as they complete. */
  push(samples: Int16Array): void {
    if (this.released) return;
    let off = 0;
    while (off < samples.length) {
      const space = this.capacity - this.len;
      const take = Math.min(space, samples.length - off);
      this.buf.set(samples.subarray(off, off + take), this.len);
      this.len += take;
      off += take;
      if (this.len === this.capacity) this.flushFull();
    }
  }

  private flushFull(): void {
    // Copy out so the emitted window is owned by the consumer and our buffer can be reused.
    const pcm = this.buf.slice(0, this.capacity);
    this.len = 0;
    this.emit({ pcm, sampleRate: this.sampleRate, channels: 2, index: this.index++ });
  }

  /**
   * Flush the partial tail as exactly ONE trailing window (or none if empty), then release.
   * Guarantees no sample loss and no double-count: a full window already flushed leaves len===0 →
   * no extra window. Idempotent — a second flush after release does nothing.
   */
  flush(): void {
    if (this.released) return;
    if (this.len > 0) {
      const pcm = this.buf.slice(0, this.len);
      this.len = 0;
      this.emit({ pcm, sampleRate: this.sampleRate, channels: 2, index: this.index++ });
    }
    this.release();
  }

  /** Drop the buffer and stop accepting samples. Idempotent. */
  release(): void {
    this.released = true;
    this.len = 0;
    this.buf = new Int16Array(0);
  }

  get isReleased(): boolean {
    return this.released;
  }
}
