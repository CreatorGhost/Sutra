// Unit tests for the desktop storage adapter (ticket F5, approach #3). All in-process: an in-memory
// better-sqlite3 stands in for the packaged native better-sqlite3-multiple-ciphers (same FTS5-capable
// engine, no cipher / no file / no live Electron). The adapter is exercised through the SAME code
// paths the app uses — the real MIGRATIONS + SCHEMA_VERSION from schema.ts, the exact upsertMemory
// INSERTs, and the exact memories_fts MATCH/bm25 query from search.ts — so these tests verify the
// capability the web sql.js path lacks (FTS5) on the adapter that will actually run on desktop.
//
// The Mac 🖥️ on-device verification (native rebuild + a launched Electron app doing an FTS5 search)
// is documented separately and is NOT a CI unit test.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { adapt, openDesktopStorage, type DatabaseCtor } from "../desktopAdapter";
import { runMigrations, type MigrateDriver } from "../migrate";
import { SCHEMA_VERSION } from "../../local/schema";

/** Build a fresh, migrated in-memory desktop StorageProvider via the real adapter open path (the
 *  injected Database constructor is the FTS5-capable better-sqlite3 — no cipher, no file). */
function freshStorage() {
  return openDesktopStorage({ filename: ":memory:", Database: Database as unknown as DatabaseCtor });
}

/** Pull the scalar user_version straight from a raw better-sqlite3 handle. */
function userVersion(db: InstanceType<typeof Database>): number {
  return Number(db.pragma("user_version", { simple: true }));
}

describe("desktop adapter — migrations", () => {
  it("real MIGRATIONS bring user_version to SCHEMA_VERSION and create the memories_fts FTS5 table", async () => {
    const db = new Database(":memory:");
    const driver: MigrateDriver = {
      exec: (sql) => db.exec(sql),
      getUserVersion: () => userVersion(db),
      setUserVersion: (v) => db.exec(`PRAGMA user_version=${v};`),
    };
    runMigrations(driver);

    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    // memories_fts is an FTS5 virtual table; it must exist and be queryable (proves FTS5 compiled in).
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe("memories_fts");
    // A MATCH against the empty table must not throw — the module is loaded and the table is valid.
    expect(() =>
      db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?").all("x"),
    ).not.toThrow();
  });

  it("re-running an already-applied additive migration does NOT throw and never advances past SCHEMA_VERSION", () => {
    const db = new Database(":memory:");
    const driver: MigrateDriver = {
      exec: (sql) => db.exec(sql),
      getUserVersion: () => userVersion(db),
      setUserVersion: (v) => db.exec(`PRAGMA user_version=${v};`),
    };
    runMigrations(driver);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);

    // Force a re-apply of an additive ALTER … ADD COLUMN step (migration 3 adds turns.voiceprint).
    // Reset user_version below that step so runMigrations re-issues the ALTER; the duplicate-column
    // error must be tolerated, exactly like db.ts migrate().
    db.exec("PRAGMA user_version=2;");
    expect(() => runMigrations(driver)).not.toThrow();
    // It heals back up to SCHEMA_VERSION and never overshoots it.
    expect(userVersion(db)).toBe(SCHEMA_VERSION);

    // A second full re-run from the top is a no-op and still caps at SCHEMA_VERSION.
    expect(() => runMigrations(driver)).not.toThrow();
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
  });
});

describe("desktop adapter — q/run round-trip (same SQL as upsertMemory)", () => {
  it("parameterized INSERT then SELECT returns plain row objects; run() returns {lastId, changes}", async () => {
    const s = freshStorage();

    // A conversation row is required by the memories FK (ON CONFLICT(conversation_id)).
    const convRun = await s.run("INSERT INTO conversations(id, title) VALUES(?, ?)", [1, "Sync"]);
    expect(convRun).toEqual({ lastId: expect.any(Number), changes: 1 });

    // Exactly the columns + ON CONFLICT upsert shape upsertMemory uses (repo.ts).
    const memRun = await s.run(
      `INSERT INTO memories(conversation_id,title,summary,facts,action_items,decisions,importance,type_tags,embedding,embed_model,embed_dim)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary`,
      [1, "Roadmap", "Discussed the Q3 roadmap", '["ship desktop app"]', "[]", "[]", 0.7, "[]", null, null, null],
    );
    expect(memRun.changes).toBe(1);
    expect(memRun.lastId).toBeGreaterThan(0);

    // Mirror the FTS index exactly as upsertMemory maintains it.
    await s.run("INSERT INTO memories_fts(rowid,title,summary,facts) VALUES(?,?,?,?)", [
      memRun.lastId,
      "Roadmap",
      "Discussed the Q3 roadmap",
      "ship desktop app",
    ]);

    const rows = await s.q<{ id: number; summary: string }>(
      "SELECT id, summary FROM memories WHERE conversation_id=?",
      [1],
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    // Plain row objects, same shape db.q returns.
    expect(rows[0]).toMatchObject({ id: memRun.lastId, summary: "Discussed the Q3 roadmap" });
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
  });

  it("coerces undefined params to null (parity with db.ts run())", async () => {
    const s = freshStorage();
    const r = await s.run("INSERT INTO conversations(id, title) VALUES(?, ?)", [5, undefined]);
    expect(r.changes).toBe(1);
    const [row] = await s.q<{ title: string | null }>("SELECT title FROM conversations WHERE id=?", [5]);
    expect(row.title).toBeNull();
  });
});

describe("desktop adapter — FTS5 lexical path (the capability the web sql.js path lacks)", () => {
  it("the exact search.ts MATCH/bm25 query returns the matching rowid and nothing for a non-match", async () => {
    const s = freshStorage();
    await s.run("INSERT INTO conversations(id, title) VALUES(?, ?)", [1, "c"]);
    await s.run(
      `INSERT INTO memories(conversation_id,summary,facts) VALUES(?,?,?)`,
      [1, "Quarterly roadmap planning session", "[]"],
    );
    const [{ id }] = await s.q<{ id: number }>("SELECT id FROM memories WHERE conversation_id=?", [1]);
    await s.run("INSERT INTO memories_fts(rowid,title,summary,facts) VALUES(?,?,?,?)", [
      id,
      "",
      "Quarterly roadmap planning session",
      "",
    ]);

    const FTS_QUERY =
      "SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?";

    const hit = await s.q<{ id: number }>(FTS_QUERY, ['"roadmap"', 30]);
    expect(hit.map((r) => r.id)).toEqual([id]);

    const miss = await s.q<{ id: number }>(FTS_QUERY, ['"nonexistenttoken"', 30]);
    expect(miss).toEqual([]);
  });
});

describe("adapt() — wraps an externally-opened DB", () => {
  it("maps run()/q() over a raw better-sqlite3 handle", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const s = adapt(db as any);
    const r = await s.run("INSERT INTO t(v) VALUES(?)", ["hi"]);
    expect(r).toEqual({ lastId: 1, changes: 1 });
    expect(await s.q("SELECT v FROM t WHERE id=?", [1])).toEqual([{ v: "hi" }]);
  });
});
