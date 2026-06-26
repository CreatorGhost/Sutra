"""Password hashing (argon2) + JWT mint/verify (HS256). No secrets are ever logged.

Hashing: argon2-cffi (installs cleanly as a prebuilt wheel; memory-hard, the current OWASP default).
JWT: PyJWT HS256, signed with SUTRA_JWT_SECRET, sub=user_id (uuid string), exp from config TTL.
Designed so OAuth providers reuse mint_token/decode_token verbatim — only the account-lookup differs.
"""
from __future__ import annotations

import datetime as dt
import uuid

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from ..config import settings

# One shared hasher (thread-safe; carries the cost params). Defaults match OWASP guidance.
_ph = PasswordHasher()

_ALG = "HS256"


def hash_password(password: str) -> str:
    """Return an argon2 PHC-string hash. The plaintext is never logged or returned."""
    return _ph.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    """Constant-time-ish verify via argon2. Returns False on any mismatch/format error (never raises)."""
    if not password_hash:
        return False
    try:
        return _ph.verify(password_hash, password)
    except (VerifyMismatchError, Exception):
        return False


def needs_rehash(password_hash: str) -> bool:
    """True if the stored hash used older params and should be upgraded on next successful login."""
    try:
        return _ph.check_needs_rehash(password_hash)
    except Exception:
        return False


def _secret() -> str:
    secret = settings.sutra_jwt_secret
    if not secret:
        # Caller (the router/deps) gates on auth_enabled() first; this is defense in depth.
        raise RuntimeError("SUTRA_JWT_SECRET is not configured")
    return secret


def auth_enabled() -> bool:
    """Tier B is opt-in at the deployment level: a JWT secret must be set to enable accounts."""
    return bool(settings.sutra_jwt_secret)


def mint_token(user_id: str | uuid.UUID, *, extra: dict | None = None) -> str:
    """Mint a short-lived HS256 access token with sub=user_id. OAuth flows reuse this unchanged."""
    now = dt.datetime.now(dt.timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + dt.timedelta(minutes=settings.sutra_jwt_ttl_minutes)).timestamp()),
        "typ": "access",
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, _secret(), algorithm=_ALG)


def decode_token(token: str) -> dict:
    """Verify signature + expiry and return the claims. Raises jwt.PyJWTError on any failure."""
    return jwt.decode(token, _secret(), algorithms=[_ALG])
