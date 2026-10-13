// Runs the REAL repo against a REAL in-memory SQLite (better-sqlite3 through the desktop adapter), so
// schema, FTS5 and SQL are exercised exactly as in the desktop app.
import { describe, it, expect, vi, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { adapt } from "../../storage/desktopAdapter";
import { runMigrations } from "../../storage/migrate";

const raw = new Database(":memory:");
runMigrations({
  exec: (sql) => raw.exec(sql),
  getUserVersion: () => Number(raw.pragma("user_version", { simple: true })),
  setUserVersion: (v) => raw.exec(`PRAGMA user_version=${v};`),
  columns: (t) => (raw.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => String(r.name)),
});
const store = adapt(raw as any);
vi.mock("../db", () => ({ q: (s: string, p?: any[]) => store.q(s, p), run: (s: string, p?: any[]) => store.run(s, p), exec: (s: string) => store.exec(s), persist: async () => {} }));

let repo: typeof import("../repo");
beforeAll(async () => { repo = await import("../repo"); });

async function seedMeeting() {
  const s = await repo.createSession("electron", "meeting", "Google Chrome");
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", text: "Let's ship Friday.", start_ts: 0, end_ts: 2, abs_start: "2026-09-22T10:00:00.000Z" });
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "r0", text: "Agreed, I'll test locally.", start_ts: 2, end_ts: 4, abs_start: "2026-09-22T10:00:02.000Z" });
  const { segmentSession } = await import("../segmentation");
  const [cid] = await segmentSession(s.id);
  return { sid: s.id, cid };
}

describe("repo — meetings", () => {
  it("a meeting session becomes ONE conversation tagged with its app", async () => {
    const { cid } = await seedMeeting();
    const d = await repo.conversationDetail(cid);
    expect(d?.conversation.is_meeting).toBe(true);
    expect((d?.conversation as any).source_app).toBe("Google Chrome");
    expect(d?.turns).toHaveLength(2);
  });

  it("re-extracting a memory replaces its FTS row (contentless FTS5 rejects plain DELETE)", async () => {
    const { cid } = await seedMeeting();
    const mem = { conversation_id: cid, title: "Ship plan", subtitle: "We ship Friday.", summary: "Shipping Friday", facts: ["friday"], open_questions: ["Who deploys?"] };
    await repo.upsertMemory(mem);
    await repo.upsertMemory({ ...mem, summary: "Shipping Monday instead", facts: ["monday"] });
    const hits = await store.q<any>("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?", ["monday"]);
    const stale = await store.q<any>("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?", ["friday"]);
    expect(hits).toHaveLength(1);
    expect(stale).toHaveLength(0);
    const d = await repo.conversationDetail(cid);
    expect(d?.memory?.open_questions).toEqual(["Who deploys?"]);
    expect((d?.memory as any).subtitle).toBe("We ship Friday.");
  });

  it("tags, notes cache and delete", async () => {
    const { cid } = await seedMeeting();
    await repo.upsertMemory({ conversation_id: cid, title: "T", summary: "S", facts: [] });
    await repo.insertAction({ text: "Test locally", owner: "Aditya", source_conversation: cid });
    await repo.setConversationTags(cid, ["infra", "demo"]);
    await repo.setNotes(cid, "detailed", { overview: "o", topics: [] });
    expect(((await repo.getNotes(cid, "detailed")) as any)?.overview).toBe("o");
    expect((await repo.conversationDetail(cid))?.conversation.tags).toEqual(["infra", "demo"]);
    expect((await repo.conversationDetail(cid))?.actions).toHaveLength(1);

    await repo.deleteConversation(cid);
    expect(await repo.conversationDetail(cid)).toBeNull();
    expect(await store.q("SELECT * FROM turns WHERE conversation_id=?", [cid])).toHaveLength(0);
    expect(await store.q("SELECT * FROM action_items WHERE source_conversation=?", [cid])).toHaveLength(0);
    expect(await store.q("SELECT * FROM notes WHERE conversation_id=?", [cid])).toHaveLength(0);
  });
});

describe("schema self-heal", () => {
  it("adds missing columns/tables even when user_version is AHEAD of SCHEMA_VERSION", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE conversations(id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE memories(id INTEGER PRIMARY KEY); CREATE TABLE sessions(id INTEGER PRIMARY KEY); CREATE TABLE turns(id INTEGER PRIMARY KEY); PRAGMA user_version=12;");
    runMigrations({
      exec: (sql) => db.exec(sql),
      getUserVersion: () => Number(db.pragma("user_version", { simple: true })),
      setUserVersion: (v) => db.exec(`PRAGMA user_version=${v};`),
      columns: (t) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => String(r.name)),
    });
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => r.name);
    expect(cols("conversations")).toEqual(expect.arrayContaining(["tags", "source_app", "is_meeting", "project_id", "status"]));
    expect(cols("memories")).toEqual(expect.arrayContaining(["subtitle", "open_questions"]));
    expect(cols("notes")).toEqual(expect.arrayContaining(["conversation_id", "style", "data"]));
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(12); // never rolled back
  });
});
