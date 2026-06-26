// db.ts desktop-delegation (ticket F7).
// Proves the storage-parity wiring:
//   (a) with a fake `globalThis.sutraDesktop` bridge present, db.ts's q/run/exec/persist forward to
//       the bridge (via createElectronStorageProvider → sutraDesktop.db) and return its rows;
//   (b) with NO bridge, the existing Capacitor/web path is used unchanged (db.ts never touches the
//       bridge and goes through openDb → the @capacitor-community/sqlite connection).
//
// db.ts memoises its provider choice on first call, so each scenario uses an ISOLATED module
// instance via vi.resetModules() + dynamic import, with the @capacitor-community/sqlite + @capacitor/core
// modules mocked so the no-bridge path is observable without a real native plugin.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Records every op forwarded across the fake IPC bridge.
type Call = { op: string; sql: string; params: unknown[] };

function installBridge(rows: any[], calls: Call[]) {
  (globalThis as any).sutraDesktop = {
    isDesktop: true,
    db: (op: string, sql: string, params: unknown[]) => {
      calls.push({ op, sql, params });
      if (op === "q") return Promise.resolve(rows);
      if (op === "run") return Promise.resolve({ lastId: 42, changes: 1 });
      return Promise.resolve(undefined); // exec / persist
    },
  };
}

function removeBridge() {
  delete (globalThis as any).sutraDesktop;
}

// A spyable fake Capacitor SQLite connection so the no-bridge path is observable.
const webConn = {
  query: vi.fn(async (_sql: string, _params: any[]) => ({ values: [{ web: true }] })),
  run: vi.fn(async (_sql: string, _params: any[]) => ({ changes: { lastId: 7, changes: 2 } })),
  execute: vi.fn(async (_sql: string) => undefined),
  open: vi.fn(async () => undefined),
};

function mockCapacitor() {
  vi.doMock("@capacitor/core", () => ({
    Capacitor: { getPlatform: () => "web", isNativePlatform: () => false },
  }));
  vi.doMock("@capacitor-community/sqlite", () => {
    const sqlite = {
      initWebStore: vi.fn(async () => undefined),
      isConnection: vi.fn(async () => ({ result: true })),
      retrieveConnection: vi.fn(async () => webConn),
      createConnection: vi.fn(async () => webConn),
      saveToStore: vi.fn(async () => undefined),
    };
    return {
      CapacitorSQLite: {},
      SQLiteConnection: vi.fn(() => sqlite),
      SQLiteDBConnection: vi.fn(),
    };
  });
  // Skip real migrations: report the connection already at the latest schema version.
  vi.doMock("../schema", () => ({ SCHEMA_VERSION: 0, MIGRATIONS: {} }));
}

beforeEach(() => {
  vi.resetModules();
  webConn.query.mockClear();
  webConn.run.mockClear();
  webConn.execute.mockClear();
});

afterEach(() => {
  removeBridge();
  vi.doUnmock("@capacitor/core");
  vi.doUnmock("@capacitor-community/sqlite");
  vi.doUnmock("../schema");
});

describe("db.ts desktop delegation", () => {
  it("(a) forwards q/run/exec/persist to the fake sutraDesktop bridge and returns its rows", async () => {
    const calls: Call[] = [];
    installBridge([{ id: 1, text: "from desktop" }], calls);
    mockCapacitor(); // present but must NOT be touched on the desktop path

    const db = await import("../db");

    const rows = await db.q("SELECT 1", [9]);
    expect(rows).toEqual([{ id: 1, text: "from desktop" }]); // bridge rows passed through verbatim

    const r = await db.run("INSERT INTO t VALUES (?)", ["x"]);
    expect(r).toEqual({ lastId: 42, changes: 1 });

    await db.exec("CREATE TABLE t(x)");
    await db.persist();

    expect(calls.map((c) => c.op)).toEqual(["q", "run", "exec", "persist"]);
    expect(calls[0]).toMatchObject({ op: "q", sql: "SELECT 1", params: [9] });
    // The Capacitor/web connection was never opened on the desktop path.
    expect(webConn.query).not.toHaveBeenCalled();
    expect(webConn.run).not.toHaveBeenCalled();
  });

  it("(b) with no bridge, uses the Capacitor/web path unchanged", async () => {
    removeBridge();
    mockCapacitor();

    const db = await import("../db");

    const rows = await db.q("SELECT 1");
    expect(rows).toEqual([{ web: true }]); // came from the mocked Capacitor connection
    // The Capacitor connection was used (openDb→migrate also issues a PRAGMA query first).
    expect(webConn.query).toHaveBeenCalledWith("SELECT 1", []);

    const r = await db.run("INSERT INTO t VALUES (?)", ["x"]);
    expect(r).toEqual({ lastId: 7, changes: 2 });
    expect(webConn.run).toHaveBeenCalledTimes(1);

    await db.exec("CREATE TABLE t(x)");
    expect(webConn.execute).toHaveBeenCalled();
  });
});
