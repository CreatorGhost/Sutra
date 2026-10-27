import { describe, it, expect } from "vitest";
import { toRomanHinglish } from "../hinglish";
import { CLOUD_VOICEPRINT_DIM, assignSpeakers, detectModelFiles, normalizeEmbedding, parseWav, resampleLinear, splitAtSpeakerChanges } from "../speechAlign";
import {
  DEFAULT_SPEECH_MODEL, SPEAKER_PACK, SPEAKER_PACK_ID, SPEECH_MODELS, downloadPlan, findSpeechModel, groupModels,
  hardwareLabel, recommendModel, speechPlan, type HardwareInfo,
} from "../speechModels";
import { WHISPER_MODELS } from "../localModels";
import { pcm16ToWav } from "../../capture/wav";

const hw = (o: Partial<HardwareInfo>): HardwareInfo => ({ platform: "darwin", arch: "arm64", appleSilicon: true, rosetta: false, chip: "Apple M2", ramGB: 16, cores: 8, gpu: null, ...o });

describe("Roman Hinglish transliteration", () => {
  it.each([
    ["कल meeting है", "kal meeting hai"],
    ["चलो कल काम करते हैं", "chalo kal kaam karte hain"],
    ["हम कल deploy करेंगे।", "ham kal deploy karenge."],
    ["ठीक है, समझना मतलब", "theek hai, samajhna matlab"],
    ["क्या बात है", "kya baat hai"],
    ["अच्छा ज़रूर", "accha zaroor"],
    ["मैं भी नहीं", "main bhi nahin"],
    ["हिंदी में बातचीत", "hindi mein baatcheet"],
    ["अपना पता करना", "apna pata karna"],
    ["ज्ञान", "gyaan"],
    ["मीटिंग १० बजे", "meeting 10 baje"],
  ])("%s → %s", (dev, roman) => {
    expect(toRomanHinglish(dev)).toBe(roman);
  });
  it("leaves Latin text untouched", () => {
    expect(toRomanHinglish("Let's ship Friday, theek hai?")).toBe("Let's ship Friday, theek hai?");
  });
});

describe("WAV decoding", () => {
  it("decodes the 16 kHz mono capture format", () => {
    const pcm = new Int16Array([0, 16384, -16384, 32767]);
    const { samples, sampleRate } = parseWav(pcm16ToWav(pcm, 16000, 1));
    expect(sampleRate).toBe(16000);
    expect(Array.from(samples)).toEqual([0, 0.5, -0.5, 32767 / 32768]);
  });
  it("mixes stereo down to mono", () => {
    const { samples } = parseWav(pcm16ToWav(new Int16Array([16384, -16384, 8192, 8192]), 16000, 2));
    expect(Array.from(samples)).toEqual([0, 0.25]);
  });
  it("rejects non-WAV input", () => {
    expect(() => parseWav(new Uint8Array(64))).toThrow(/WAV/);
  });
  it("resamples 48 kHz to 16 kHz", () => {
    expect(resampleLinear(new Float32Array(4800), 48000, 16000).length).toBe(1600);
  });
});

describe("speaker ↔ segment alignment", () => {
  const turns = [
    { start: 0, end: 4.2, speaker: 0 },
    { start: 4.4, end: 9, speaker: 1 },
    { start: 9.2, end: 12, speaker: 0 },
  ];
  it("cuts a phrase where the speaker changes", () => {
    const [a, b, ...rest] = splitAtSpeakerChanges([{ start: 0.5, end: 8 }], turns);
    expect(rest).toEqual([]);
    expect(a.start).toBe(0.5);
    expect(a.end).toBeCloseTo(4.3); // middle of the gap between the two turns
    expect(b.start).toBe(a.end);
    expect(b.end).toBe(8);
  });
  it("does not leave slivers shorter than minPiece", () => {
    expect(splitAtSpeakerChanges([{ start: 3.9, end: 8 }], turns)).toEqual([{ start: 3.9, end: 8 }]);
  });
  it("keeps phrases with one speaker whole", () => {
    expect(splitAtSpeakerChanges([{ start: 5, end: 8.5 }], turns)).toEqual([{ start: 5, end: 8.5 }]);
  });
  it("assigns the most-overlapping speaker, or the nearest one within a second", () => {
    expect(assignSpeakers([{ start: 0.5, end: 4.3 }, { start: 3.5, end: 9 }, { start: 12.5, end: 13 }, { start: 20, end: 21 }], turns))
      .toEqual([0, 1, 0, null]);
  });
});

