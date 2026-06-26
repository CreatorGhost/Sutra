"""User-account data layer: create / fetch users. Mirrors the existing service style (asyncpg, no ORM).

Account lookup is the ONLY thing OAuth would change later; signup/login here is the password path.
Email is stored CITEXT (case-insensitive unique), so lookups need no lower() dance.
"""
from __future__ import annotations

import logging

from ..db import get_pool
from .security import hash_password, needs_rehash, verify_password

log = logging.getLogger("sutra.auth")

# Seeded single-tenant sentinel (schema.sql). Owns pre-Tier-B rows; must never be deletable via API.
SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001"


async def ensure_entitlement(user_id) -> None:
    """Give the user a control-plane entitlement row (default plan: 'testing').

    Called on signup AND on every successful login so accounts created before the control plane
    existed get a row lazily. Non-fatal by design: a missing entitlement must never block auth —
    the proxy treats it as the default plan anyway.
    """
    try:
        pool = await get_pool()
        await pool.execute(
            "INSERT INTO entitlements (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
            user_id,
        )
    except Exception as e:  # table missing on an old DB / transient error — auth still succeeds
        log.warning("ensure_entitlement failed for user %s: %s", user_id, e)


async def delete_user(user_id) -> bool:
    """Delete the account row. Every user-data table carries ON DELETE CASCADE (verified in
    schema.sql), so this single delete wipes the memory projection, entitlements, usage, audit
    log, OAuth clients/tokens and settings. Tokens die immediately because current_user re-fetches
    the row per request. Returns True if a row was deleted."""
    pool = await get_pool()
    result = await pool.execute("DELETE FROM users WHERE id=$1", user_id)
    deleted = result.endswith("1")
    if deleted:
        log.info("user deleted: %s", user_id)  # id only — never the email
    return deleted


async def get_user_by_email(email: str) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT id, email, password_hash, auth_provider, created_at FROM users WHERE email=$1",
        email.strip(),
    )
    return dict(row) if row else None


async def get_user_by_id(user_id) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT id, email, password_hash, auth_provider, created_at FROM users WHERE id=$1",
        user_id,
    )
    return dict(row) if row else None


async def create_user(email: str, password: str) -> dict:
    """Create a password account. Raises ValueError('email already registered') on a dup email.

    The plaintext password is hashed immediately and never logged.
    """
    pool = await get_pool()
    email = email.strip()
    existing = await pool.fetchval("SELECT 1 FROM users WHERE email=$1", email)
    if existing:
        raise ValueError("email already registered")
    pw_hash = hash_password(password)
    row = await pool.fetchrow(
        "INSERT INTO users(email, password_hash, auth_provider) VALUES($1,$2,'password') "
        "RETURNING id, email, auth_provider, created_at",
        email, pw_hash,
    )
    log.info("user created: %s", row["id"])  # id only — never the email-password pair
    await ensure_entitlement(row["id"])
    return dict(row)


async def authenticate(email: str, password: str) -> dict | None:
    """Return the user dict on a valid email+password, else None. Never logs the password.

    Transparently upgrades the stored hash params on a successful login if they are out of date.
    """
    user = await get_user_by_email(email)
    if user is None:
        # Hash a throwaway to keep timing roughly uniform between unknown-email and wrong-password.
        verify_password(password, None)
        return None
    if not verify_password(password, user.get("password_hash")):
        return None
    if user.get("password_hash") and needs_rehash(user["password_hash"]):
        try:
            pool = await get_pool()
            await pool.execute(
                "UPDATE users SET password_hash=$1 WHERE id=$2",
                hash_password(password), user["id"],
            )
        except Exception:  # non-fatal: login still succeeds
            log.warning("password rehash failed for user %s", user["id"])
    await ensure_entitlement(user["id"])
    return user
