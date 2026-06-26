-- Sutra schema. Idempotent (safe to run on every boot). TRANSCRIPTS ONLY — no audio columns anywhere.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ============================================================================
-- TIER B — Accounts (multi-tenant). Every user-data row below carries user_id.
-- Designed so Google/Facebook OAuth slot in later over this SAME table + JWT:
-- add an auth_provider value + (later) an oauth identities table; nothing else changes.
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          CITEXT UNIQUE NOT NULL,
    password_hash  TEXT,                                  -- null for pure-OAuth accounts (future)
    auth_provider  TEXT NOT NULL DEFAULT 'password',      -- password | google | facebook
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seeded system user. Owns any rows captured by the single-tenant server variant BEFORE Tier B
-- existed, so the NOT NULL user_id backfill below is clean and existing tests stay green.
-- Fixed UUID so backfill + tests can reference it deterministically.
INSERT INTO users (id, email, password_hash, auth_provider)
VALUES ('00000000-0000-0000-0000-000000000001', 'system@sutra.local', NULL, 'system')
ON CONFLICT (id) DO NOTHING;

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
    is_meeting              BOOLEAN NOT NULL DEFAULT FALSE,
    refined                 BOOLEAN NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Extracted memory per conversation. embedding = text-embedding-3-large @ 1536 dims.