describe("voiceprints", () => {
  it("unit-normalizes", () => {
    const v = normalizeEmbedding([3, 4])!;
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
  });
  it("never emits the cloud ECAPA dimension, so local and cloud vectors can't be compared", () => {
    expect(normalizeEmbedding(new Array(CLOUD_VOICEPRINT_DIM).fill(1))!.length).toBe(CLOUD_VOICEPRINT_DIM + 1);
    expect(normalizeEmbedding(new Array(512).fill(1))!.length).toBe(512);
  });
  it("rejects empty or silent vectors", () => {
    expect(normalizeEmbedding([])).toBeNull();
    expect(normalizeEmbedding([0, 0, 0])).toBeNull();
  });
});

describe("model file detection (sherpa-onnx archive layouts)", () => {
  it("Qwen3-ASR: conv front-end, int8 encoder/decoder, tokenizer folder", () => {
    const d = "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25";
    expect(detectModelFiles("qwen3-asr", [`${d}/conv_frontend.onnx`, `${d}/encoder.int8.onnx`, `${d}/decoder.int8.onnx`, `${d}/tokenizer/vocab.json`, `${d}/tokenizer/merges.txt`, `${d}/tokenizer/tokenizer_config.json`, `${d}/README.md`]))
      .toEqual({ convFrontend: `${d}/conv_frontend.onnx`, encoder: `${d}/encoder.int8.onnx`, decoder: `${d}/decoder.int8.onnx`, tokenizer: `${d}/tokenizer` });
  });
  it("Whisper: prefers int8 over fp32 and finds prefixed tokens", () => {
    const d = "a/sherpa-onnx-whisper-turbo";
    expect(detectModelFiles("whisper", [`${d}/turbo-encoder.onnx`, `${d}/turbo-encoder.int8.onnx`, `${d}/turbo-decoder.onnx`, `${d}/turbo-decoder.int8.onnx`, `${d}/turbo-tokens.txt`, `${d}/test_wavs/0.wav`]))
      .toEqual({ encoder: `${d}/turbo-encoder.int8.onnx`, decoder: `${d}/turbo-decoder.int8.onnx`, tokens: `${d}/turbo-tokens.txt` });
  });
  it("Parakeet transducer", () => {
    const f = ["p/encoder.int8.onnx", "p/decoder.int8.onnx", "p/joiner.int8.onnx", "p/tokens.txt"];
    expect(detectModelFiles("transducer", f)).toEqual({ encoder: f[0], decoder: f[1], joiner: f[2], tokens: f[3] });
  });
  it("speaker pack: VAD, pyannote segmentation, embedding", () => {
    const f = ["silero_vad.onnx", "sherpa-onnx-pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0/model.onnx", "sherpa-onnx-pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx", "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"];
    expect(detectModelFiles("speakers", f)).toEqual({ vad: f[0], segmentation: f[2], embedding: f[3] });
  });
  it("names the missing part", () => {
    expect(() => detectModelFiles("transducer", ["encoder.onnx", "decoder.onnx", "tokens.txt"])).toThrow(/joiner/);
  });
});

