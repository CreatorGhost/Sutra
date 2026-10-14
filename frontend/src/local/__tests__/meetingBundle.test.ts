// A phone meeting exported from one REAL SQLite database (better-sqlite3 through the desktop adapter)
// and imported into another — the phone's library and the Mac's.
import { beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { adapt } from "../../storage/desktopAdapter";
import { runMigrations } from "../../storage/migrate";

function makeDb() {
  const raw = new Database(":memory:");
  runMigrations({
    exec: (sql) => raw.exec(sql),
    getUserVersion: () => Number(raw.pragma("user_version", { simple: true })),
    setUserVersion: (v) => raw.exec(`PRAGMA user_version=${v};`),
    columns: (t) => (raw.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => String(r.name)),
  });
  return adapt(raw as any);
}
const phoneDb = makeDb();
const macDb = makeDb();
let db = phoneDb;
vi.mock("../db", () => ({ q: (s: string, p?: any[]) => db.q(s, p), run: (s: string, p?: any[]) => db.run(s, p), exec: (s: string) => db.exec(s), persist: async () => {} }));

let repo: typeof import("../repo");
let graph: typeof import("../graph");
let bundle: typeof import("../meetingBundle");
beforeAll(async () => {
  repo = await import("../repo");
  graph = await import("../graph");
  bundle = await import("../meetingBundle");
});

/** On the phone: a meeting between its owner (Aditya, enrolled with a voice) and Ravi. */
async function phoneMeeting() {
  db = phoneDb;
  const me = await repo.insertPerson("Aditya", true, [0.1, 0.2, 0.3]);
  const ravi = await repo.insertPerson("Ravi", false, [0.4, 0.5, 0.6]);
  const s = await repo.createSession("android", "meeting", null);
  const cid = await repo.insertConversation({ session_id: s.id, title: "Launch sync", started_at: "2026-10-01T10:00:00.000Z", ended_at: "2026-10-01T10:30:00.000Z", participant_person_ids: [me, ravi], status: "done" });
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", person_id: me, text: "We launch Friday.", start_ts: 0, end_ts: 2, abs_start: "2026-10-01T10:00:00.000Z", voiceprint: [0.1, 0.2, 0.3] });
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "c1", person_id: ravi, text: "I'll test the Android build.", start_ts: 2, end_ts: 5, abs_start: "2026-10-01T10:00:02.000Z", voiceprint: [0.4, 0.5, 0.6] });
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "c2", text: "Can we add Priya?", start_ts: 5, end_ts: 7, abs_start: "2026-10-01T10:00:05.000Z" });
  await repo.setTurnsConversation((await repo.unsegmentedTurns(s.id)).map((t: any) => t.id), cid);
  await repo.setConversationMeeting(cid, true);
  await repo.setConversationTags(cid, ["launch"]);
  await repo.upsertMemory({ conversation_id: cid, title: "Launch sync", subtitle: "Friday launch", summary: "The team agreed to launch on Friday.", facts: ["launch friday"], open_questions: ["Who writes the notes?"] }, [0.9, 0.9]);
  await repo.insertAction({ text: "Test the Android build", owner: "Ravi", source_conversation: cid });
  await repo.insertEvent({ conversation_id: cid, title: "Launch", when_text: "Friday", start_ts: "2026-10-03T09:00:00", kind: "deadline" });
  await repo.setMinutes(cid, { attendees: ["Aditya", "Ravi"], summary: "Launch Friday" });
  await repo.setNotes(cid, "detailed", { overview: "Launch planning" });
  const a = await graph.upsertEntity("project", "Sutra Android", "The phone app", null);
  const b = await graph.upsertEntity("person", "Ravi", null, null);
  await graph.upsertEdge(b, a, "works on", cid, [1]);
  return cid;
}

