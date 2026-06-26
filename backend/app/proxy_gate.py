"""Per-user auth + entitlement gate + durable metering for the stateless proxy.

The proxy stays CONTENT-stateless (it never stores user content); what it gains here is
identity + counters (docs/MONETIZATION-PLAN.md §5). Three auth sources, in order:

  1. `Authorization: Bearer <JWT>` — verified locally (HS256, same SUTRA_JWT_SECRET the
     control plane signs with; no network hop). This is the per-user path.
  2. `X-Sutra-Secret` — legacy shared secret, accepted only while PROXY_ACCEPT_SHARED_SECRET
     is on (transition for old installs). Metered under the seeded system user (dev plan, no caps).
  3. Nothing configured at all — USB/dev mode, unchanged: every request is anonymous.

DB posture: the proxy works WITHOUT a database (remote standalone deploys). When the control-plane
DB is reachable, metering becomes durable (batched inserts into usage_events) and plan caps are
enforced; when it is not, we fail OPEN for valid-JWT users (their signature proves the account)
and metering falls back to the in-memory demo counters. Tokens are never logged.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hmac
import logging
import time
import uuid
from dataclasses import dataclass

import jwt
from fastapi import Header, HTTPException

from .auth.security import _ALG, auth_enabled, _secret
from .auth.service import SYSTEM_USER_ID
from .config import settings

log = logging.getLogger("sutra.proxy.gate")

# Audiences: app tokens carry no `aud` today (transition; Phase-4 hardening mints aud="sutra-app").
# A token minted for the MCP connector (aud="sutra-mcp") must NOT work on the proxy.
_APP_AUDIENCES = (None, "sutra-app")

# Kinds that count against the combined ai_calls_month cap. transcribe is capped separately by
# audio seconds; voiceprint rides on transcribe and is metered but never gated.
_AI_CALL_KINDS = ("extract", "chat", "embed", "rerank")

_ENTITLEMENT_TTL_S = 60          # plan/usage snapshot cache (plan §5.2)
_FLUSH_INTERVAL_S = 5            # metering batch insert cadence (plan §5.3)
_BUFFER_CAP = 10_000             # hard memory bound; overflow drops oldest (logged)


@dataclass(frozen=True)
class Principal:
    """Who is calling the proxy. user_id is a uuid STRING (or None only in anon/dev mode)."""

    user_id: str | None
    source: str  # "jwt" | "secret" | "anon"

    @property
    def gated(self) -> bool:
        # Only real per-user JWTs are quota-gated; legacy shared-secret + USB/dev are not.
        return self.source == "jwt"


def _unauthorized(code: str) -> HTTPException:
    # Machine-readable body so the app can tell "sign in again" from "rejected".
    return HTTPException(401, {"code": code})


async def require_user(
    authorization: str | None = Header(default=None),
    x_sutra_secret: str | None = Header(default=None),
) -> Principal:
    """Resolve the caller. Bearer JWT first, then the legacy shared secret, then anon (dev only)."""
    # A Bearer token only means something when this deployment can verify it (SUTRA_JWT_SECRET set).
    # In pure dev/anon mode we IGNORE a stray token and fall through to anon instead of 401ing it —
    # a local proxy rejecting a token-bearing client is what kicked recorders back to the login screen.
    if authorization and auth_enabled():
        parts = authorization.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
            raise _unauthorized("unauthorized")
        try:
            claims = jwt.decode(parts[1].strip(), _secret(), algorithms=[_ALG],
                                options={"verify_aud": False})
        except jwt.ExpiredSignatureError:
            raise _unauthorized("token_expired")
        except jwt.PyJWTError:
            raise _unauthorized("unauthorized")
        if claims.get("typ") != "access" or claims.get("aud") not in _APP_AUDIENCES:
            raise _unauthorized("unauthorized")
        try:
            uid = uuid.UUID(str(claims.get("sub")))
        except (ValueError, TypeError):
            raise _unauthorized("unauthorized")
        return Principal(user_id=str(uid), source="jwt")

    expected = settings.proxy_shared_secret
    if expected and settings.proxy_accept_shared_secret:
        if x_sutra_secret and hmac.compare_digest(x_sutra_secret, expected):
            # Legacy installs: attributed to the seeded system user (dev plan — metered, not capped).
            return Principal(user_id=SYSTEM_USER_ID, source="secret")

    if not expected and not auth_enabled():
        # Pure USB/dev: nothing configured, behave exactly as before per-user auth existed.
        return Principal(user_id=SYSTEM_USER_ID, source="anon")

    raise _unauthorized("unauthorized")


# ---------------------------------------------------------------------------
# Database plumbing — optional by design. One failed connect switches metering/gating off and
# retries quietly in the background (every _DB_RETRY_S) so a proxy without Postgres just works.
# ---------------------------------------------------------------------------
_DB_RETRY_S = 60.0
_db_down_until = 0.0


async def _pool_or_none():
    global _db_down_until
    if time.monotonic() < _db_down_until:
        return None
    try:
        from .db import get_pool

        return await get_pool()
    except Exception as e:
        _db_down_until = time.monotonic() + _DB_RETRY_S
        log.warning("control-plane DB unreachable — metering/quotas degraded: %s", e)
        return None


# ---------------------------------------------------------------------------
# Entitlement gate (plan caps, cached per user for 60s; 402 when over)
# ---------------------------------------------------------------------------
_snapshots: dict[str, tuple[float, dict]] = {}


def _month_bounds_utc() -> tuple[dt.datetime, dt.datetime]:
    now = dt.datetime.now(dt.timezone.utc)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    nxt = (start + dt.timedelta(days=32)).replace(day=1)
    return start, nxt


async def _load_snapshot(user_id: str) -> dict | None:
    """Plan caps + month-to-date usage for one user, or None when the DB is unavailable."""
    pool = await _pool_or_none()
    if pool is None:
        return None
    try:
        ent = await pool.fetchrow(
            "SELECT e.plan_id, e.status, e.override_caps, p.name, p.transcribe_seconds_month, p.ai_calls_month "
            "FROM entitlements e JOIN plans p ON p.id = e.plan_id WHERE e.user_id = $1",
            uuid.UUID(user_id),
        )
        if ent is None:
            # Account predates the control plane (or signup's ensure_entitlement lost a race):
            # treat as the signup-default plan rather than blocking a paying-nothing tester.
            ent = await pool.fetchrow(
                "SELECT 'testing' AS plan_id, 'active' AS status, '{}'::jsonb AS override_caps, "
                "p.name, p.transcribe_seconds_month, p.ai_calls_month FROM plans p WHERE p.id = 'testing'",
            )
            if ent is None:
                return None  # plans not seeded (old DB) — fail open
        rows = await pool.fetch(
            "SELECT kind, COALESCE(SUM(amount), 0) AS used FROM usage_events "
            "WHERE user_id = $1 AND at >= date_trunc('month', now()) GROUP BY kind",
            uuid.UUID(user_id),
        )
    except Exception as e:
        log.warning("entitlement lookup failed for %s — failing open: %s", user_id, e)
        return None
    by_kind = {r["kind"]: float(r["used"]) for r in rows}
    overrides = ent["override_caps"] or {}
    caps = {
        "transcribe_seconds_month": overrides.get("transcribe_seconds_month", ent["transcribe_seconds_month"]),
        "ai_calls_month": overrides.get("ai_calls_month", ent["ai_calls_month"]),
    }
    start, resets = _month_bounds_utc()
    return {
        "plan": ent["plan_id"],
        "plan_name": ent["name"],
        "status": ent["status"],
        "caps": caps,
        "by_kind": by_kind,
        "audio_seconds_used": by_kind.get("transcribe", 0.0),
        "ai_calls_used": sum(by_kind.get(k, 0.0) for k in _AI_CALL_KINDS),
        "period_start": start.isoformat(),
        "resets_at": resets.isoformat(),
    }


async def get_snapshot(user_id: str, *, fresh: bool = False) -> dict | None:
    if not fresh:
        hit = _snapshots.get(user_id)
        if hit and hit[0] > time.monotonic():
            return hit[1]
    snap = await _load_snapshot(user_id)
    if snap is not None:
        _snapshots[user_id] = (time.monotonic() + _ENTITLEMENT_TTL_S, snap)
    return snap


async def check_quota(principal: Principal, kind: str) -> None:
    """402 when the caller's plan cap for `kind` is exhausted. Fail-open when the DB is away —
    a valid JWT already proves the account existed within the token TTL (plan §5.5)."""
    if not principal.gated or principal.user_id is None or kind == "voiceprint":
        return
    snap = await get_snapshot(principal.user_id)
    if snap is None:
        return  # DB down / not provisioned — fail open
    if kind == "transcribe":
        cap, used = snap["caps"]["transcribe_seconds_month"], snap["audio_seconds_used"]
    else:
        cap, used = snap["caps"]["ai_calls_month"], snap["ai_calls_used"]
    if cap is not None and used >= float(cap):
        raise HTTPException(402, {"code": "quota_exceeded", "kind": kind,
                                  "resets_at": snap["resets_at"]})


# ---------------------------------------------------------------------------
# Durable metering — buffered, batch-inserted, never blocks or fails a user request.
# ---------------------------------------------------------------------------
_buffer: list[tuple[uuid.UUID, str, float]] = []
# Legacy in-memory counters (kept: the anon/dev /usage view + zero-DB deployments).
_mem_usage: dict[str, dict[str, float]] = {}


def meter(principal: Principal, kind: str, amount: float = 1.0) -> None:
    u = _mem_usage.setdefault(principal.user_id or "anon", {})
    u[kind] = u.get(kind, 0.0) + (amount if kind == "transcribe" else 1.0)
    if principal.user_id is None or principal.source == "anon":
        return
    if len(_buffer) >= _BUFFER_CAP:
        del _buffer[: _BUFFER_CAP // 10]
        log.warning("metering buffer overflow — oldest 10%% dropped")
    try:
        _buffer.append((uuid.UUID(principal.user_id), kind, float(amount)))
    except (ValueError, TypeError):
        pass  # malformed id can't reach here via require_user; belt-and-braces


async def flush_metering() -> int:
    """Drain the buffer into usage_events. Returns rows written. Safe to call concurrently-ish
    (single event loop). Rows for users deleted in the meantime are skipped via WHERE EXISTS."""
    if not _buffer:
        return 0
    pool = await _pool_or_none()
    if pool is None:
        return 0
    batch, _buffer[:] = _buffer[:], []
    try:
        await pool.executemany(
            "INSERT INTO usage_events (user_id, kind, amount) "
            "SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM users WHERE id = $1)",
            batch,
        )
        return len(batch)
    except Exception as e:
        # Put the batch back (front) and try again next tick; the cap bounds memory.
        _buffer[:0] = batch
        log.warning("metering flush failed (%d rows kept): %s", len(batch), e)
        return 0


_flusher_task: asyncio.Task | None = None


async def _flusher_loop() -> None:
    while True:
        await asyncio.sleep(_FLUSH_INTERVAL_S)
        try:
            await flush_metering()
        except Exception:  # the loop must never die
            log.exception("metering flusher tick failed")


def start_flusher() -> None:
    global _flusher_task
    if _flusher_task is None or _flusher_task.done():
        _flusher_task = asyncio.create_task(_flusher_loop())


async def stop_flusher() -> None:
    global _flusher_task
    if _flusher_task is not None:
        _flusher_task.cancel()
        try:
            await _flusher_task
        except (asyncio.CancelledError, Exception):
            pass
        _flusher_task = None
    await flush_metering()  # final drain so a clean shutdown loses nothing


def mem_usage_view() -> dict:
    """The legacy demo /usage map (anon + shared-secret callers, zero-DB deployments)."""
    return _mem_usage


def reset_state() -> None:
    """Test hook: clear caches/buffers so cases are independent."""
    global _db_down_until
    _snapshots.clear()
    _buffer.clear()
    _mem_usage.clear()
    _db_down_until = 0.0
