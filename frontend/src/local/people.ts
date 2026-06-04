import { findPersonByName, insertPerson, relabelSpeaker as repoRelabel, turnVoiceprintsForLabel, upsertPersonVoiceprint } from "./repo";
import { meanVector } from "./util";

/** "This is me" / name labeling. Maps a session's speaker (cloud label or voiceprint cluster) to a
 *  person, then LEARNS that person's voiceprint from the labeled turns so future sessions auto-tag them
 *  (the cross-session recognition the manual relabel UI promises). Voiceprint learning is best-effort
 *  and only happens in hybrid mode, where per-turn voiceprints were captured. */
export async function relabelSpeaker(sessionId: number, label: string, opts: { person_id?: number; name?: string; is_me?: boolean }) {
  let personId = opts.person_id ?? null;
  if (personId == null) {
    if (!opts.name) throw new Error("person_id or name required");
    const existing = await findPersonByName(opts.name);
    personId = existing ? existing.id : await insertPerson(opts.name, !!opts.is_me);
  }
  await repoRelabel(sessionId, label, personId!);
  try {
    const vecs = await turnVoiceprintsForLabel(sessionId, label);
    if (vecs.length) await upsertPersonVoiceprint(personId!, meanVector(vecs));
  } catch (e) { console.warn("voiceprint enroll-on-label skipped", e); }
  return { session_id: sessionId, label, person_id: personId };
}

export async function enroll(name: string, isMe: boolean, _audio?: Blob | null) {
  // Name-only enrollment from Settings (no audio sample here). The voiceprint is learned later, the
  // first time this person is labeled inside a conversation (relabelSpeaker above). `_audio` is reserved
  // for a future "record a sample" enrollment flow.
  const id = await insertPerson(name, isMe);
  return { id, canonical_name: name, is_me: isMe, provisional: false };
}
