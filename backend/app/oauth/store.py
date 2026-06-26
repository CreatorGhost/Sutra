"""OAuth data layer (asyncpg, no ORM — mirrors auth.service style). Codes and refresh tokens are stored
ONLY as sha256 hashes; the plaintext lives client-side. Nothing secret is logged.
"""
from __future__ import annotations

import datetime as dt
import logging

from ..db import get_pool
from .security import random_token, sha256_hex

log = logging.getLogger("sutra.oauth")

CODE_TTL = dt.timedelta(minutes=10)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------- clients ----
async def register_client(name: str | None, redirect_uris: list[str]) -> dict:
    """Persist a PUBLIC DCR client. client_id is high-entropy; there is no secret to store."""
    pool = await get_pool()
    client_id = "sutra-" + random_token(18)
    await pool.execute(
        "INSERT INTO oauth_clients(client_id, name, redirect_uris) VALUES($1,$2,$3)",
        client_id, (name or None), redirect_uris,
    )
    log.info("oauth client registered: %s", client_id)  # id only — redirect_uris not logged
    return {"client_id": client_id, "name": name, "redirect_uris": redirect_uris}


async def get_client(client_id: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT client_id, name, redirect_uris FROM oauth_clients WHERE client_id=$1", client_id
    )
    return dict(row) if row else None


# ------------------------------------------------------------------ codes ----
async def issue_code(*, user_id, client_id: str, redirect_uri: str, code_challenge: str) -> str:
    """Mint + persist a single-use authorization code (hashed). Returns the PLAINTEXT code."""
    pool = await get_pool()
    code = random_token(32)
    await pool.execute(
        "INSERT INTO oauth_codes(code_hash, user_id, client_id, redirect_uri, code_challenge, expires_at) "
        "VALUES($1,$2,$3,$4,$5,$6)",
        sha256_hex(code), user_id, client_id, redirect_uri, code_challenge, _now() + CODE_TTL,
    )
    return code


async def consume_code(code: str, *, client_id: str, redirect_uri: str) -> dict | None:
    """Atomically redeem a code: must exist, be unused, unexpired, and match client_id + redirect_uri.

    Marks ``used_at`` in the SAME UPDATE (single-use; a replay finds used_at already set → no match).
    Returns the bound {user_id, code_challenge} on success, else None. Mismatched client/redirect → None
    (and the code is NOT consumed, so it can't be burned by a wrong-client probe).
    """
    pool = await get_pool()
    row = await pool.fetchrow(
        "UPDATE oauth_codes SET used_at=now() "
        "WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now() "
        "AND client_id=$2 AND redirect_uri=$3 "
        "RETURNING user_id, code_challenge",
        sha256_hex(code), client_id, redirect_uri,
    )
    return dict(row) if row else None


# ----------------------------------------------------------- refresh tokens ----
async def issue_refresh_token(*, user_id, client_id: str, ttl_days: int = 30) -> str:
    """Mint + persist a refresh token (hashed). Returns the PLAINTEXT token."""
    pool = await get_pool()
    token = random_token(32)
    await pool.execute(
        "INSERT INTO oauth_tokens(token_hash, user_id, client_id, expires_at) VALUES($1,$2,$3,$4)",
        sha256_hex(token), user_id, client_id, _now() + dt.timedelta(days=ttl_days),
    )
    return token


async def rotate_refresh_token(token: str, *, client_id: str) -> dict | None:
    """Redeem a refresh token and rotate it: revoke the presented one, return its {user_id} on success.

    Single-use rotation — the presented token is revoked in the same UPDATE; the caller then issues a
    fresh refresh token. Must be unrevoked, unexpired, and bound to the same client_id. Returns None on
    any mismatch (the caller turns that into invalid_grant).
    """
    pool = await get_pool()
    row = await pool.fetchrow(
        "UPDATE oauth_tokens SET revoked_at=now() "
        "WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now() AND client_id=$2 "
        "RETURNING user_id",
        sha256_hex(token), client_id,
    )
    return dict(row) if row else None
