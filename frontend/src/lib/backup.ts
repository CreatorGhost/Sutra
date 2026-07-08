// Full local backup & restore. The on-device DB is Keystore-backed SQLCipher and the Android app sets
// allowBackup=false, so NOTHING survives an uninstall/reinstall on its own. This is the user's only
// path to keep their memory: a single self-contained JSON file they hold. Export dumps the whole DB
// via the plugin's exportToJson('full'); import wipes-and-replaces the SAME DB via importFromJson.
//
// The file is PLAINTEXT (the export is the decrypted contents) — the UI warns that anyone holding it
// can read it. We don't re-encrypt: a backup the user can't open after a reinstall is worthless, and
// the device's at-rest encryption (SQLCipher) is a separate concern from a file the user exports.
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { DB_NAME, getConnection, getSqlite, openDb, persist, resetConnectionCache } from "../local/db";

const ENVELOPE_APP = "sutra";

// memories_fts is a contentless FTS5 mirror of memories, maintained by repo writes. The plugin's
// exportToJson dumps it (plus the FTS5 shadow tables SQLite auto-creates), but those rows are
// un-importable: the validator rejects the shadow-table shape, and FTS5 internals can't be
// re-INSERTed as plain rows. We drop them on export and rebuild the index from memories on import.
const DROPPED_TABLES = new Set([
  "memories_fts",
  "memories_fts_data",
  "memories_fts_idx",
  "memories_fts_docsize",
  "memories_fts_config",
  "memories_fts_content",
]);

type Envelope = {
  app: string;
  schema_version: number;
  exported_at: string;
  // The plugin's JsonSQLite object (database/version/tables/...) — the thing importFromJson eats.
  data: unknown;
};

