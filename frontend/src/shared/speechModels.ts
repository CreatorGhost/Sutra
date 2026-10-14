// On-device speech: the model catalog, the per-machine recommendation and how the transcript-language
// setting maps onto a model. PURE — shared by the Electron main process (download + run) and the
// renderer (model picker). Desktop transcription and speaker separation run 100% locally.
//
// Runtime: sherpa-onnx (npm `sherpa-onnx-node`, prebuilt N-API binaries for macOS arm64/x64, Windows
// x64 and Linux — nothing for the user to install). It runs every "sherpa" model below plus voice
// activity detection, speaker diarization and speaker embeddings. whisper.cpp's `whisper-cli` is an
// OPTIONAL second engine, only offered when the user already has it (ggml models, incl. a native
// Roman-Hinglish fine-tune).
import { WHISPER_MODELS, type WhisperModel } from "./localModels";
import type { SherpaFamily } from "./speechAlign";

export type SpeechEngine = "sherpa" | "whisper-cpp";
export type ModelGroup = "hindi" | "english" | "advanced" | "whisper-cpp";

export interface SpeechAsset {
  url: string;
  /** "file" is saved as-is under `file`; "tar.bz2" is extracted into the model folder. */
  kind: "file" | "tar.bz2";
  file: string;
  /** Approximate download size in MB (progress uses the server's Content-Length when it sends one). */
  sizeMB: number;
  /** Optional integrity pin; checked when present. */
  sha256?: string;
}

export interface SpeechModel {
  id: string;
  label: string;
  engine: SpeechEngine;
  /** sherpa runtime config family, or "ggml" for whisper-cli models. */
  family: SherpaFamily | "ggml";
  assets: SpeechAsset[];
  sizeMB: number;
  /** Rough RAM needed while transcribing, in GB. */
  ramGB: number;
  /** Understands Hindi (and Hindi-English code-switching). */
  hindi: boolean;
  /** Languages beyond English, for the note ("25 European languages"). */
  languages: string;
  /** FLEURS Hindi word error rate (%), where published — lower is better. */
  hindiWer?: number;
  speed: 1 | 2 | 3 | 4 | 5;
  accuracy: 1 | 2 | 3 | 4 | 5;
  license: string;
  note: string;
  group: ModelGroup;
  /** Writes Hindi in Roman letters natively (no transliteration needed). */
  romanNative?: boolean;
  /** False when the exact download URL could not be checked when this catalog was written. */
  verified: boolean;
}

const SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download";
const asr = (file: string, sizeMB: number): SpeechAsset => ({ url: `${SHERPA}/asr-models/${file}`, kind: "tar.bz2", file, sizeMB });

/** Voice activity + speaker separation, shared by every model. Downloaded automatically with the first
 *  transcription model (sherpa models also need its voice-activity detector to cut audio into phrases). */
export const SPEAKER_PACK_ID = "speakers";
export const SPEAKER_PACK: SpeechModel = {
  id: SPEAKER_PACK_ID, label: "Speaker separation", engine: "sherpa", family: "speakers", group: "advanced",
  assets: [
    { url: `${SHERPA}/asr-models/silero_vad.onnx`, kind: "file", file: "silero_vad.onnx", sizeMB: 2 },
    { url: `${SHERPA}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`, kind: "tar.bz2", file: "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", sizeMB: 6 },
    // Same embedding model as sherpa-onnx's own diarization example. Its vectors become per-turn voiceprints.
    { url: `${SHERPA}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`, kind: "file", file: "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx", sizeMB: 38 },
  ],
  sizeMB: 46, ramGB: 0.3, hindi: true, languages: "any", speed: 5, accuracy: 3, license: "MIT / Apache-2.0",
  note: "Tells the other people on a call apart and learns voices you name.", verified: false,
};

