"""Control-plane tests (docs/MONETIZATION-PLAN.md): signup -> entitlement, account deletion
(cascade + system-user guard), per-user proxy auth (Bearer JWT / legacy shared secret / dev mode,
machine-readable 401 codes), durable metering into usage_events, the 402 quota gate, and /usage.

Runs against the same isolated test DB as the other suites (conftest `client`/`_db` fixtures).
"""
from __future__ import annotations

import datetime as dt
import os

os.environ.setdefault("SUTRA_JWT_SECRET", "test-secret-please-change")

import jwt as pyjwt
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app import proxy_gate
from app.auth.security import mint_token
from app.auth.service import SYSTEM_USER_ID
from app.config import settings
from app.proxy import app as proxy_app
from app.proxy_gate import Principal


async def _signup(client, email, password="password123"):
    r = await client.post("/auth/signup", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def proxy_client(_db):
    # ASGITransport does not run the lifespan: no background flusher — tests flush explicitly,
    # which also proves flush_metering() works standalone.
    proxy_gate.reset_state()
    transport = ASGITransport(app=proxy_app)
    async with AsyncClient(transport=transport, base_url="http://p") as c:
        yield c
    proxy_gate.reset_state()


async def _user_id(pool, email):
    return await pool.fetchval("SELECT id FROM users WHERE email=$1", email)


# ------------------------------------------------- signup -> entitlement ----
async def test_signup_creates_testing_entitlement(client, _db):
    await _signup(client, "plan@example.com")
    uid = await _user_id(_db, "plan@example.com")
    row = await _db.fetchrow("SELECT plan_id, status FROM entitlements WHERE user_id=$1", uid)
    assert row is not None
    assert row["plan_id"] == "testing"
    assert row["status"] == "active"


async def test_login_backfills_missing_entitlement(client, _db):
    await _signup(client, "lazy@example.com")
    uid = await _user_id(_db, "lazy@example.com")
    await _db.execute("DELETE FROM entitlements WHERE user_id=$1", uid)
    r = await client.post("/auth/login", json={"email": "lazy@example.com", "password": "password123"})
    assert r.status_code == 200
    assert await _db.fetchval("SELECT plan_id FROM entitlements WHERE user_id=$1", uid) == "testing"


async def test_plans_seeded(client, _db):
    plans = {r["id"]: r for r in await _db.fetch("SELECT * FROM plans")}
    assert {"testing", "dev", "free", "pro"} <= set(plans)
    assert plans["dev"]["transcribe_seconds_month"] is None  # truly unlimited
    assert plans["testing"]["transcribe_seconds_month"] is not None  # abuse ceiling exists


# ----------------------------------------------------- account deletion ----
async def test_delete_account_requires_correct_password(client, _db):
    tok = await _signup(client, "del1@example.com")
    r = await client.request("DELETE", "/auth/account", json={"password": "WRONG-pass"}, headers=_auth(tok))
    assert r.status_code == 403
    assert (await client.get("/auth/me", headers=_auth(tok))).status_code == 200  # still alive


async def test_delete_account_cascades_and_kills_tokens(client, _db):
    tok = await _signup(client, "del2@example.com")
    uid = await _user_id(_db, "del2@example.com")
    await _db.execute(
        "INSERT INTO usage_events (user_id, kind, amount) VALUES ($1,'chat',1)", uid)
    r = await client.request("DELETE", "/auth/account", json={"password": "password123"}, headers=_auth(tok))
    assert r.status_code == 200 and r.json()["deleted"] is True
    assert await _user_id(_db, "del2@example.com") is None
    # ON DELETE CASCADE wiped the control-plane rows too
    assert await _db.fetchval("SELECT count(*) FROM entitlements WHERE user_id=$1", uid) == 0
    assert await _db.fetchval("SELECT count(*) FROM usage_events WHERE user_id=$1", uid) == 0
    # the token died with the row
    assert (await client.get("/auth/me", headers=_auth(tok))).status_code == 401


async def test_delete_account_refuses_system_user(client, _db):
    tok = mint_token(SYSTEM_USER_ID)
    r = await client.request("DELETE", "/auth/account", json={"password": "x"}, headers=_auth(tok))
    assert r.status_code == 403
    assert await _db.fetchval("SELECT count(*) FROM users WHERE id=$1::uuid", SYSTEM_USER_ID) == 1


# ------------------------------------------------------- proxy auth ----
async def test_proxy_rejects_anon_when_auth_configured(proxy_client, _db):
    r = await proxy_client.post("/extract", json={"json_schema": {}, "system": "s", "user": "u"})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "unauthorized"


async def test_proxy_machine_readable_token_codes(proxy_client, client, _db):
    # garbage bearer
    r = await proxy_client.get("/usage", headers=_auth("garbage"))
    assert r.status_code == 401 and r.json()["detail"]["code"] == "unauthorized"
    # expired token
    now = dt.datetime.now(dt.timezone.utc)
    expired = pyjwt.encode(
        {"sub": SYSTEM_USER_ID, "iat": int(now.timestamp()) - 120,
         "exp": int(now.timestamp()) - 60, "typ": "access"},
        settings.sutra_jwt_secret, algorithm="HS256")
    r = await proxy_client.get("/usage", headers=_auth(expired))
    assert r.status_code == 401 and r.json()["detail"]["code"] == "token_expired"
    # an MCP-connector token (aud=sutra-mcp) must NOT work on the proxy
    tok = await _signup(client, "aud@example.com")
    claims = pyjwt.decode(tok, settings.sutra_jwt_secret, algorithms=["HS256"])
    mcp_tok = pyjwt.encode({**claims, "aud": "sutra-mcp"}, settings.sutra_jwt_secret, algorithm="HS256")
    r = await proxy_client.get("/usage", headers=_auth(mcp_tok))
    assert r.status_code == 401 and r.json()["detail"]["code"] == "unauthorized"


async def test_proxy_legacy_shared_secret_transition(proxy_client, _db, monkeypatch):
    monkeypatch.setattr(settings, "proxy_shared_secret", "s3cret")
    monkeypatch.setattr(settings, "proxy_accept_shared_secret", True)
    r = await proxy_client.get("/usage", headers={"X-Sutra-Secret": "s3cret"})
    assert r.status_code == 200  # legacy demo counters view
    r = await proxy_client.get("/usage", headers={"X-Sutra-Secret": "WRONG"})
    assert r.status_code == 401
    # cutover: flag off -> the shared secret stops working
    monkeypatch.setattr(settings, "proxy_accept_shared_secret", False)
    r = await proxy_client.get("/usage", headers={"X-Sutra-Secret": "s3cret"})
    assert r.status_code == 401


async def test_proxy_dev_mode_unchanged_when_nothing_configured(proxy_client, _db, monkeypatch):
    monkeypatch.setattr(settings, "proxy_shared_secret", "")
    monkeypatch.setattr(settings, "sutra_jwt_secret", "")
    r = await proxy_client.get("/usage")
    assert r.status_code == 200  # anonymous USB/dev behavior preserved


# ------------------------------------------- metering + /usage + quota ----
async def test_metering_flushes_durably_and_usage_reports(proxy_client, client, _db):
    tok = await _signup(client, "meter@example.com")
    uid = await _user_id(_db, "meter@example.com")
    principal = Principal(user_id=str(uid), source="jwt")
    proxy_gate.meter(principal, "chat")
    proxy_gate.meter(principal, "transcribe", amount=42.5)
    assert await proxy_gate.flush_metering() == 2
    rows = await _db.fetch(
        "SELECT kind, amount FROM usage_events WHERE user_id=$1 ORDER BY kind", uid)
    assert [(r["kind"], float(r["amount"])) for r in rows] == [("chat", 1.0), ("transcribe", 42.5)]

    r = await proxy_client.get("/usage", headers=_auth(tok))
    assert r.status_code == 200, r.text
    snap = r.json()
    assert snap["available"] is True
    assert snap["plan"] == "testing"
    assert snap["ai_calls_used"] == 1.0
    assert snap["audio_seconds_used"] == 42.5
    assert snap["caps"]["ai_calls_month"] == 5000
    assert snap["resets_at"] > snap["period_start"]


async def test_quota_gate_402_with_machine_readable_body(proxy_client, client, _db):
    tok = await _signup(client, "capped@example.com")
    uid = await _user_id(_db, "capped@example.com")
    # abuse-clamp this user via override_caps (the plan's per-user exception mechanism)
    await _db.execute(
        "UPDATE entitlements SET override_caps=$1 WHERE user_id=$2",
        {"ai_calls_month": 0}, uid)
    r = await proxy_client.post(
        "/extract", json={"json_schema": {}, "system": "s", "user": "u"}, headers=_auth(tok))
    assert r.status_code == 402, r.text
    body = r.json()["detail"]
    assert body["code"] == "quota_exceeded" and body["kind"] == "extract" and body["resets_at"]
    # transcribe is capped independently, by audio seconds
    await _db.execute(
        "UPDATE entitlements SET override_caps=$1 WHERE user_id=$2",
        {"transcribe_seconds_month": 0}, uid)
    proxy_gate.reset_state()  # drop the 60s entitlement cache so the new clamp is visible
    r = await proxy_client.post(
        "/transcribe", files={"file": ("a.webm", b"xx", "audio/webm")}, headers=_auth(tok))
    assert r.status_code == 402
    assert r.json()["detail"]["kind"] == "transcribe"


async def test_metering_survives_user_deletion_race(proxy_client, client, _db):
    """Rows buffered for a user deleted before the flush are skipped, not a crash."""
    tok = await _signup(client, "gone@example.com")
    uid = await _user_id(_db, "gone@example.com")
    proxy_gate.meter(Principal(user_id=str(uid), source="jwt"), "chat")
    await client.request("DELETE", "/auth/account", json={"password": "password123"}, headers=_auth(tok))
    await proxy_gate.flush_metering()  # must not raise (WHERE EXISTS guard)
    assert await _db.fetchval("SELECT count(*) FROM usage_events WHERE user_id=$1", uid) == 0


# ------------------------------------------------- /transcribe multichannel form field ----
class _SpyStt:
    """Records the multichannel flag the endpoint threads to the provider."""
    last_multichannel: bool | None = None

    async def transcribe_diarize(self, audio, filename, content_type, prompt=None, multichannel=False):
        _SpyStt.last_multichannel = multichannel
        return {"text": "ok", "duration": 1.0,
                "segments": [{"speaker": "Me", "start": 0.0, "end": 1.0, "text": "ok"}]}


async def test_transcribe_multichannel_form_field_threads_to_provider(proxy_client, client, _db, monkeypatch):
    import app.proxy as proxy

    monkeypatch.setattr(proxy, "get_stt_provider", lambda *a, **k: _SpyStt())
    tok = await _signup(client, "mc@example.com")

    # Omitting the field preserves today's behavior (default False).
    _SpyStt.last_multichannel = None
    r = await proxy_client.post("/transcribe", files={"file": ("a.webm", b"xx", "audio/webm")},
                                headers=_auth(tok))
    assert r.status_code == 200, r.text
    assert _SpyStt.last_multichannel is False

    # multichannel=true reaches the provider with the flag set.
    _SpyStt.last_multichannel = None
    r = await proxy_client.post("/transcribe", files={"file": ("a.webm", b"xx", "audio/webm")},
                                data={"multichannel": "true"}, headers=_auth(tok))
    assert r.status_code == 200, r.text
    assert _SpyStt.last_multichannel is True
