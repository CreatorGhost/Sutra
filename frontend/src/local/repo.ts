// Typed on-device data access (port of the Postgres-backed services' SQL). JSON columns are TEXT(JSON1).
import { q, run, exec, persist } from "./db";
import { blobToVec, vecToBlob } from "./util";

const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(s: any, d: T): T => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

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
export const deletePerson = async (id: number) => { await run("DELETE FROM people WHERE id=?", [id]); await persist(); };
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
  const turns = await q(`SELECT t.id,t.session_speaker_label,t.session_id,p.canonical_name person_name,p.is_me,t.text,t.lang,t.start_ts,t.redacted
                         FROM turns t LEFT JOIN people p ON p.id=t.person_id WHERE t.conversation_id=? ORDER BY t.window_index,t.start_ts,t.id`, [cid]);
  const ids = P<number[]>((conv as any).participant_person_ids, []).filter((x) => Number.isInteger(x));
  const participants = ids.length ? await q(`SELECT id,canonical_name,is_me FROM people WHERE id IN (${ids.map(() => "?").join(",")})`, ids) : [];
  const events = await q("SELECT id,title,when_text,start_ts,kind FROM events WHERE conversation_id=? ORDER BY (start_ts IS NULL), start_ts, id", [cid]);
  const memory = m ? { ...m, facts: P((m as any).facts, []), action_items: P((m as any).action_items, []), decisions: P((m as any).decisions, []), type_tags: P((m as any).type_tags, []) } : null;
  return { conversation: { ...conv, participant_person_ids: ids }, memory, turns, participants, events };
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

export { exec };