describe("speech model catalog", () => {
  it("has unique ids and the default model", () => {
    const ids = [...SPEECH_MODELS.map((m) => m.id), SPEAKER_PACK_ID];
    expect(new Set(ids).size).toBe(ids.length);
    expect(findSpeechModel(DEFAULT_SPEECH_MODEL)?.hindi).toBe(true);
    expect(findSpeechModel(SPEAKER_PACK_ID)).toBe(SPEAKER_PACK);
  });
  it("maps sherpa models to sherpa-onnx release archives", () => {
    for (const m of SPEECH_MODELS.filter((x) => x.engine === "sherpa")) {
      expect(m.assets).toHaveLength(1);
      expect(m.assets[0].kind).toBe("tar.bz2");
      expect(m.assets[0].url).toBe(`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${m.assets[0].file}`);
      expect(m.assets[0].file).toMatch(/^sherpa-onnx-[\w.-]+\.tar\.bz2$/);
    }
    expect(findSpeechModel("qwen3-asr-0.6b")!.assets[0].file).toBe("sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2");
  });
  it("keeps whisper.cpp model ids and files (existing downloads and stt_model settings stay valid)", () => {
    for (const w of WHISPER_MODELS) {
      const m = findSpeechModel(w.id)!;
      expect(m.engine).toBe("whisper-cpp");
      expect(m.assets[0]).toMatchObject({ kind: "file", file: w.file, url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${w.file}` });
    }
  });
  it("only Hindi-capable models sit in the Hindi group", () => {
    for (const m of SPEECH_MODELS.filter((x) => x.group === "hindi")) expect(m.hindi).toBe(true);
  });
  it("downloads the speaker pack before the first model, once", () => {
    expect(downloadPlan("qwen3-asr-0.6b", []).map((m) => m.id)).toEqual([SPEAKER_PACK_ID, "qwen3-asr-0.6b"]);
    expect(downloadPlan("qwen3-asr-0.6b", [SPEAKER_PACK_ID]).map((m) => m.id)).toEqual(["qwen3-asr-0.6b"]);
    expect(downloadPlan(SPEAKER_PACK_ID, []).map((m) => m.id)).toEqual([SPEAKER_PACK_ID]);
  });
});

describe("hardware tiers", () => {
  it("recommends Qwen3-ASR on ordinary Macs and PCs, Whisper Small on tiny machines", () => {
    expect(recommendModel(hw({ ramGB: 8 })).id).toBe("qwen3-asr-0.6b");
    expect(recommendModel(hw({ ramGB: 32, chip: "Apple M3 Max" })).id).toBe("qwen3-asr-0.6b");
    expect(recommendModel(hw({ platform: "win32", arch: "x64", appleSilicon: false, ramGB: 16, gpu: { vendor: "nvidia", name: "RTX 4060", vramGB: 8 } })).id).toBe("qwen3-asr-0.6b");
    expect(recommendModel(hw({ ramGB: 4 })).id).toBe("whisper-small");
    expect(recommendModel(null).id).toBe(DEFAULT_SPEECH_MODEL);
  });
  it("labels the machine quietly", () => {
    expect(hardwareLabel(hw({ chip: "Apple M2", ramGB: 16 }))).toBe("M2 · 16 GB");
    expect(hardwareLabel(hw({ chip: "Apple M3 Pro", ramGB: 36 }))).toBe("M3 Pro · 36 GB");
    expect(hardwareLabel(hw({ appleSilicon: false, arch: "x64", chip: "Intel(R) Core(TM) i7-9750H", ramGB: 16 }))).toBe("Intel Mac · 16 GB");
    expect(hardwareLabel(hw({ platform: "win32", ramGB: 31.9 }))).toBe("PC · 32 GB");
  });
  it("groups the picker: recommended on top, whisper.cpp only when installed", () => {
    const g = groupModels("qwen3-asr-0.6b", { whisperCli: false });
    expect(g[0]).toMatchObject({ key: "recommended" });
    expect(g[0].models.map((m) => m.id)).toEqual(["qwen3-asr-0.6b"]);
    expect(g.flatMap((x) => x.models).filter((m) => m.id === "qwen3-asr-0.6b")).toHaveLength(1);
    expect(g.flatMap((x) => x.models).some((m) => m.engine === "whisper-cpp")).toBe(false);
    expect(groupModels("qwen3-asr-0.6b", { whisperCli: true }).find((x) => x.key === "whisper-cpp")!.models.every((m) => m.engine === "whisper-cpp")).toBe(true);
  });
});

describe("transcript language → model run", () => {
  const qwen = findSpeechModel("qwen3-asr-0.6b")!;
  const turbo = findSpeechModel("whisper-turbo")!;
  const apex = findSpeechModel("hinglish-apex-ggml")!;
  it("Roman Hinglish: Hindi model + transliteration (unless the model writes Roman itself)", () => {
    expect(speechPlan(qwen, "hinglish")).toEqual({ whisperLanguage: "hi", whisperTask: "transcribe", romanize: true, translated: false });
    expect(speechPlan(turbo, "hinglish")).toMatchObject({ whisperLanguage: "hi", romanize: true });
    expect(speechPlan(apex, "hinglish")).toMatchObject({ romanize: false });
  });
  it("Devanagari keeps the native script", () => {
    expect(speechPlan(qwen, "devanagari")).toMatchObject({ whisperLanguage: "hi", romanize: false });
  });
  it("English: Whisper translates itself, other models leave it to the text engine", () => {
    expect(speechPlan(turbo, "english")).toMatchObject({ whisperTask: "translate", translated: true });
    expect(speechPlan(qwen, "english")).toMatchObject({ whisperTask: "transcribe", translated: false });
  });
  it("Verbatim auto-detects", () => {
    expect(speechPlan(turbo, "verbatim")).toMatchObject({ whisperLanguage: "", whisperTask: "transcribe", romanize: false });
  });
});
