// Typed on-device data access (port of the Postgres-backed services' SQL). JSON columns are TEXT(JSON1).
import { q, run, exec, persist } from "./db";
import { blobToVec, cosine, normName, vecToBlob } from "./util";
import { coalesceTurns } from "./coalesce";

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(s: any, d: T): T => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

/** User-facing label for the Projects feature. Single source of truth so it can be renamed in ONE place
 *  (the owner picked "Projects" but reserves the right to rename). Import this wherever the word is shown. */
export const PROJECT_LABEL = "Projects" as const;

/** A canonical glossary term for a project: the correct spelling + any ways it's commonly mis-heard/mis-spelled
 *  (e.g. {canonical:"AiSensy", heardAs:["AI sensor","AI Sensi"]}). Drives Whisper-style post-correction. */
export type ProjectTerm = { canonical: string; heardAs: string[] };

/** PURE: parse/normalize the projects.terms JSON column into a clean ProjectTerm[]. Tolerant of legacy/
 *  hand-edited shapes — accepts a JSON string OR an already-parsed array; coerces bare strings to
 *  {canonical, heardAs:[]}; trims; drops blanks/dupes (case-insensitive on canonical); dedupes heardAs.
 *  Empty/absent input -> []. No DB, no I/O — unit-tested directly. */
export function parseProjectTerms(raw: unknown): ProjectTerm[] {
  let arr: unknown = raw;
  if (typeof raw === "string") arr = P<unknown[]>(raw, []);
  if (!Array.isArray(arr)) return [];
  const out: ProjectTerm[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    let canonical = "";
    let heard: unknown[] = [];
    if (typeof item === "string") canonical = item;
    else if (item && typeof item === "object") {
      canonical = String((item as any).canonical ?? "").trim();
      const h = (item as any).heardAs;
      heard = Array.isArray(h) ? h : [];
    }
    canonical = canonical.trim();
    if (!canonical) continue;
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const heardSeen = new Set<string>();
    const heardAs: string[] = [];
    for (const x of heard) {
      const s = String(x ?? "").trim();
      if (!s) continue;
      const lk = s.toLowerCase();
      // skip a heardAs that just repeats the canonical, and dedupe
      if (lk === key || heardSeen.has(lk)) continue;
      heardSeen.add(lk);
      heardAs.push(s);
    }
    out.push({ canonical, heardAs });
  }
  return out;
}

/** Max characters for a project brief — capped both in the UI (with a live counter) and when injecting,
 *  per the "lost in the middle" / context-budget research. Single source of truth so UI + injection agree. */
export const BRIEF_CAP = 1500;

/** PURE: clamp a project brief to BRIEF_CAP characters (never throws; null/undefined -> ""). The UI uses
 *  this on blur as a gentle, non-blocking trim; the injection step uses the same cap. No DB, no I/O. */
export function clampBrief(raw: unknown, cap: number = BRIEF_CAP): string {
  const s = raw == null ? "" : String(raw);
  return s.length > cap ? s.slice(0, cap) : s;
}

// ---- sessions ----
export async function createSession(device?: string) {
  const { lastId } = await run("INSERT INTO sessions(device,status) VALUES(?, 'active')", [device ?? null]);
  await persist();
  return (await q("SELECT * FROM sessions WHERE id=?", [lastId]))[0];
}
export const getSession = async (id: number) => (await q("SELECT * FROM sessions WHERE id=?", [id]))[0];
export async function closeSession(id: number) { await run("UPDATE sessions SET status='closed', ended_at=datetime('now') WHERE id=?", [id]); await persist(); }
export const listSessions = () =>
  q(`SELECT s.*, (SELECT count(*) FROM turns t WHERE t.session_id=s.id) turn_count
     FROM sessions s ORDER BY s.started_at DESC LIMIT 200`);

// ---- people ----
export const listPeople = () =>
  q(`SELECT id,canonical_name,is_me,provisional,enroll_count,notes,(voiceprint IS NOT NULL) has_voiceprint,created_at
     FROM people ORDER BY is_me DESC, provisional, id`);
export const peopleWithVoiceprints = async () =>
  (await q("SELECT id,canonical_name,is_me,provisional,voiceprint,voiceprint_dim FROM people WHERE voiceprint IS NOT NULL"))
    .map((r: any) => ({ ...r, vec: blobToVec(r.voiceprint) }));
export async function insertPerson(name: string, isMe = false, voiceprint?: number[], notes?: string) {
  if (isMe) await run("UPDATE people SET is_me=0 WHERE is_me=1");
  const { lastId } = await run(
    "INSERT INTO people(canonical_name,is_me,provisional,voiceprint,voiceprint_dim,enroll_count,notes) VALUES(?,?,?,?,?,?,?)",
    [name, isMe ? 1 : 0, 0, voiceprint ? vecToBlob(voiceprint) : null, voiceprint?.length ?? null, voiceprint ? 1 : 0, notes ?? null]);
  await persist();
  return lastId;
}
export const deletePerson = async (id: number) => { await run("DELETE FROM project_people WHERE person_id=?", [id]); await run("DELETE FROM people WHERE id=?", [id]); await persist(); };
/** Fold a new centroid into a person's enrolled voiceprint (running mean over enroll events, re-normalized),
 *  so naming a speaker once teaches Sutra to auto-recognize them in later sessions. */
