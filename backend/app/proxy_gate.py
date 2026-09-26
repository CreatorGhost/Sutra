"""Auth + usage gate for the intelligence proxy (app/proxy.py).

`proxy.py` imported this module but it was never committed, so the proxy could not start. This is the
minimal self-hosted gate: it keeps the exact interface proxy.py expects and the documented behaviour —

  * nothing configured              → open (USB / local dev), unchanged from before;
  * PROXY_SHARED_SECRET set         → requests must send a matching X-Sutra-Secret
                                       (while PROXY_ACCEPT_SHARED_SECRET is on) or a valid bearer JWT;
  * SUTRA_JWT_SECRET set            → `Authorization: Bearer <HS256 JWT>` is verified locally.

Usage is counted in memory only (for /usage). Plan quotas and durable metering belong to the hosted
control plane and are intentionally not implemented here: check_quota never blocks.
"""
from __future__ import annotations

import hmac
from collections import defaultdict
from dataclasses import dataclass

from fastapi import Header, HTTPException

from .config import settings


@dataclass(frozen=True)
class Principal:
    user_id: str | None = None
    # True when the caller is a real per-user account whose usage the control plane meters.
    gated: bool = False


_usage: dict[str, float] = defaultdict(float)


def _unauthorized(code: str) -> HTTPException:
    return HTTPException(401, {"code": code})


async def require_user(authorization: str | None = Header(None),
                       x_sutra_secret: str | None = Header(None)) -> Principal:
    token = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else None
    if token and settings.sutra_jwt_secret:
        try:
            import jwt  # PyJWT
            claims = jwt.decode(token, settings.sutra_jwt_secret, algorithms=["HS256"])
        except Exception as e:  # expired, bad signature, malformed
            raise _unauthorized("token_expired" if "expired" in type(e).__name__.lower() else "unauthorized")
        return Principal(user_id=str(claims.get("sub") or "") or None, gated=True)

    secret = settings.proxy_shared_secret
    if not secret:
        return Principal()  # nothing configured: open dev/USB mode
    if settings.proxy_accept_shared_secret and x_sutra_secret and hmac.compare_digest(x_sutra_secret, secret):
        return Principal()
    raise HTTPException(401, "missing or invalid X-Sutra-Secret")


async def check_quota(principal: Principal, kind: str) -> None:
    """No plan caps in the self-hosted gate."""
    return None


def meter(principal: Principal, kind: str, amount: float = 1.0) -> None:
    _usage[kind] += float(amount or 0.0)


def mem_usage_view() -> dict:
    return {"available": True, "source": "memory", "usage": dict(_usage)}


async def get_snapshot(user_id: str, fresh: bool = False) -> dict | None:
    return None  # no control-plane database in the self-hosted gate


async def flush_metering() -> None:
    return None


def start_flusher() -> None:
    return None


async def stop_flusher() -> None:
    return None
