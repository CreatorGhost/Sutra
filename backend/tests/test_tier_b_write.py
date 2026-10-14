"""Tier B Phase 2 tests: the 5 MCP write tools + consent + audit + sync-survival.

Mirrors test_tier_b.py: same isolated test DB (conftest `client`/`_db`), SUTRA_JWT_SECRET live, the mock
provider offline. The write tools resolve the caller from the inbound bearer JWT via
``mcp_server._require_user``; in-process there are no HTTP headers, so each test monkeypatches that one
resolver to the user under test and then calls the REAL tool function (``tool.fn``) — exercising the
shipped consent gate, DB writes, audit rows, origin stamping, and supersede logic exactly as in
production (only the header->user_id step is substituted).

Asserts the contract (tier-b-phase23-contract.md P2.0–P2.3):
  - consent OFF (master or per-tool) -> every write denied with the exact consent string;
  - consent ON -> each tool works and stamps origin='mcp';
  - cross-tenant write attempts fail as "not found"/"fact not found", NEVER touching another user's row;
  - correct_fact supersedes (old row preserved, new row active, chain linked);
  - an audit row is written per successful write; list_memory_updates shows the trail (no before/after);
  - /sync preserves origin='mcp' priors/action_items and replaces origin='device' ones;
  - the legacy single-tenant path (system user, no origin given) is unaffected.
"""
from __future__ import annotations

import os
import uuid

os.environ.setdefault("SUTRA_JWT_SECRET", "test-secret-please-change")

import pytest
from fastmcp.exceptions import ToolError

from app import mcp_server
from app.db import get_pool
from app.mcp_write_settings import WRITE_FLAG_KEYS, get_write_flags, set_write_flags
from app.services import tenant

CONSENT_DENIED = "Memory updates are disabled. Enable them in Sutra Settings → Cloud sync."


