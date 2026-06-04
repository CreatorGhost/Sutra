// On-device SQLite schema (port of the Postgres schema.sql). Transcripts only — no audio columns.
// pgvector vector(N) -> embedding BLOB (Float32) + dim; jsonb -> TEXT (JSON1); arrays -> JSON text.
// Bi-temporal edges (valid_from/valid_to/ingested_at) baked in from day one.
export const SCHEMA_VERSION = 4;

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
};
