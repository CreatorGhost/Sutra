-- Sutra schema. Idempotent (safe to run on every boot). TRANSCRIPTS ONLY — no audio columns anywhere.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- People (canonical identities). voiceprint = ECAPA 192-d embedding, computed in-flight, audio discarded.
CREATE TABLE IF NOT EXISTS people (
    id              BIGSERIAL PRIMARY KEY,
    canonical_name  TEXT NOT NULL,
    is_me           BOOLEAN NOT NULL DEFAULT FALSE,
    provisional     BOOLEAN NOT NULL DEFAULT FALSE,  -- auto-discovered speaker, not yet named
    voiceprint      vector(192),
    enroll_count    INT NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Capture sessions.
CREATE TABLE IF NOT EXISTS sessions (
    id          BIGSERIAL PRIMARY KEY,
    device      TEXT,
    status      TEXT NOT NULL DEFAULT 'active',     -- active | closed
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ
);

-- Diarized turns. session_speaker_label is the per-call A/B/C; person_id is the resolved identity.
CREATE TABLE IF NOT EXISTS turns (
    id                     BIGSERIAL PRIMARY KEY,
    session_id             BIGINT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    window_index           INT NOT NULL DEFAULT 0,
    session_speaker_label  TEXT NOT NULL,
    person_id              BIGINT REFERENCES people(id) ON DELETE SET NULL,
    speaker_confidence     REAL,
    text                   TEXT NOT NULL,
    lang                   TEXT,                      -- 'en' | 'hi' | 'hi-en' (heuristic)
    start_ts               DOUBLE PRECISION,          -- seconds within window
    end_ts                 DOUBLE PRECISION,
    abs_start              TIMESTAMPTZ,
    conversation_id        BIGINT,                    -- set during segmentation
    redacted               BOOLEAN NOT NULL DEFAULT FALSE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conversations (segmented from turns).
CREATE TABLE IF NOT EXISTS conversations (
    id                      BIGSERIAL PRIMARY KEY,
    session_id              BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
    title                   TEXT,
    started_at              TIMESTAMPTZ,
    ended_at                TIMESTAMPTZ,
    participant_person_ids  BIGINT[] NOT NULL DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extracted memory per conversation. embedding = text-embedding-3-large @ 1536 dims.
CREATE TABLE IF NOT EXISTS memories (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    summary          TEXT NOT NULL,
    facts            JSONB NOT NULL DEFAULT '[]',
    action_items     JSONB NOT NULL DEFAULT '[]',
    decisions        JSONB NOT NULL DEFAULT '[]',
    importance_score REAL NOT NULL DEFAULT 0.5,
    type_tags        TEXT[] NOT NULL DEFAULT '{}',
    embedding        vector(1536),
    search_tsv       tsvector,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Knowledge-graph nodes.
CREATE TABLE IF NOT EXISTS entities (
    id              BIGSERIAL PRIMARY KEY,
    type            TEXT NOT NULL,    -- person|project|topic|org|place|event|commitment
    canonical_name  TEXT NOT NULL,
    norm_name       TEXT NOT NULL,    -- lowercased/trimmed for dedupe
    attrs           JSONB NOT NULL DEFAULT '{}',
    embedding       vector(1536),
    importance      REAL NOT NULL DEFAULT 0.5,
    mention_count   INT NOT NULL DEFAULT 1,
    person_id       BIGINT REFERENCES people(id) ON DELETE SET NULL,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT entities_type_norm_uniq UNIQUE (type, norm_name)
);

-- Knowledge-graph edges (typed, weighted, with evidence).
CREATE TABLE IF NOT EXISTS edges (
    id          BIGSERIAL PRIMARY KEY,
    src_entity  BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    dst_entity  BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation    TEXT NOT NULL,
    weight      REAL NOT NULL DEFAULT 1.0,
    evidence    JSONB NOT NULL DEFAULT '[]',   -- [{conversation_id, turn_ids:[...]}]
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT edges_uniq UNIQUE (src_entity, dst_entity, relation)
);

-- Action items (tracked; generated_draft is the Gmail/Calendar draft TEXT, not sent).
CREATE TABLE IF NOT EXISTS action_items (
    id                   BIGSERIAL PRIMARY KEY,
    text                 TEXT NOT NULL,
    owner                TEXT,
    status               TEXT NOT NULL DEFAULT 'open',   -- open | done | dropped
    due                  DATE,
    source_conversation  BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
    generated_draft      TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily rollups (emailed recap).
CREATE TABLE IF NOT EXISTS daily_rollups (
    id           BIGSERIAL PRIMARY KEY,
    day          DATE NOT NULL UNIQUE,
    summary      TEXT,
    highlights   JSONB NOT NULL DEFAULT '[]',
    open_actions JSONB NOT NULL DEFAULT '[]',
    emailed_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row settings (UI-editable overrides; env remains the default source).
CREATE TABLE IF NOT EXISTS settings (
    id    INT PRIMARY KEY DEFAULT 1,
    data  JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT settings_singleton CHECK (id = 1)
);
INSERT INTO settings (id, data) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_turns_session       ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_conv          ON turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_turns_person        ON turns(person_id);
CREATE INDEX IF NOT EXISTS idx_memories_conv       ON memories(conversation_id);
CREATE INDEX IF NOT EXISTS idx_memories_tsv        ON memories USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_memories_embedding  ON memories USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
CREATE INDEX IF NOT EXISTS idx_entities_norm       ON entities(norm_name);
CREATE INDEX IF NOT EXISTS idx_entities_type       ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_embedding  ON entities USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
CREATE INDEX IF NOT EXISTS idx_entities_trgm       ON entities USING gin (norm_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_edges_src           ON edges(src_entity);
CREATE INDEX IF NOT EXISTS idx_edges_dst           ON edges(dst_entity);
CREATE INDEX IF NOT EXISTS idx_people_voiceprint   ON people USING hnsw (voiceprint vector_cosine_ops) WITH (m=16, ef_construction=64);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);

-- one memory per conversation (idempotent) -> enables ON CONFLICT upsert on re-extraction
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_conversation_uniq') THEN
    ALTER TABLE memories ADD CONSTRAINT memories_conversation_uniq UNIQUE (conversation_id);
  END IF;
END $$;
