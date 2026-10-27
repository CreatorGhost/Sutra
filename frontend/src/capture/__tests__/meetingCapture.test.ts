// F6 — meeting capture controller tests. Drive the REAL MeetingController against a mocked
// CaptureProvider + api (no DOM, no Web Audio, no DB) to prove: start wiring, window→ingest as a
// 2-channel WAV tagged multichannel, in-flight accounting, the stop flow that mirrors Capture.tsx,
// and the no-audio / stream-ended / permission error UX. A separate block runs a CaptureWindow all the
// way through the REAL ingest path (mocked provider returning channel-tagged segments) to confirm the
// F4 channel-attribution is reached — and that single-channel still passes through unchanged.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MeetingController,
  STREAM_ENDED_MESSAGE,
  type MeetingApi,
} from "../meetingCapture";
import { NO_AUDIO_TRACK_MESSAGE } from "../stereoCore";
import type { CaptureProvider, CaptureStartOptions, CaptureWindow } from "../CaptureProvider";
import { WAV_HEADER_BYTES } from "../wav";

function makeWindow(index = 0, frames = 4): CaptureWindow {
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i;
  return { pcm, sampleRate: 48000, channels: 2, index };
}

/** A controllable fake provider that records the options Start was called with. */
function makeProvider() {
  let startOpts: CaptureStartOptions | undefined;
  const startCalls: CaptureStartOptions[] = [];
  const provider: CaptureProvider = {
    kind: "browser",
    start: vi.fn(async (opts?: CaptureStartOptions) => { startOpts = opts; if (opts) startCalls.push(opts); }),
    stop: vi.fn(async () => {}),
  };
  return {
    provider,
    get opts() { return startOpts; },
    startCalls,
    emitWindow: (w: CaptureWindow) => startOpts?.onWindow?.(w),
    emitError: (e: Error) => startOpts?.onError?.(e),
  };
}

function makeApi(overrides: Partial<MeetingApi> = {}): MeetingApi & {
  ingestArgs: any[][];
} {
  const ingestArgs: any[][] = [];
  return {
    ingestArgs,
    createSession: vi.fn(async () => ({ id: 42 })),
    ingestWindow: vi.fn(async (...args: any[]) => { ingestArgs.push(args); return { turns: [{ id: 1 }] }; }),
    closeSession: vi.fn(async () => ({})),
    processSession: vi.fn(async () => ({ failed: 0 })),
    ...overrides,
  } as any;
}

describe("MeetingController — start wiring", () => {
  it("creates a session, then starts the provider ONCE with the wired options", async () => {
    const p = makeProvider();
    const api = makeApi();
    const ctrl = new MeetingController({
      provider: p.provider, api, micDeviceId: "mic-7", output: "speakers",
    });
    await ctrl.start();

    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(p.provider.start).toHaveBeenCalledTimes(1);
    expect(p.opts?.micDeviceId).toBe("mic-7");
    expect(p.opts?.output).toBe("speakers");
    expect(typeof p.opts?.onWindow).toBe("function");
    expect(typeof p.opts?.onError).toBe("function");
    // createSession happened before provider.start.
    expect((api.createSession as any).mock.invocationCallOrder[0])
      .toBeLessThan((p.provider.start as any).mock.invocationCallOrder[0]);
  });
});

/** One second of a 440 Hz tone on the chosen channels (silence elsewhere), interleaved stereo. */
function voicedWindow(index: number, channels: (0 | 1)[], seconds = 1): CaptureWindow {
  const frames = 48000 * seconds;
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 8000);
    for (const c of channels) pcm[i * 2 + c] = v;
  }
  return { pcm, sampleRate: 48000, channels: 2, index };
}