describe("meeting bundles", () => {
  let exported: import("../meetingBundle").MeetingBundle;

  it("export carries the meeting by name — no audio, voiceprints, embeddings or local ids", async () => {
    const cid = await phoneMeeting();
    exported = await bundle.exportMeetingBundle(cid, { deviceName: "Pixel 9", platform: "android" });
    expect(exported.uid).toMatch(/^[\w-]{8,64}$/);
    expect((await bundle.exportMeetingBundle(cid)).uid).toBe(exported.uid); // stable
    expect(exported.turns.map((t) => [t.speaker, t.person, t.is_me])).toEqual([["me", "Aditya", true], ["c1", "Ravi", false], ["c2", null, false]]);
    expect(exported.participants).toEqual(["Aditya", "Ravi"]);
    expect(exported.me).toBe("Aditya");
    expect(exported.memory?.open_questions).toEqual(["Who writes the notes?"]);
    expect(exported.graph?.edges).toEqual([{ from: "Ravi", to: "Sutra Android", relation: "works_on" }]);
    const json = JSON.stringify(exported);
    for (const banned of ["voiceprint", "embedding", "audio", "person_id", "session_id", "conversation_id", "\"id\""]) expect(json).not.toContain(banned);
  });

  it("import lands in the Mac's library, mapping the phone's owner to the Mac's own me", async () => {
    db = macDb;
    const macMe = await repo.insertPerson("Aditya Dev", true);
    const macRavi = await repo.insertPerson("ravi");
    const r = await bundle.importMeetingBundle(JSON.parse(JSON.stringify(exported)));
    expect(r.created).toBe(true);

    const d = await repo.conversationDetail(r.conversationId);
    expect(d?.conversation.title).toBe("Launch sync");
    expect(d?.conversation.is_meeting).toBe(true);
    expect(d?.conversation.tags).toEqual(["launch"]);
    expect((d?.conversation as any).status).toBe("done");
    const turns = await macDb.q<any>("SELECT session_speaker_label, person_id, text FROM turns WHERE conversation_id=? ORDER BY start_ts", [r.conversationId]);
    expect(turns.map((t) => t.person_id)).toEqual([macMe, macRavi, null]);
    expect((await macDb.q<any>("SELECT count(*) n FROM people WHERE is_me=1"))[0].n).toBe(1);
    expect((await macDb.q<any>("SELECT count(*) n FROM people"))[0].n).toBe(2); // nobody new
    expect(d?.memory?.summary).toBe("The team agreed to launch on Friday.");
    expect(await macDb.q("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?", ["friday"])).toHaveLength(1);
    expect(d?.actions).toMatchObject([{ text: "Test the Android build", owner: "Ravi", status: "open" }]);
    expect(d?.events).toMatchObject([{ title: "Launch", kind: "deadline" }]);
    expect(d?.minutes).toMatchObject({ summary: "Launch Friday" });
    expect(await repo.getNotes(r.conversationId, "detailed")).toMatchObject({ overview: "Launch planning" });
    const sess = (await macDb.q<any>("SELECT kind, source_app, device FROM sessions WHERE id=(SELECT session_id FROM conversations WHERE id=?)", [r.conversationId]))[0];
    expect(sess).toEqual({ kind: "phone", source_app: "Phone", device: "phone:Pixel 9" });
    const edges = await macDb.q<any>("SELECT relation, evidence FROM edges");
    expect(edges).toHaveLength(1);
    expect(JSON.parse(edges[0].evidence)[0].conversation_id).toBe(r.conversationId);
    // No voiceprints crossed over.
    expect(await macDb.q("SELECT id FROM turns WHERE voiceprint IS NOT NULL")).toHaveLength(0);
    expect(await macDb.q("SELECT id FROM people WHERE voiceprint IS NOT NULL")).toHaveLength(0);
  });

  it("importing the same meeting again updates it in place", async () => {
    db = macDb;
    const changed = { ...exported, conversation: { ...exported.conversation, title: "Launch sync (final)" }, turns: exported.turns.slice(0, 2) };
    const first = (await macDb.q<any>("SELECT id FROM conversations WHERE uid=?", [exported.uid]))[0].id;
    const mentions = (await macDb.q<any>("SELECT sum(mention_count) n FROM entities"))[0].n;
    const r = await bundle.importMeetingBundle(changed);
    expect(r).toEqual({ conversationId: first, created: false });
    expect(await macDb.q("SELECT id FROM conversations")).toHaveLength(1);
    expect(await macDb.q("SELECT id FROM sessions")).toHaveLength(1);
    expect(await macDb.q("SELECT id FROM turns")).toHaveLength(2);
    expect(await macDb.q("SELECT id FROM action_items")).toHaveLength(1);
    expect((await repo.conversationDetail(first))?.conversation.title).toBe("Launch sync (final)");
    expect((await macDb.q<any>("SELECT sum(mention_count) n FROM entities"))[0].n).toBe(mentions);
    expect((await macDb.q<any>("SELECT weight FROM edges"))[0].weight).toBe(1);
  });

  it("creates people it doesn't know, and a me only when there is none", async () => {
    db = makeDb();
    const r = await bundle.importMeetingBundle({ ...exported, uid: "another-meeting-1", participants: ["Priya"] });
    const people = await db.q<any>("SELECT canonical_name, is_me FROM people ORDER BY id");
    expect(people).toEqual([{ canonical_name: "Priya", is_me: 0 }, { canonical_name: "Aditya", is_me: 1 }, { canonical_name: "Ravi", is_me: 0 }]);
    expect(r.created).toBe(true);
  });

  it("refuses what isn't a bundle and caps what is", async () => {
    await expect(bundle.importMeetingBundle(null)).rejects.toThrow(/different version/);
    await expect(bundle.importMeetingBundle({ v: 1, uid: "x" })).rejects.toThrow(/missing id/);
    const p = bundle.parseMeetingBundle({
      v: 1, uid: "abcdefgh", conversation: { title: 42, status: "hacked" },
      turns: [{ text: "x".repeat(50_000), speaker: "0", person: { evil: true }, is_me: "yes" }, { speaker: "1" }],
      notes: [{ style: "../../etc", data: {} }, { style: "brief", data: { a: 1 } }],
      actions: [{ text: "" }, { text: "Do it", status: "weird" }],
    });
    expect(p.conversation.title).toBeNull();
    expect(p.conversation.status).toBe("pending");
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0]).toMatchObject({ person: null, is_me: false });
    expect(p.turns[0].text).toHaveLength(20_000);
    expect(p.notes.map((n) => n.style)).toEqual(["brief"]);
    expect(p.actions).toEqual([{ text: "Do it", owner: null, due: null, status: "open" }]);
  });
});
