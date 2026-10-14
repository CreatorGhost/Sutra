// A finished meeting as one portable bundle: the phone exports it when a meeting is done and the paired
// Mac saves it into its own library (`meetings.put`). Text only — never audio, voiceprints or
// embeddings, and no ids that only mean something on the device that made it: people travel by NAME,
// and the phone owner's turns ("me") always land on the Mac's own "me".
//
// Importing is idempotent by `uid` (a stable per-conversation id): the first import creates a session
// (kind "phone"), the conversation and everything derived from it, plus the graph; importing the same
// meeting again updates it IN PLACE (title, turns, notes, minutes, actions…) without touching the
// graph again, so mention counts and edge weights aren't inflated. The bundle is remote input — every
// field is checked and capped before it reaches the database.
import { persist, q, run } from "./db";
import { findPersonByName, getMe, insertConversation, insertEvent, insertPerson, setMinutes, setNotes, upsertMemory } from "./repo";
import { upsertEdge, upsertEntity } from "./graph";

export interface BundleTurn {
  speaker: string;
  person: string | null;
  is_me: boolean;
  text: string;
  text_clean: string | null;
  lang: string | null;
  start: number | null;
  end: number | null;
  abs_start: string | null;
  window_index: number;
  redacted: boolean;
}

export interface MeetingBundle {
  v: 1;
  uid: string;
  origin: { deviceName: string; platform: string };
  conversation: {
    title: string | null;
    started_at: string | null;
    ended_at: string | null;
    status: string;
    is_meeting: boolean;
    refined: boolean;
    source_app: string | null;
    tags: string[];
  };
  turns: BundleTurn[];
  memory: {
    title: string | null;
    subtitle: string | null;
    summary: string;
    facts: string[];
    action_items: unknown[];
    decisions: unknown[];
    open_questions: unknown[];
    importance: number;
    type_tags: string[];
  } | null;
  actions: { text: string; owner: string | null; due: string | null; status: string }[];
  events: { title: string; when_text: string | null; start_ts: string | null; kind: string | null }[];
  minutes: unknown | null;
  notes: { style: string; data: unknown }[];
  /** Everyone in the meeting, by name. */
  participants: string[];
  /** The exporting device owner's own name, so it never becomes a second person on the importer. */
  me: string | null;
  /** Graph facts this conversation is evidence for. */
  graph?: { entities: { type: string; name: string; description: string | null }[]; edges: { from: string; to: string; relation: string }[] };
}

const P = <T>(s: unknown, d: T): T => { try { return s == null ? d : JSON.parse(String(s)); } catch { return d; } };
const newUid = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

// ---- export ----

/** The conversation's stable cross-device id, minted on first use. */
async function conversationUid(cid: number, current: unknown): Promise<string> {
  if (typeof current === "string" && current) return current;
  const uid = newUid();
  await run("UPDATE conversations SET uid=? WHERE id=?", [uid, cid]);
  await persist();
  return uid;
}

