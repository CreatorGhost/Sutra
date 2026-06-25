// Shared migration runner for the desktop (better-sqlite3) storage adapter. Runs the REAL
// MIGRATIONS + SCHEMA_VERSION from src/local/schema.ts — the same DDL the web/native db.ts migrate()
// applies — so there is exactly one source of truth for the schema across every backend.
//
// Behavior parity with db.ts migrate() (see src/local/db.ts):
//   • steps from PRAGMA user_version + 1 up to SCHEMA_VERSION,
//   • TOLERATES a re-applied additive migration (ALTER … ADD COLUMN has no IF NOT EXISTS) — a
//     "duplicate column" / "already exists" error from a partially-applied step is swallowed and the
//     step is treated as done, so a partial on-device state can't permanently wedge open,
//   • bumps user_version one step at a time and NEVER advances it past SCHEMA_VERSION.
//
// better-sqlite3 is synchronous, so this is a plain sync function over a tiny driver interface (no
// dependency on better-sqlite3 itself — the adapter injects exec/userVersion). That also lets the
// unit test drive it against an in-memory DB without any async plumbing.
import { MIGRATIONS, SCHEMA_VERSION } from "../local/schema";

/** The minimal synchronous driver migrate() needs — supplied by the desktop adapter. */
export interface MigrateDriver {
  /** Run a (possibly multi-statement) SQL string with no bound params. */
  exec(sql: string): void;
  /** Read the current PRAGMA user_version. */
  getUserVersion(): number;
  /** Set PRAGMA user_version to v. */
  setUserVersion(v: number): void;
}

/** Apply pending migrations up to SCHEMA_VERSION. Idempotent and tolerant of a partially-applied
 *  additive step, matching db.ts migrate(). */
export function runMigrations(driver: MigrateDriver): void {
  const cur = driver.getUserVersion();
  for (let v = cur + 1; v <= SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    try {
      driver.exec(sql);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Tolerate a re-applied additive migration (ALTER ADD COLUMN has no IF NOT EXISTS) so a partial
      // or older on-device state can't permanently wedge the open. Any other failure is a real error.
      if (!/duplicate column|already exists/i.test(msg)) throw e;
      console.warn(`migration v${v} already partially applied (${msg}); continuing`);
    }
    driver.setUserVersion(v);
  }
}
