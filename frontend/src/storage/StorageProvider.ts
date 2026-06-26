// Storage seam for the desktop/web split (ticket F5). ONE StorageProvider interface is the contract
// every persistence backend implements. The exported shapes mirror db.ts exactly (q → row[],
// run → {lastId, changes}, exec/persist void) so a caller written against either is identical.
//
// Why a seam at all: the web path uses sql.js, compiled WITHOUT FTS5 — lexical search
// (memories_fts MATCH … bm25) silently returns nothing there. The desktop adapter is backed by
// better-sqlite3, which DOES ship FTS5, so the packaged desktop app gets the full hybrid-retrieval
// path. This module is the contract only; it pulls in NO native module on import.

/** Result of a write — matches db.ts run(): the new rowid and the affected-row count. */
export interface RunResult {
  lastId: number;
  changes: number;
}

/**
 * The single persistence contract. The desktop (better-sqlite3) adapter and the renderer IPC proxy
 * both satisfy it. Methods mirror db.ts's exported functions one-for-one.
 */
export interface StorageProvider {
  /** Which runtime this provider targets — for diagnostics / UI copy. */
  readonly kind: "desktop" | "web";
  /** Parameterized query → array of plain row objects (same shape db.q returns). */
  q<T = any>(sql: string, params?: any[]): Promise<T[]>;
  /** Parameterized write → { lastId, changes } (same shape db.run returns). */
  run(sql: string, params?: any[]): Promise<RunResult>;
  /** Execute one or more statements with no bound params (DDL / pragmas). */
  exec(sql: string): Promise<void>;
  /** Flush any in-memory store to durable storage (no-op where writes are already durable). */
  persist(): Promise<void>;
}