CREATE TABLE IF NOT EXISTS memories (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    title            TEXT,
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

-- Scheduled / time-bound events extracted from a conversation (device schema.ts migration 4).
CREATE TABLE IF NOT EXISTS events (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    when_text        TEXT,
    start_ts         TIMESTAMPTZ,
    kind             TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Minutes of Meeting (device schema.ts migration 6). One derived blob per conversation.
CREATE TABLE IF NOT EXISTS minutes (
    conversation_id  BIGINT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    data             JSONB NOT NULL DEFAULT '{}',
    generated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Your Context priors (device schema.ts migration 7). Only share_cloud=1 ever syncs to the server.
CREATE TABLE IF NOT EXISTS priors (
    id                   BIGSERIAL PRIMARY KEY,
    kind                 TEXT NOT NULL,
    entity_id            BIGINT,
    subject              TEXT NOT NULL,
    norm_subject         TEXT NOT NULL,
    value                TEXT,
    attrs                JSONB NOT NULL DEFAULT '{}',
    confidence           REAL NOT NULL DEFAULT 0.5,
    supported            INT NOT NULL DEFAULT 1,
    contradicted         INT NOT NULL DEFAULT 0,
    provenance           TEXT NOT NULL DEFAULT 'derived',
    status               TEXT NOT NULL DEFAULT 'suggested',
    source_conversation  BIGINT,
    is_prior             BOOLEAN NOT NULL DEFAULT TRUE,
    share_cloud          BOOLEAN NOT NULL DEFAULT FALSE,
    valid_from           TIMESTAMPTZ,
    valid_to             TIMESTAMPTZ,
    last_confirmed_at    TIMESTAMPTZ,
    superseded_by        BIGINT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily rollups (emailed recap).
CREATE TABLE IF NOT EXISTS daily_rollups (
    id           BIGSERIAL PRIMARY KEY,
    day          DATE NOT NULL,
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

-- Columns added to pre-existing tables (the CREATE ... IF NOT EXISTS above is a no-op on an already
-- applied single-tenant DB, so new columns are added explicitly here to upgrade old databases too).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_meeting BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS refined    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE memories      ADD COLUMN IF NOT EXISTS title      TEXT;

-- ============================================================================
-- TIER B — Phase 2 write tools: origin provenance on the two write-tool targets.
-- 'device' = synced from the phone (the phone stays source of truth — /sync replaces these); 'mcp' =
-- created/edited by an MCP write tool (these SURVIVE /sync, see app/sync.py). Default 'device' so every
-- legacy + synced row is correctly classified without a backfill step.
-- ============================================================================
ALTER TABLE priors       ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'device';
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'device';
-- CHECK constraints added once (named, IF-NOT-EXISTS guarded — same pattern as the FK/unique blocks).
DO $origin_checks$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='priors_origin_chk') THEN
        ALTER TABLE priors ADD CONSTRAINT priors_origin_chk CHECK (origin IN ('device','mcp'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='action_items_origin_chk') THEN
        ALTER TABLE action_items ADD CONSTRAINT action_items_origin_chk CHECK (origin IN ('device','mcp'));
    END IF;
END $origin_checks$;

-- ============================================================================
-- TIER B — multi-tenant column threaded onto every user-data table.
-- Added via idempotent ALTERs (the CREATEs above are the legacy single-tenant
-- shape; this block upgrades both a fresh DB and an already-applied one).
-- Pattern per table: add a nullable user_id, backfill existing rows to the
-- system user, then enforce NOT NULL + the FK + composite indexes.
-- ============================================================================
DO $tierb$
DECLARE
    sys_uid CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
    tbl TEXT;
    user_tables CONSTANT TEXT[] := ARRAY[
        'people','sessions','turns','conversations','memories','entities','edges',
        'action_items','events','minutes','priors','daily_rollups'
    ];
BEGIN
    FOREACH tbl IN ARRAY user_tables LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS user_id UUID', tbl);
        EXECUTE format('UPDATE %I SET user_id = %L WHERE user_id IS NULL', tbl, sys_uid);
        -- DEFAULT to the system user so the SINGLE-TENANT capture path (api.py / services/* inserts
        -- that don't know about user_id) keeps working unchanged: every legacy insert lands under the
        -- system user. Tier B inserts (sync / write tools) always pass an explicit user_id.
        EXECUTE format('ALTER TABLE %I ALTER COLUMN user_id SET DEFAULT %L', tbl, sys_uid);
        EXECUTE format('ALTER TABLE %I ALTER COLUMN user_id SET NOT NULL', tbl);
        -- FK to users(id). Added once; named so the IF-NOT-EXISTS guard is cheap.
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = tbl || '_user_fk'
        ) THEN
            EXECUTE format(
                'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
                tbl, tbl || '_user_fk'
            );
        END IF;
    END LOOP;
END
$tierb$;

-- Per-user uniqueness replaces the old global UNIQUE constraints (a fact/edge/day/conversation is
-- unique WITHIN a user, not across the whole server). Drop the legacy single-tenant uniques and add
-- composite (user_id, <key>) ones so two users can hold the "same" row independently.
ALTER TABLE memories      DROP CONSTRAINT IF EXISTS memories_conversation_uniq;
ALTER TABLE entities      DROP CONSTRAINT IF EXISTS entities_type_norm_uniq;
ALTER TABLE edges         DROP CONSTRAINT IF EXISTS edges_uniq;
-- daily_rollups had an inline `day DATE NOT NULL UNIQUE` whose auto-name is daily_rollups_day_key on an
-- already-applied DB; drop it so the per-user (user_id, day) unique below is the only one.
ALTER TABLE daily_rollups DROP CONSTRAINT IF EXISTS daily_rollups_day_key;

DO $uniques$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='memories_user_conv_uniq') THEN
        ALTER TABLE memories ADD CONSTRAINT memories_user_conv_uniq UNIQUE (user_id, conversation_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='entities_user_type_norm_uniq') THEN
        ALTER TABLE entities ADD CONSTRAINT entities_user_type_norm_uniq UNIQUE (user_id, type, norm_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='edges_user_uniq') THEN
        ALTER TABLE edges ADD CONSTRAINT edges_user_uniq UNIQUE (user_id, src_entity, dst_entity, relation);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='daily_rollups_user_day_uniq') THEN
        ALTER TABLE daily_rollups ADD CONSTRAINT daily_rollups_user_day_uniq UNIQUE (user_id, day);
    END IF;
END $uniques$;

-- ============================================================================
-- TIER B — audit_log for Phase-2 write tools (before/after snapshots, reversible).
-- Read tools never touch this; it exists now so the write-tool agent has a stable target.
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool          TEXT NOT NULL,
    args_summary  JSONB NOT NULL DEFAULT '{}',
    before        JSONB,
    after         JSONB,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- TIER B — Phase 2 consent (default-deny). One row per user holding the MCP-write flags as a JSONB
-- blob. Absent row OR absent key == false (read in app/mcp_write_settings.py): the master switch and
-- every per-tool switch default OFF, so a write tool refuses until the user explicitly opts in.
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_settings (
    user_id  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data     JSONB NOT NULL DEFAULT '{}'
);

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
CREATE INDEX IF NOT EXISTS idx_events_start        ON events(start_ts);
CREATE INDEX IF NOT EXISTS idx_events_conv         ON events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_priors_norm         ON priors(norm_subject);
CREATE INDEX IF NOT EXISTS idx_priors_kind         ON priors(kind);
CREATE INDEX IF NOT EXISTS idx_priors_status       ON priors(status);

-- ============================================================================
-- CONTROL PLANE — plans / entitlements / usage (docs/MONETIZATION-PLAN.md §3).
-- Identity + entitlement only: NO user content lives here. Tiers exist from day 1
-- but everything is free during testing — usage is metered now to price them later.
-- ============================================================================
-- NOTE: the per-month audio cap is named transcribe_seconds_month (NOT audio_*) on purpose: the
-- no-audio-columns invariant test bans audio-like column names, and this is a numeric CAP on the
-- transcribe kind, not audio content. Audio itself is never persisted anywhere.
CREATE TABLE IF NOT EXISTS plans (
    id                        TEXT PRIMARY KEY,         -- 'testing' | 'free' | 'pro' | 'dev'
    name                      TEXT NOT NULL,
    transcribe_seconds_month  INTEGER,                  -- NULL = unlimited
    ai_calls_month            INTEGER,                  -- extract+chat+embed+rerank combined; NULL = unlimited
    price_inr_month           INTEGER NOT NULL DEFAULT 0,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time fixup for DBs created while the cap was briefly named audio_seconds_month.
DO $plans_rename$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='plans' AND column_name='audio_seconds_month') THEN
        ALTER TABLE plans RENAME COLUMN audio_seconds_month TO transcribe_seconds_month;
    END IF;
END $plans_rename$;

CREATE TABLE IF NOT EXISTS entitlements (
    user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan_id        TEXT NOT NULL DEFAULT 'testing' REFERENCES plans(id),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','past_due','canceled')),
    period_start   TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
    override_caps  JSONB NOT NULL DEFAULT '{}',         -- per-user exceptions (comps, abuse clamps)
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_events (
    id       BIGSERIAL PRIMARY KEY,
    user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL CHECK (kind IN ('transcribe','voiceprint','extract','chat','embed','rerank')),
    amount   NUMERIC NOT NULL,                          -- transcribe: audio SECONDS; others: 1 per call
    at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_user_month ON usage_events (user_id, kind, at);

-- Seeded plans. `testing` is the signup default: feels unlimited to real testers, but carries an
-- abuse ceiling (the proxy is on a public IP and pays our provider bill). `dev` = truly unlimited,
-- for our own accounts (assigned via SQL). free/pro are placeholders — nothing enforces prices yet.
INSERT INTO plans (id, name, transcribe_seconds_month, ai_calls_month, price_inr_month) VALUES
    ('testing', 'Testing',   60000, 5000,  0),          -- 1,000 min audio + 5,000 AI calls / month
    ('dev',     'Developer',  NULL, NULL,  0),
    ('free',    'Free',      18000, 1500,  0),          -- placeholder caps/prices — business decision later
    ('pro',     'Pro',      120000, 20000, 499)
ON CONFLICT (id) DO NOTHING;

-- The legacy single-tenant system user meters under `dev` (no caps): shared-secret proxy traffic
-- during the transition window is attributed to it.
INSERT INTO entitlements (user_id, plan_id)
VALUES ('00000000-0000-0000-0000-000000000001', 'dev')
ON CONFLICT (user_id) DO NOTHING;

-- Composite tenant indexes (every scoped query leads with user_id).
CREATE INDEX IF NOT EXISTS idx_people_user            ON people(user_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_user          ON sessions(user_id, id);
CREATE INDEX IF NOT EXISTS idx_turns_user_conv        ON turns(user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_turns_user_session     ON turns(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user     ON conversations(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_user_conv     ON memories(user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_entities_user_norm     ON entities(user_id, norm_name);
CREATE INDEX IF NOT EXISTS idx_edges_user_src         ON edges(user_id, src_entity);
CREATE INDEX IF NOT EXISTS idx_edges_user_dst         ON edges(user_id, dst_entity);
CREATE INDEX IF NOT EXISTS idx_action_items_user      ON action_items(user_id, status);
CREATE INDEX IF NOT EXISTS idx_events_user_start      ON events(user_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_priors_user_status     ON priors(user_id, status);
CREATE INDEX IF NOT EXISTS idx_daily_rollups_user_day ON daily_rollups(user_id, day DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_ts      ON audit_log(user_id, ts DESC);
