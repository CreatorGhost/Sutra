import type { Provider } from "../providers/provider";
import { LANGS, type Lang } from "../providers";
import * as repo from "./repo";
import { detectLang } from "./util";
import { attributeSegments } from "./channelAttribution";

/** Diarize a window and persist turns. The audio Blob is used in-flight only and never stored.
 *  P2: speaker identity = the per-call diarization label; cross-session identity comes from manual
 *  "this is me" labeling (auto ECAPA voiceprint is Phase 3). */
/** How a window's audio maps to speakers. `multichannel` asks the STT provider to split a stereo file
 *  itself (not every provider can); `channel` says the (mono) blob IS one known channel — 0 = the owner's
 *  mic, 1 = the meeting's system audio — which works with every provider (see MeetingController). */
export interface IngestChannelOpts { multichannel?: boolean; channel?: 0 | 1 }

export async function ingestWindow(sessionId: number, blob: Blob, windowIndex: number, provider: Provider, filename?: string, windowStartMs?: number, channelOpts?: boolean | IngestChannelOpts) {
  const opts: IngestChannelOpts = typeof channelOpts === "boolean" ? { multichannel: channelOpts } : (channelOpts ?? {});
  const requestMultichannel = !!opts.multichannel;
  const sess = await repo.getSession(sessionId);
  if (!sess) throw new Error("session not found");
  // Honor the user's transcription-language choice (onboarding/Settings → transcript_lang setting).
  // This is what makes Hinglish real: hinglish/devanagari/verbatim transcribe IN-LANGUAGE (no
  // translation); only "english" translates. Default to "english" when unset (legacy behavior).
  const transcriptLang = (((await repo.getSettings())?.transcript_lang as Lang) || "english");
  const langCfg = LANGS[transcriptLang] ?? LANGS.english;
  // Per-turn voiceprints come from the cloud proxy (hybrid) or from the desktop's local speech engine,
  // which diarizes and embeds on this computer. The phone's on-device mode has neither.
  const sttCloud = (provider.sttId ?? provider.id) === "cloud";
  const sttLocal = (provider.sttId ?? provider.id) === "local";
  const wantVoiceprints = sttCloud || sttLocal;
  // Use the caller-derived filename (correct extension for the actual codec — low-bitrate Opus in
  // an ogg container, or webm/mp4 where ogg isn't supported). Fall back only if none was provided;
  // match the fallback to the blob's own type so the extension stays consistent with the content.
  const fallbackExt = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
  // Online-meeting capture sends two-channel WAV windows and asks for per-channel diarization so the
  // owner (mic, ch0) and remotes (system, ch1) are tagged at the source (F4 attribution then applies).
  // Ambient capture leaves multichannel undefined → the opt is omitted and the request is unchanged.
  // The owner's own mic channel never needs voiceprints (it is always "Me").
  const tr = await provider.transcribeDiarize(blob, filename ?? `window-${windowIndex}.${fallbackExt}`,
    { prompt: langCfg.prompt, voiceprints: wantVoiceprints && opts.channel !== 0, multichannel: requestMultichannel || undefined, language: transcriptLang });
  // A known-channel mono window: tag every segment so attribution treats it exactly like a provider-split
  // multichannel response (channel 0 → "Me", channel 1 → remotes, diarized among themselves).
  if (opts.channel != null) for (const s of tr.segments as any[]) { s.channel = opts.channel; s.is_me = opts.channel === 0; }
  const started: string | null = sess.started_at ?? null;
  // English mode (degrade-safe): when the user picked "english" we translate segment texts to English
  // in ONE batched call (via the text engine — on-device mode has no translate endpoint). On ANY failure
  // we keep the original text so ingest never blocks. Non-English modes (hinglish/devanagari/verbatim)
  // skip this. Local Whisper models translate while transcribing and report `translated: true`; other
  // local models (Qwen3-ASR, …) keep the spoken language and report `translated: false`.
  const localUntranslated = sttLocal && (tr as { translated?: boolean }).translated === false;
  if (langCfg.translate && (sttCloud || localUntranslated) && tr.segments.length) {
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
      voiceprint: a.voiceprint, // per-turn voiceprint (cloud ECAPA or local embedding); null when short/owner/phone
    });
    turns.push({ id, window_index: windowIndex, session_speaker_label: a.session_speaker_label, person_id: a.person_id, person_name: null, text: s.text, lang, start_ts: s.start, end_ts: s.end, abs_start: absStart });
  }
  return { session_id: sessionId, window_index: windowIndex, duration: tr.duration, turns };
}