async def _signup(client, email, password="password123"):
    r = await client.post("/auth/signup", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


async def _user_id(client, token) -> uuid.UUID:
    me = await client.get("/auth/me", headers=_auth(token))
    return uuid.UUID(me.json()["id"])


def _as_user(monkeypatch, uid: uuid.UUID):
    """Make every write/read tool resolve the caller to `uid` (substitutes the header->JWT step)."""
    async def _fake_require_user():
        return uid
    monkeypatch.setattr(mcp_server, "_require_user", _fake_require_user)


async def _enable_all(uid: uuid.UUID):
    await set_write_flags(uid, {k: True for k in WRITE_FLAG_KEYS})


# ----------------------------------------------------------- consent ------
async def test_consent_defaults_all_false(client, _db):
    tok = await _signup(client, "c0@example.com")
    flags = (await client.get("/settings/mcp-write", headers=_auth(tok))).json()
    assert set(flags) == set(WRITE_FLAG_KEYS)
    assert all(v is False for v in flags.values())


async def test_consent_put_whitelists_keys(client, _db):
    tok = await _signup(client, "c1@example.com")
    r = await client.put("/settings/mcp-write", headers=_auth(tok),
                         json={"mcp_write_enabled": True, "mcp_write_add_fact": True,
                               "evil_key": True, "is_admin": True})
    body = r.json()
    assert r.status_code == 200
    assert body["mcp_write_enabled"] is True and body["mcp_write_add_fact"] is True
    # arbitrary keys are never stored or echoed
    assert "evil_key" not in body and "is_admin" not in body
    assert set(body) == set(WRITE_FLAG_KEYS)
    # the others stay default-false
    assert body["mcp_write_correct_fact"] is False


async def test_consent_endpoints_require_auth(client, _db):
    assert (await client.get("/settings/mcp-write")).status_code == 401
    assert (await client.put("/settings/mcp-write", json={"mcp_write_enabled": True})).status_code == 401


async def test_write_denied_when_consent_off(client, _db, monkeypatch):
    tok = await _signup(client, "off@example.com")
    uid = await _user_id(client, tok)
    _as_user(monkeypatch, uid)
    # master OFF, per-tool OFF -> all 5 writes denied with the exact string
    with pytest.raises(ToolError) as e:
        await mcp_server.add_fact.fn(subject="x")
    assert str(e.value) == CONSENT_DENIED
    for call in (
        lambda: mcp_server.correct_fact.fn(prior_id=1, value="y"),
        lambda: mcp_server.add_action_item.fn(text="t"),
        lambda: mcp_server.update_action_item.fn(id=1, status="done"),
        lambda: mcp_server.relabel_person.fn(person_id=1, name="N"),
    ):
        with pytest.raises(ToolError) as e:
            await call()
        assert str(e.value) == CONSENT_DENIED


async def test_master_on_but_per_tool_off_still_denied(client, _db, monkeypatch):
    tok = await _signup(client, "master@example.com")
    uid = await _user_id(client, tok)
    _as_user(monkeypatch, uid)
    await set_write_flags(uid, {"mcp_write_enabled": True})  # master on, every per-tool still off
    with pytest.raises(ToolError) as e:
        await mcp_server.add_fact.fn(subject="x")
    assert str(e.value) == CONSENT_DENIED
    # turning on JUST add_fact lets only that tool through
    await set_write_flags(uid, {"mcp_write_add_fact": True})
    out = await mcp_server.add_fact.fn(subject="ok")
    assert out["subject"] == "ok"
    with pytest.raises(ToolError):
        await mcp_server.add_action_item.fn(text="still off")


async def test_per_tool_on_but_master_off_still_denied(client, _db, monkeypatch):
    tok = await _signup(client, "nomaster@example.com")
    uid = await _user_id(client, tok)
    _as_user(monkeypatch, uid)
    await set_write_flags(uid, {"mcp_write_add_fact": True})  # per-tool on, master still off
    with pytest.raises(ToolError) as e:
        await mcp_server.add_fact.fn(subject="x")
    assert str(e.value) == CONSENT_DENIED


# ----------------------------------------------------- tools work (on) ----
async def test_add_fact_works_and_origin_mcp(client, _db, monkeypatch):
    tok = await _signup(client, "af@example.com")
    uid = await _user_id(client, tok)
    _as_user(monkeypatch, uid)
    await _enable_all(uid)
    out = await mcp_server.add_fact.fn(subject="likes tea", value="green", kind="pref")
    assert out["subject"] == "likes tea" and out["value"] == "green"
    assert out["status"] == "confirmed" and out["kind"] == "pref"
    pool = await get_pool()
    row = await pool.fetchrow("SELECT origin, provenance, share_cloud FROM priors WHERE id=$1", out["id"])
    assert row["origin"] == "mcp" and row["provenance"] == "user" and row["share_cloud"] is True
    # visible in get_your_context (share_cloud=1 + user/confirmed)
    priors = await tenant.top_priors(uid)
    assert any(p["subject"] == "likes tea" for p in priors)
    # bad kind clamps to 'pref'; over-long subject clamps to 200
    out2 = await mcp_server.add_fact.fn(subject="z" * 500, kind="not-a-kind")
    assert out2["kind"] == "pref"
    r2 = await pool.fetchrow("SELECT length(subject) AS n FROM priors WHERE id=$1", out2["id"])
    assert r2["n"] == 200


async def test_correct_fact_supersedes_and_preserves_old(client, _db, monkeypatch):
    tok = await _signup(client, "cf@example.com")
    uid = await _user_id(client, tok)
    _as_user(monkeypatch, uid)
    await _enable_all(uid)
    first = await mcp_server.add_fact.fn(subject="role", value="engineer")
    res = await mcp_server.correct_fact.fn(prior_id=first["id"], value="manager")
    assert res["old_id"] == first["id"] and res["new_id"] != first["id"]
    assert res["value"] == "manager"
    pool = await get_pool()
    old = await pool.fetchrow("SELECT superseded_by, valid_to FROM priors WHERE id=$1", first["id"])
    assert old["superseded_by"] == res["new_id"] and old["valid_to"] is not None  # old preserved, not deleted
    new = await pool.fetchrow("SELECT origin, superseded_by, valid_to FROM priors WHERE id=$1", res["new_id"])
    assert new["origin"] == "mcp" and new["superseded_by"] is None and new["valid_to"] is None
    # get_your_context shows only the active (new) one
    subjects_values = {(p["subject"], p["value"]) for p in await tenant.top_priors(uid)}
    assert ("role", "manager") in subjects_values and ("role", "engineer") not in subjects_values
    # correcting an ALREADY-superseded id -> fact not found
    with pytest.raises(ToolError) as e:
        await mcp_server.correct_fact.fn(prior_id=first["id"], value="again")
    assert "fact not found" in str(e.value)
    # no-op (neither field) rejected
    with pytest.raises(ToolError):
        await mcp_server.correct_fact.fn(prior_id=res["new_id"])


async def test_action_item_add_update_nondestructive(client, _db, monkeypatch):
    tok = await _signup(client, "ai@example.com")
    uid = await _user_id(client, tok)
    _as_user(monkeypatch, uid)
    await _enable_all(uid)
    add = await mcp_server.add_action_item.fn(text="buy milk", owner="me", due="2030-01-02")
    assert add["status"] == "open" and add["due"] == "2030-01-02"
    pool = await get_pool()
    assert (await pool.fetchval("SELECT origin FROM action_items WHERE id=$1", add["id"])) == "mcp"
    upd = await mcp_server.update_action_item.fn(id=add["id"], status="done", text="buy oat milk")
    assert upd["status"] == "done" and upd["text"] == "buy oat milk"
    # mcp-origin row carries NO sync-replacement note
    assert "note" not in upd
    # still exactly one row (never hard-deleted)
    assert (await pool.fetchval("SELECT count(*) FROM action_items WHERE user_id=$1", uid)) == 1
    # empty update rejected
    with pytest.raises(ToolError):
        await mcp_server.update_action_item.fn(id=add["id"])


async def test_update_device_origin_action_carries_note(client, _db, monkeypatch):
    tok = await _signup(client, "dev@example.com")
    uid = await _user_id(client, tok)
    # a device-origin action arrives via /sync
    fixture = {"action_items": [{"text": "from phone", "status": "open"}]}
    assert (await client.post("/sync", json=fixture, headers=_auth(tok))).status_code == 200
    pool = await get_pool()
    aid = await pool.fetchval("SELECT id FROM action_items WHERE user_id=$1", uid)
    assert (await pool.fetchval("SELECT origin FROM action_items WHERE id=$1", aid)) == "device"
    _as_user(monkeypatch, uid)
    await _enable_all(uid)
    upd = await mcp_server.update_action_item.fn(id=aid, status="done")
    assert upd["status"] == "done"
    assert "note" in upd and "next sync" in upd["note"]


async def test_relabel_person_reversible(client, _db, monkeypatch):
    tok = await _signup(client, "rp@example.com")
    uid = await _user_id(client, tok)
    await client.post("/sync", json={"people": [{"id": 1, "canonical_name": "Speaker A"}]}, headers=_auth(tok))
    pool = await get_pool()
    pid = await pool.fetchval("SELECT id FROM people WHERE user_id=$1", uid)
    _as_user(monkeypatch, uid)
    await _enable_all(uid)
    out = await mcp_server.relabel_person.fn(person_id=pid, name="Priya")
    assert out["canonical_name"] == "Priya"
    assert any(p["canonical_name"] == "Priya" for p in await tenant.list_people(uid))
    # before-value preserved in the audit row
    audit = await pool.fetchrow("SELECT before, after FROM audit_log WHERE user_id=$1 AND tool='relabel_person'", uid)
    assert audit["before"]["canonical_name"] == "Speaker A"
    assert audit["after"]["canonical_name"] == "Priya"


# ------------------------------------------------------ audit / trail -----
async def test_audit_rows_written_and_listed(client, _db, monkeypatch):
    tok = await _signup(client, "aud@example.com")
    uid = await _user_id(client, tok)
    _as_user(monkeypatch, uid)
    await _enable_all(uid)
    f = await mcp_server.add_fact.fn(subject="s1", value="v1")
    await mcp_server.correct_fact.fn(prior_id=f["id"], value="v2")
    await mcp_server.add_action_item.fn(text="todo")
    updates = await mcp_server.list_memory_updates.fn(limit=10)
    tools = [u["tool"] for u in updates]
    assert tools == ["add_action_item", "correct_fact", "add_fact"]  # most-recent first
    # the tool output omits before/after but keeps args_summary + ts
    for u in updates:
        assert set(u) == {"id", "tool", "args_summary", "ts"}
    # before/after ARE persisted in the DB (reversibility) — just not exposed by the tool
    pool = await get_pool()
    cnt = await pool.fetchval("SELECT count(*) FROM audit_log WHERE user_id=$1", uid)
    assert cnt == 3


# --------------------------------------------------- cross-tenant deny ----
async def test_cross_tenant_writes_are_not_found(client, _db, monkeypatch):
    ta = await _signup(client, "wa@example.com")
    tb = await _signup(client, "wb@example.com")
    ua = await _user_id(client, ta)
    ub = await _user_id(client, tb)
    # B owns a prior, an action, a person (via add_fact + sync)
    _as_user(monkeypatch, ub)
    await _enable_all(ub)
    b_fact = await mcp_server.add_fact.fn(subject="b-secret", value="hidden")
    b_action = (await mcp_server.add_action_item.fn(text="b-todo"))["id"]
    await client.post("/sync", json={"people": [{"id": 1, "canonical_name": "B-person"}]}, headers=_auth(tb))
    pool = await get_pool()
    b_person = await pool.fetchval("SELECT id FROM people WHERE user_id=$1", ub)

    # now act as A (consent fully on for A) and try to touch B's rows by id
    _as_user(monkeypatch, ua)
    await _enable_all(ua)
    with pytest.raises(ToolError) as e:
        await mcp_server.correct_fact.fn(prior_id=b_fact["id"], value="pwned")
    assert "fact not found" in str(e.value)
    with pytest.raises(ToolError) as e:
        await mcp_server.update_action_item.fn(id=b_action, status="done")
    assert "not found" in str(e.value)
    with pytest.raises(ToolError) as e:
        await mcp_server.relabel_person.fn(person_id=b_person, name="pwned")
    assert "not found" in str(e.value)

    # B's rows are completely untouched
    assert (await pool.fetchval("SELECT value FROM priors WHERE id=$1", b_fact["id"])) == "hidden"
    assert (await pool.fetchval("SELECT status FROM action_items WHERE id=$1", b_action)) == "open"
    assert (await pool.fetchval("SELECT canonical_name FROM people WHERE id=$1", b_person)) == "B-person"
    # and A's audit log recorded NONE of the failed cross-tenant attempts
    assert (await pool.fetchval("SELECT count(*) FROM audit_log WHERE user_id=$1", ua)) == 0


# --------------------------------------------- sync preserves origin='mcp'-
async def test_sync_preserves_mcp_origin_rows(client, _db, monkeypatch):
    tok = await _signup(client, "sync-mcp@example.com")
    uid = await _user_id(client, tok)
    _as_user(monkeypatch, uid)
    await _enable_all(uid)
    # MCP creates a fact + an action
    mcp_fact = await mcp_server.add_fact.fn(subject="mcp-fact", value="keep")
    mcp_action = (await mcp_server.add_action_item.fn(text="mcp-todo"))["id"]
    # phone syncs its own device projection (a device prior + device action)
    fixture = {
        "priors": [{"kind": "fact", "subject": "device-fact", "value": "v", "status": "confirmed",
                    "provenance": "user", "share_cloud": 1}],
        "action_items": [{"text": "device-todo", "status": "open"}],
    }
    assert (await client.post("/sync", json=fixture, headers=_auth(tok))).status_code == 200

    pool = await get_pool()
    # MCP rows SURVIVE the sync
    assert (await pool.fetchval("SELECT count(*) FROM priors WHERE id=$1", mcp_fact["id"])) == 1
    assert (await pool.fetchval("SELECT count(*) FROM action_items WHERE id=$1", mcp_action)) == 1
    # both device + mcp rows now coexist
    pr = {r["subject"]: r["origin"] for r in await pool.fetch("SELECT subject, origin FROM priors WHERE user_id=$1", uid)}
    assert pr.get("mcp-fact") == "mcp" and pr.get("device-fact") == "device"
    ai = {r["text"]: r["origin"] for r in await pool.fetch("SELECT text, origin FROM action_items WHERE user_id=$1", uid)}
    assert ai.get("mcp-todo") == "mcp" and ai.get("device-todo") == "device"

    # re-sync a DIFFERENT device projection -> device rows replaced, mcp rows still survive
    fixture2 = {
        "priors": [{"kind": "fact", "subject": "device-fact-2", "value": "v", "status": "confirmed",
                    "provenance": "user", "share_cloud": 1}],
        "action_items": [{"text": "device-todo-2", "status": "open"}],
    }
    assert (await client.post("/sync", json=fixture2, headers=_auth(tok))).status_code == 200
    pr2 = {r["subject"]: r["origin"] for r in await pool.fetch("SELECT subject, origin FROM priors WHERE user_id=$1", uid)}
    assert pr2.get("mcp-fact") == "mcp"            # mcp survives
    assert "device-fact" not in pr2               # old device replaced
    assert pr2.get("device-fact-2") == "device"   # new device present
    ai2 = {r["text"]: r["origin"] for r in await pool.fetch("SELECT text, origin FROM action_items WHERE user_id=$1", uid)}
    assert ai2.get("mcp-todo") == "mcp" and "device-todo" not in ai2 and ai2.get("device-todo-2") == "device"


# ----------------------------------------- legacy single-tenant unaffected
async def test_legacy_default_origin_is_device(client, _db):
    """Inserts that don't mention origin (the single-tenant capture path) default to 'device'."""
    pool = await get_pool()
    sys_uid = "00000000-0000-0000-0000-000000000001"
    pr_id = await pool.fetchval(
        "INSERT INTO priors(user_id, kind, subject, norm_subject) VALUES($1,'fact','legacy','legacy') RETURNING id",
        uuid.UUID(sys_uid),
    )
    ai_id = await pool.fetchval(
        "INSERT INTO action_items(user_id, text) VALUES($1,'legacy todo') RETURNING id", uuid.UUID(sys_uid),
    )
    assert (await pool.fetchval("SELECT origin FROM priors WHERE id=$1", pr_id)) == "device"
    assert (await pool.fetchval("SELECT origin FROM action_items WHERE id=$1", ai_id)) == "device"