describe("MeetingController — window → per-channel ingest (split, default)", () => {
  it("transcribes each voiced channel as a mono 16 kHz WAV tagged with its channel", async () => {
    const p = makeProvider();
    const api = makeApi();
    const inflight: number[] = [];
    const windows: number[] = [];
    const ctrl = new MeetingController({
      provider: p.provider, api,
      onInflight: (n) => inflight.push(n), onWindows: (n) => windows.push(n),
    });
    await ctrl.start();

    p.emitWindow(voicedWindow(3, [0, 1]));
    expect(inflight.at(-1)).toBe(2); // one upload per channel, bumped synchronously
    expect(windows.at(-1)).toBe(1);

    await vi.waitFor(() => expect(api.ingestWindow).toHaveBeenCalledTimes(2));
    const byChannel = Object.fromEntries(api.ingestArgs.map((a) => [a[5].channel, a]));
    for (const ch of [0, 1]) {
      const [sid, blob, index, filename, startMs] = byChannel[ch];
      expect(sid).toBe(42);
      expect((blob as Blob).type).toBe("audio/wav");
      expect((blob as Blob).size).toBe(WAV_HEADER_BYTES + 16000 * 2); // 1 s mono @16 kHz
      expect(index).toBe(3);
      expect(String(filename)).toMatch(ch === 0 ? /-me\.wav$/ : /-them\.wav$/);
      expect(typeof startMs).toBe("number");
    }
    await vi.waitFor(() => expect(inflight.at(-1)).toBe(0));
  });

  it("skips a silent channel entirely (no transcription call for it)", async () => {
    const p = makeProvider();
    const api = makeApi();
    const ctrl = new MeetingController({ provider: p.provider, api });
    await ctrl.start();
    p.emitWindow(voicedWindow(0, [1])); // only the meeting side talks
    await vi.waitFor(() => expect(api.ingestWindow).toHaveBeenCalledTimes(1));
    expect(api.ingestArgs[0][5]).toEqual({ channel: 1 });
    p.emitWindow(makeWindow(1)); // near-silence on both
    await ctrl.stop();
    expect(api.ingestWindow).toHaveBeenCalledTimes(1);
  });

  it("stamps each window with when it was SPOKEN (capture start + audio offset)", async () => {
    const p = makeProvider();
    const api = makeApi();
    const ctrl = new MeetingController({ provider: p.provider, api });
    await ctrl.start();
    p.emitWindow(voicedWindow(0, [0], 2));
    p.emitWindow(voicedWindow(1, [0], 1));
    await vi.waitFor(() => expect(api.ingestWindow).toHaveBeenCalledTimes(2));
    const [first, second] = api.ingestArgs.map((a) => a[4] as number);
    expect(second - first).toBe(2000);
  });
});

describe("MeetingController — stereo mode (provider splits channels)", () => {
  it("wraps a window into one 2-channel WAV and ingests it multichannel", async () => {
    const p = makeProvider();
    const api = makeApi();
    const ctrl = new MeetingController({ provider: p.provider, api, channelMode: "stereo" });
    await ctrl.start();
    const w = makeWindow(3, 4);
    p.emitWindow(w);
    await vi.waitFor(() => expect(api.ingestWindow).toHaveBeenCalledTimes(1));
    const [sid, blob, index, filename, , multichannel] = api.ingestArgs[0];
    expect(sid).toBe(42);
    expect((blob as Blob).size).toBe(WAV_HEADER_BYTES + w.pcm.length * 2);
    expect(index).toBe(3);
    expect(String(filename).endsWith(".wav")).toBe(true);
    expect(multichannel).toBe(true);
  });
});

