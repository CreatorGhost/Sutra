// On-device SQLite schema (port of the Postgres schema.sql). Transcripts only — no audio columns.
// pgvector vector(N) -> embedding BLOB (Float32) + dim; jsonb -> TEXT (JSON1); arrays -> JSON text.
// Bi-temporal edges (valid_from/valid_to/ingested_at) baked in from day one.
export const SCHEMA_VERSION = 5;

/** v5 tables — declared before MIGRATIONS (which interpolates it) and re-run by ensureSchema. */
const TABLES_V5 = `
CREATE TABLE IF NOT EXISTS priors(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id INTEGER, subject TEXT NOT NULL,
  norm_subject TEXT NOT NULL, value TEXT, attrs TEXT NOT NULL DEFAULT '{}', confidence REAL NOT NULL DEFAULT 0.5,
  supported INTEGER NOT NULL DEFAULT 1, contradicted INTEGER NOT NULL DEFAULT 0, provenance TEXT NOT NULL DEFAULT 'derived',
  status TEXT NOT NULL DEFAULT 'suggested', source_conversation INTEGER, source_turn_ids TEXT NOT NULL DEFAULT '[]',
  is_prior INTEGER NOT NULL DEFAULT 1, share_cloud INTEGER NOT NULL DEFAULT 0, valid_from TEXT, valid_to TEXT,
  last_confirmed_at TEXT, superseded_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, brief TEXT, color TEXT,
  context_enabled INTEGER NOT NULL DEFAULT 1, share_cloud INTEGER NOT NULL DEFAULT 0, terms TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS project_people(
  project_id INTEGER NOT NULL, person_id INTEGER NOT NULL, role TEXT, PRIMARY KEY(project_id, person_id));
CREATE TABLE IF NOT EXISTS notes(
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  style TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(conversation_id, style));
`;

export const MIGRATIONS: Record<number, string> = {
  1: `
CREATE TABLE IF NOT EXISTS people(
  id INTEGER PRIMARY KEY AUTOINCREMENT, canonical_name TEXT NOT NULL,
  is_me INTEGER NOT NULL DEFAULT 0, provisional INTEGER NOT NULL DEFAULT 0,
  voiceprint BLOB, voiceprint_dim INTEGER, enroll_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT, status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT (datetime('now')), ended_at TEXT);

CREATE TABLE IF NOT EXISTS turns(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  window_index INTEGER NOT NULL DEFAULT 0, session_speaker_label TEXT NOT NULL,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL, speaker_confidence REAL,
  text TEXT NOT NULL, lang TEXT, start_ts REAL, end_ts REAL, abs_start TEXT,
  conversation_id INTEGER, redacted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS conversations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, title TEXT,
  started_at TEXT, ended_at TEXT, participant_person_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  summary TEXT NOT NULL, facts TEXT NOT NULL DEFAULT '[]', action_items TEXT NOT NULL DEFAULT '[]',
  decisions TEXT NOT NULL DEFAULT '[]', importance REAL NOT NULL DEFAULT 0.5,
  type_tags TEXT NOT NULL DEFAULT '[]', title TEXT,
  embedding BLOB, embed_model TEXT, embed_dim INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(conversation_id));

-- contentless FTS (BM25) mirror of memories; rowid = memories.id, maintained by the repo
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, summary, facts, content='', tokenize='unicode61 remove_diacritics 2');

CREATE TABLE IF NOT EXISTS entities(
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, canonical_name TEXT NOT NULL,
  norm_name TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}',
  embedding BLOB, embed_dim INTEGER, importance REAL NOT NULL DEFAULT 0.5,
  mention_count INTEGER NOT NULL DEFAULT 1, person_id INTEGER,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type, norm_name));

CREATE TABLE IF NOT EXISTS edges(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_entity INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_entity INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0, evidence TEXT NOT NULL DEFAULT '[]',
  valid_from TEXT, valid_to TEXT, ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(src_entity, dst_entity, relation));

CREATE TABLE IF NOT EXISTS action_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, owner TEXT,
  status TEXT NOT NULL DEFAULT 'open', due TEXT, source_conversation INTEGER,
  generated_draft TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS daily_rollups(
  id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL UNIQUE, summary TEXT,
  highlights TEXT NOT NULL DEFAULT '[]', open_actions TEXT NOT NULL DEFAULT '[]',
  emailed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL DEFAULT '{}');
INSERT OR IGNORE INTO settings(id, data) VALUES (1, '{}');

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_conv ON turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_turns_person ON turns(person_id);
CREATE INDEX IF NOT EXISTS idx_memories_conv ON memories(conversation_id);
CREATE INDEX IF NOT EXISTS idx_entities_norm ON entities(norm_name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_entity);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_entity);
CREATE INDEX IF NOT EXISTS idx_edges_valid ON edges(valid_to);
CREATE INDEX IF NOT EXISTS idx_action_status ON action_items(status);
`,

  2: `
-- Opt-in fine-tuning corpus. Separate from app data; user-controlled (view/export/wipe); never auto-uploaded.
CREATE TABLE IF NOT EXISTS training_samples(
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT, lang TEXT, consent_version TEXT, redacted INTEGER NOT NULL DEFAULT 0,
  has_audio INTEGER NOT NULL DEFAULT 0, model_id TEXT, prompt_version TEXT, conversation_id INTEGER,
  transcript TEXT);
CREATE TABLE IF NOT EXISTS training_extraction(sample_id INTEGER PRIMARY KEY, extraction_raw TEXT, extraction_corrected TEXT);
CREATE TABLE IF NOT EXISTS training_asr(sample_id INTEGER PRIMARY KEY, asr_raw TEXT, asr_corrected TEXT, diarization TEXT);
CREATE TABLE IF NOT EXISTS training_audio(sample_id INTEGER PRIMARY KEY, audio BLOB, mime TEXT);
CREATE TABLE IF NOT EXISTS training_edits(id INTEGER PRIMARY KEY AUTOINCREMENT, sample_id INTEGER, field TEXT, before TEXT, after TEXT, ts TEXT NOT NULL DEFAULT (datetime('now')));
`,

  3: `
-- Per-turn ECAPA voiceprint (192-d, base64 TEXT — see util.vecToBlob; NOT a raw BLOB, the native
-- bridge rejects bound Uint8Arrays). Computed server-side from in-flight audio (vectors only). Used
-- on-device to cluster a session's turns into stable speakers and match them to enrolled people.
ALTER TABLE turns ADD COLUMN voiceprint TEXT;
`,

  4: `
-- Conversation processing status so a failed extraction shows "Retry" instead of a frozen
-- "still processing…". pending = segmented, not yet extracted; done = memory written; failed = extraction threw.
ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

-- Scheduled / time-bound events extracted from a conversation ("kal 11 baje meeting", "5pm send files").
-- start_ts is an ISO datetime resolved against the conversation date (null when unresolvable).
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT NOT NULL, when_text TEXT, start_ts TEXT, kind TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_ts);
CREATE INDEX IF NOT EXISTS idx_events_conv ON events(conversation_id);
`,

  5: `
-- Tables the repo layer already reads/writes but that no earlier committed migration created
-- (priors, projects, project_people), plus meeting notes (one row per conversation per style).
${TABLES_V5}
`,
};