export async function exportMeetingBundle(conversationId: number, origin: { deviceName: string; platform: string } = { deviceName: "Phone", platform: "" }): Promise<MeetingBundle> {
  const c = (await q("SELECT * FROM conversations WHERE id=?", [conversationId]))[0] as any;
  if (!c) throw new Error("That meeting no longer exists.");
  const uid = await conversationUid(conversationId, c.uid);
  const turns = await q(
    `SELECT t.session_speaker_label, p.canonical_name person, p.is_me, t.text, t.text_clean, t.lang, t.start_ts, t.end_ts, t.abs_start, t.window_index, t.redacted
     FROM turns t LEFT JOIN people p ON p.id=t.person_id WHERE t.conversation_id=? ORDER BY t.window_index, t.start_ts, t.id`, [conversationId]) as any[];
  const m = (await q("SELECT title,subtitle,summary,facts,action_items,decisions,open_questions,importance,type_tags FROM memories WHERE conversation_id=?", [conversationId]))[0] as any;
  const actions = await q("SELECT text,owner,due,status FROM action_items WHERE source_conversation=? ORDER BY id", [conversationId]) as any[];
  const events = await q("SELECT title,when_text,start_ts,kind FROM events WHERE conversation_id=? ORDER BY id", [conversationId]) as any[];
  const minutes = (await q("SELECT data FROM minutes WHERE conversation_id=?", [conversationId]))[0] as any;
  const notes = await q("SELECT style,data FROM notes WHERE conversation_id=? ORDER BY style", [conversationId]) as any[];
  const ids = P<unknown[]>(c.participant_person_ids, []).filter((x): x is number => Number.isInteger(x));
  const people = ids.length ? await q(`SELECT canonical_name FROM people WHERE id IN (${ids.map(() => "?").join(",")})`, ids) as any[] : [];
  const me = (await getMe()) as any;
  const edges = await q(
    `SELECT e.relation, s.type st, s.canonical_name sn, s.attrs sa, d.type dt, d.canonical_name dn, d.attrs da
     FROM edges e JOIN entities s ON s.id=e.src_entity JOIN entities d ON d.id=e.dst_entity
     WHERE EXISTS (SELECT 1 FROM json_each(e.evidence) j WHERE json_extract(j.value,'$.conversation_id')=?)`, [conversationId]) as any[];
  const entities = new Map<string, { type: string; name: string; description: string | null }>();
  const addEntity = (type: string, name: string, attrs: unknown) =>
    entities.set(`${type}\n${name.toLowerCase()}`, { type, name, description: P<any>(attrs, {})?.description ?? null });
  for (const e of edges) { addEntity(e.st, e.sn, e.sa); addEntity(e.dt, e.dn, e.da); }

  return {
    v: 1,
    uid,
    origin,
    conversation: {
      title: c.title ?? null, started_at: c.started_at ?? null, ended_at: c.ended_at ?? null, status: String(c.status ?? "pending"),
      is_meeting: !!c.is_meeting, refined: !!c.refined, source_app: c.source_app ?? null, tags: P<string[]>(c.tags, []),
    },
    turns: turns.map((t) => ({
      speaker: String(t.session_speaker_label ?? ""), person: t.person ?? null, is_me: !!t.is_me || t.session_speaker_label === "me",
      text: String(t.text ?? ""), text_clean: t.text_clean ?? null, lang: t.lang ?? null,
      start: t.start_ts ?? null, end: t.end_ts ?? null, abs_start: t.abs_start ?? null, window_index: Number(t.window_index) || 0, redacted: !!t.redacted,
    })),
    memory: m ? {
      title: m.title ?? null, subtitle: m.subtitle ?? null, summary: String(m.summary ?? ""), facts: P(m.facts, []), action_items: P(m.action_items, []),
      decisions: P(m.decisions, []), open_questions: P(m.open_questions, []), importance: Number(m.importance ?? 0.5), type_tags: P(m.type_tags, []),
    } : null,
    actions: actions.map((a) => ({ text: String(a.text), owner: a.owner ?? null, due: a.due ?? null, status: String(a.status ?? "open") })),
    events: events.map((e) => ({ title: String(e.title), when_text: e.when_text ?? null, start_ts: e.start_ts ?? null, kind: e.kind ?? null })),
    minutes: minutes ? P(minutes.data, null) : null,
    notes: notes.map((n) => ({ style: String(n.style), data: P(n.data, {}) })),
    participants: people.map((p) => String(p.canonical_name)),
    me: me?.canonical_name ?? null,
    graph: { entities: [...entities.values()], edges: edges.map((e) => ({ from: String(e.sn), to: String(e.dn), relation: String(e.relation) })) },
  };
}

// ---- validation (the bundle is remote input) ----

const MAX_TURNS = 20_000;
const MAX_TEXT = 20_000;
const MAX_ITEMS = 500;
const MAX_JSON = 512 * 1024;