describe("MeetingController — stop mirrors Capture.tsx", () => {
  it("stops the provider, drains uploads, then closes + processes the session in order", async () => {
    const p = makeProvider();
    const api = makeApi();
    const ctrl = new MeetingController({ provider: p.provider, api });
    await ctrl.start();
    p.emitWindow(voicedWindow(0, [0]));

    await ctrl.stop();

    expect(p.provider.stop).toHaveBeenCalledTimes(1);
    expect(api.ingestWindow).toHaveBeenCalledTimes(1);
    expect(api.closeSession).toHaveBeenCalledWith(42);
    expect(api.processSession).toHaveBeenCalledWith(42);
    // close before process; ingest (drained) before close.
    const close = (api.closeSession as any).mock.invocationCallOrder[0];
    const proc = (api.processSession as any).mock.invocationCallOrder[0];
    const ingest = (api.ingestWindow as any).mock.invocationCallOrder[0];
    expect(ingest).toBeLessThan(close);
    expect(close).toBeLessThan(proc);
  });

  it("asks which project before writing the notes, and passes the answer on", async () => {
    const p = makeProvider();
    const api = makeApi();
    const ctrl = new MeetingController({ provider: p.provider, api, chooseProject: async () => 7 });
    await ctrl.start();
    await ctrl.stop();
    expect(api.processSession).toHaveBeenCalledWith(42, 7);
  });

  it("asks before the last audio has finished transcribing", async () => {
    const p = makeProvider();
    const api = makeApi();
    let release!: () => void;
    (api.ingestWindow as any).mockImplementation(() => new Promise((r) => { release = () => r({ turns: [] }); }));
    const asked = vi.fn(async () => null);
    const ctrl = new MeetingController({ provider: p.provider, api, chooseProject: asked });
    await ctrl.start();
    p.emitWindow(voicedWindow(0, [0]));
    const stopping = ctrl.stop();
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    expect(api.processSession).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(api.processSession).toHaveBeenCalledWith(42, null);
  });

  it("teardown() on unmount tears down a live capture without processing", async () => {
    const p = makeProvider();
    const api = makeApi();
    const ctrl = new MeetingController({ provider: p.provider, api });
    await ctrl.start();
    ctrl.teardown();
    expect(p.provider.stop).toHaveBeenCalledTimes(1);
    expect(api.processSession).not.toHaveBeenCalled();
  });
});

describe("MeetingController — error UX", () => {
  it("NO_AUDIO_TRACK: surfaces re-share prompt, returns to idle, no dangling session / no process", async () => {
    const p = makeProvider();
    const api = makeApi();
    let error: string | null = null;
    const phases: string[] = [];
    const ctrl = new MeetingController({
      provider: p.provider, api,
      onError: (m) => { error = m; }, onPhase: (ph) => phases.push(ph),
    });
    await ctrl.start();
    p.emitError(new Error(NO_AUDIO_TRACK_MESSAGE));

    await vi.waitFor(() => expect(error).toBe(NO_AUDIO_TRACK_MESSAGE));
    expect(phases.at(-1)).toBe("idle");
    expect(api.processSession).not.toHaveBeenCalled();
    // session was discarded (closed, never processed) so nothing dangles.
    expect(api.closeSession).toHaveBeenCalledWith(42);
  });

  it("STREAM-ENDED: graceful stop + a Restart affordance (phase 'ended'); restart works", async () => {
    const p = makeProvider();
    const api = makeApi();
    const phases: string[] = [];
    const ctrl = new MeetingController({ provider: p.provider, api, onPhase: (ph) => phases.push(ph) });
    await ctrl.start();
    p.emitError(new Error(STREAM_ENDED_MESSAGE));

    await vi.waitFor(() => expect(phases.at(-1)).toBe("ended"));
    expect(p.provider.stop).toHaveBeenCalled();
    expect(api.processSession).toHaveBeenCalledWith(42); // graceful: process what we captured

    // A fresh capture can begin without a reload.
    await ctrl.start();
    expect(p.provider.start).toHaveBeenCalledTimes(2);
    expect(phases.at(-1)).toBe("capturing");
  });

  it("PERMISSION error at start: surfaces a message, returns to idle, Start re-usable", async () => {
    const p = makeProvider();
    (p.provider.start as any).mockRejectedValueOnce(
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
    );
    const api = makeApi();
    let error: string | null = null;
    const phases: string[] = [];
    const ctrl = new MeetingController({
      provider: p.provider, api, onError: (m) => { error = m; }, onPhase: (ph) => phases.push(ph),
    });
    await ctrl.start();
    expect(error).toContain("Permission denied");
    expect(phases.at(-1)).toBe("idle");
    expect(ctrl.isCapturing).toBe(false);
    // No dangling open session: the one we opened was discarded.
    expect(api.closeSession).toHaveBeenCalledWith(42);

    // Start is usable again (provider resolves this time).
    (p.provider.start as any).mockResolvedValueOnce(undefined);
    await ctrl.start();
    expect(ctrl.isCapturing).toBe(true);
  });
});