/** Additive columns ensured on EVERY open (not just on a version bump). SQLite has no
 *  `ADD COLUMN IF NOT EXISTS`, and local databases in the wild were migrated by builds whose
 *  migrations never landed here (user_version can be AHEAD of SCHEMA_VERSION), so a plain versioned
 *  migration can't be trusted to have created these. ensureSchema() checks PRAGMA table_info and only
 *  adds what's missing — idempotent and safe on any prior state. */
export const ENSURED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, decl: string]> = [
  ["sessions", "kind", "TEXT"],                 // 'meeting' (two-channel, one conversation) | 'ambient'
  ["sessions", "source_app", "TEXT"],           // detected meeting app, e.g. "Google Chrome"
  ["turns", "text_clean", "TEXT"],
  ["conversations", "status", "TEXT NOT NULL DEFAULT 'pending'"],
  ["conversations", "refined", "INTEGER NOT NULL DEFAULT 0"],
  ["conversations", "is_meeting", "INTEGER NOT NULL DEFAULT 0"],
  ["conversations", "source_app", "TEXT"],
  ["conversations", "tags", "TEXT NOT NULL DEFAULT '[]'"],
  ["conversations", "project_id", "INTEGER"],
  ["conversations", "project_auto", "INTEGER NOT NULL DEFAULT 0"],
  ["conversations", "suggested_project_id", "INTEGER"],
  ["memories", "subtitle", "TEXT"],
  ["memories", "open_questions", "TEXT NOT NULL DEFAULT '[]'"],
];

/** Minimal driver ensureSchema needs; both db.ts (Capacitor/sql.js) and the desktop adapter supply one. */
export interface EnsureDriver {
  exec(sql: string): Promise<void> | void;
  columns(table: string): Promise<string[]> | string[];
}

/** Idempotently create the v5 tables and add any ENSURED_COLUMNS that are missing. Run after migrations. */
export async function ensureSchema(d: EnsureDriver): Promise<void> {
  await d.exec(TABLES_V5);
  const cache = new Map<string, Set<string>>();
  for (const [table, column, decl] of ENSURED_COLUMNS) {
    if (!cache.has(table)) cache.set(table, new Set((await d.columns(table)).map((c) => c.toLowerCase())));
    const cols = cache.get(table)!;
    if (cols.has(column)) continue;
    await d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
    cols.add(column);
  }
}

/** Synchronous twin of ensureSchema for the better-sqlite3 desktop adapter (its driver is sync). */
export function ensureSchemaSync(d: { exec(sql: string): void; columns(table: string): string[] }): void {
  d.exec(TABLES_V5);
  for (const [table, column, decl] of ENSURED_COLUMNS) {
    if (d.columns(table).some((c) => c.toLowerCase() === column)) continue;
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
  }
}
