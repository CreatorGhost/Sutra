import type { Provider } from "./provider";
import { CloudProvider } from "./cloudProvider";
import { OnDeviceProvider } from "./ondeviceProvider";
import { AgentProvider } from "./agentProvider";
import { ComposedProvider, LocalWhisperProvider } from "./localSttProvider";
import { desktop } from "../desktop/bridge";
import { DEFAULT_WHISPER_MODEL } from "../shared/localModels";
import { safeModel, type AgentId } from "../shared/agentProtocol";

const PROXY_BASE =
  (import.meta as any).env?.VITE_PROXY_URL || "http://localhost:8787";

export type Mode = "hybrid" | "ondevice";

// UI copy — the two audio promises must NEVER be blurred (per product decision).
export const MODE_COPY: Record<Mode, { label: string; audio: string }> = {
  hybrid: { label: "Hybrid", audio: "Audio is processed in the cloud and never stored." },
  ondevice: { label: "On-device", audio: "Audio never leaves your device." },
};

export type Lang = "english" | "hinglish" | "devanagari" | "verbatim";

/** Transcription language modes — user picks one in onboarding (switchable in Settings).
 *  `prompt` primes transcription; `translate` runs a second English-translation pass. */
export const LANGS: Record<Lang, { label: string; desc: string; example: string; prompt: string; translate: boolean }> = {
  english: {
    label: "English",
    desc: "Everything in clean English — Hindi is auto-translated for you.",
    example: "“chalo kal kaam karte hain” → “let's work tomorrow”",
    // English mode is the ONLY mode that translates. (Previously this prompt only romanized, so the
    // translate flag did nothing — fixed so the choice is honest.)
    prompt: "This is a Hindi-English (Hinglish) conversation. Output EVERYTHING in clear, natural English — translate any Hindi/Hinglish speech to English (e.g. 'chalo kal kaam karte hain' -> 'let's work tomorrow'). Keep proper nouns and names as spoken; do NOT output Devanagari or romanized Hindi.",
    translate: true,
  },
  hinglish: {
    label: "Hinglish",
    desc: "Hindi written in English letters (Roman) — easy to read & edit.",
    example: "“chalo kal kaam karte hain”",
    prompt: "This is a casual Hindi-English (Hinglish) conversation. Transcribe in the Latin/Roman alphabet — write Hindi words romanized in English spelling (e.g. 'chalo kal kaam karte hain'), NOT in Devanagari. Keep English words in English.",
    translate: false,
  },
  devanagari: {
    label: "Hindi (Devanagari)",
    desc: "Hindi in its native script, English in English.",
    example: "“चलो कल काम करते हैं”",
    prompt: "This is a Hindi-English conversation. Write Hindi in Devanagari script and English in the Latin alphabet, preserving the original code-switching.",
    translate: false,
  },
  verbatim: {
    label: "Verbatim",
    desc: "Exactly as spoken — no translation or clean-up.",
    example: "Mixed Hindi & English, as-is",
    prompt: "",
    translate: false,
  },
};

let _cloud: Provider | null = null;
let _ondevice: Provider | null = null;

/** Hybrid is the DEFAULT: transcribe (audio in-flight) + extract/chat/embed via cloud for max Hinglish
 *  accuracy. On-device is the user-selectable fallback (no network / budget device), labelled lower-accuracy. */
export function getProvider(mode: Mode = "hybrid"): Provider {
  if (mode === "ondevice") return (_ondevice ??= new OnDeviceProvider());
  return (_cloud ??= new CloudProvider(PROXY_BASE));
}

/** Where each job runs, from Settings:
 *    stt_engine: "cloud" (Sutra service) | "local" (whisper.cpp on this computer, desktop only)
 *    ai_engine:  "cloud" | "claude" | "codex" | "cursor" (local agent CLIs, desktop only)
 *  Outside the desktop app both fall back to the cloud. */
export type SttEngine = "cloud" | "local";
export type AiEngine = "cloud" | AgentId;

export function engineChoice(s: Record<string, unknown>): { stt: SttEngine; ai: AiEngine; sttModel: string; aiModel: string | null } {
  const stt: SttEngine = desktop && s["stt_engine"] === "local" ? "local" : "cloud";
  const aiRaw = String(s["ai_engine"] ?? "cloud");
  const ai: AiEngine = desktop && (aiRaw === "claude" || aiRaw === "codex" || aiRaw === "cursor") ? aiRaw : "cloud";
  return {
    stt, ai,
    sttModel: String(s["stt_model"] || DEFAULT_WHISPER_MODEL),
    aiModel: ai === "cloud" ? null : safeModel(s[`ai_model_${ai}`]),
  };
}

const composed = new Map<string, Provider>();

export function resolveProvider(s: Record<string, unknown>): Provider {
  if (s["mode"] === "ondevice") return getProvider("ondevice");
  const c = engineChoice(s);
  if (c.stt === "cloud" && c.ai === "cloud") return getProvider("hybrid");
  const key = `${c.stt}:${c.sttModel}|${c.ai}:${c.aiModel ?? ""}`;
  let p = composed.get(key);
  if (!p) {
    const text = c.ai === "cloud" ? getProvider("hybrid") : new AgentProvider(c.ai, c.aiModel);
    const stt = c.stt === "local" ? new LocalWhisperProvider(c.sttModel) : getProvider("hybrid");
    p = new ComposedProvider(stt, text);
    composed.set(key, p);
  }
  return p;
}
