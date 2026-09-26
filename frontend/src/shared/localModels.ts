// Local (on-device) speech-to-text: the model catalog and whisper.cpp output parsing. PURE — shared by
// the Electron main process (download + run) and the renderer (model picker).
//
// Engine: whisper.cpp's `whisper-cli` (Metal on Apple Silicon, CUDA/Vulkan/CPU elsewhere). Models are
// the official ggml conversions hosted at huggingface.co/ggerganov/whisper.cpp. Audio is written to a
// private temp file only for the duration of one call, then deleted (whisper-cli reads files).

export interface WhisperModel {
  id: string;
  file: string;
  label: string;
  /** Download size in MB (approximate). */
  sizeMB: number;
  /** Rough RAM needed while transcribing, in GB. */
  ramGB: number;
  multilingual: boolean;
  speed: 1 | 2 | 3 | 4 | 5;
  accuracy: 1 | 2 | 3 | 4 | 5;
  note: string;
  recommended?: boolean;
}

export const WHISPER_MODELS: WhisperModel[] = [
  { id: "large-v3-turbo-q5_0", file: "ggml-large-v3-turbo-q5_0.bin", label: "Large v3 Turbo (quantized)", sizeMB: 574, ramGB: 1.5, multilingual: true, speed: 4, accuracy: 4,
    note: "Best balance on a Mac. Near large-v3 accuracy incl. Hindi/Hinglish, ~6× faster.", recommended: true },
  { id: "large-v3-turbo", file: "ggml-large-v3-turbo.bin", label: "Large v3 Turbo", sizeMB: 1620, ramGB: 2.5, multilingual: true, speed: 4, accuracy: 4,
    note: "Full-precision Turbo. Slightly better than the quantized build, 3× the download." },
  { id: "large-v3-q5_0", file: "ggml-large-v3-q5_0.bin", label: "Large v3 (quantized)", sizeMB: 1080, ramGB: 2.5, multilingual: true, speed: 2, accuracy: 5,
    note: "Most accurate multilingual model, quantized. Slower; best for accents and code-switching." },
  { id: "large-v3", file: "ggml-large-v3.bin", label: "Large v3", sizeMB: 3100, ramGB: 4.5, multilingual: true, speed: 1, accuracy: 5,
    note: "Reference accuracy. Needs a fast Mac (M-series Pro/Max) to keep up with long meetings." },
  { id: "medium", file: "ggml-medium.bin", label: "Medium", sizeMB: 1530, ramGB: 2.5, multilingual: true, speed: 3, accuracy: 3,
    note: "Older mid-size model. Turbo is better and faster — kept for compatibility." },
  { id: "small", file: "ggml-small.bin", label: "Small", sizeMB: 488, ramGB: 1, multilingual: true, speed: 5, accuracy: 2,
    note: "Fast on any machine. Fine for clear English; weaker on Hinglish and noisy calls." },
  { id: "base.en", file: "ggml-base.en.bin", label: "Base (English only)", sizeMB: 148, ramGB: 0.5, multilingual: false, speed: 5, accuracy: 1,
    note: "Tiny and instant. English-only; for testing or very old hardware." },
];

export const DEFAULT_WHISPER_MODEL = "large-v3-turbo-q5_0";
export const whisperModelUrl = (m: WhisperModel) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`;
export const findWhisperModel = (id: string | null | undefined) => WHISPER_MODELS.find((m) => m.id === id) ?? null;

/** Transcript-language choice (Settings) → whisper-cli language flags. Whisper's --prompt is "previous
 *  text", not an instruction, so it gets a short sample in the wanted style rather than directions. */
export function whisperLanguageArgs(lang: string | null | undefined): { language: string; translate: boolean; prompt?: string } {
  switch (lang) {
    case "english": return { language: "auto", translate: true };
    case "hinglish": return { language: "auto", translate: false, prompt: "Haan, theek hai. Kal meeting mein baat karte hain, phir deploy karenge." };
    case "devanagari": return { language: "hi", translate: false, prompt: "हाँ, ठीक है। कल meeting में बात करते हैं, फिर deploy करेंगे।" };
    default: return { language: "auto", translate: false };
  }
}

/** Build whisper-cli arguments. `outPrefix` gets ".json" appended by whisper-cli (-oj -of). */
export function whisperArgs(o: { modelPath: string; wavPath: string; outPrefix: string; language: string; translate: boolean; prompt?: string; threads: number }): string[] {
  const args = ["-m", o.modelPath, "-f", o.wavPath, "-oj", "-of", o.outPrefix, "-np", "-t", String(o.threads), "-l", o.language];
  if (o.translate) args.push("-tr");
  if (o.prompt) args.push("--prompt", o.prompt);
  return args;
}

export interface LocalSegment { start: number; end: number; text: string }

/** Whisper's classic hallucinations on silence / music — never worth a transcript line. */
const NOISE = /^\s*[[(]?\s*(blank_audio|music|silence|no speech|inaudible|applause|laughter|sound|noise)\s*[\])]?\s*\.?\s*$/i;

/** Parse whisper-cli's `-oj` JSON ({ transcription: [{ offsets: {from,to} (ms), text }] }). */
export function parseWhisperJson(raw: unknown): { text: string; duration: number; segments: LocalSegment[] } {
  const j = typeof raw === "string" ? JSON.parse(raw) : (raw as any);
  const segs: LocalSegment[] = [];
  for (const s of Array.isArray(j?.transcription) ? j.transcription : []) {
    const text = String(s?.text ?? "").trim();
    if (!text || NOISE.test(text)) continue;
    const from = Number(s?.offsets?.from ?? 0) / 1000;
    const to = Number(s?.offsets?.to ?? from * 1000) / 1000;
    // Merge whisper's sentence fragments that continue mid-sentence into the previous segment.
    const prev = segs[segs.length - 1];
    if (prev && !/[.!?।…]$/.test(prev.text) && from - prev.end < 0.8 && prev.text.length < 400) {
      prev.text = `${prev.text} ${text}`;
      prev.end = to;
    } else {
      segs.push({ start: from, end: to, text });
    }
  }
  return { text: segs.map((s) => s.text).join(" "), duration: segs.length ? segs[segs.length - 1].end : 0, segments: segs };
}
