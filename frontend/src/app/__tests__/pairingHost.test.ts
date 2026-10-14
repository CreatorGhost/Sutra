import { describe, expect, it, vi } from "vitest";
import { mixToMono, resample, speechWav, toInt16, toSpeechWav } from "../pairing/audioDecode";
import { aiCall, hostInfo, runHostRequest, type HostDeps } from "../pairing/hostDispatch";
import type { ExecMessage } from "../../shared/pairing/hostApi";
import type { AgentStatus } from "../../shared/agentProtocol";
import { DEFAULT_SPEECH_MODEL } from "../../shared/speechModels";

describe("phone audio → speech WAV", () => {
  it("mixes channels to mono", () => {
    expect([...mixToMono([new Float32Array([1, 0.5, 0]), new Float32Array([0, 0.5, 1, 9])])]).toEqual([0.5, 0.5, 0.5]);
    const one = new Float32Array([0.1]);
    expect(mixToMono([one])).toBe(one);
  });

  it("downsamples by averaging each span, upsamples by interpolating", () => {
    // 48 kHz → 16 kHz: every 3 samples become their mean.
    expect([...resample(new Float32Array([0, 0.3, 0.6, 0.9, 0.9, 0.9]), 48000, 16000)].map((v) => +v.toFixed(3))).toEqual([0.3, 0.9]);
    // 44.1 kHz (non-integer ratio) keeps the duration: 1 s in, 1 s out.
    const tone = new Float32Array(44100).fill(0.25);
    const down = resample(tone, 44100, 16000);
    expect(down.length).toBe(16000);
    expect(Math.max(...down.map((v) => Math.abs(v - 0.25)))).toBeLessThan(1e-6);
    // 8 kHz → 16 kHz: halfway samples are interpolated.
    expect([...resample(new Float32Array([0, 1, 0]), 8000, 16000)]).toEqual([0, 0.5, 1, 0.5, 0, 0]);
    const same = new Float32Array([1]);
    expect(resample(same, 16000, 16000)).toBe(same);
  });

  it("converts to clipped 16-bit PCM", () => {
    expect([...toInt16(new Float32Array([0, 1, -1, 2, -3, 0.5]))]).toEqual([0, 32767, -32767, 32767, -32767, 16384]);
  });

  it("writes a 16 kHz mono WAV", async () => {
    const wav = speechWav({ sampleRate: 48000, channels: [new Float32Array(48000), new Float32Array(48000)] });
    expect(wav.type).toBe("audio/wav");
    const dv = new DataView(await wav.arrayBuffer());
    expect(dv.getUint16(22, true)).toBe(1);        // channels
    expect(dv.getUint32(24, true)).toBe(16000);    // sample rate
    expect(dv.getUint32(40, true)).toBe(16000 * 2); // 1 s of 16-bit samples
  });

  it("decodes through the given decoder and refuses empty audio", async () => {
    const decode = vi.fn(async () => ({ sampleRate: 16000, channels: [new Float32Array(160)] }));
    expect((await toSpeechWav(new ArrayBuffer(4), decode)).size).toBe(44 + 320);
    await expect(toSpeechWav(new ArrayBuffer(4), async () => ({ sampleRate: 16000, channels: [] }))).rejects.toThrow(/no audio/);
  });
});

const agent = (id: AgentStatus["id"], over: Partial<AgentStatus> = {}): AgentStatus => ({
  id, label: id, installed: true, path: "/x", version: "1", signedIn: true, account: null, models: ["m1", "m2"], defaultModel: "m1",
  install: "", signIn: "", hint: null, ...over,
});

function fakeDeps(settings: Record<string, unknown> = {}, over: Partial<HostDeps> = {}) {
  const calls: { engine: string | null; model: (id: any) => string | null; fn: string; args: unknown[] }[] = [];
  const deps: HostDeps = {
    settings: async () => settings,
    detect: async () => [agent("claude", { signedIn: false }), agent("codex"), agent("gemini", { installed: false })],
    speechProblem: async () => null,
    toWav: async (b) => new Blob([b], { type: "audio/wav" }),
    transcribe: async (wav, filename, opts, model) => ({ bytes: wav.size, filename, opts, model, text: "hello", translated: false }),
    textProvider: (engine, modelFor) => {
      const job = (fn: string) => async (...args: unknown[]) => { calls.push({ engine, model: modelFor, fn, args }); return { fn }; };
      return { extract: job("extract"), chat: job("chat"), translate: job("translate") as any, refine: job("refine") as any, rerank: job("rerank") as any };
    },
    importBundle: async () => ({ conversationId: 7, created: true }),
    ...over,
  };
  return { deps, calls };
}
const req = (method: string, params: unknown, blob?: ArrayBuffer): ExecMessage => ({ reqId: 1, method, params, blob, device: { id: "d1", name: "Pixel 9", platform: "android" } });