// Archive names verified against the sherpa-onnx `asr-models` release listing; sizes are estimates.
const SHERPA_MODELS: SpeechModel[] = [
  { id: "qwen3-asr-0.6b", label: "Qwen3-ASR 0.6B", engine: "sherpa", family: "qwen3-asr", group: "hindi",
    assets: [asr("sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2", 900)], sizeMB: 900, ramGB: 1.5,
    hindi: true, languages: "Hindi, English + 28 more", hindiWer: 12.7, speed: 4, accuracy: 4, license: "Apache-2.0",
    note: "Best Hindi and Hinglish accuracy that runs comfortably on most laptops.", verified: true },
  { id: "whisper-turbo", label: "Whisper Large v3 Turbo", engine: "sherpa", family: "whisper", group: "hindi",
    assets: [asr("sherpa-onnx-whisper-turbo.tar.bz2", 1100)], sizeMB: 1100, ramGB: 2.5,
    hindi: true, languages: "99 languages", hindiWer: 18.9, speed: 3, accuracy: 3, license: "MIT",
    note: "Widely used multilingual model. Can write English directly from Hindi speech.", verified: true },
  { id: "whisper-small", label: "Whisper Small", engine: "sherpa", family: "whisper", group: "hindi",
    assets: [asr("sherpa-onnx-whisper-small.tar.bz2", 400)], sizeMB: 400, ramGB: 1,
    hindi: true, languages: "99 languages", speed: 5, accuracy: 2, license: "MIT",
    note: "Light enough for older or 4 GB machines. Weaker on fast Hinglish.", verified: true },
  { id: "parakeet-v2", label: "Parakeet TDT 0.6B v2", engine: "sherpa", family: "transducer", group: "english",
    assets: [asr("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2", 630)], sizeMB: 630, ramGB: 1.5,
    hindi: false, languages: "English", speed: 5, accuracy: 5, license: "CC-BY-4.0",
    note: "Fastest and most accurate for English-only meetings. No Hindi.", verified: true },
  { id: "parakeet-v3", label: "Parakeet TDT 0.6B v3", engine: "sherpa", family: "transducer", group: "english",
    assets: [asr("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2", 640)], sizeMB: 640, ramGB: 1.5,
    hindi: false, languages: "25 European languages", speed: 5, accuracy: 4, license: "CC-BY-4.0",
    note: "English and European languages, very fast. No Hindi.", verified: true },
  { id: "whisper-large-v3", label: "Whisper Large v3", engine: "sherpa", family: "whisper", group: "advanced",
    assets: [asr("sherpa-onnx-whisper-large-v3.tar.bz2", 3000)], sizeMB: 3000, ramGB: 4.5,
    hindi: true, languages: "99 languages", speed: 1, accuracy: 4, license: "MIT",
    note: "Full-size Whisper. Slow on a CPU; for accents Turbo struggles with.", verified: true },
  { id: "whisper-medium", label: "Whisper Medium", engine: "sherpa", family: "whisper", group: "advanced",
    assets: [asr("sherpa-onnx-whisper-medium.tar.bz2", 1000)], sizeMB: 1000, ramGB: 2.5,
    hindi: true, languages: "99 languages", speed: 2, accuracy: 3, license: "MIT",
    note: "Older mid-size model. Turbo is faster and usually better.", verified: true },
  { id: "omnilingual-300m", label: "Omnilingual ASR 300M", engine: "sherpa", family: "omnilingual", group: "advanced",
    assets: [asr("sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05.tar.bz2", 380)], sizeMB: 380, ramGB: 1,
    hindi: true, languages: "1,600 languages", speed: 5, accuracy: 2, license: "Apache-2.0",
    note: "Meta's 1,600-language model. For regional languages the others don't cover.", verified: true },
];

