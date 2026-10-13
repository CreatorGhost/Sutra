// Desktop backup round-trip against a REAL in-memory SQLite (better-sqlite3 via the desktop adapter),
// with the real repo writing the data — the same SQL the Electron main process runs.
import { describe, it, expect, vi, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { adapt } from "../../storage/desktopAdapter";
import { runMigrations } from "../../storage/migrate";
import { SCHEMA_VERSION } from "../../local/schema";

const raw = new Database(":memory:");
runMigrations({
  exec: (sql) => raw.exec(sql),
  getUserVersion: () => Number(raw.pragma("user_version", { simple: true })),
  setUserVersion: (v) => raw.exec(`PRAGMA user_version=${v};`),
  columns: (t) => (raw.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => String(r.name)),
});
raw.pragma("foreign_keys = ON");
const store = adapt(raw as any);
vi.mock("../../local/db", () => ({
  DB_NAME: "sutra",
  q: (s: string, p?: any[]) => store.q(s, p),
  run: (s: string, p?: any[]) => store.run(s, p),
  exec: (s: string) => store.exec(s),
  persist: async () => {},
}));

let repo: typeof import("../../local/repo");
let backup: typeof import("../backup");
beforeAll(async () => {
  repo = await import("../../local/repo");
  backup = await import("../backup");
});

/** Every user table's rows, for before/after comparison. */
function snapshot(): Record<string, unknown[]> {
  const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memories_fts%' ORDER BY name").all() as any[]).map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, raw.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all()]));
}
const ftsHits = (term: string) => (raw.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?").all(term) as any[]).map((r) => r.rowid);

async function seed() {
  const me = await repo.insertPerson("Aditya", true, [0.1, 0.2, 0.3]);
  await repo.insertPerson("Priya O'Neil");
  const s = await repo.createSession("electron", "meeting", "Zoom");
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", person_id: me, text: "Ship it on Friday — 'quoted'.", start_ts: 0, end_ts: 2, abs_start: "2026-09-22T10:00:00.000Z" });
  const cid = await repo.insertConversation({ session_id: s.id, started_at: "2026-09-22T10:00:00.000Z", ended_at: "2026-09-22T10:30:00.000Z" });
  await repo.upsertMemory({ conversation_id: cid, title: "Launch plan", summary: "Shipping Friday", facts: ["kangaroo"], decisions: ["ship"] });
  await repo.insertAction({ text: "Write release notes", owner: "Aditya", source_conversation: cid });
  await repo.putSettings({ mcp_enabled: true, recap_time: "08:30", transcript_lang: "hinglish" });
  await repo.insertPrior({ kind: "person", subject: "Priya", value: "my manager", provenance: "user", status: "confirmed", confidence: 0.8 });
  // A real BLOB column (training audio) must survive the JSON trip byte-for-byte.
  raw.prepare("INSERT INTO training_samples(source,lang,consent_version,transcript) VALUES('live','en','v1','t')").run();
  raw.prepare("INSERT INTO training_audio(sample_id,audio,mime) VALUES(1,?,?)").run(Buffer.from([0, 1, 2, 250, 255]), "audio/wav");
  return cid;
}

describe("desktop backup (SQL dump / restore)", () => {
  it("round-trips every table, BLOBs included, and rebuilds the search index", async () => {
    await seed();
    const before = snapshot();
    const file = JSON.stringify(await backup.buildSqlDump());
    const parsed = JSON.parse(file);
    expect(parsed.app).toBe("sutra");
    expect(parsed.schema_version).toBe(SCHEMA_VERSION);
    expect(parsed.data.tables.map((t: any) => t.name)).not.toContain("memories_fts");

    // Diverge: add, change and delete data after the backup was taken.
    const extra = await repo.insertPerson("Someone New");
    await repo.putSettings({ recap_time: "21:00" });
    raw.exec("DELETE FROM action_items");
    await repo.upsertMemory({ conversation_id: 1, title: "Changed", summary: "Monday now", facts: ["wombat"] });
    expect(ftsHits("wombat")).toHaveLength(1);

    const r = await backup.restoreSqlDump(file);
    expect(r.changes).toBeGreaterThan(5);
    expect(snapshot()).toEqual(before);
    expect((await repo.listPeople()).map((p: any) => p.id)).not.toContain(extra);
    expect((await repo.getSettings())["recap_time"]).toBe("08:30");
    expect(Buffer.from((raw.prepare("SELECT audio FROM training_audio").get() as any).audio)).toEqual(Buffer.from([0, 1, 2, 250, 255]));
    expect(ftsHits("kangaroo")).toEqual([1]);
    expect(ftsHits("wombat")).toEqual([]);
    expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("rejects bad files before touching anything", async () => {
    const before = snapshot();
    await expect(backup.restoreSqlDump("not json")).rejects.toThrow(/valid JSON/);
    await expect(backup.restoreSqlDump(JSON.stringify({ app: "other", data: {} }))).rejects.toThrow(/Sutra backup/);
    await expect(backup.restoreSqlDump(JSON.stringify({ app: "sutra", schema_version: SCHEMA_VERSION + 1, data: { tables: [] } }))).rejects.toThrow(/newer version/);
    await expect(backup.restoreSqlDump(JSON.stringify({ app: "sutra", schema_version: 1, data: { tables: [{ name: "people", schema: [{ column: "id", value: "INTEGER" }], values: [[1, 2]] }] } }))).rejects.toThrow(/doesn't match/);
    await expect(backup.restoreSqlDump(JSON.stringify({ app: "sutra", schema_version: 1, data: { tables: [{ name: "nope", schema: [{ column: "x" }], values: [] }] } }))).rejects.toThrow(/no data/);
    expect(snapshot()).toEqual(before);
  });

  it("rolls back completely when a row fails mid-restore", async () => {
    const before = snapshot();
    const dump: any = await backup.buildSqlDump();
    const people = dump.data.tables.find((t: any) => t.name === "people");
    const nameIdx = people.schema.findIndex((s: any) => s.column === "canonical_name");
    people.values.push(people.values[0].map((v: unknown, i: number) => (i === nameIdx ? null : i === 0 ? 999 : v))); // NOT NULL violation
    await expect(backup.restoreSqlDump(JSON.stringify(dump))).rejects.toThrow(/nothing was changed/);
    expect(snapshot()).toEqual(before);
    // The connection is usable (no dangling transaction) and FK enforcement is back on.
    await repo.putSettings({ after_failure: true });
    expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("restores a phone (Capacitor JsonSQLite) export, quirky constraint entries and all", async () => {
    const phone = {
      app: "sutra",
      schema_version: SCHEMA_VERSION,
      exported_at: "2026-09-01T00:00:00Z",
      data: {
        database: "sutra", version: SCHEMA_VERSION, encrypted: false, mode: "full",
        tables: [
          { name: "people", schema: [{ column: "id", value: "INTEGER PRIMARY KEY AUTOINCREMENT" }, { column: "canonical_name", value: "TEXT NOT NULL" }, { column: "is_me", value: "INTEGER" }, { column: "", value: "UNIQUE(canonical_name)" }],
            values: [[7, "Phone Me", 1], [8, "Ravi", 0]] },
          { name: "settings", schema: [{ column: "id", value: "INTEGER" }, { column: "data", value: "TEXT" }], values: [[1, JSON.stringify({ recap_time: "07:15" })]] },
          { name: "memories_fts", schema: [{ column: "title" }], values: [["x"]] },
          { name: "future_table", schema: [{ column: "a" }], values: [[1]] },
        ],
      },
    };
    await backup.restoreSqlDump(JSON.stringify(phone));
    expect((await repo.listPeople()).map((p: any) => [p.id, p.canonical_name, !!p.is_me])).toEqual([[7, "Phone Me", true], [8, "Ravi", false]]);
    expect((await repo.getSettings())["recap_time"]).toBe("07:15");
    expect(raw.prepare("SELECT count(*) n FROM conversations").get()).toEqual({ n: 0 });
  });
});