const text = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "");
const textOrNull = (v: unknown, max = 500): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown, max = MAX_ITEMS): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const strings = (v: unknown, max = MAX_ITEMS, len = 2000): string[] => list(v, max).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, len));
/** Free-form JSON (minutes, notes, structured memory items): kept as-is, but bounded in size. */
const blob = <T>(v: unknown, fallback: T): T => {
  if (v === undefined) return fallback;
  try { return JSON.stringify(v).length <= MAX_JSON ? (v as T) : fallback; } catch { return fallback; }
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A checked, normalized bundle. Throws a readable message when it isn't one. */
export function parseMeetingBundle(raw: unknown): MeetingBundle {
  const b = obj(raw);
  if (b.v !== 1) throw new Error("This meeting is from a different version of Sutra — update both apps.");
  if (typeof b.uid !== "string" || !/^[\w-]{8,64}$/.test(b.uid)) throw new Error("This meeting can't be saved (missing id).");
  const c = obj(b.conversation);
  const m = b.memory == null ? null : obj(b.memory);
  const origin = obj(b.origin);
  const g = obj(b.graph);
  return {
    v: 1,
    uid: b.uid,
    origin: { deviceName: text(origin.deviceName, 80) || "Phone", platform: text(origin.platform, 40) },
    conversation: {
      title: textOrNull(c.title), started_at: textOrNull(c.started_at, 40), ended_at: textOrNull(c.ended_at, 40),
      status: ["pending", "done", "failed"].includes(c.status as string) ? (c.status as string) : "pending",
      is_meeting: c.is_meeting === true, refined: c.refined === true, source_app: textOrNull(c.source_app, 80), tags: strings(c.tags, 50, 60),
    },
    turns: list(b.turns, MAX_TURNS).map(obj).filter((t) => typeof t.text === "string").map((t) => ({
      speaker: text(t.speaker, 40) || "0", person: textOrNull(t.person, 120), is_me: t.is_me === true,
      text: text(t.text, MAX_TEXT), text_clean: textOrNull(t.text_clean, MAX_TEXT), lang: textOrNull(t.lang, 20),
      start: numOrNull(t.start), end: numOrNull(t.end), abs_start: textOrNull(t.abs_start, 40),
      window_index: Math.max(0, Math.floor(numOrNull(t.window_index) ?? 0)), redacted: t.redacted === true,
    })),
    memory: m && typeof m.summary === "string" ? {
      title: textOrNull(m.title), subtitle: textOrNull(m.subtitle, 1000), summary: text(m.summary, MAX_TEXT),
      facts: strings(m.facts), action_items: blob(list(m.action_items), []), decisions: blob(list(m.decisions), []),
      open_questions: blob(list(m.open_questions), []), importance: Math.min(1, Math.max(0, numOrNull(m.importance) ?? 0.5)), type_tags: strings(m.type_tags, 30, 60),
    } : null,
    actions: list(b.actions).map(obj).filter((a) => typeof a.text === "string" && a.text).map((a) => ({
      text: text(a.text, 2000), owner: textOrNull(a.owner, 120), due: textOrNull(a.due, 60), status: a.status === "done" ? "done" : "open",
    })),
    events: list(b.events).map(obj).filter((e) => typeof e.title === "string" && e.title).map((e) => ({
      title: text(e.title, 500), when_text: textOrNull(e.when_text, 200), start_ts: textOrNull(e.start_ts, 40), kind: textOrNull(e.kind, 40),
    })),
    minutes: b.minutes && typeof b.minutes === "object" ? blob(b.minutes, null) : null,
    notes: list(b.notes, 20).map(obj).filter((n) => typeof n.style === "string" && /^[\w-]{1,40}$/.test(n.style)).map((n) => ({ style: n.style as string, data: blob(n.data ?? {}, {}) })),
    participants: strings(b.participants, 200, 120).filter((n) => n.trim()),
    me: textOrNull(b.me, 120),
    graph: {
      entities: list(g.entities, 1000).map(obj).filter((e) => typeof e.type === "string" && typeof e.name === "string" && e.name.trim())
        .map((e) => ({ type: text(e.type, 40), name: text(e.name, 200), description: textOrNull(e.description, 1000) })),
      edges: list(g.edges, 2000).map(obj).filter((e) => typeof e.from === "string" && typeof e.to === "string")
        .map((e) => ({ from: text(e.from, 200), to: text(e.to, 200), relation: text(e.relation, 80) || "related_to" })),
    },
  };
}

// ---- import ----

/** Save a meeting from another device. Re-importing the same `uid` updates it in place. */
export async function importMeetingBundle(raw: unknown): Promise<{ conversationId: number; created: boolean }> {
  const b = parseMeetingBundle(raw);
  const c = b.conversation;

  // People by name; the exporting owner always maps to OUR "me" (created only if we have none).
  const ids = new Map<string, number>();
  let meId: number | null = null;
  const me = async () => (meId ??= ((await getMe()) as any)?.id ?? await insertPerson(b.me || "Me", true));
  const isMeName = (n: string) => !!b.me && n.toLowerCase() === b.me.toLowerCase();
  const person = async (name: string | null, isMe: boolean): Promise<number | null> => {
    if (isMe || (name && isMeName(name))) return me();
    if (!name) return null;
    const k = name.toLowerCase();
    if (!ids.has(k)) ids.set(k, ((await findPersonByName(name)) as any)?.id ?? await insertPerson(name));
    return ids.get(k)!;
  };
  const participants = new Set<number>();
  for (const n of b.participants) { const id = await person(n, false); if (id != null) participants.add(id); }
  const turnPeople: (number | null)[] = [];
  for (const t of b.turns) {
    const id = await person(t.person, t.is_me);
    turnPeople.push(id);
    if (id != null) participants.add(id);
  }

  const existing = (await q("SELECT id, session_id FROM conversations WHERE uid=?", [b.uid]))[0] as any;
  let cid: number;
  let sid: number;
  if (existing) {
    cid = existing.id;
    sid = existing.session_id;
    await run("DELETE FROM turns WHERE conversation_id=?", [cid]);
    await run("DELETE FROM action_items WHERE source_conversation=?", [cid]);
    await run("DELETE FROM events WHERE conversation_id=?", [cid]);
    await run("DELETE FROM notes WHERE conversation_id=?", [cid]);
    await run("DELETE FROM minutes WHERE conversation_id=?", [cid]);
    await run("UPDATE conversations SET title=?, started_at=?, ended_at=?, participant_person_ids=? WHERE id=?",
      [c.title, c.started_at, c.ended_at, JSON.stringify([...participants]), cid]);
  } else {
    const s = await run("INSERT INTO sessions(device,status,kind,source_app,started_at,ended_at) VALUES(?, 'closed', 'phone', 'Phone', COALESCE(?, datetime('now')), ?)",
      [`phone:${b.origin.deviceName}`, c.started_at, c.ended_at]);
    sid = s.lastId;
    cid = await insertConversation({ session_id: sid, title: c.title, started_at: c.started_at, ended_at: c.ended_at, participant_person_ids: [...participants] });
    await run("UPDATE conversations SET uid=? WHERE id=?", [b.uid, cid]);
  }
  await run("UPDATE conversations SET status=?, is_meeting=?, refined=?, source_app=?, tags=? WHERE id=?",
    [b.memory ? "done" : c.status, c.is_meeting ? 1 : 0, c.refined ? 1 : 0, c.source_app ?? b.origin.deviceName, JSON.stringify(c.tags), cid]);

  for (let i = 0; i < b.turns.length; i++) {
    const t = b.turns[i];
    await run(
      `INSERT INTO turns(session_id,conversation_id,window_index,session_speaker_label,person_id,text,text_clean,lang,start_ts,end_ts,abs_start,redacted)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sid, cid, t.window_index, t.speaker, turnPeople[i], t.text, t.text_clean, t.lang, t.start, t.end, t.abs_start, t.redacted ? 1 : 0]);
  }
  if (b.memory) await upsertMemory({ conversation_id: cid, ...b.memory, title: b.memory.title ?? "" });
  for (const a of b.actions) {
    await run("INSERT INTO action_items(text,owner,status,due,source_conversation) VALUES(?,?,?,?,?)", [a.text, a.owner, a.status, a.due, cid]);
  }
  for (const e of b.events) await insertEvent({ conversation_id: cid, ...e });
  if (b.minutes) await setMinutes(cid, b.minutes);
  for (const n of b.notes) await setNotes(cid, n.style, n.data);

  // The graph only on first import: upserts reinforce (count up) on every call.
  if (!existing && b.graph) {
    const byName = new Map<string, number>();
    for (const e of b.graph.entities) {
      const id = await upsertEntity(e.type, e.name, e.description, null);
      if (id && !byName.has(e.name.toLowerCase())) byName.set(e.name.toLowerCase(), id);
    }
    for (const e of b.graph.edges) {
      const src = byName.get(e.from.toLowerCase()), dst = byName.get(e.to.toLowerCase());
      if (src && dst) await upsertEdge(src, dst, e.relation, cid, []);
    }
  }
  await persist();
  return { conversationId: cid, created: !existing };
}
