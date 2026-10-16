import { findPersonByName, getSettings, insertPerson, minutesFor, relabelSpeaker as repoRelabel, sessionConversationIds, setConversationProject, turnVoiceprintsForLabel, upsertPersonVoiceprint } from "./repo";
import { meanVector } from "./util";
import { isFullTextEngine, resolveProvider } from "../providers";
import { generateMinutes } from "./minutes";

/** "This is me" / name labeling. Maps a session's speaker (cloud label or voiceprint cluster) to a
 *  person, then LEARNS that person's voiceprint from the labeled turns so future sessions auto-tag them
 *  (the cross-session recognition the manual relabel UI promises). Voiceprint learning is best-effort
 *  and only happens in hybrid mode, where per-turn voiceprints were captured. */
/** `untrusted`: the name came from something a meeting participant controls (their display name on the
 *  call's screen). It labels this meeting only — never the owner, never anyone's voiceprint. */
export async function relabelSpeaker(sessionId: number, label: string, opts: { person_id?: number; name?: string; is_me?: boolean; untrusted?: boolean }) {
  let personId = opts.person_id ?? null;
  if (personId == null) {
    if (!opts.name) throw new Error("person_id or name required");
    const existing = await findPersonByName(opts.name);
    if (opts.untrusted && existing?.is_me) throw new Error("a participant's display name matches the owner");
    personId = existing ? existing.id : await insertPerson(opts.name, !!opts.is_me);
  }
  await repoRelabel(sessionId, label, personId!);
  if (opts.untrusted) return { session_id: sessionId, label, person_id: personId };
  try {
    const vecs = await turnVoiceprintsForLabel(sessionId, label);
    if (vecs.length) await upsertPersonVoiceprint(personId!, meanVector(vecs));
  } catch (e) { console.warn("voiceprint enroll-on-label skipped", e); }
  // Minutes refresh runs in the BACKGROUND (fire-and-forget) so the rename registers INSTANTLY — the
  // re-map above is what the UI shows right away; the cloud minutes refresh (real name into
  // attendees/owners/discussion) lands a moment later. Self-swallowing & never blocks the rename.
  void regenerateMinutesAfterNaming(sessionId);
  return { session_id: sessionId, label, person_id: personId };
}

/** Re-run minutes for any conversation in this session that already has a minutes row, so a name added
 *  after generation replaces the frozen "Speaker N". Mirrors the auto-minutes gate (settings + cloud);
 *  the manual Regenerate button is unaffected. Best-effort — swallows every error. */
async function regenerateMinutesAfterNaming(sessionId: number): Promise<void> {
  try {
    const settings = await getSettings();
    if (settings.auto_minutes === false) return;
    // The same engine the rest of the app uses (the user's AI agent on desktop), not a fixed cloud one.
    const provider = resolveProvider(settings);
    if (!isFullTextEngine(provider)) return;
    for (const cid of await sessionConversationIds(sessionId)) {
      try { if (await minutesFor(cid)) await generateMinutes(cid, provider); }
      catch (e) { console.warn("minutes regen-on-name skipped", cid, e); }
    }
  } catch (e) { console.warn("minutes regen-on-name pass skipped", e); }
}

/** User maps (or unmaps, with null) a conversation to a project, then RE-RUNS that conversation's minutes
 *  so the new project's glossary/roster grounds them (or, on unmap, reverts to ungrounded). Always a USER
 *  choice (auto=false), so it overrides any silent auto-map and clears the pending suggestion. Minutes
 *  regeneration is best-effort and never throws — re-mapping must succeed even if minutes can't run. */
export async function setProjectForConversation(convId: number, projectId: number | null) {
  await setConversationProject(convId, projectId, false);
  await regenerateMinutesForConversation(convId);
  return { conversation_id: convId, project_id: projectId };
}

/** Re-run minutes for ONE conversation (if it already has a minutes row), mirroring the auto-minutes gate
 *  (auto on, cloud provider). Best-effort — swallows every error. Used when a project re-map changes the
 *  grounding context. */
async function regenerateMinutesForConversation(convId: number): Promise<void> {
  try {
    const settings = await getSettings();
    if (settings.auto_minutes === false) return;
    const provider = resolveProvider(settings);
    if (!isFullTextEngine(provider)) return;
    if (await minutesFor(convId)) await generateMinutes(convId, provider);
  } catch (e) { console.warn("minutes regen-on-remap skipped", convId, e); }
}

export async function enroll(name: string, isMe: boolean, _audio?: Blob | null) {
  // Name-only enrollment from Settings (no audio sample here). The voiceprint is learned later, the
  // first time this person is labeled inside a conversation (relabelSpeaker above). `_audio` is reserved
  // for a future "record a sample" enrollment flow.
  const id = await insertPerson(name, isMe);
  return { id, canonical_name: name, is_me: isMe, provisional: false };
}
