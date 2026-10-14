"""Tier B foundation tests: auth (signup/login/me/JWT), /sync idempotent upsert, and the #1 invariant
— TENANT ISOLATION. Two users sync distinct fixtures; each scoped read service returns ONLY the caller's
rows; cross-tenant access never leaks another user's data.

Runs against the same isolated test DB as test_pipeline (conftest `client`/`_db` fixtures), with
SUTRA_JWT_SECRET set so the auth layer is live.
"""
from __future__ import annotations

import os

os.environ.setdefault("SUTRA_JWT_SECRET", "test-secret-please-change")

import pytest

from app.services import tenant


async def _signup(client, email, password="password123"):
    r = await client.post("/auth/signup", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------- auth ----
async def test_signup_login_me_flow(client, _db):
    tok = await _signup(client, "alice@example.com")
    me = await client.get("/auth/me", headers=_auth(tok))
    assert me.status_code == 200
    assert me.json()["email"] == "alice@example.com"
    assert me.json()["auth_provider"] == "password"

    # login returns a working token too
    login = await client.post("/auth/login", json={"email": "alice@example.com", "password": "password123"})
    assert login.status_code == 200
    tok2 = login.json()["access_token"]
    assert (await client.get("/auth/me", headers=_auth(tok2))).status_code == 200


async def test_duplicate_signup_rejected(client, _db):
    await _signup(client, "dup@example.com")
    r = await client.post("/auth/signup", json={"email": "dup@example.com", "password": "password123"})
    assert r.status_code == 409


async def test_wrong_password_is_generic_401(client, _db):
    await _signup(client, "bob@example.com")
    r = await client.post("/auth/login", json={"email": "bob@example.com", "password": "WRONG"})
    assert r.status_code == 401
    # never reveal which factor failed
    assert "password" in r.json()["detail"].lower()


async def test_me_requires_valid_bearer(client, _db):
    assert (await client.get("/auth/me")).status_code == 401
    assert (await client.get("/auth/me", headers=_auth("garbage"))).status_code == 401
    assert (await client.get("/auth/me", headers={"Authorization": "Token x"})).status_code == 401


async def test_sync_requires_auth(client, _db):
    assert (await client.post("/sync", json={})).status_code == 401


# ----------------------------------------------------- sync + isolation ----
def _fixture(tag):
    """A small projection: 1 person, 1 conversation, 1 memory, 1 entity, 1 action, 1 event, 1 prior."""
    return {
        "people": [{"id": 1, "canonical_name": f"{tag}-person", "is_me": True}],
        "conversations": [{"id": 10, "title": f"{tag}-conv", "started_at": "2026-06-01T10:00:00+00:00",
                           "participant_person_ids": [1], "is_meeting": True}],
        "memories": [{"conversation_id": 10, "title": f"{tag}-mem", "summary": f"summary about {tag} widgets",
                      "facts": [f"{tag} fact one"], "importance": 0.8, "type_tags": ["work"]}],
        "turns": [{"conversation_id": 10, "session_speaker_label": "A", "person_id": 1, "text": f"{tag} hello"},
                  {"conversation_id": 10, "session_speaker_label": "A", "text": "REDACTED LINE", "redacted": True}],
        "entities": [{"id": 100, "type": "project", "canonical_name": f"{tag}-project"}],
        "edges": [],
        "action_items": [{"text": f"{tag} ship it", "status": "open", "source_conversation": 10,
                          "generated_draft": "SECRET DRAFT BODY"}],
        "events": [{"conversation_id": 10, "title": f"{tag} demo", "start_ts": "2030-01-01T09:00:00+00:00", "kind": "meeting"}],
        "minutes": [{"conversation_id": 10, "data": {"title": f"{tag} minutes", "summary": "mins"}}],
        "priors": [
            {"kind": "fact", "subject": f"{tag}-shared", "value": "v", "status": "confirmed",
             "provenance": "user", "share_cloud": 1, "attrs": {"relationship_to_user": "colleague"}},
            {"kind": "fact", "subject": f"{tag}-PRIVATE", "value": "v", "status": "confirmed",
             "provenance": "user", "share_cloud": 0},
        ],
        "rollups": [{"day": "2026-06-01", "summary": f"{tag} day"}],
    }


async def _user_id(client, token):
    me = await client.get("/auth/me", headers=_auth(token))
    import uuid
    return uuid.UUID(me.json()["id"])


async def test_sync_persists_scoped_and_isolation_holds(client, _db):
    ta = await _signup(client, "tenant-a@example.com")
    tb = await _signup(client, "tenant-b@example.com")
    ua = await _user_id(client, ta)
    ub = await _user_id(client, tb)

    ra = await client.post("/sync", json=_fixture("A"), headers=_auth(ta))
    assert ra.status_code == 200, ra.text
    assert ra.json()["counts"]["people"] == 1 and ra.json()["counts"]["turns"] == 1  # redacted dropped
    await client.post("/sync", json=_fixture("B"), headers=_auth(tb))

    # --- each scoped service returns ONLY the caller's rows ---
    a_convs = await tenant.list_conversations(ua)
    b_convs = await tenant.list_conversations(ub)
    assert len(a_convs) == 1 and a_convs[0]["title"] == "A-conv"
    assert len(b_convs) == 1 and b_convs[0]["title"] == "B-conv"

    a_people = await tenant.list_people(ua)
    assert [p["canonical_name"] for p in a_people] == ["A-person"]

    # --- cross-tenant: A's conversation id is invisible to B (returns None, not B's data) ---
    a_conv_id = a_convs[0]["id"]
    assert await tenant.conversation(ub, a_conv_id) is None
    detail = await tenant.conversation(ua, a_conv_id)
    assert detail is not None and detail["conversation"]["title"] == "A-conv"

    # --- whitelists: redacted turn dropped, draft body never present ---
    assert all("REDACTED" not in (t["text"] or "") for t in detail["turns"])
    a_actions = await tenant.list_action_items(ua)
    # sync drops the generated_draft body entirely (defense in depth), so the server never even stores
    # it — has_draft is False and the body string can never appear anywhere in the scoped output.
    assert a_actions[0]["has_draft"] is False
    import json
    assert "SECRET DRAFT BODY" not in json.dumps(a_actions)

    # --- priors: only share_cloud=1 confirmed/user; private + cross-tenant never leak ---
    a_priors = await tenant.top_priors(ua)
    subjects = [p["subject"] for p in a_priors]
    assert "A-shared" in subjects
    assert all("PRIVATE" not in s for s in subjects)
    assert all(not s.startswith("B-") for s in subjects)
    assert a_priors[0]["relationship_to_user"] == "colleague"

    # --- events / minutes / rollups scoped ---
    assert len(await tenant.upcoming_events(ua)) == 1
    assert (await tenant.minutes(ua, a_conv_id))["title"] == "A minutes"
    assert await tenant.minutes(ub, a_conv_id) is None  # A's conversation id is invisible to B
    # Both tenants synced a rollup for the SAME day — each sees ONLY their own (per-user (user_id,day)
    # uniqueness), never the other's. This is the isolation proof for same-key rows across tenants.
    assert (await tenant.daily_rollup(ua, "2026-06-01"))["summary"] == "A day"
    assert (await tenant.daily_rollup(ub, "2026-06-01"))["summary"] == "B day"


async def test_sync_is_idempotent(client, _db):
    tok = await _signup(client, "idem@example.com")
    uid = await _user_id(client, tok)
    for _ in range(3):
        r = await client.post("/sync", json=_fixture("X"), headers=_auth(tok))
        assert r.status_code == 200
    # replaying the same projection converges — exactly one conversation, one person, one action.
    assert len(await tenant.list_conversations(uid)) == 1
    assert len(await tenant.list_people(uid)) == 1
    assert len(await tenant.list_action_items(uid)) == 1


async def test_search_is_scoped(client, _db):
    ta = await _signup(client, "s-a@example.com")
    tb = await _signup(client, "s-b@example.com")
    ua = await _user_id(client, ta)
    ub = await _user_id(client, tb)
    await client.post("/sync", json=_fixture("A"), headers=_auth(ta))
    await client.post("/sync", json=_fixture("B"), headers=_auth(tb))
    # mock provider embeds deterministically; FTS leg ranks the seeded memory regardless.
    res_a = await tenant.search(ua, "widgets")
    assert all(r["title"] not in ("B-mem",) for r in res_a)
    for r in res_a:
        # every returned conversation belongs to A
        assert (await tenant.conversation(ub, r["conversation_id"])) is None