/** whisper.cpp (ggml) models — only offered when `whisper-cli` is installed. */
const ggml = (m: WhisperModel): SpeechModel => ({
  id: m.id, label: m.label, engine: "whisper-cpp", family: "ggml", group: "whisper-cpp",
  assets: [{ url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`, kind: "file", file: m.file, sizeMB: m.sizeMB }],
  sizeMB: m.sizeMB, ramGB: m.ramGB, hindi: m.multilingual, languages: m.multilingual ? "99 languages" : "English",
  speed: m.speed, accuracy: m.accuracy, license: "MIT", note: m.note, verified: true,
});
const WHISPER_CPP_MODELS: SpeechModel[] = [
  // Oriserve Whisper-Hindi2Hinglish "Apex" (turbo base, Apache-2.0) converted to ggml. Writes Roman
  // Hinglish natively. The file name inside the Hugging Face repo could not be checked from here.
  { id: "hinglish-apex-ggml", label: "Hindi2Hinglish Apex", engine: "whisper-cpp", family: "ggml", group: "whisper-cpp",
    assets: [{ url: "https://huggingface.co/gouravg8/gtm-hi2hing-ggml/resolve/main/ggml-model.bin", kind: "file", file: "ggml-hi2hinglish-apex.bin", sizeMB: 1600 }],
    sizeMB: 1600, ramGB: 2.5, hindi: true, languages: "Hindi → Roman Hinglish", speed: 3, accuracy: 4, license: "Apache-2.0",
    note: "Fine-tuned to write Hinglish in Roman letters directly.", romanNative: true, verified: false },
  ...WHISPER_MODELS.map(ggml),
];

export const SPEECH_MODELS: SpeechModel[] = [...SHERPA_MODELS, ...WHISPER_CPP_MODELS];
export const DEFAULT_SPEECH_MODEL = "qwen3-asr-0.6b";
export const findSpeechModel = (id: string | null | undefined): SpeechModel | null =>
  id === SPEAKER_PACK_ID ? SPEAKER_PACK : SPEECH_MODELS.find((m) => m.id === id) ?? null;

// ---- hardware ---------------------------------------------------------------------------------------

export interface HardwareInfo {
  platform: string;
  arch: string;
  /** Apple Silicon Mac (true even when Sutra runs under Rosetta). */
  appleSilicon: boolean;
  rosetta: boolean;
  /** CPU / chip name, e.g. "Apple M2 Pro" or "Intel(R) Core(TM) i7-9750H". */
  chip: string | null;
  ramGB: number;
  cores: number;
  gpu: { vendor: "nvidia" | "other"; name: string; vramGB: number | null } | null;
}

/** "M2 · 16 GB", "Intel Mac · 16 GB", "PC · 32 GB" — the quiet label under the model list. */
export function hardwareLabel(hw: HardwareInfo): string {
  const ram = `${Math.round(hw.ramGB)} GB`;
  if (hw.platform === "darwin") {
    const m = hw.chip?.match(/\b(M\d+(?:\s+(?:Pro|Max|Ultra))?)\b/);
    return `${hw.appleSilicon ? m?.[1] ?? "Apple Silicon Mac" : "Intel Mac"} · ${ram}`;
  }
  return `${hw.platform === "win32" ? "PC" : "computer"} · ${ram}`;
}

/** The model to suggest for this machine. Every recommendation is a model that understands Hindi:
 *  Sutra's users switch between Hindi and English mid-sentence even when they want English notes.
 *  Qwen3-ASR 0.6B has the best Hindi accuracy among the bundled runtime's models and needs ~1.5 GB
 *  RAM, so it fits 8 GB Macs and ordinary Windows laptops; only very small machines drop to Whisper
 *  Small. (sherpa-onnx's npm builds run on the CPU, so a GPU does not change the pick.) */
export function recommendModel(hw: HardwareInfo | null): { id: string; reason: string } {
  if (hw && hw.ramGB > 0 && hw.ramGB < 6) {
    return { id: "whisper-small", reason: "Light enough to keep up on this computer's memory." };
  }
  return { id: DEFAULT_SPEECH_MODEL, reason: "Best Hindi and Hinglish accuracy that keeps up in real time here." };
}

/** Models listed for this machine, grouped for the picker. The recommended one is pulled out on top;
 *  whisper.cpp models appear only when `whisper-cli` is installed. */
export function groupModels(recommendedId: string, opts: { whisperCli: boolean }): { key: "recommended" | ModelGroup; models: SpeechModel[] }[] {
  const visible = SPEECH_MODELS.filter((m) => m.engine === "sherpa" || opts.whisperCli);
  const rec = visible.filter((m) => m.id === recommendedId);
  const rest = visible.filter((m) => m.id !== recommendedId);
  const groups: { key: "recommended" | ModelGroup; models: SpeechModel[] }[] = [
    { key: "recommended", models: rec },
    { key: "hindi", models: rest.filter((m) => m.group === "hindi") },
    { key: "english", models: rest.filter((m) => m.group === "english") },
    { key: "advanced", models: rest.filter((m) => m.group === "advanced") },
    { key: "whisper-cpp", models: rest.filter((m) => m.group === "whisper-cpp") },
  ];
  return groups.filter((g) => g.models.length);
}

/** Which downloads a model needs: the speaker pack first (small; sherpa ASR also needs its voice-activity
 *  detector), then the model itself. */
export function downloadPlan(id: string, installed: string[]): SpeechModel[] {
  const m = findSpeechModel(id);
  if (!m) return [];
  const plan = installed.includes(SPEAKER_PACK_ID) || id === SPEAKER_PACK_ID ? [] : [SPEAKER_PACK];
  if (!installed.includes(id)) plan.push(m);
  return plan;
}

// ---- transcript language → model settings ----------------------------------------------------------

export interface SpeechPlan {
  /** Whisper language hint ("" = auto-detect). Ignored by models without one. */
  whisperLanguage: string;
  whisperTask: "transcribe" | "translate";
  /** Run Devanagari → Roman Hinglish on the output. */
  romanize: boolean;
  /** The model already produced English, so ingest must not translate again. When false in English
   *  mode, ingest runs the text engine's translate pass instead. */
  translated: boolean;
}

/** Map the user's transcript_lang (english | hinglish | devanagari | verbatim) onto a model run. */
export function speechPlan(model: SpeechModel, lang: string | null | undefined): SpeechPlan {
  // Whisper (sherpa) and whisper.cpp both translate speech to English natively (task=translate / -tr).
  const whisper = model.family === "whisper" || model.family === "ggml";
  switch (lang) {
    case "english":
      // Whisper translates speech to English natively; every other model transcribes and the text
      // engine translates afterwards (one batched call per window).
      return { whisperLanguage: "", whisperTask: whisper ? "translate" : "transcribe", romanize: false, translated: whisper };
    case "hinglish":
      return { whisperLanguage: model.hindi ? "hi" : "", whisperTask: "transcribe", romanize: !model.romanNative, translated: false };
    case "devanagari":
      return { whisperLanguage: model.hindi ? "hi" : "", whisperTask: "transcribe", romanize: false, translated: false };
    default:
      return { whisperLanguage: "", whisperTask: "transcribe", romanize: false, translated: false };
  }
}

// ---- IPC shapes (main ↔ renderer) -------------------------------------------------------------------

export interface SpeechProgress {
  /** The model the user asked for. */
  id: string;
  /** What is downloading right now (the model, or the speaker pack it pulls in). */
  item?: string;
  phase?: "download" | "extract";
  received: number;
  total: number;
  done?: boolean;
  error?: string;
}

export interface SpeechStatus {
  /** Whether the bundled speech runtime has a native build for this computer. */
  runtime: { ok: boolean; error: string | null };
  hardware: HardwareInfo;
  installed: string[];
  downloading: SpeechProgress | null;
  /** Path of whisper.cpp's CLI when installed (optional engine). */
  whisperCli: string | null;
  /** Disk used by downloaded models, in MB. */
  diskMB: number;
}

export interface SpeechTranscribeOpts {
  model: string;
  /** transcript_lang */
  language?: string | null;
  /** Separate speakers (diarize) and return a voiceprint per segment. Off for the owner's mic channel. */
  speakers?: boolean;
}

export interface LocalSpeechSegment { start: number; end: number; text: string; speaker: string; embedding: number[] | null }
export interface LocalTranscription { text: string; duration: number; segments: LocalSpeechSegment[]; translated: boolean }
