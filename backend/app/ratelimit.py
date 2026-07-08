"""Minimal in-process rate limiter for the auth endpoints.

ponytail: per-process, in-memory sliding window — the laziest thing that actually throttles
credential-stuffing on a single-box deploy, with no new dependency. Ceiling: it does NOT coordinate
across workers/replicas and resets on process restart. If the control plane ever runs multiple
workers or replicas, swap _consume for a Redis token bucket keyed the same way (bucket:ip).
"""
from __future__ import annotations

import time
from collections import defaultdict, deque

# (max requests, window seconds) per client key.
_LIMITS: dict[str, tuple[int, float]] = {
    "auth": (10, 60.0),  # 10 login/signup attempts per minute per client IP
}
_hits: dict[str, deque] = defaultdict(deque)


def _consume(key: str, now: float, bucket: str = "auth") -> int | None:
    """Core sliding-window decision (no framework deps, so it is unit-testable directly).
    Returns retry-after seconds when the key is over its limit, else None (and records the hit)."""
    max_n, window = _LIMITS[bucket]
    dq = _hits[key]
    while dq and dq[0] <= now - window:
        dq.popleft()
    if len(dq) >= max_n:
        return int(window - (now - dq[0])) + 1
    dq.append(now)
    return None


def _client_ip(request) -> str:
    # Behind the reverse proxy the real client is the first X-Forwarded-For hop; else the socket peer.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(bucket: str = "auth"):
    """Build a FastAPI dependency that 429s a client once it exceeds `bucket`'s window."""
    from fastapi import HTTPException, Request  # lazy: keeps _consume importable without FastAPI

    async def _dep(request: Request) -> None:
        retry = _consume(f"{bucket}:{_client_ip(request)}", time.monotonic(), bucket)
        if retry is not None:
            raise HTTPException(
                status_code=429,
                detail={"code": "rate_limited", "retry_after": retry},
                headers={"Retry-After": str(retry)},
            )

    return _dep


def reset_state() -> None:
    """Test hook: clear counters so cases are independent."""
    _hits.clear()


if __name__ == "__main__":
    # ponytail self-check: 10 allowed, 11th blocked, clears after the window slides.
    reset_state()
    t = 1000.0
    for i in range(10):
        assert _consume("k", t) is None, f"request {i} should pass"
    assert _consume("k", t) is not None, "11th request should be rate-limited"
    assert _consume("k", t + 61) is None, "should pass again after the 60s window slides"
    assert _consume("other", t) is None, "a different client key is independent"
    print("ratelimit self-check OK")
