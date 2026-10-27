"""Regression tests for backend/app/api.py settings contract (finding H2).

These tests exercise the REAL `put_settings_ep` handler directly (no DB, no full
ASGI app, no torch/speechbrain). The only thing standing between us and importing
`app.api` is the optional `aiosmtplib` dependency pulled in transitively via
`app.services.recap`; we stub it so the import succeeds in a bare test env.

H2: putting only rejected keys must NOT silently return 200 with {"applied": {}}.
The handler must (a) surface which keys were rejected and (b) return a non-200
(422) when every submitted key was rejected, and (c) skip the no-op DB UPDATE in
that case.
"""
from __future__ import annotations

import sys
import types

import pytest

# --- make `app.api` importable in a bare environment -------------------------
# app.api -> app.services.recap -> aiosmtplib (optional, not installed in CI).
sys.modules.setdefault("aiosmtplib", types.ModuleType("aiosmtplib"))

from fastapi import HTTPException  # noqa: E402

import app.api as api  # noqa: E402
from app.config import set_runtime_overrides, settings  # noqa: E402
from app.schemas import SettingsUpdate  # noqa: E402


class _FakePool:
    """Records whether the settings UPDATE was issued (it must be skipped when
    nothing was applied)."""

    def __init__(self) -> None:
        self.execute_calls: list[tuple] = []
        self.fetchval_calls: list[tuple] = []

    async def execute(self, *args):  # noqa: ANN002
        self.execute_calls.append(args)
        return "UPDATE 1"

    async def fetchval(self, *args):  # noqa: ANN002
        # put_settings_ep persists via `UPDATE ... RETURNING data`; echo the applied
        # patch back (arg[1] is the JSONB delta) so the handler's cache refresh succeeds.
        self.fetchval_calls.append(args)
        return args[1] if len(args) > 1 else {}


@pytest.fixture
def fake_pool(monkeypatch):
    pool = _FakePool()

    async def _get_pool():
        return pool

    monkeypatch.setattr(api, "get_pool", _get_pool)
    return pool


async def test_rejected_only_payload_does_not_silently_succeed(fake_pool):
    """RED on old code: old handler returns {"applied": {}} with HTTP 200 and
    issues a no-op UPDATE. New code must raise 422 and name the rejected key."""
    body = SettingsUpdate(data={"definitely_not_a_real_setting": 123})

    with pytest.raises(HTTPException) as exc:
        await api.put_settings_ep(body)

    assert exc.value.status_code == 422
    detail = exc.value.detail
    assert detail["applied"] == {}
    assert "definitely_not_a_real_setting" in detail["rejected"]
    # the no-op DB write must be skipped when nothing applied
    assert fake_pool.execute_calls == []


async def test_coercion_failure_is_surfaced_not_swallowed(fake_pool):
    """An overridable key with an uncoercible value (int field, non-numeric
    string) must be reported in `rejected`, not silently dropped."""
    # search_topn is an int setting; "not-an-int" fails int("not-an-int").
    body = SettingsUpdate(data={"search_topn": "not-an-int"})

    with pytest.raises(HTTPException) as exc:
        await api.put_settings_ep(body)

    assert exc.value.status_code == 422
    assert "search_topn" in exc.value.detail["rejected"]
    assert fake_pool.execute_calls == []


async def test_valid_key_still_applies_and_writes(fake_pool):
    """Green-path regression: a valid overridable key is applied, persisted via
    a single UPDATE, and the response now also carries an (empty) `rejected`."""
    from app.config import get_runtime_settings
    try:
        body = SettingsUpdate(data={"search_topn": 25})
        out = await api.put_settings_ep(body)
        assert out["applied"] == {"search_topn": 25}
        assert out["rejected"] == {}
        # The handler persists to the DB row + refreshes the runtime cache WITHOUT mutating the
        # global Settings singleton (no cross-request bleed). The override is visible via the
        # runtime view, not the process-global `settings`.
        assert get_runtime_settings().search_topn == 25
        # exactly one UPDATE issued (via fetchval RETURNING), carrying only the applied keys
        assert len(fake_pool.fetchval_calls) == 1
        assert fake_pool.fetchval_calls[0][1] == {"search_topn": 25}
    finally:
        set_runtime_overrides({})


async def test_mixed_payload_applies_good_and_reports_bad(fake_pool):
    """A mix of one valid and one unknown key: the valid one applies (HTTP 200,
    no exception) and the unknown one is reported in `rejected`."""
    from app.config import get_runtime_settings
    try:
        body = SettingsUpdate(data={"search_topn": 12, "bogus_key": True})
        out = await api.put_settings_ep(body)
        assert out["applied"] == {"search_topn": 12}
        assert "bogus_key" in out["rejected"]
        # applied override is visible via the runtime view (no global singleton mutation)
        assert get_runtime_settings().search_topn == 12
        # UPDATE issued (via fetchval RETURNING) with ONLY the applied subset, never the rejected key
        assert len(fake_pool.fetchval_calls) == 1
        assert fake_pool.fetchval_calls[0][1] == {"search_topn": 12}
    finally:
        set_runtime_overrides({})


async def test_empty_payload_is_noop_no_update_no_error(fake_pool):
    """Empty data must remain a benign 200 no-op (no 422, no DB write)."""
    out = await api.put_settings_ep(SettingsUpdate(data={}))
    assert out == {"applied": {}, "rejected": {}}
    assert fake_pool.execute_calls == []
