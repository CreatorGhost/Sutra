import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from "@capacitor-community/sqlite";
import { Capacitor } from "@capacitor/core";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema";

const DB_NAME = "sutra";
let sqlite: SQLiteConnection | null = null;
let db: SQLiteDBConnection | null = null;
let opening: Promise<SQLiteDBConnection> | null = null;

const LEGACY_KEY = "sutra_db_key";

/**
 * The SQLCipher passphrase, from the CSPRNG. We hand it to the SQLite plugin, which stores it in
 * AndroidKeyStore-backed EncryptedSharedPreferences (AES-256-GCM MasterKey) — that store is the
 * SINGLE source of truth. We never persist the passphrase in JS/WebView storage. (Older builds wrote
 * a PLAINTEXT copy to localStorage; that copy — not the cipher — was the real on-device exposure.)
 */
function generateSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Legacy plaintext passphrase a prior build may have left in localStorage. Used only to preserve an
 *  already-encrypted DB during migration (reused once, then purged). */
function readLegacyPlaintextKey(): string {
  try { return (typeof localStorage !== "undefined" && localStorage.getItem(LEGACY_KEY)) || ""; }
  catch { return ""; }
}

/** One-time migration: delete the plaintext passphrase older builds left in WebView localStorage.
 *  The active secret lives in the plugin's Keystore-backed store, so this copy is pure liability
 *  (readable on a rooted device, exfiltratable via auto-backup). */
function purgeLegacyPlaintextKey(): void {
  try { if (typeof localStorage !== "undefined") localStorage.removeItem(LEGACY_KEY); }
  catch { /* ignore */ }
}

async function _open(): Promise<SQLiteDBConnection> {
  sqlite = new SQLiteConnection(CapacitorSQLite);
  const platform = Capacitor.getPlatform();
  const encrypted = platform !== "web"; // SQLCipher on device; web store is dev-only (unencrypted)
  if (platform === "web") {
    await sqlite.initWebStore();
  } else if (encrypted) {
    const stored = (await sqlite.isSecretStored()).result ?? false;
    if (!stored) {
      // First init on this device: seed the plugin's Keystore-backed secret store. If a one-version-
      // older build left a plaintext passphrase in localStorage, reuse it so the existing encrypted
      // DB still opens; otherwise mint a fresh CSPRNG passphrase. Nothing is written back to JS.
      await sqlite.setEncryptionSecret(readLegacyPlaintextKey() || generateSecret());
    }
    // Whether first-init or already-provisioned, remove any plaintext passphrase from WebView storage.
    purgeLegacyPlaintextKey();
  }
  const exists = (await sqlite.isConnection(DB_NAME, false)).result ?? false;
  const conn = exists
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, encrypted, "secret", SCHEMA_VERSION, false);
  await conn.open();
  await migrate(conn);
  if (platform === "web") await sqlite.saveToStore(DB_NAME);
  db = conn;
  return conn;
}

export async function openDb(): Promise<SQLiteDBConnection> {
  if (db) return db;
  // don't cache a REJECTED open forever (bad secret / migration failure) — clear so a later call retries
  if (!opening) { opening = _open(); opening.catch(() => { opening = null; }); }
  return opening;
}

async function migrate(c: SQLiteDBConnection): Promise<void> {
  const res = await c.query("PRAGMA user_version;");
  const cur = Number((res.values?.[0] as any)?.user_version ?? 0);
  for (let v = cur + 1; v <= SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    try {
      await c.execute(sql);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Tolerate a re-applied additive migration (ALTER ADD COLUMN has no IF NOT EXISTS) so a partial or
      // older on-device state can't permanently wedge openDb. Any other failure is a real error.
      if (!/duplicate column|already exists/i.test(msg)) throw e;
      console.warn(`migration v${v} already partially applied (${msg}); continuing`);
    }
    await c.execute(`PRAGMA user_version=${v};`);
  }
}

export async function q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const c = await openDb();
  return ((await c.query(sql, params)).values ?? []) as T[];
}

export async function run(sql: string, params: any[] = []): Promise<{ lastId: number; changes: number }> {
  const c = await openDb();
  // Defensive: the native SQLite bridge rejects `undefined` params ("No value for type"). Coerce to null.
  const safe = params.map((p) => (p === undefined ? null : p));
  const r = await c.run(sql, safe);
  return { lastId: r.changes?.lastId ?? 0, changes: r.changes?.changes ?? 0 };
}

export async function exec(sql: string): Promise<void> {
  const c = await openDb();
  await c.execute(sql);
}

/** Persist the web store after writes (no-op on native). */
export async function persist(): Promise<void> {
  if (Capacitor.getPlatform() === "web" && sqlite) await sqlite.saveToStore(DB_NAME);
}
