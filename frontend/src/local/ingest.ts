import type { Provider } from "../providers/provider";
import { LANGS, type Lang } from "../providers";
import * as repo from "./repo";
import { detectLang } from "./util";

/** Diarize a window and persist turns. The audio Blob is used in-flight only and never stored.
 *  P2: speaker identity = the per-call diarization label; cross-session identity comes from manual
 *  "this is me" labeling (auto ECAPA voiceprint is Phase 3). */
export async function ingestWindow(sessionId: number, blob: Blob, windowIndex: number, provider: Provider, filename?: string) {
  const sess = await repo.getSession(sessionId);
  if (!sess) throw new Error("session not found");
  // Honor the user's transcription-language choice (onboarding/Settings → transcript_lang setting).
  // This is what makes Hinglish real: hinglish/devanagari/verbatim transcribe IN-LANGUAGE (no
  // translation); only "english" translates. Default to "english" when unset (legacy behavior).
  const transcriptLang = (((await repo.getSettings())?.transcript_lang as Lang) || "english");
  const langCfg = LANGS[transcriptLang] ?? LANGS.english;
  // Speaker-ID is a HYBRID feature: only the cloud provider has the proxy voiceprint endpoint. In
  // on-device mode (provider.id !== "cloud") we don't request voiceprints — speaker-ID is "coming soon".
  const wantVoiceprints = provider.id === "cloud";
  // Use the caller-derived filename (correct extension for the actual codec — Android WebView
  // records MP4, not webm). Fall back to a webm name only if none was provided.
  const tr = await provider.transcribeDiarize(blob, filename ?? `window-${windowIndex}.webm`,
    { prompt: langCfg.prompt, translate: langCfg.translate, voiceprints: wantVoiceprints });
  const started: string | null = sess.started_at ?? null;
  const turns: any[] = [];
  for (const s of tr.segments) {
    const lang = detectLang(s.text);
    let absStart: string | null = null;
    if (started) {
      const base = Date.parse(started.includes("T") ? started : started.replace(" ", "T") + "Z");
      if (!Number.isNaN(base)) absStart = new Date(base + s.start * 1000).toISOString();
    }
    const id = await repo.insertTurn({
      session_id: sessionId, window_index: windowIndex, session_speaker_label: s.speaker,
      text: s.text, lang, start_ts: s.start, end_ts: s.end, abs_start: absStart,
      voiceprint: s.embedding ?? null, // per-turn ECAPA vector (hybrid only); null when short/on-device
    });
    turns.push({ id, session_speaker_label: s.speaker, person_id: null, person_name: null, text: s.text, lang, start_ts: s.start });
  }
  return { session_id: sessionId, window_index: windowIndex, duration: tr.duration, turns };
}