function yyyymmdd(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Make a plugin-exported JsonSQLite importable. exportToJson has two quirks against this schema:
 *  1. It emits the FTS5 mirror + its shadow tables, which can't be re-imported (see DROPPED_TABLES).
 *  2. It mis-exports inline table constraints. A multi-column one like `UNIQUE(type, norm_name)`
 *     comes back split as {column:"UNIQUE(type", value:"norm_name)"} (a real column name never has
 *     "("), and a single-column one like `UNIQUE(conversation_id)` comes back as
 *     {column:"", value:"UNIQUE(conversation_id)"}. The first over-counts the column total so the
 *     validator rejects every value row; the second the importer can't render at all — it skips the
 *     entry but leaves a trailing comma, yielding `CREATE TABLE (...,)` → "near \")\": syntax error".
 *     We drop both: a schema entry is kept only if the importer can emit it — a real column name (no
 *     "("), or an explicit foreignkey / constraint key. The table still re-creates with its real
 *     columns + PRIMARY KEY (uniqueness is also enforced by the app's ON CONFLICT writes, so losing
 *     an inline UNIQUE on restore is harmless).
 */
function isRenderableSchemaEntry(s: any): boolean {
  if (s && (s.foreignkey || s.constraint || s.primarykey)) return true;
  return typeof s?.column === "string" && s.column.length > 0 && !s.column.includes("(");
}
function sanitizeForImport(data: any): any {
  const tables = (data.tables ?? [])
    .filter((t: any) => !DROPPED_TABLES.has(t.name))
    .map((t: any) => {
      if (!Array.isArray(t.schema)) return t;
      return { ...t, schema: t.schema.filter(isRenderableSchemaEntry) };
    });
  return { ...data, tables };
}

async function userVersion(): Promise<number> {
  try {
    const c = await getConnection();
    const res = await c.query("PRAGMA user_version;");
    return Number((res.values?.[0] as any)?.user_version ?? 0);
  } catch {
    return 0;
  }
}

/** Dump the whole DB to a single JSON file. Native → write to Cache + Share sheet; web → download. */
export async function exportBackup(): Promise<{ filename: string; bytes: number; uri?: string }> {
  const conn = await getConnection();
  // 'full' mode dumps schema + every row (vs 'partial', which only emits rows changed since the last
  // export). encrypted defaults false → the export is plaintext JSON, intentionally portable.
  const dump = await conn.exportToJson("full");
  if (!dump?.export) throw new Error("Export produced no data.");
  // Sanitize at export time so the saved file is portable and re-importable on any device.
  const envelope: Envelope = {
    app: ENVELOPE_APP,
    schema_version: await userVersion(),
    exported_at: new Date().toISOString(),
    data: sanitizeForImport(dump.export),
  };
  const json = JSON.stringify(envelope);
  const bytes = json.length;
  const filename = `sutra-backup-${yyyymmdd()}.json`;

  if (Capacitor.isNativePlatform()) {
    const path = `exports/${filename}`;
    const written = await Filesystem.writeFile({
      path,
      data: json,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    const uri = written.uri || (await Filesystem.getUri({ path, directory: Directory.Cache })).uri;
    try {
      await Share.share({
        title: "Sutra backup",
        files: [uri],
        dialogTitle: "Save your Sutra backup",
      });
    } catch (e: any) {
      if (!/cancel/i.test(String(e?.message ?? e))) throw e;
    }
    return { filename, bytes, uri };
  }

  // Web: download a file.
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return { filename, bytes };
}

/** Read a File or raw string into the parsed, validated envelope. Throws a human-readable message. */
async function readEnvelope(file: File | string): Promise<Envelope> {
  const text = typeof file === "string" ? file : await file.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || parsed.app !== ENVELOPE_APP) {
    throw new Error("That doesn't look like a Sutra backup.");
  }
  if (!parsed.data || typeof parsed.data !== "object") {
    throw new Error("Backup file is missing its data.");
  }
  return parsed as Envelope;
}

/**
 * Replace EVERYTHING in the local DB with the contents of a backup file. Destructive by design — the
 * caller must have confirmed with the user first, and should window.location.reload() on success so
 * the cached DB connection is rebuilt cleanly.
 */
export async function importBackup(file: File | string): Promise<{ changes: number }> {
  const envelope = await readEnvelope(file);
  // Force a clean full overwrite into the SAME db name regardless of what flags the file carried:
  // mode 'full' (re-create schema + all rows) + overwrite (drop the existing DB first). We keep the
  // exported database name as-is so it lands on "sutra". Re-run sanitize defensively so older backup
  // files (made before the export sanitizer) are still importable.
  const data: any = { ...sanitizeForImport(envelope.data as any), mode: "full", overwrite: true };
  if (!data.database) data.database = DB_NAME;
  const jsonstring = JSON.stringify(data);

  const sqlite = await getSqlite();

  // Validate against the plugin's own parser before we touch the live DB.
  try {
    const valid = (await sqlite.isJsonValid(jsonstring)).result ?? false;
    if (!valid) throw new Error("Backup failed the database validity check.");
  } catch (e: any) {
    throw new Error(`Backup is not importable: ${String(e?.message ?? e)}`);
  }

  // Close the live connection so importFromJson (which drops & re-creates the DB by name) doesn't
  // race a held handle. After this the caller reloads, which re-opens via openDb().
  try {
    const open = (await sqlite.isConnection(DB_NAME, false)).result ?? false;
    if (open) await sqlite.closeConnection(DB_NAME, false);
  } catch {
    /* nothing open to close */
  }

  const res = await sqlite.importFromJson(jsonstring);
  const changes = res.changes?.changes ?? 0;
  if (changes < 0) throw new Error("Import reported a failure.");

  // We closed the live connection above, so the cached handle in db.ts is now stale — drop it so the
  // next openDb() re-establishes against the freshly imported DB.
  resetConnectionCache();

  // The FTS mirror was dropped from the backup, and migrate() won't re-create it (user_version is
  // already current after a full import), so re-create + repopulate it from the restored memories.
  await rebuildFts();

  // Web: flush jeep-sqlite's in-memory DB back to its IndexedDB store so the reload sees it.
  await persist();

  return { changes };
}

/** Re-create + repopulate the contentless FTS5 mirror from the restored memories rows. The DDL must
 *  match schema.ts; the index is then backfilled exactly as repo writes maintain it. */
async function rebuildFts(): Promise<void> {
  try {
    const conn = await openDb();
    await conn.execute(
      "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(" +
        "title, summary, facts, content='', tokenize='unicode61 remove_diacritics 2');"
    );
    await conn.execute("DELETE FROM memories_fts;");
    const rows = (await conn.query("SELECT id, title, summary, facts FROM memories")).values ?? [];
    for (const m of rows as any[]) {
      let facts = "";
      try { facts = (JSON.parse(m.facts ?? "[]") as string[]).join(" "); } catch { /* facts not JSON */ }
      await conn.run("INSERT INTO memories_fts(rowid,title,summary,facts) VALUES(?,?,?,?)",
        [m.id, m.title ?? "", m.summary ?? "", facts]);
    }
  } catch (e) {
    // A failed FTS rebuild must not fail the whole restore — the data is already in; search just
    // re-indexes as memories are next written.
    console.warn("FTS rebuild after import failed (search will re-index lazily):", e);
  }
}
