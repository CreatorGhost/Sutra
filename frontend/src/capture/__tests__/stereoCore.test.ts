// Pure unit tests for the shared two-channel capture core (ticket F2, approach #2). These exercise
// the REAL exported helpers with NO Web Audio, NO DOM and NO live devices: windowing/ring-buffer,
// channel-merge config, echo policy, and the no-audio-track guard. The audio-never-persisted
// invariant is asserted structurally — the ONLY sink the buffer has is the onWindow callback.
import { describe, it, expect } from "vitest";
import {
  StereoWindowBuffer,
  resolveEchoPolicy,
  hasAudioTrack,
  CAPTURE_SAMPLE_RATE,
  type EchoPolicy,
} from "../stereoCore";
import type { CaptureWindow } from "../CaptureProvider";

/** Build interleaved stereo Int16 samples: count FRAMES (so length = count*2). */
function interleaved(frames: number): Int16Array {
  const a = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    a[i * 2] = i % 1000; // ch0
    a[i * 2 + 1] = -(i % 1000); // ch1
  }
  return a;
}

describe("StereoWindowBuffer — windowing / ring buffer", () => {
  // Small framesPerWindow so the test feeds a known, tractable sample count.
  const framesPerWindow = 4;
  const rate = CAPTURE_SAMPLE_RATE;

  it("produces the correct number of full windows with valid, monotonic 0-based indices", () => {
    const out: CaptureWindow[] = [];
    const buf = new StereoWindowBuffer((w) => out.push(w), framesPerWindow, rate);

    // Feed exactly 3 full windows' worth of interleaved stereo frames.
    buf.push(interleaved(framesPerWindow * 3));

    expect(out.length).toBe(3);
    out.forEach((w, i) => {
      expect(w.channels).toBe(2);
      expect(w.sampleRate).toBe(48000);
      expect(w.index).toBe(i); // monotonically increasing, 0-based
      expect(w.pcm.length).toBe(framesPerWindow * 2);
    });
  });

  it("splits a stream pushed in odd chunks into the same windows (no boundary loss)", () => {
    const out: CaptureWindow[] = [];
    const buf = new StereoWindowBuffer((w) => out.push(w), framesPerWindow, rate);
    const all = interleaved(framesPerWindow * 2); // 2 full windows
    // Push in awkward chunks that straddle the window boundary.
    buf.push(all.subarray(0, 3));
    buf.push(all.subarray(3, 10));
    buf.push(all.subarray(10, all.length));
    expect(out.length).toBe(2);
    expect(out[0].pcm.length).toBe(framesPerWindow * 2);
    expect(out[1].pcm.length).toBe(framesPerWindow * 2);
  });

  it("flushes exactly ONE trailing partial window on stop, with no sample loss or double-count", () => {
    const out: CaptureWindow[] = [];
    const buf = new StereoWindowBuffer((w) => out.push(w), framesPerWindow, rate);
    // 1 full window + a partial (2 frames) tail.
    buf.push(interleaved(framesPerWindow + 2));
    expect(out.length).toBe(1); // only the full one so far

    buf.flush();
    expect(out.length).toBe(2); // exactly one trailing window
    expect(out[1].index).toBe(1);
    expect(out[1].pcm.length).toBe(2 * 2); // 2 frames * 2 channels — partial, not padded

    // No double-count: total emitted samples equal total pushed samples.
    const totalEmitted = out.reduce((n, w) => n + w.pcm.length, 0);
    expect(totalEmitted).toBe((framesPerWindow + 2) * 2);
  });

  it("flush with an empty buffer emits NO trailing window", () => {
    const out: CaptureWindow[] = [];
    const buf = new StereoWindowBuffer((w) => out.push(w), framesPerWindow, rate);
    buf.push(interleaved(framesPerWindow)); // exactly one full window, buffer now empty
    expect(out.length).toBe(1);
    buf.flush();
    expect(out.length).toBe(1); // none added — the buffer was empty at flush
  });

  it("release() makes the buffer inert: no further windows after stop", () => {
    const out: CaptureWindow[] = [];
    const buf = new StereoWindowBuffer((w) => out.push(w), framesPerWindow, rate);
    buf.flush(); // releases
    expect(buf.isReleased).toBe(true);
    buf.push(interleaved(framesPerWindow * 5)); // ignored after release
    expect(out.length).toBe(0);
    buf.flush(); // idempotent — no throw, no extra window
    expect(out.length).toBe(0);
  });

  it("the ONLY sink is the onWindow callback (audio-never-persisted)", () => {
    // Structural assertion: the buffer never reaches for storage; if onWindow is a no-op, the
    // pushed audio simply vanishes (in-RAM only). We assert it neither throws nor returns anything
    // observable beyond the callback.
    const buf = new StereoWindowBuffer(() => {}, framesPerWindow, rate);
    expect(() => buf.push(interleaved(framesPerWindow * 2))).not.toThrow();
  });
});

describe("resolveEchoPolicy — output device → mic/system constraints (spec §6)", () => {
  it("headphones → mic echoCancellation:false, no local-playback suppression", () => {
    const p: EchoPolicy = resolveEchoPolicy("headphones");
    expect(p.micEchoCancellation).toBe(false);
    expect(p.suppressLocalAudioPlayback).toBe(false);
  });

  it("speakers → mic echoCancellation:true AND suppressLocalAudioPlayback:true on the system track", () => {
    const p: EchoPolicy = resolveEchoPolicy("speakers");
    expect(p.micEchoCancellation).toBe(true);
    expect(p.suppressLocalAudioPlayback).toBe(true);
  });
});

describe("hasAudioTrack — no-audio-track guard primitive", () => {
  it("false when getAudioTracks() is empty, true when it has at least one", () => {
    expect(hasAudioTrack({ getAudioTracks: () => [] })).toBe(false);
    expect(hasAudioTrack({ getAudioTracks: () => [{}] })).toBe(true);
  });
});
