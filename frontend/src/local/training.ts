// Opt-in, on-device, encrypted fine-tuning corpus. NEVER auto-uploaded. User controls view/export/wipe.
// Two consent tiers: text (extraction transcripts+outputs+edits) and audio (audio+transcript for ASR).
import { EXTRACT_SYSTEM, PROMPT_VERSION } from "./aiPrompts";
import { q, run, persist } from "./db";
import { getSettings, putSettings } from "./repo";

export const CONSENT_VERSION = "dpdp-v1";
const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));

export async function isTextOptIn() { return !!(await getSettings())["training_optin"]; }
export async function isAudioOptIn() { return !!(await getSettings())["training_audio_optin"]; }
export const setTextOptIn = (on: boolean) => putSettings({ training_optin: on, training_consent_version: CONSENT_VERSION });
export const setAudioOptIn = (on: boolean) => putSettings({ training_audio_optin: on, training_consent_version: CONSENT_VERSION });

export async function captureExtraction(p: {
  conversation_id: number; lang: string; model_id: string; transcript: string; extraction_raw: unknown;
}) {
  if (!(await isTextOptIn())) return undefined;
  const { lastId } = await run(
    `INSERT INTO training_samples(source,lang,consent_version,model_id,prompt_version,conversation_id,transcript)
     VALUES('live',?,?,?,?,?,?)`,
    [p.lang, CONSENT_VERSION, p.model_id, PROMPT_VERSION, p.conversation_id, p.transcript]);
  await run("INSERT OR REPLACE INTO training_extraction(sample_id,extraction_raw) VALUES(?,?)", [lastId, JSON.stringify(p.extraction_raw)]);
  await persist();
  return lastId;
}

export async function captureAudio(sampleId: number, asrRaw: string, diarization: unknown, audio: Uint8Array, mime: string) {
  if (!(await isAudioOptIn())) return;
  await run("INSERT OR REPLACE INTO training_asr(sample_id,asr_raw,diarization) VALUES(?,?,?)", [sampleId, asrRaw, JSON.stringify(diarization)]);
  await run("INSERT OR REPLACE INTO training_audio(sample_id,audio,mime) VALUES(?,?,?)", [sampleId, audio, mime]);
  await run("UPDATE training_samples SET has_audio=1 WHERE id=?", [sampleId]);
  await persist();
}

export async function logEdit(sampleId: number, field: string, before: string, after: string) {
  await run("INSERT INTO training_edits(sample_id,field,before,after) VALUES(?,?,?,?)", [sampleId, field, before, after]);
  if (field === "extraction") await run("UPDATE training_extraction SET extraction_corrected=? WHERE sample_id=?", [after, sampleId]);
  if (field === "transcript") await run("UPDATE training_asr SET asr_corrected=? WHERE sample_id=?", [after, sampleId]);
  await persist();
}

export async function stats() {
  const s = (await q(`SELECT count(*) n, COALESCE(sum(has_audio),0) audio FROM training_samples`))[0] as any;
  const edits = (await q(`SELECT count(*) n FROM training_edits`))[0] as any;
  return { samples: s?.n ?? 0, with_audio: s?.audio ?? 0, edits: edits?.n ?? 0 };
}

export async function exportJSONL(kind: "extraction" | "asr"): Promise<string> {
  if (kind === "extraction") {
    const rows = (await q(`SELECT s.transcript, e.extraction_raw, e.extraction_corrected FROM training_samples s JOIN training_extraction e ON e.sample_id=s.id`)) as any[];
    return rows.map((r) => JSON.stringify({ messages: [
      { role: "system", content: EXTRACT_SYSTEM },
      { role: "user", content: r.transcript },
      { role: "assistant", content: r.extraction_corrected ?? r.extraction_raw },
    ] })).join("\n");
  }
  const rows = (await q(`SELECT s.lang, a.asr_raw, a.asr_corrected, au.mime, au.audio FROM training_samples s JOIN training_asr a ON a.sample_id=s.id JOIN training_audio au ON au.sample_id=s.id`)) as any[];
  return rows.map((r) => JSON.stringify({
    audio_base64: b64(r.audio instanceof Uint8Array ? r.audio : new Uint8Array(r.audio)),
    mime: r.mime, text: r.asr_corrected ?? r.asr_raw, lang: r.lang,
  })).join("\n");
}

export async function wipe() {
  for (const t of ["training_edits", "training_audio", "training_asr", "training_extraction", "training_samples"]) {
    await run("DELETE FROM " + t);
  }
  await persist();
}
