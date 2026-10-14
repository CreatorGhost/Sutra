import { describe, expect, it, vi } from "vitest";
import { CHANGE_THRESHOLD, MAX_FRAMES, STILL_RESHOT_MS, frameDiff, shouldKeep, toGray } from "../meetingMedia";
import { MeetingController } from "../meetingCapture";
import type { CaptureProvider, CaptureStartOptions } from "../CaptureProvider";

describe("screenshots: only when the screen changed", () => {
  it("measures change on a grayscale thumbnail", () => {
    const a = new Uint8Array(100).fill(100);
    expect(frameDiff(null, a)).toBe(1);
    expect(frameDiff(a, a)).toBe(0);
    const b = a.slice(); b.fill(200, 0, 10); // 10% of the pixels changed a lot
    expect(frameDiff(a, b)).toBeCloseTo((10 * 100) / (100 * 255), 5);
    expect([...toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]))]).toEqual([255, 0]);
  });

  it("keeps the first frame, real changes, and a still screen now and then; past the cap only big changes", () => {
    expect(shouldKeep(0, 0, 0)).toBe(true);
    expect(shouldKeep(CHANGE_THRESHOLD, 4000, 3)).toBe(true);
    expect(shouldKeep(CHANGE_THRESHOLD / 2, 4000, 3)).toBe(false);          // a cursor blink
    expect(shouldKeep(0.01, STILL_RESHOT_MS, 3)).toBe(true);               // the same slide, minutes later
    expect(shouldKeep(0, STILL_RESHOT_MS * 2, 3)).toBe(false);             // a frozen screen: nothing new
    expect(shouldKeep(CHANGE_THRESHOLD * 2, 4000, MAX_FRAMES)).toBe(false);
    expect(shouldKeep(CHANGE_THRESHOLD * 4, 4000, MAX_FRAMES)).toBe(true);
  });
});

describe("recording with screenshots on", () => {
  const provider = () => {
    let opts: CaptureStartOptions | undefined;
    const p: CaptureProvider = { kind: "electron", start: vi.fn(async (o?: CaptureStartOptions) => { opts = o; }), stop: vi.fn(async () => {}) };
    return { p, get opts() { return opts; } };
  };
  const api = () => ({
    createSession: vi.fn(async () => ({ id: 42 })), ingestWindow: vi.fn(async () => ({ turns: [] })),
    closeSession: vi.fn(async () => ({})), processSession: vi.fn(async () => ({ failed: 0 })),
  }) as any;

  it("keeps the screen track only when a media sink is given, and finishes it before the notes", async () => {
    const off = provider();
    await new MeetingController({ provider: off.p, api: api() }).start();
    expect(off.opts?.keepVideo).toBeUndefined();

    const on = provider();
    const a = api();
    const sink = { frame: vi.fn(async () => ({})), audio: vi.fn(async () => 0) };
    const ctrl = new MeetingController({ provider: on.p, api: a, media: sink });
    await ctrl.start();
    expect(on.opts?.keepVideo).toBe(true);
    on.opts!.onStreams!({ getAudioTracks: () => [] } as any, { getAudioTracks: () => [] } as any, null);
    await ctrl.stop();
    expect(a.processSession).toHaveBeenCalledWith(42);
  });
});
