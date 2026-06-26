"""FastAPI auth dependencies. `current_user` is the reusable bearer-JWT validator that /sync,
the read services, and the MCP auth layer all hang off of. Tokens are never logged.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

import jwt
from fastapi import Header, HTTPException

from . import service
from .security import auth_enabled, decode_token


@dataclass(frozen=True)
class User:
    """The authenticated principal. `id` is a uuid.UUID — pass it straight into scoped queries."""

    id: uuid.UUID
    email: str
    auth_provider: str


def require_auth_enabled() -> None:
    """503 if the deployment has not configured a JWT secret (Tier B is opt-in per-deployment)."""
    if not auth_enabled():
        raise HTTPException(503, "account features are not enabled on this server")


def _bearer(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(401, "missing bearer token")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(401, "malformed authorization header")
    return parts[1].strip()


async def current_user(authorization: str | None = Header(default=None)) -> User:
    """Validate the bearer JWT and resolve the user. Raises 401 on any failure; 503 if disabled.

    The token's `sub` is the user_id; we re-fetch the row so a deleted account can't keep acting.
    """
    require_auth_enabled()
    token = _bearer(authorization)
    try:
        claims = decode_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "token expired")
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid token")
    sub = claims.get("sub")
    try:
        uid = uuid.UUID(str(sub))
    except (ValueError, TypeError):
        raise HTTPException(401, "invalid token subject")
    row = await service.get_user_by_id(uid)
    if row is None:
        raise HTTPException(401, "account no longer exists")
    return User(id=row["id"], email=row["email"], auth_provider=row["auth_provider"])


async def optional_current_user(authorization: str | None = Header(default=None)) -> User | None:
    """Like current_user but returns None instead of raising when no/invalid credentials are sent.

    Used where an endpoint serves both Tier-A (anonymous) and Tier-B (authenticated) callers.
    """
    if not auth_enabled() or not authorization:
        return None
    try:
        return await current_user(authorization)
    except HTTPException:
        return None