describe("host request dispatch", () => {
  it("describes engines, the active pick and speech readiness", async () => {
    const { deps } = fakeDeps({ ai_model_codex: "m2" });
    expect(await hostInfo(deps)).toEqual({
      engines: [
        { id: "claude", label: "claude", ready: false, account: null, models: ["m1", "m2"], defaultModel: "m1" },
        { id: "codex", label: "codex", ready: true, account: null, models: ["m1", "m2"], defaultModel: "m1" },
        { id: "gemini", label: "gemini", ready: false, account: null, models: ["m1", "m2"], defaultModel: "m1" },
      ],
      activeEngine: "codex", activeModel: "m2",
      speech: { ready: true, model: DEFAULT_SPEECH_MODEL, error: null },
    });
    const chosen = fakeDeps({ ai_engine: "claude", stt_model: "whisper-turbo" }, { speechProblem: async () => "Download a model first." });
    expect(await hostInfo(chosen.deps)).toMatchObject({ activeEngine: "claude", activeModel: null, speech: { ready: false, model: "whisper-turbo", error: "Download a model first." } });
  });

  it("transcribes uploaded audio with this computer's model", async () => {
    const { deps } = fakeDeps({ stt_model: "whisper-turbo", transcript_lang: "hinglish" });
    const r: any = await runHostRequest(req("stt.transcribe", { mime: "audio/webm", filename: "../w.webm", opts: { voiceprints: true } }, new ArrayBuffer(10)), deps);
    expect(r).toEqual({ bytes: 10, filename: "phone-audio.wav", opts: { language: "hinglish", voiceprints: true }, model: "whisper-turbo", text: "hello", translated: false });
    const phoneLang: any = await runHostRequest(req("stt.transcribe", { opts: { language: "english", voiceprints: false } }, new ArrayBuffer(1)), deps);
    expect(phoneLang.opts).toEqual({ language: "english", voiceprints: false });
    await expect(runHostRequest(req("stt.transcribe", {}), deps)).rejects.toThrow(/No audio/);
    const notReady = fakeDeps({}, { speechProblem: async () => "Download a transcription model first." });
    await expect(runHostRequest(req("stt.transcribe", {}, new ArrayBuffer(1)), notReady.deps)).rejects.toThrow("On your Mac: Download a transcription model first.");
  });

  it("runs AI jobs on the Mac's engine, or the one the phone asks for", async () => {
    const { deps, calls } = fakeDeps({ ai_engine: "claude", ai_model_claude: "opus", ai_model_codex: "m1" });
    await aiCall({ fn: "chat", args: [{}, "sys", "user"] }, deps);
    expect(calls[0]).toMatchObject({ engine: "claude", fn: "chat", args: [{}, "sys", "user"] });
    expect(calls[0].model("claude")).toBe("opus");
    await aiCall({ fn: "refine", args: [["a"], null], engine: "codex", model: "m2" }, deps);
    expect(calls[1]).toMatchObject({ engine: "codex", fn: "refine", args: [["a"]] });
    expect(calls[1].model("codex")).toBe("m2");          // the requested model…
    expect(calls[1].model("claude")).toBe("opus");       // …only for the requested engine
    await aiCall({ fn: "translate", args: [["x"]], engine: null, model: "m9" }, deps);
    expect(calls[2].engine).toBe("claude");
    expect(calls[2].model("claude")).toBe("opus");       // a model without an engine is ignored
    const auto = fakeDeps({});
    await aiCall({ fn: "rerank", args: ["q", ["d"]] }, auto.deps);
    expect(auto.calls[0].engine).toBeNull();             // automatic
  });

  it("rejects unknown jobs and malformed arguments", async () => {
    const { deps, calls } = fakeDeps();
    await expect(aiCall({ fn: "embed", args: [["x"]] }, deps)).rejects.toThrow(/doesn't know that AI job/);
    await expect(aiCall({ fn: "constructor", args: [] }, deps)).rejects.toThrow(/doesn't know/);
    await expect(aiCall({ fn: "chat", args: ["not a schema", "s", "u"] }, deps)).rejects.toThrow(/didn't make sense/);
    await expect(aiCall({ fn: "translate", args: [[1, 2]] }, deps)).rejects.toThrow(/didn't make sense/);
    await expect(aiCall({ fn: "refine", args: "x" }, deps)).rejects.toThrow(/didn't make sense/);
    await expect(aiCall({ fn: "chat", args: [{}, "s", "u"], model: "--evil", engine: "nope" }, deps)).resolves.toBeTruthy();
    expect(calls[0].model("claude")).toBeNull();
    await expect(runHostRequest(req("blob.put", {}), deps)).rejects.toThrow(/doesn't know that request/);
  });

  it("saves meetings under the paired phone's own name", async () => {
    const importBundle = vi.fn(async () => ({ conversationId: 3, created: false }));
    const { deps } = fakeDeps({}, { importBundle });
    expect(await runHostRequest(req("meetings.put", { bundle: { v: 1, uid: "u", origin: { deviceName: "Spoofed" } } }), deps)).toEqual({ conversationId: 3, created: false });
    expect(importBundle).toHaveBeenCalledWith({ v: 1, uid: "u", origin: { deviceName: "Pixel 9", platform: "android" } });
  });
});
