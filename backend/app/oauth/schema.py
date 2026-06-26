"""OAuth 2.1 connector schema — CREATE TABLE IF NOT EXISTS for the three OAuth tables.

Exported as ``oauth_schema_sql`` (a plain string). The verifier appends this to the startup schema
apply (or runs it once); it is idempotent, so re-running it on every boot is safe.

Design notes:
- ``oauth_clients`` holds Dynamic Client Registration (RFC 7591) results — PUBLIC clients only (no
  secret), so there is no client_secret column to leak.
- ``oauth_codes`` stores single-use authorization codes HASHED at rest (sha256 hex). The code value is
  bound to user_id + client_id + the PKCE code_challenge + the exact redirect_uri; a 10-minute TTL and a
  ``used_at`` stamp enforce single-use + expiry.
- ``oauth_tokens`` stores refresh tokens HASHED at rest (sha256 hex), rotating: issuing a new one stamps
  the old row ``revoked_at``. Access tokens are stateless JWTs (not stored). Both reference users(id) with
  ON DELETE CASCADE so a deleted account drops its grants.
"""

oauth_schema_sql = """
-- ============================================================================
-- TIER B P3 — OAuth 2.1 connector (Authorization Server tables). Idempotent.
-- ============================================================================
CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id      TEXT PRIMARY KEY,
    name           TEXT,
    redirect_uris  JSONB NOT NULL DEFAULT '[]',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash       TEXT PRIMARY KEY,                       -- sha256 hex of the single-use code
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id       TEXT NOT NULL,
    redirect_uri    TEXT NOT NULL,
    code_challenge  TEXT NOT NULL,                          -- PKCE S256 challenge
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,                            -- non-null once redeemed (single-use)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash    TEXT PRIMARY KEY,                         -- sha256 hex of the refresh token
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id     TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,                              -- non-null once rotated/revoked
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_user   ON oauth_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user  ON oauth_tokens(user_id);
"""