export async function upsertPersonVoiceprint(personId: number, centroid: number[]) {
  if (!centroid.length) return;
  const row = (await q("SELECT voiceprint,enroll_count FROM people WHERE id=?", [personId]))[0] as any;
  let vec = centroid.slice();
  let count = 1;
  if (row?.voiceprint) {
    const old = Array.from(blobToVec(row.voiceprint)) as number[];
    const c = Math.max(1, Number(row.enroll_count) || 1);
    if (old.length === centroid.length) {
      vec = old.map((x, i) => (x * c + centroid[i]) / (c + 1));
      const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
      if (n) vec = vec.map((x) => x / n);
    }
    count = c + 1;
  }
  await run("UPDATE people SET voiceprint=?,voiceprint_dim=?,enroll_count=? WHERE id=?", [vecToBlob(vec), vec.length, count, personId]);
  await persist();
}
export const findPersonByName = async (name: string) =>
  (await q("SELECT * FROM people WHERE lower(canonical_name)=lower(?) AND provisional=0", [name]))[0];
/** The device owner row (is_me=1), or undefined if not enrolled — channel-0 ("Me") turns from
 *  multichannel capture resolve their person_id from this (F4). */
export const getMe = async () => (await q("SELECT * FROM people WHERE is_me=1 LIMIT 1"))[0];

