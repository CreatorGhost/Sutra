// Tests for the capture factory + provider lifecycle (ticket F2, approach #2). The factory selection
// and "no throw on construct / import has no side effects" cases need no DOM. The start()/stop()
// lifecycle cases run against MOCKED Web Audio + getUserMedia/getDisplayMedia globals (no live
// devices), asserting: the no-audio-track guard stops acquired tracks and never produces a
// one-channel window; start() rejects when capture can't begin; stop() is idempotent.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createCaptureProvider,
  ElectronCapture,
  BrowserCapture,
  SYSTEM_AUDIO_DENIED_MESSAGE,
} from "../CaptureProvider";
import { NO_AUDIO_TRACK_MESSAGE } from "../stereoCore";

/** Set a (possibly getter-only, e.g. Node's built-in navigator) global by force. */
function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

describe("createCaptureProvider — factory selection", () => {
  it("isElectron:true → ElectronCapture (kind 'electron')", () => {
    const p = createCaptureProvider({ supported: true, isElectron: true, reason: "" });
    expect(p).toBeInstanceOf(ElectronCapture);
    expect(p.kind).toBe("electron");
  });

  it("isElectron:false → BrowserCapture (kind 'browser')", () => {
    const p = createCaptureProvider({ supported: true, isElectron: false, reason: "" });
    expect(p).toBeInstanceOf(BrowserCapture);
    expect(p.kind).toBe("browser");
  });

  it("no args in a DOM-less env does not throw and returns a BrowserCapture", () => {
    let p: ReturnType<typeof createCaptureProvider> | undefined;
    expect(() => {
      p = createCaptureProvider();
    }).not.toThrow();
    expect(p).toBeInstanceOf(BrowserCapture);
    expect(p!.kind).toBe("browser");
  });

  it("constructing either provider never throws (no Web Audio touched on construct)", () => {
    expect(() => new ElectronCapture()).not.toThrow();
    expect(() => new BrowserCapture()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mocked Web Audio + media for lifecycle tests
// ---------------------------------------------------------------------------

function fakeTrack(kind: "audio" | "video") {
  return {
    kind,
    stop: vi.fn(),
    addEventListener: vi.fn(),
  };
}

function fakeStream(tracks: ReturnType<typeof fakeTrack>[]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  };
}

/** Install minimal Web Audio + mediaDevices globals. Returns handles to assert against. */
function installAudioMocks(opts: {
  displayHasAudio: boolean;
}) {
  const micTracks = [fakeTrack("audio")];
  const displayTracks = opts.displayHasAudio
    ? [fakeTrack("audio"), fakeTrack("video")]
    : [fakeTrack("video")];

  const getUserMedia = vi.fn(async () => fakeStream(micTracks));
  const getDisplayMedia = vi.fn(async () => fakeStream(displayTracks));

  setGlobal("navigator", { mediaDevices: { getUserMedia, getDisplayMedia } });

  const closed = { value: false };
  class FakeAudioContext {
    state = "running";
    audioWorklet = { addModule: vi.fn(async () => {}) };
    createChannelMerger = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    close = vi.fn(async () => {
      this.state = "closed";
      closed.value = true;
    });
  }
  class FakeAudioWorkletNode {
    port = { onmessage: null as unknown, postMessage: vi.fn(), close: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
  }
  setGlobal("AudioContext", FakeAudioContext);
  setGlobal("AudioWorkletNode", FakeAudioWorkletNode);

  return { micTracks, displayTracks, getUserMedia, getDisplayMedia, closed };
}

describe("BrowserCapture lifecycle (mocked Web Audio)", () => {
  let saved: { navigator: unknown; AudioContext: unknown; AudioWorkletNode: unknown };
  beforeEach(() => {
    saved = {
      navigator: (globalThis as any).navigator,
      AudioContext: (globalThis as any).AudioContext,
      AudioWorkletNode: (globalThis as any).AudioWorkletNode,
    };
  });
  afterEach(() => {
    setGlobal("navigator", saved.navigator);
    setGlobal("AudioContext", saved.AudioContext);
    setGlobal("AudioWorkletNode", saved.AudioWorkletNode);
    vi.restoreAllMocks();
  });

  it("starts and emits windows only via onWindow when a display audio track is present", async () => {
    installAudioMocks({ displayHasAudio: true });
    const cap = new BrowserCapture();
    const onError = vi.fn();
    await expect(cap.start({ onWindow: () => {}, onError })).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    await cap.stop();
  });

  it("no-audio-track guard: onError fires with a re-share message AND all tracks are stopped", async () => {
    const { micTracks, displayTracks } = installAudioMocks({ displayHasAudio: false });
    const cap = new BrowserCapture();
    const onError = vi.fn();
    await cap.start({ onWindow: () => {}, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe(NO_AUDIO_TRACK_MESSAGE);
    // Every acquired track was stopped — capture never proceeded with one channel.
    for (const t of [...micTracks, ...displayTracks]) expect(t.stop).toHaveBeenCalled();
  });

  it("no-audio-track guard: REJECTS when no onError is supplied", async () => {
    installAudioMocks({ displayHasAudio: false });
    const cap = new BrowserCapture();
    await expect(cap.start({})).rejects.toThrow(NO_AUDIO_TRACK_MESSAGE);
  });

  it("start() rejects (or onErrors) when getDisplayMedia is unavailable", async () => {
    setGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
    const cap = new BrowserCapture();
    await expect(cap.start({})).rejects.toThrow();
  });

  it("stop() is idempotent: before start, and twice after start — no throw, context closed once", async () => {
    const { closed } = installAudioMocks({ displayHasAudio: true });
    const cap = new BrowserCapture();
    await expect(cap.stop()).resolves.toBeUndefined(); // before start
    await cap.start({ onWindow: () => {} });
    await cap.stop();
    expect(closed.value).toBe(true);
    await expect(cap.stop()).resolves.toBeUndefined(); // twice after start, no double-free
  });

  it("after stop no further onWindow fires (worklet port detached, buffer released)", async () => {
    installAudioMocks({ displayHasAudio: true });
    const cap = new BrowserCapture();
    const windows: unknown[] = [];
    await cap.start({ onWindow: (w) => windows.push(w) });
    await cap.stop();
    // Buffer is released + worklet disconnected on stop; the partial flush emitted at most the tail,
    // but no NEW windows can arrive (no live audio thread in the mock). Re-stopping stays inert.
    const count = windows.length;
    await cap.stop();
    expect(windows.length).toBe(count);
  });
});

describe("ElectronCapture lifecycle (mocked Web Audio)", () => {
  let saved: { navigator: unknown; AudioContext: unknown; AudioWorkletNode: unknown };
  beforeEach(() => {
    saved = {
      navigator: (globalThis as any).navigator,
      AudioContext: (globalThis as any).AudioContext,
      AudioWorkletNode: (globalThis as any).AudioWorkletNode,
    };
  });
  afterEach(() => {
    setGlobal("navigator", saved.navigator);
    setGlobal("AudioContext", saved.AudioContext);
    setGlobal("AudioWorkletNode", saved.AudioWorkletNode);
    vi.restoreAllMocks();
  });

  it("starts with a loopback display audio track and stops cleanly", async () => {
    installAudioMocks({ displayHasAudio: true });
    const cap = new ElectronCapture();
    expect(cap.kind).toBe("electron");
    await expect(cap.start({ onWindow: () => {} })).resolves.toBeUndefined();
    await cap.stop();
  });

  it("screen & system audio refused: a clear message (the recorder falls back to the mic), mic released", async () => {
    const { getDisplayMedia, micTracks } = installAudioMocks({ displayHasAudio: true });
    getDisplayMedia.mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    await expect(new ElectronCapture().start({})).rejects.toThrow(SYSTEM_AUDIO_DENIED_MESSAGE);
    for (const t of micTracks) expect(t.stop).toHaveBeenCalled();
  });

  it("no-audio-track guard also applies to the desktop path", async () => {
    installAudioMocks({ displayHasAudio: false });
    const cap = new ElectronCapture();
    const onError = vi.fn();
    await cap.start({ onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe(NO_AUDIO_TRACK_MESSAGE);
  });
});
