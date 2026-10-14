// On-device SQLite schema (port of the Postgres schema.sql). Transcripts only — no audio columns.
// pgvector vector(N) -> embedding BLOB (Float32) + dim; jsonb -> TEXT (JSON1); arrays -> JSON text.
// Bi-temporal edges (valid_from/valid_to/ingested_at) baked in from day one.
export const SCHEMA_VERSION = 10;

/** Tables added after v9 (meeting notes cache), plus `minutes` again as a safety net. Declared before
 *  MIGRATIONS (which interpolates it) and re-run idempotently by ensureSchema on every open. */
const TABLES_ENSURED = `
CREATE TABLE IF NOT EXISTS minutes(
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS notes(
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  style TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(conversation_id, style));
-- Code folders linked to a project (desktop). Ask can read them, read-only; the Mac app also keeps its own
-- list of folders the user picked in the system dialog and only ever opens those (electron/projectFolders).
-- A meeting's Ask chat, kept with the meeting. role: user | assistant | note (a note the user wrote).
-- pinned=1: added to the meeting's notes ("Added to this meeting"); error=1: the engine failed.
CREATE TABLE IF NOT EXISTS meeting_chat(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  question TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  error INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_meeting_chat ON meeting_chat(conversation_id, id);
-- Notes from screenshots (desktop, "Take screenshots during meetings"): what the AI saw on screen that the
-- transcript doesn't say, which recording it came from, and whether the user confirmed (then the
-- recording's screenshots + audio are deleted). meeting_images: the screenshots the AI kept for the notes.
CREATE TABLE IF NOT EXISTS meeting_visual(
  conversation_id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL,
  facts TEXT NOT NULL DEFAULT '[]',
  frames_seen INTEGER NOT NULL DEFAULT 0,
  frames_total INTEGER NOT NULL DEFAULT 0,
  engine TEXT,
  error TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS meeting_images(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  at INTEGER,
  caption TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS project_folders(
  project_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project_id, path));
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
-- training_audio: the ONLY place in the schema that can hold raw audio, and it is OPT-IN ONLY.
-- The default privacy invariant stands: no raw audio is persisted. Audio is used in-flight and discarded.
-- This table is only ever written if the user explicitly opts into on-device audio training (encrypted
-- on-device, never uploaded). That opt-in is currently UNWIRED/disabled in the UI, so in practice this
-- table stays empty. Do not write to it without an explicit, surfaced user consent flow.
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
-- "Clean-up Transcript": a context-aware refinement pass over a conversation's turns. Non-destructive —
-- turns.text stays the RAW source of truth; cleaned text lands here (NULL until cleaned). A per-conversation
-- conversations.refined (0/1) toggle decides whether cleaned text is shown/used; user can revert anytime.
ALTER TABLE turns ADD COLUMN text_clean TEXT;
ALTER TABLE conversations ADD COLUMN refined INTEGER NOT NULL DEFAULT 0;
`,

  6: `
-- "Minutes of Meeting": a conversation flagged as a meeting (is_meeting, set by the extractor) can have
-- structured minutes generated for it — automatically (when auto_minutes is on) or on demand via the
-- per-conversation button. Minutes are DERIVED & non-destructive: the transcript + memory stay the
-- source of truth; minutes live in their own table and can be regenerated or cleared anytime.
ALTER TABLE conversations ADD COLUMN is_meeting INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS minutes(
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')));
`,

  7: `
-- "Your Context": a PROFILE TIER of the user's personal PRIORS — beliefs the user holds (or that we
-- have derived about their world), NOT ground truth. Priors are canonicalized (one row per subject,
-- keyed on (kind, norm_subject) / shared entity_id, reinforced on re-mention) and decay over time
-- (effective confidence ramps down by a half-life). They are DERIVED & non-destructive: the transcript +
-- memories + graph stay the source of truth; priors live in their own table and can be edited, dismissed,
-- superseded, or cleared anytime. Derivation is rule-based (no extra LLM calls). Privacy: one control,
-- share_cloud (default 0); only share_cloud=1 priors ride along in cloud-mode chat. Derived priors are
-- status='suggested' (never auto-confirmed); conflicts are only FLAGGED (contradicted++) — never
-- auto-superseded (the user supersedes explicitly). Additive only — no existing table/row is touched.
CREATE TABLE IF NOT EXISTS priors(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_id INTEGER,
  subject TEXT NOT NULL,
  norm_subject TEXT NOT NULL,
  value TEXT,
  attrs TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  supported INTEGER NOT NULL DEFAULT 1,
  contradicted INTEGER NOT NULL DEFAULT 0,
  provenance TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'suggested',
  source_conversation INTEGER,
  source_turn_ids TEXT NOT NULL DEFAULT '[]',
  is_prior INTEGER NOT NULL DEFAULT 1,
  share_cloud INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to TEXT,
  last_confirmed_at TEXT,
  superseded_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_priors_norm ON priors(norm_subject);
CREATE INDEX IF NOT EXISTS idx_priors_kind ON priors(kind);
CREATE INDEX IF NOT EXISTS idx_priors_entity ON priors(entity_id);
CREATE INDEX IF NOT EXISTS idx_priors_status ON priors(status);
`,

  8: `
-- "Projects": user-authored, per-project CONTEXT that grounds the AI (cleanup + attribution + minutes).
-- A project = a one-time, user-written brief (free text, injected verbatim) + a structured people list
-- (name + role-in-THIS-project, optionally voice-linked to a known person) + canonical terms/glossary.
-- The AI never saves context on its own: it may OFFER a brief/people/terms drawn from the project's own linked
-- files (an empty brief is pre-filled, editable); people and terms are added only when the user accepts them.
-- v1 is ON-DEVICE ONLY: context_enabled (default 1) gates LOCAL use; share_cloud (default 0) is a UI
-- placeholder — cloud egress of projects is DEFERRED/disabled in v1 (never conflate the two switches).
-- Additive & non-destructive: project_id on conversations is NULLABLE; unmapped conversations are the
-- default and behave exactly as today. The SAME person can have a DIFFERENT role in different projects,
-- so role lives ONLY on project_people (membership), never globally on people.
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  brief TEXT,
  color TEXT,
  context_enabled INTEGER NOT NULL DEFAULT 1,
  share_cloud INTEGER NOT NULL DEFAULT 0,
  terms TEXT, /* JSON: [{canonical, heardAs:[]}] */
  created_at TEXT DEFAULT (datetime('now')));

-- Map a conversation to a project (NULL = unmapped = today's behavior). Nullable, additive.
ALTER TABLE conversations ADD COLUMN project_id INTEGER;

-- Per-project membership: role lives HERE (per-project), never on the global people row. One global
-- people row per human (one voiceprint); the same person may carry a different role in each project.
CREATE TABLE IF NOT EXISTS project_people(
  project_id INTEGER,
  person_id INTEGER,
  role TEXT,
  PRIMARY KEY(project_id, person_id));
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
`,

  9: `
-- Projects mapping provenance (P3). Additive & non-destructive.
-- project_auto=1 marks a SILENT, high-confidence auto-map (vs a user choice) so the UI can show a
-- "Mapped to X — undo" affordance; a user-set project clears it. suggested_project_id holds a
-- MEDIUM-confidence guess the user can one-tap confirm — the conversation stays UNMAPPED until they do
-- (low/none leaves both NULL/0, exactly today's behavior).
ALTER TABLE conversations ADD COLUMN project_auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN suggested_project_id INTEGER;
`,

  10: `
-- Meeting notes cache (Brief comes from the extraction; Detailed is generated on demand per style).
-- Meeting-capture session metadata (kind, source app), tags, subtitle and open questions are ADDITIVE
-- columns ensured by ensureSchema() below (SQLite has no ADD COLUMN IF NOT EXISTS).
${TABLES_ENSURED}
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
  ["conversations", "uid", "TEXT"],             // stable id across devices (a phone meeting saved on the Mac too)
  ["memories", "subtitle", "TEXT"],
  ["memories", "open_questions", "TEXT NOT NULL DEFAULT '[]'"],
  ["projects", "code_access", "INTEGER NOT NULL DEFAULT 1"], // Ask may read the project's linked folders
];

/** Minimal driver ensureSchema needs; both db.ts (Capacitor/sql.js) and the desktop adapter supply one. */
export interface EnsureDriver {
  exec(sql: string): Promise<void> | void;
  columns(table: string): Promise<string[]> | string[];
}

/** Idempotently create the v5 tables and add any ENSURED_COLUMNS that are missing. Run after migrations. */
export async function ensureSchema(d: EnsureDriver): Promise<void> {
  await d.exec(TABLES_ENSURED);
  const cache = new Map<string, Set<string>>();
  for (const [table, column, decl] of ENSURED_COLUMNS) {
    if (!cache.has(table)) cache.set(table, new Set((await d.columns(table)).map((c) => c.toLowerCase())));
    const cols = cache.get(table)!;
    if (!cols.size) continue; // the table itself doesn't exist here (an odd prior state) — nothing to extend
    if (cols.has(column)) continue;
    await d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
    cols.add(column);
  }
}

/** Synchronous twin of ensureSchema for the better-sqlite3 desktop adapter (its driver is sync). */
export function ensureSchemaSync(d: { exec(sql: string): void; columns(table: string): string[] }): void {
  d.exec(TABLES_ENSURED);
  for (const [table, column, decl] of ENSURED_COLUMNS) {
    const cols = d.columns(table);
    if (!cols.length || cols.some((c) => c.toLowerCase() === column)) continue; // missing table: nothing to extend
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
  }
}