// --- F4 attribution reached through the REAL ingest path ---------------------------------------
// Mock repo (DB) + the provider module so we can call the real ingestSvc.ingestWindow with a window
// blob and confirm a channel-tagged response yields channel-attributed turns, while a single-channel
// response passes through byte-for-byte.
const insertCalls: any[] = [];
vi.mock("../../local/repo", () => ({
  __esModule: true,
  getSession: vi.fn(async () => ({ id: 42, started_at: null })),
  getSettings: vi.fn(async () => ({ transcript_lang: "verbatim" })),
  getMe: vi.fn(async () => ({ id: 9 })),
  insertTurn: vi.fn(async (row: any) => { insertCalls.push(row); return insertCalls.length; }),
}));

describe("ingestWindow — F4 channel attribution reached (meeting path)", () => {
  beforeEach(() => { insertCalls.length = 0; });

  it("multichannel response → owner (me, person 9, no voiceprint) + remote (r-prefixed, voiceprint kept)", async () => {
    const { ingestWindow } = await import("../../local/ingest");
    const provider: any = {
      id: "cloud",
      transcribeDiarize: vi.fn(async () => ({
        duration: 1, text: "", segments: [
          { speaker: "0", channel: 0, is_me: true, start: 0, end: 1, text: "hi", embedding: [0.1, 0.2] },
          { speaker: "A", channel: 1, start: 1, end: 2, text: "hello", embedding: [0.3, 0.4] },
        ],
      })),
      translate: vi.fn(),
    };
    const blob = new Blob([new Uint8Array(WAV_HEADER_BYTES)], { type: "audio/wav" });
    await ingestWindow(42, blob, 0, provider, "window-0.wav", Date.now(), true);

    // provider asked for multichannel diarization.
    expect(provider.transcribeDiarize.mock.calls[0][2].multichannel).toBe(true);
    // owner row.
    expect(insertCalls[0].session_speaker_label).toBe("me");
    expect(insertCalls[0].person_id).toBe(9);
    expect(insertCalls[0].voiceprint).toBe(null);
    // remote row.
    expect(insertCalls[1].session_speaker_label).toBe("rA");
    expect(insertCalls[1].person_id).toBe(null);
    expect(insertCalls[1].voiceprint).toEqual([0.3, 0.4]);
  });

  it("single-channel response (no multichannel arg) passes through unchanged + sends NO multichannel opt", async () => {
    const { ingestWindow } = await import("../../local/ingest");
    const provider: any = {
      id: "cloud",
      transcribeDiarize: vi.fn(async () => ({
        duration: 1, text: "", segments: [
          { speaker: "A", start: 0, end: 1, text: "hey", embedding: [0.5] },
        ],
      })),
      translate: vi.fn(),
    };
    const blob = new Blob([new Uint8Array(8)], { type: "audio/webm" });
    await ingestWindow(42, blob, 0, provider, "window-0.webm", Date.now());

    expect(provider.transcribeDiarize.mock.calls[0][2].multichannel).toBeUndefined();
    expect(insertCalls[0].session_speaker_label).toBe("A");
    expect(insertCalls[0].person_id).toBe(null);
    expect(insertCalls[0].voiceprint).toEqual([0.5]);
  });
});
