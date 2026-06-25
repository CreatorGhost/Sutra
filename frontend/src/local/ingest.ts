import type { Provider } from "../providers/provider";
import { LANGS, type Lang } from "../providers";
import * as repo from "./repo";
import { detectLang } from "./util";
import { attributeSegments } from "./channelAttribution";

/** Diarize a window and persist turns. The audio Blob is used in-flight only and never stored.
 *  P2: speaker identity = the per-call diarization label; cross-session identity comes from manual
 *  "this is me" labeling (auto ECAPA voiceprint is Phase 3). */
export async function ingestWindow(sessionId: number, blob: Blob, windowIndex: number, provider: Provider, filename?: string, windowStartMs?: number) {
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
  // Use the caller-derived filename (correct extension for the actual codec — low-bitrate Opus in
  // an ogg container, or webm/mp4 where ogg isn't supported). Fall back only if none was provided;
  // match the fallback to the blob's own type so the extension stays consistent with the content.
  const fallbackExt = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
  const tr = await provider.transcribeDiarize(blob, filename ?? `window-${windowIndex}.${fallbackExt}`,
    { prompt: langCfg.prompt, voiceprints: wantVoiceprints });
  const started: string | null = sess.started_at ?? null;
  // English mode (degrade-safe): when the user picked "english" we translate segment texts to English
  // in ONE batched call (cloud only — on-device has no translate endpoint). On ANY failure we keep the
  // original text so ingest never blocks. Non-English modes (hinglish/devanagari/verbatim) skip this.
  if (langCfg.translate && provider.id === "cloud" && tr.segments.length) {
    try {
      const en = await provider.translate(tr.segments.map((s: any) => s.text));
      if (Array.isArray(en) && en.length === tr.segments.length) {
        tr.segments.forEach((s: any, i: number) => { if (en[i] && en[i].trim()) s.text = en[i]; });
      }
    } catch (e) { console.warn("translate pass skipped", e); }
  }
  // Channel-aware attribution (F4): multichannel (online-meeting) windows carry `channel`/`is_me` per
  // segment — channel 0 is the device owner ("Me", deterministic, no voiceprint), channel 1 the remotes
  // (voiceprint kept for ECAPA naming). Resolve the owner person row ONCE per window, and only when a
  // segment is actually channel-tagged, so the single-channel (ambient) path is identical to pre-F4.
  const multichannel = tr.segments.some((s: any) => typeof s.channel === "number" || typeof s.is_me === "boolean");
  const ownerPersonId = multichannel ? ((await repo.getMe())?.id ?? null) : null;
  const attributed = attributeSegments(tr.segments as any[], ownerPersonId);
  const turns: any[] = [];
  for (let i = 0; i < tr.segments.length; i++) {
    const s = tr.segments[i];
    const a = attributed[i];
    const lang = detectLang(s.text);
    const winBaseMs = (windowStartMs != null && Number.isFinite(windowStartMs))
      ? windowStartMs
      : (started ? Date.parse(started.includes("T") ? started : started.replace(" ", "T") + "Z") : NaN);
    let absStart: string | null = null;
    if (!Number.isNaN(winBaseMs)) absStart = new Date(winBaseMs + s.start * 1000).toISOString();
    const id = await repo.insertTurn({
      session_id: sessionId, window_index: windowIndex, session_speaker_label: a.session_speaker_label,
      person_id: a.person_id, text: s.text, lang, start_ts: s.start, end_ts: s.end, abs_start: absStart,
      voiceprint: a.voiceprint, // per-turn ECAPA vector (hybrid only); null when short/on-device/owner
    });
    turns.push({ id, window_index: windowIndex, session_speaker_label: a.session_speaker_label, person_id: a.person_id, person_name: null, text: s.text, lang, start_ts: s.start, end_ts: s.end, abs_start: absStart });
  }
  return { session_id: sessionId, window_index: windowIndex, duration: tr.duration, turns };
}