// ---- turns ----
export async function insertTurn(t: any) {
  const { lastId } = await run(
    `INSERT INTO turns(session_id,window_index,session_speaker_label,person_id,speaker_confidence,text,lang,start_ts,end_ts,abs_start,redacted,voiceprint)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [t.session_id, t.window_index ?? 0, t.session_speaker_label, t.person_id ?? null, t.speaker_confidence ?? null,
     t.text, t.lang ?? null, t.start_ts ?? null, t.end_ts ?? null, t.abs_start ?? null, t.redacted ? 1 : 0,
     t.voiceprint != null ? vecToBlob(t.voiceprint) : null]);
  await persist();
  return lastId;
}
/** Session turns (in order) with their decoded per-turn voiceprint (null where none) — for clustering. */
export const turnsForClustering = async (sid: number) =>
  (await q(`SELECT id,text,session_speaker_label,start_ts,end_ts,voiceprint FROM turns WHERE session_id=?
            ORDER BY window_index,start_ts,id`, [sid]))
    .map((r: any) => ({ id: r.id as number, text: String(r.text ?? ""), cloud: String(r.session_speaker_label ?? ""),
                        start_ts: Number(r.start_ts) || 0, end_ts: Number(r.end_ts) || 0,
                        vec: r.voiceprint ? (Array.from(blobToVec(r.voiceprint)) as number[]) : null }));
/** Rewrite the per-session speaker label for a set of turns (voiceprint cluster -> stable label).
 *  Chunked to stay under SQLite's 999 bound-variable limit (a long meeting can exceed it). */
export async function setTurnSpeakerLabel(ids: number[], label: string) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 800) {
    const batch = ids.slice(i, i + 800);
    await run(`UPDATE turns SET session_speaker_label=? WHERE id IN (${batch.map(() => "?").join(",")})`, [label, ...batch]);
  }
  await persist();
}
/** All decoded voiceprints for a (session, speaker-label) — used to build an enrolled person's centroid. */
export const turnVoiceprintsForLabel = async (sid: number, label: string): Promise<number[][]> =>
  (await q("SELECT voiceprint FROM turns WHERE session_id=? AND session_speaker_label=? AND voiceprint IS NOT NULL", [sid, label]))
    .map((r: any) => Array.from(blobToVec(r.voiceprint)) as number[]);
export const sessionTurns = (sid: number) =>
  q(`SELECT t.*, p.canonical_name person_name, p.is_me FROM turns t LEFT JOIN people p ON p.id=t.person_id
     WHERE t.session_id=? ORDER BY t.window_index,t.start_ts,t.id`, [sid]);
/** Raw (NON-coalesced) turns for a conversation — the source rows the refinement pass cleans 1:1. */
export const rawConversationTurns = (cid: number) =>
  q(`SELECT t.id,t.session_speaker_label,t.person_id,p.canonical_name person_name,p.is_me,t.text,t.lang,t.start_ts,t.end_ts,t.abs_start,t.window_index
     FROM turns t LEFT JOIN people p ON p.id=t.person_id
     WHERE t.conversation_id=? AND t.redacted=0 ORDER BY t.window_index,t.start_ts,t.id`, [cid]);
/** Store a turn's cleaned text (raw t.text is never destroyed). */
export async function setTurnClean(id: number, clean: string) { await run("UPDATE turns SET text_clean=? WHERE id=?", [clean, id]); await persist(); }
/** Flip a conversation between raw and cleaned text display/extraction. */
export async function setConversationRefined(cid: number, on: boolean) { await run("UPDATE conversations SET refined=? WHERE id=?", [on ? 1 : 0, cid]); await persist(); }
export const unsegmentedTurns = (sid: number) =>
  q(`SELECT id,text,abs_start,person_id FROM turns WHERE session_id=? AND conversation_id IS NULL AND redacted=0
     ORDER BY window_index,start_ts,id`, [sid]);
export async function setTurnsConversation(ids: number[], convId: number) {
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 800) {
    const batch = ids.slice(i, i + 800);
    await run(`UPDATE turns SET conversation_id=? WHERE id IN (${batch.map(() => "?").join(",")})`, [convId, ...batch]);
  }
  await persist(); // durability: segmentation links must survive an app kill (web store flush)
}
export async function relabelSpeaker(sid: number, label: string, personId: number) {
  await run("UPDATE turns SET person_id=? WHERE session_id=? AND session_speaker_label=?", [personId, sid, label]);
  await persist();
}

// ---- conversations ----
export async function insertConversation(c: any) {
  const { lastId } = await run(
    "INSERT INTO conversations(session_id,title,started_at,ended_at,participant_person_ids,status) VALUES(?,?,?,?,?,?)",
    [c.session_id ?? null, c.title ?? null, c.started_at ?? null, c.ended_at ?? null, J(c.participant_person_ids ?? []), c.status ?? "pending"]);
  if (!lastId) throw new Error("insertConversation: no row id (insert failed)");
  await persist();
  return lastId;
}
export const setConversationTitle = async (id: number, title: string) => { await run("UPDATE conversations SET title=? WHERE id=?", [title, id]); await persist(); };
export const setConversationStatus = async (id: number, status: string) => { await run("UPDATE conversations SET status=? WHERE id=?", [status, id]); await persist(); };
export const setConversationMeeting = async (id: number, on: boolean) => { await run("UPDATE conversations SET is_meeting=? WHERE id=?", [on ? 1 : 0, id]); await persist(); };

// ---- minutes (Minutes of Meeting) — derived, non-destructive; one row per conversation ----
export const setMinutes = async (cid: number, data: any) => {
  await run(`INSERT INTO minutes(conversation_id,data,generated_at) VALUES(?,?,datetime('now'))
             ON CONFLICT(conversation_id) DO UPDATE SET data=excluded.data, generated_at=excluded.generated_at`,
    [cid, J(data ?? {})]);
  await persist();
};
export const clearMinutes = async (cid: number) => { await run("DELETE FROM minutes WHERE conversation_id=?", [cid]); await persist(); };
export const minutesFor = async (cid: number) => {
  const row = (await q("SELECT data,generated_at FROM minutes WHERE conversation_id=?", [cid]))[0] as any;
  return row ? { ...P(row.data, {} as Record<string, unknown>), generated_at: row.generated_at } : null;
};
/** Conversation ids in a session (to make processSession idempotent — skip re-segmentation). */
export const sessionConversationIds = async (sid: number): Promise<number[]> =>
  (await q("SELECT id FROM conversations WHERE session_id=? ORDER BY id", [sid])).map((r: any) => r.id);
/** Sessions that still have turns not assigned to any conversation (recovery targets). */
export const sessionsWithUnsegmentedTurns = async (): Promise<number[]> =>
  (await q("SELECT DISTINCT session_id sid FROM turns WHERE conversation_id IS NULL AND redacted=0")).map((r: any) => r.sid);
/** Conversations that have no memory row yet — i.e. extraction never completed (recovery targets). */
export const conversationsWithoutMemory = async (): Promise<number[]> =>
  (await q("SELECT c.id FROM conversations c LEFT JOIN memories m ON m.conversation_id=c.id WHERE m.id IS NULL ORDER BY c.id")).map((r: any) => r.id);
/** Memory-less conversations within one session (idempotent reprocessing target). */
export const sessionConversationsWithoutMemory = async (sid: number): Promise<number[]> =>
  (await q("SELECT c.id FROM conversations c LEFT JOIN memories m ON m.conversation_id=c.id WHERE c.session_id=? AND m.id IS NULL ORDER BY c.id", [sid])).map((r: any) => r.id);

// ---- events (scheduled/time-bound things extracted from a conversation) ----
export const clearEvents = async (cid: number) => { await run("DELETE FROM events WHERE conversation_id=?", [cid]); };
export const insertEvent = (e: any) =>
  run("INSERT INTO events(conversation_id,title,when_text,start_ts,kind) VALUES(?,?,?,?,?)",
    [e.conversation_id ?? null, e.title, e.when_text ?? null, e.start_ts ?? null, e.kind ?? null]);
export const eventsForConversation = (cid: number) =>
  q("SELECT id,title,when_text,start_ts,kind FROM events WHERE conversation_id=? ORDER BY (start_ts IS NULL), start_ts, id", [cid]);
/** Upcoming events across all conversations (start_ts >= now), for the Memory "upcoming" strip. */
export const upcomingEvents = (nowIso: string) =>
  q(`SELECT e.id,e.title,e.when_text,e.start_ts,e.kind,e.conversation_id, c.title conv_title
     FROM events e LEFT JOIN conversations c ON c.id=e.conversation_id
     WHERE e.start_ts IS NOT NULL AND e.start_ts >= ? ORDER BY e.start_ts LIMIT 50`, [nowIso]);
export const listConversations = async () =>
  (await q(`SELECT c.*, m.summary, m.importance AS importance_score, m.type_tags, json_array_length(m.action_items) action_count
            FROM conversations c LEFT JOIN memories m ON m.conversation_id=c.id
            ORDER BY c.started_at DESC LIMIT 200`)).map((r: any) =>
    ({ ...r, type_tags: P(r.type_tags, []), participant_person_ids: P(r.participant_person_ids, []) }));
export async function conversationDetail(cid: number) {
  const conv = (await q("SELECT * FROM conversations WHERE id=?", [cid]))[0];
  if (!conv) return null;
  const m = (await q(`SELECT id,conversation_id,title,summary,facts,action_items,decisions,importance AS importance_score,type_tags,created_at
                      FROM memories WHERE conversation_id=?`, [cid]))[0];
  const turns = await q(`SELECT t.id,t.session_speaker_label,t.session_id,t.person_id,p.canonical_name person_name,p.is_me,t.text,t.text_clean,t.lang,t.start_ts,t.end_ts,t.abs_start,t.window_index,t.redacted
                         FROM turns t LEFT JOIN people p ON p.id=t.person_id WHERE t.conversation_id=? ORDER BY t.window_index,t.start_ts,t.id`, [cid]);
  // Non-destructive cleaned text: when this conversation is refined, display + extraction use t.text_clean
  // (falling back to raw t.text per-turn where no cleaned text exists). Raw t.text stays the source of truth.
  const useClean = !!(conv as any).refined;
  const hasClean = (turns as any[]).some((t: any) => t.text_clean != null);
  const resolved = (turns as any[]).map((t: any) => ({ ...t, text: (useClean && t.text_clean) ? t.text_clean : t.text }));
  // Read-time coalescing: merge consecutive same-speaker diarization turns for coherent display/extraction.
  // crossWindow only when speakers are stabilized (person_id present); never mutates stored rows.
  const crossWindow = resolved.some((t: any) => t.person_id != null);
  const coalesced = coalesceTurns(resolved as any, { maxGapS: 2, maxMergeWords: 400, crossWindow });
  const ids = P<number[]>((conv as any).participant_person_ids, []).filter((x) => Number.isInteger(x));
  const participants = ids.length ? await q(`SELECT id,canonical_name,is_me FROM people WHERE id IN (${ids.map(() => "?").join(",")})`, ids) : [];
  const events = await q("SELECT id,title,when_text,start_ts,kind FROM events WHERE conversation_id=? ORDER BY (start_ts IS NULL), start_ts, id", [cid]);
  const minutes = await minutesFor(cid);
  const memory = m ? { ...m, facts: P((m as any).facts, []), action_items: P((m as any).action_items, []), decisions: P((m as any).decisions, []), type_tags: P((m as any).type_tags, []) } : null;
  return { conversation: { ...conv, participant_person_ids: ids, refined: useClean, hasClean, is_meeting: !!(conv as any).is_meeting, project_id: (conv as any).project_id ?? null, project_auto: !!(conv as any).project_auto, suggested_project_id: (conv as any).suggested_project_id ?? null }, memory, turns: coalesced, participants, events, minutes };
}

/** Redaction-safe variant of conversationDetail used by the MCP read layer: identical result shape,
 *  but turns with redacted=1 are EXCLUDED (filtered in SQL with t.redacted=0) before coalesce/return,
 *  so a redacted turn can never reach an external consumer. Everything else (clean-text resolution,
 *  cross-window coalescing, participants/events/minutes) is preserved exactly as conversationDetail. */
export async function conversationDetailSafe(cid: number) {
  const conv = (await q("SELECT * FROM conversations WHERE id=?", [cid]))[0];
  if (!conv) return null;
  const m = (await q(`SELECT id,conversation_id,title,summary,facts,action_items,decisions,importance AS importance_score,type_tags,created_at
                      FROM memories WHERE conversation_id=?`, [cid]))[0];
  const turns = await q(`SELECT t.id,t.session_speaker_label,t.session_id,t.person_id,p.canonical_name person_name,p.is_me,t.text,t.text_clean,t.lang,t.start_ts,t.end_ts,t.abs_start,t.window_index,t.redacted
                         FROM turns t LEFT JOIN people p ON p.id=t.person_id WHERE t.conversation_id=? AND t.redacted=0 ORDER BY t.window_index,t.start_ts,t.id`, [cid]);
  const useClean = !!(conv as any).refined;
  const hasClean = (turns as any[]).some((t: any) => t.text_clean != null);
  const resolved = (turns as any[]).map((t: any) => ({ ...t, text: (useClean && t.text_clean) ? t.text_clean : t.text }));
  const crossWindow = resolved.some((t: any) => t.person_id != null);
  const coalesced = coalesceTurns(resolved as any, { maxGapS: 2, maxMergeWords: 400, crossWindow });
  const ids = P<number[]>((conv as any).participant_person_ids, []).filter((x) => Number.isInteger(x));
  const participants = ids.length ? await q(`SELECT id,canonical_name,is_me FROM people WHERE id IN (${ids.map(() => "?").join(",")})`, ids) : [];
  const events = await q("SELECT id,title,when_text,start_ts,kind FROM events WHERE conversation_id=? ORDER BY (start_ts IS NULL), start_ts, id", [cid]);
  const minutes = await minutesFor(cid);
  const memory = m ? { ...m, facts: P((m as any).facts, []), action_items: P((m as any).action_items, []), decisions: P((m as any).decisions, []), type_tags: P((m as any).type_tags, []) } : null;
  return { conversation: { ...conv, participant_person_ids: ids, refined: useClean, hasClean, is_meeting: !!(conv as any).is_meeting }, memory, turns: coalesced, participants, events, minutes };
}

// ---- memories (+ FTS mirror) ----
export async function upsertMemory(m: any, embedding?: number[]) {
  await run(
    `INSERT INTO memories(conversation_id,title,summary,facts,action_items,decisions,importance,type_tags,embedding,embed_model,embed_dim)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET title=excluded.title,summary=excluded.summary,facts=excluded.facts,
       action_items=excluded.action_items,decisions=excluded.decisions,importance=excluded.importance,
       type_tags=excluded.type_tags,embedding=excluded.embedding,embed_model=excluded.embed_model,embed_dim=excluded.embed_dim`,
    [m.conversation_id, m.title ?? "", m.summary, J(m.facts ?? []), J(m.action_items ?? []), J(m.decisions ?? []),
     m.importance ?? 0.5, J(m.type_tags ?? []), embedding ? vecToBlob(embedding) : null, m.embed_model ?? null, embedding?.length ?? null]);
  const row = (await q("SELECT id FROM memories WHERE conversation_id=?", [m.conversation_id]))[0] as any;
  const id = row.id;
  await run("DELETE FROM memories_fts WHERE rowid=?", [id]);
  await run("INSERT INTO memories_fts(rowid,title,summary,facts) VALUES(?,?,?,?)",
    [id, m.title ?? "", m.summary, (m.facts ?? []).join(" ")]);
  await persist();
  return id;
}
export const memoriesForSearch = async () =>
  (await q("SELECT id,conversation_id,embedding,created_at FROM memories WHERE embedding IS NOT NULL"))
    .map((r: any) => ({ id: r.id, conversation_id: r.conversation_id, created_at: r.created_at, vec: blobToVec(r.embedding) }));
export const memoryCards = (ids: number[]) =>
  ids.length ? q(`SELECT m.id,m.conversation_id,m.title,m.summary,m.facts,m.importance,m.created_at,c.started_at
                  FROM memories m JOIN conversations c ON c.id=m.conversation_id WHERE m.id IN (${ids.map(() => "?").join(",")})`, ids) : Promise.resolve([]);

// ---- action items ----
/** Remove a conversation's existing action items — used before re-inserting on the re-extraction
 *  (recovery) path so reprocessing the same conversation doesn't duplicate its action items. */
export const clearActions = async (conversationId: number) => { await run("DELETE FROM action_items WHERE source_conversation=?", [conversationId]); await persist(); };
export const insertAction = async (a: any) => {
  await run("INSERT INTO action_items(text,owner,status,due,source_conversation) VALUES(?,?, 'open',?,?)",
    [a.text, a.owner ?? null, a.due ?? null, a.source_conversation ?? null]);
  await persist();
};
export const listActions = (status?: string) =>
  status ? q("SELECT * FROM action_items WHERE status=? ORDER BY created_at DESC", [status])
         : q("SELECT * FROM action_items ORDER BY created_at DESC LIMIT 300");
export const setActionStatus = async (id: number, status: string) => { await run("UPDATE action_items SET status=? WHERE id=?", [status, id]); await persist(); };

// ---- rollups & settings ----
export async function upsertRollup(day: string, summary: string, highlights: any[], openActions: any[]) {
  await run(`INSERT INTO daily_rollups(day,summary,highlights,open_actions) VALUES(?,?,?,?)
             ON CONFLICT(day) DO UPDATE SET summary=excluded.summary,highlights=excluded.highlights,open_actions=excluded.open_actions`,
    [day, summary, J(highlights), J(openActions)]);
  await persist();
}
export const listRollups = () => q("SELECT * FROM daily_rollups ORDER BY day DESC LIMIT 90");
export const getSettings = async (): Promise<Record<string, unknown>> => {
  // Never let a settings read throw — ingest/segmentation call this on the hot path; a failure here
  // must not abort transcription. Falls back to defaults ({}) and logs.
  try { return P((((await q("SELECT data FROM settings WHERE id=1"))[0] as any) || {}).data, {} as Record<string, unknown>); }
  catch (e) { console.warn("getSettings failed; using defaults", e); return {}; }
};
export async function putSettings(patch: Record<string, unknown>) {
  const cur = await getSettings();
  await run("UPDATE settings SET data=? WHERE id=1", [J({ ...cur, ...patch })]);
  await persist();
  return { ...cur, ...patch };
}

// ---- priors ("Your Context") — a profile tier of the user's personal beliefs, canonicalized + decaying ----
// Priors are DERIVED & non-destructive: raw turns/memories/graph stay the source of truth. One privacy
// control (share_cloud, default 0); only share_cloud=1 priors ride along in cloud-mode chat. Derived priors
// are status='suggested' (never auto-confirmed). Conflicts are only FLAGGED (contradicted++); never
// auto-superseded — the user supersedes explicitly. No background loop, no extra LLM calls.

/** Half-life recency decay — identical formula to search.ts recency(): 0.5^(ageDays/halfLife),
 *  age measured from last_confirmed_at (falls back to created_at upstream). */
function priorRecency(ts: string, halfLifeDays: number): number {
  if (!ts) return 1;
  const t = Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return 1;
  const ageDays = (Date.now() - t) / 86400000;
  return Math.pow(0.5, ageDays / Math.max(0.5, halfLifeDays));
}

/** Insert a raw prior row. `embedding` is NOT stored on priors (no column); it is only used by
 *  upsertPrior for the canonicalize/merge cosine tier. Returns the new row id. */
export async function insertPrior(p: any): Promise<number> {
  const subject = String(p.subject ?? "").trim();
  const { lastId } = await run(
    `INSERT INTO priors(kind,entity_id,subject,norm_subject,value,attrs,confidence,supported,contradicted,
       provenance,status,source_conversation,source_turn_ids,is_prior,share_cloud,valid_from,valid_to,
       last_confirmed_at,superseded_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [p.kind, p.entity_id ?? null, subject, normName(p.norm_subject ?? subject), p.value ?? null,
     J(p.attrs ?? {}), p.confidence ?? 0.5, p.supported ?? 1, p.contradicted ?? 0,
     p.provenance ?? "derived", p.status ?? "suggested", p.source_conversation ?? null,
     J(p.source_turn_ids ?? []), p.is_prior ?? 1, p.share_cloud ? 1 : 0, p.valid_from ?? null,
     p.valid_to ?? null, p.last_confirmed_at ?? null, p.superseded_by ?? null]);
  await persist();
  return lastId;
}

/** Canonicalize/merge a prior, mirroring graph.ts upsertEntity's tiers:
 *  (1) exact (kind, norm_subject) match OR same entity_id -> reinforce (supported++, refresh
 *      last_confirmed_at); (2) embedding cosine vs entity_sim_threshold (over linked entities of
 *      same-kind priors) -> merge into that prior; (3) else insert a fresh row. Returns the prior id. */
export async function upsertPrior(p: any): Promise<number> {
  const subject = String(p.subject ?? "").trim();
  const nn = normName(p.norm_subject ?? subject);
  if (!nn) return 0;
  const reinforce = async (id: number) => {
    await run(
      `UPDATE priors SET supported=supported+1, last_confirmed_at=datetime('now'),
         entity_id=COALESCE(entity_id, ?) WHERE id=?`,
      [p.entity_id ?? null, id]);
    await persist();
    return id;
  };
  // Tier 1: exact canonical key (same kind + norm_subject) — or same canonical entity_id.
  const exact = (await q(
    `SELECT id FROM priors WHERE kind=? AND (norm_subject=? OR (entity_id IS NOT NULL AND entity_id=?))
     ORDER BY id LIMIT 1`, [p.kind, nn, p.entity_id ?? -1]))[0] as any;
  if (exact) return reinforce(exact.id);
  // Tier 2: embedding cosine vs entity_sim_threshold, mirroring upsertEntity. Priors carry no embedding
  // column, so we compare the supplied embedding against the embeddings of canonical entities linked to
  // existing same-kind priors; a match folds into that prior.
  if (p.embedding && p.embedding.length) {
    const s = await getSettings();
    const thr = Number(s["entity_sim_threshold"] ?? 0.86);
    const cands = (await q(
      `SELECT pr.id pid, e.embedding emb FROM priors pr JOIN entities e ON e.id=pr.entity_id
       WHERE pr.kind=? AND e.embedding IS NOT NULL`, [p.kind])) as any[];
    let bestId = -1, best = -1;
    for (const c of cands) { const sim = cosine(p.embedding, blobToVec(c.emb)); if (sim > best) { best = sim; bestId = c.pid; } }
    if (bestId > 0 && best >= thr) return reinforce(bestId);
  }
  // Tier 3: new prior.
  return insertPrior(p);
}

export const listPriors = () =>
  q(`SELECT * FROM priors ORDER BY (status='confirmed') DESC, supported DESC, created_at DESC LIMIT 500`);
export const getPrior = async (id: number) => (await q("SELECT * FROM priors WHERE id=?", [id]))[0];
export const setPriorStatus = async (id: number, status: string) => {
  // Confirming a prior is also a fresh confirmation (refreshes the decay clock).
  await run(
    `UPDATE priors SET status=?, last_confirmed_at=CASE WHEN ?='confirmed' THEN datetime('now') ELSE last_confirmed_at END
     WHERE id=?`, [status, status, id]);
  await persist();
};
/** Edit a prior's user-facing fields (non-destructive; only the listed keys are patched). */
export async function editPrior(id: number, patch: any) {
  const cols: string[] = [], vals: any[] = [];
  const set = (c: string, v: any) => { cols.push(`${c}=?`); vals.push(v); };
  if (patch.subject != null) { const sub = String(patch.subject).trim(); set("subject", sub); set("norm_subject", normName(sub)); }
  if (patch.value !== undefined) set("value", patch.value ?? null);
  if (patch.kind != null) set("kind", patch.kind);
  if (patch.attrs !== undefined) set("attrs", J(patch.attrs ?? {}));
  if (patch.confidence != null) set("confidence", patch.confidence);
  if (patch.valid_from !== undefined) set("valid_from", patch.valid_from ?? null);
  if (patch.valid_to !== undefined) set("valid_to", patch.valid_to ?? null);
  if (!cols.length) return;
  await run(`UPDATE priors SET ${cols.join(", ")} WHERE id=?`, [...vals, id]);
  await persist();
}
/** Explicit, user-driven supersede (NEVER automatic): insert the replacement prior, then point the
 *  old prior at it via superseded_by + close it out (valid_to=now). The old row is preserved. */
export async function supersedePrior(oldId: number, newPrior: any): Promise<number> {
  const newId = await insertPrior({ ...newPrior, provenance: newPrior.provenance ?? "user", status: newPrior.status ?? "confirmed" });
  await run("UPDATE priors SET superseded_by=?, valid_to=COALESCE(valid_to, datetime('now')) WHERE id=?", [newId, oldId]);
  await persist();
  return newId;
}
export const setPriorShareCloud = async (id: number, on: boolean) => {
  await run("UPDATE priors SET share_cloud=? WHERE id=?", [on ? 1 : 0, id]);
  await persist();
};

/** Top active priors for a query, scored by effective_confidence =
 *  confidence * recency(last_confirmed_at, prior_half_life_days||60) * clamp(1+0.1*(supported-contradicted),0.5,1.5).
 *  Only confirmed-or-user, not superseded, not expired. When cloud=true, restricted to share_cloud=1.
 *  `query` is reserved for future lexical/semantic narrowing; v1 ranks the active set by effective confidence. */
export async function topPriors(query: string, k = 8, cloud = false) {
  const s = await getSettings();
  const halfLife = Number(s["prior_half_life_days"] ?? 60) || 60;
  const rows = (await q(
    `SELECT * FROM priors
     WHERE (status='confirmed' OR provenance='user') AND superseded_by IS NULL AND valid_to IS NULL
       ${cloud ? "AND share_cloud=1" : ""}`)) as any[];
  return rows
    .map((r) => {
      const supportFactor = Math.max(0.5, Math.min(1.5, 1 + 0.1 * ((Number(r.supported) || 0) - (Number(r.contradicted) || 0))));
      const rec = priorRecency(r.last_confirmed_at || r.created_at, halfLife);
      const effective_confidence = (Number(r.confidence) || 0.5) * rec * supportFactor;
      return { ...r, attrs: P(r.attrs, {} as Record<string, unknown>), source_turn_ids: P(r.source_turn_ids, [] as number[]), effective_confidence };
    })
    .sort((a, b) => b.effective_confidence - a.effective_confidence)
    .slice(0, k);
}

// ---- projects ("Projects") — user-authored, per-project context; on-device only in v1 ----
// Role lives ONLY on project_people (per-project membership), never on the global people row. project_id
// on conversations is nullable; unmapped is the default and behaves exactly as today. share_cloud is a v1
// UI placeholder (cloud egress deferred); context_enabled gates LOCAL grounding.

export async function createProject(name?: string): Promise<number> {
  const { lastId } = await run(
    "INSERT INTO projects(name,brief,color,context_enabled,share_cloud,terms) VALUES(?,?,?,?,?,?)",
    [name ?? null, null, null, 1, 0, J([])]);
  await persist();
  return lastId;
}

/** Patch only the supplied project fields (non-destructive; absent keys untouched). `terms` is normalized
 *  through parseProjectTerms before storage so the column stays a clean ProjectTerm[] JSON. */
export async function updateProject(
  id: number,
  patch: { name?: string; brief?: string; color?: string | null; context_enabled?: boolean; share_cloud?: boolean; terms?: unknown },
): Promise<void> {
  const cols: string[] = [], vals: any[] = [];
  const set = (c: string, v: any) => { cols.push(`${c}=?`); vals.push(v); };
  if (patch.name !== undefined) set("name", patch.name ?? null);
  if (patch.brief !== undefined) set("brief", patch.brief ?? null);
  if (patch.color !== undefined) set("color", patch.color ?? null);
  if (patch.context_enabled !== undefined) set("context_enabled", patch.context_enabled ? 1 : 0);
  if (patch.share_cloud !== undefined) set("share_cloud", patch.share_cloud ? 1 : 0);
  if (patch.terms !== undefined) set("terms", J(parseProjectTerms(patch.terms)));
  if (!cols.length) return;
  await run(`UPDATE projects SET ${cols.join(", ")} WHERE id=?`, [...vals, id]);
  await persist();
}

export const deleteProject = async (id: number) => {
  await run("DELETE FROM project_people WHERE project_id=?", [id]);
  // Unmap any conversations pointing at this project (additive: never deletes the conversation).
  await run("UPDATE conversations SET project_id=NULL WHERE project_id=?", [id]);
  await run("DELETE FROM projects WHERE id=?", [id]);
  await persist();
};

const hydrateProject = (r: any) => ({ ...r, context_enabled: !!r.context_enabled, share_cloud: !!r.share_cloud, terms: parseProjectTerms(r.terms) });

export const listProjects = async () =>
  (await q(`SELECT p.*, (SELECT count(*) FROM project_people pp WHERE pp.project_id=p.id) people_count,
              (SELECT group_concat(pe.canonical_name, '\x1f') FROM
                 (SELECT pe.canonical_name FROM project_people pp JOIN people pe ON pe.id=pp.person_id
                    WHERE pp.project_id=p.id ORDER BY pe.is_me DESC, pe.canonical_name LIMIT 4) pe) people_names
            FROM projects p ORDER BY p.created_at DESC, p.id DESC`))
    .map((r: any) => ({ ...hydrateProject(r), people_names: r.people_names ? String(r.people_names).split("\x1f") : [] }));

/** A project + its people list (joined to the global people row for canonical_name + voiceprint presence).
 *  role comes from the per-project membership; person_id may be null only for an unresolved member name. */
export async function getProject(id: number) {
  const row = (await q("SELECT * FROM projects WHERE id=?", [id]))[0];
  if (!row) return null;
  const people = await q(
    `SELECT pp.person_id, pp.role, p.canonical_name, p.is_me, (p.voiceprint IS NOT NULL) has_voiceprint
     FROM project_people pp LEFT JOIN people p ON p.id=pp.person_id
     WHERE pp.project_id=? ORDER BY p.is_me DESC, p.canonical_name`, [id]);
  return { ...hydrateProject(row), people };
}

/** Add a person to a project with a per-project role. Provide an existing person_id, OR a name to create a
 *  fresh global people row (one row per human). Idempotent on (project_id, person_id) — re-add updates role. */
export async function addProjectPerson(
  projectId: number,
  member: { person_id?: number; name?: string; role?: string },
): Promise<number> {
  let pid = member.person_id;
  if (pid == null) {
    const name = String(member.name ?? "").trim();
    if (!name) throw new Error("addProjectPerson: person_id or name required");
    const existing = await findPersonByName(name);
    pid = existing ? (existing as any).id : await insertPerson(name);
  }
  await run(
    `INSERT INTO project_people(project_id,person_id,role) VALUES(?,?,?)
     ON CONFLICT(project_id,person_id) DO UPDATE SET role=excluded.role`,
    [projectId, pid, member.role ?? null]);
  await persist();
  return pid as number;
}

export const setProjectPersonRole = async (projectId: number, personId: number, role: string | null) => {
  await run("UPDATE project_people SET role=? WHERE project_id=? AND person_id=?", [role ?? null, projectId, personId]);
  await persist();
};

export const removeProjectPerson = async (projectId: number, personId: number) => {
  await run("DELETE FROM project_people WHERE project_id=? AND person_id=?", [projectId, personId]);
  await persist();
};

/** Map (or unmap, with null) a conversation to a project. `auto` distinguishes a SILENT high-confidence
 *  auto-map (project_auto=1, drives the "Mapped to X — undo" affordance) from a USER choice (auto=0, the
 *  default — which also clears any pending suggestion). Nullable; unmapping clears the auto flag too. */
export const setConversationProject = async (convId: number, projectId: number | null, auto = false) => {
  await run(
    "UPDATE conversations SET project_id=?, project_auto=?, suggested_project_id=NULL WHERE id=?",
    [projectId, projectId != null && auto ? 1 : 0, convId]);
  await persist();
};

/** Record a MEDIUM-confidence guess WITHOUT mapping — the conversation stays unmapped until the user
 *  confirms (one tap). Pass null to clear the suggestion. Never touches project_id. */
export const setConversationProjectSuggestion = async (convId: number, projectId: number | null) => {
  await run("UPDATE conversations SET suggested_project_id=? WHERE id=?", [projectId, convId]);
  await persist();
};

/** The project a conversation is mapped to (with its people), or null when unmapped. */
export async function projectForConversation(convId: number) {
  const row = (await q("SELECT project_id FROM conversations WHERE id=?", [convId]))[0] as any;
  const pid = row?.project_id;
  return pid == null ? null : getProject(Number(pid));
}

/** PURE-ish read: the mapping signals a conversation carries for the scorer / chip — the current mapping,
 *  whether it was a silent auto-map (show undo), and any pending suggestion. Tolerant of pre-v9 rows. */
export async function conversationMapping(convId: number): Promise<{ project_id: number | null; project_auto: boolean; suggested_project_id: number | null }> {
  const row = (await q("SELECT project_id, project_auto, suggested_project_id FROM conversations WHERE id=?", [convId]))[0] as any;
  return {
    project_id: row?.project_id ?? null,
    project_auto: !!row?.project_auto,
    suggested_project_id: row?.suggested_project_id ?? null,
  };
}

/** The enrolled person_ids actually present in a conversation (distinct, non-null) — the strongest signal
 *  for the project scorer ("who was in the room"). Read from the turns' resolved person_id. */
export async function conversationPersonIds(convId: number): Promise<number[]> {
  const rows = await q(
    "SELECT DISTINCT person_id FROM turns WHERE conversation_id=? AND person_id IS NOT NULL", [convId]);
  return rows.map((r: any) => Number(r.person_id)).filter((x) => Number.isInteger(x));
}

/** All projects shaped for the scorer (id + member person_ids + canonical terms + roster names). Reuses
 *  listProjects (terms already parsed) + a single grouped membership read; context-disabled projects are
 *  EXCLUDED (a project the user turned off must never claim a conversation). */
export async function scorableProjects(): Promise<{ projectId: number; peopleIds: number[]; terms: ProjectTerm[]; names: string[] }[]> {
  const projects = (await listProjects()).filter((p: any) => p.context_enabled !== false);
  if (!projects.length) return [];
  const members = await q(
    `SELECT pp.project_id, pp.person_id, p.canonical_name
     FROM project_people pp LEFT JOIN people p ON p.id=pp.person_id`);
  const byProject = new Map<number, { peopleIds: number[]; names: string[] }>();
  for (const m of members as any[]) {
    const pid = Number(m.project_id);
    if (!byProject.has(pid)) byProject.set(pid, { peopleIds: [], names: [] });
    const g = byProject.get(pid)!;
    if (Number.isInteger(m.person_id)) g.peopleIds.push(Number(m.person_id));
    const nm = String(m.canonical_name ?? "").trim();
    if (nm) g.names.push(nm);
  }
  return projects.map((p: any) => {
    const g = byProject.get(Number(p.id)) ?? { peopleIds: [], names: [] };
    return { projectId: Number(p.id), peopleIds: g.peopleIds, terms: p.terms as ProjectTerm[], names: g.names };
  });
}

export { exec };
