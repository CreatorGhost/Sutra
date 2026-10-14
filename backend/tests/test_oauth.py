"""Tier B P3 — OAuth 2.1 connector + social-scaffold tests.

Runs WITHOUT main.py wiring: builds a tiny FastAPI app that includes ``oauth_router`` and applies
``oauth_schema_sql`` itself (exactly the two lines the verifier adds to main.py). Uses the same isolated
test DB + seeded system user as the other Tier B tests.

Covers: discovery shapes (RFC 9728/8414); DCR; the full PKCE dance (register -> authorize as a created
user -> code -> token -> verify_mcp_bearer); rejection of bad verifier / replayed code / wrong redirect;
refresh-token rotation; /auth/providers env gating; and that a Phase-1 plain JWT still validates via
verify_mcp_bearer while a token with a foreign audience does not.
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
import uuid
from urllib.parse import parse_qs, urlsplit

os.environ.setdefault("SUTRA_JWT_SECRET", "test-secret-please-change")
# Deterministic public base for discovery-doc assertions.
os.environ["SUTRA_PUBLIC_URL"] = "http://testserver"

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.db import apply_schema, get_pool
from app.oauth import oauth_router, oauth_schema_sql, verify_mcp_bearer
from app.auth.security import mint_token  # Phase-1 plain JWT (no aud) for back-compat assertion

BASE = "http://testserver"


# --------------------------------------------------------------- fixtures ----
@pytest_asyncio.fixture
async def oauth_app(_db):
    """A minimal app with ONLY the oauth router — proves the module is self-contained. _db (from
    conftest) has already init'd the pool, applied schema, and truncated user-data tables."""
    await apply_schema()
    pool = await get_pool()
    await pool.execute(oauth_schema_sql)  # the verifier's "apply oauth_schema_sql" step
    # Clean OAuth tables between runs so codes/clients/tokens don't bleed across tests.
    await pool.execute("TRUNCATE oauth_clients, oauth_codes, oauth_tokens RESTART IDENTITY CASCADE")

    app = FastAPI()
    app.include_router(oauth_router)  # the verifier's "include_router" step
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE) as c:
        yield c


async def _create_user(email: str, password: str = "password123") -> uuid.UUID:
    """Create a real password account directly via the auth service (no /auth router mounted here)."""
    from app.auth import service as auth_service

    user = await auth_service.create_user(email, password)
    return user["id"]


def _pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)[:64]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


async def _register(client, redirect_uri="https://app.example.com/cb") -> str:
    r = await client.post(
        "/oauth/register", json={"client_name": "Test Connector", "redirect_uris": [redirect_uri]}
    )
    assert r.status_code == 201, r.text
    return r.json()["client_id"]


async def _get_code(client, *, client_id, redirect_uri, challenge, email, password="password123", state="xyz"):
    """Drive GET (form render) + POST (login) and return the issued code from the redirect."""
    g = await client.get(
        "/oauth/authorize",
        params={
            "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
            "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
        },
    )
    assert g.status_code == 200 and "Connect to Sutra" in g.text
    p = await client.post(
        "/oauth/authorize",
        data={
            "email": email, "password": password, "client_id": client_id, "redirect_uri": redirect_uri,
            "response_type": "code", "state": state, "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
    )
    assert p.status_code == 302, p.text
    loc = p.headers["location"]
    assert loc.startswith(redirect_uri)
    qs = parse_qs(urlsplit(loc).query)
    assert qs.get("state") == [state]  # state echoed verbatim
    return qs["code"][0]


# -------------------------------------------------------------- discovery ----
async def test_protected_resource_metadata(oauth_app):
    r = await oauth_app.get("/.well-known/oauth-protected-resource")
    assert r.status_code == 200
    body = r.json()
    assert body["resource"] == f"{BASE}/mcp"
    assert body["authorization_servers"] == [BASE]


async def test_authorization_server_metadata(oauth_app):
    r = await oauth_app.get("/.well-known/oauth-authorization-server")
    assert r.status_code == 200
    body = r.json()
    assert body["issuer"] == BASE
    assert body["authorization_endpoint"] == f"{BASE}/oauth/authorize"
    assert body["token_endpoint"] == f"{BASE}/oauth/token"
    assert body["registration_endpoint"] == f"{BASE}/oauth/register"
    assert body["code_challenge_methods_supported"] == ["S256"]
    assert set(body["grant_types_supported"]) == {"authorization_code", "refresh_token"}
    assert body["token_endpoint_auth_methods_supported"] == ["none"]


# -------------------------------------------------------------------- DCR ----
async def test_dynamic_client_registration(oauth_app):
    r = await oauth_app.post(
        "/oauth/register",
        json={"client_name": "My App", "redirect_uris": ["https://my.app/callback"]},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["client_id"]
    assert body["redirect_uris"] == ["https://my.app/callback"]
    assert body["token_endpoint_auth_method"] == "none"
    assert "client_secret" not in body  # public client — no secret


async def test_register_rejects_bad_redirect(oauth_app):
    assert (await oauth_app.post("/oauth/register", json={"redirect_uris": []})).status_code == 400
    assert (await oauth_app.post("/oauth/register", json={"redirect_uris": "nope"})).status_code == 400
    assert (await oauth_app.post("/oauth/register", json={"redirect_uris": ["::::"]})).status_code == 400


# ------------------------------------------------------- full PKCE happy path ----
async def test_full_pkce_dance_then_verify_bearer(oauth_app):
    uid = await _create_user("oauth-alice@example.com")
    client_id = await _register(oauth_app)
    verifier, challenge = _pkce_pair()
    redirect_uri = "https://app.example.com/cb"

    code = await _get_code(
        oauth_app, client_id=client_id, redirect_uri=redirect_uri, challenge=challenge,
        email="oauth-alice@example.com",
    )

    tok = await oauth_app.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "client_id": client_id, "code_verifier": verifier,
        },
    )
    assert tok.status_code == 200, tok.text
    body = tok.json()
    access = body["access_token"]
    assert body["token_type"].lower() == "bearer"
    assert body["expires_in"] > 0
    assert body["refresh_token"]

    # The access token validates on the /mcp auth layer and resolves to the SAME user.
    resolved = await verify_mcp_bearer(access)
    assert resolved == uid

    # And it carries aud="sutra-mcp".
    import jwt as _jwt
    from app.oauth.security import MCP_AUDIENCE
    claims = _jwt.decode(access, os.environ["SUTRA_JWT_SECRET"], algorithms=["HS256"],
                         options={"verify_aud": False})
    assert claims["aud"] == MCP_AUDIENCE
    assert claims["sub"] == str(uid)


async def test_bad_verifier_rejected(oauth_app):
    await _create_user("oauth-bob@example.com")
    client_id = await _register(oauth_app)
    _verifier, challenge = _pkce_pair()
    redirect_uri = "https://app.example.com/cb"
    code = await _get_code(
        oauth_app, client_id=client_id, redirect_uri=redirect_uri, challenge=challenge,
        email="oauth-bob@example.com",
    )
    # A wrong (but well-formed) verifier must fail PKCE.
    bad = secrets.token_urlsafe(48)[:64]
    tok = await oauth_app.post(
        "/oauth/token",
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
              "client_id": client_id, "code_verifier": bad},
    )
    assert tok.status_code == 400
    assert tok.json()["error"] == "invalid_grant"


async def test_replayed_code_rejected(oauth_app):
    await _create_user("oauth-carol@example.com")
    client_id = await _register(oauth_app)
    verifier, challenge = _pkce_pair()
    redirect_uri = "https://app.example.com/cb"
    code = await _get_code(
        oauth_app, client_id=client_id, redirect_uri=redirect_uri, challenge=challenge,
        email="oauth-carol@example.com",
    )
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "client_id": client_id, "code_verifier": verifier}
    first = await oauth_app.post("/oauth/token", data=data)
    assert first.status_code == 200
    # Single-use: the exact same code cannot be redeemed twice.
    second = await oauth_app.post("/oauth/token", data=data)
    assert second.status_code == 400
    assert second.json()["error"] == "invalid_grant"


async def test_wrong_redirect_uri_rejected_at_token(oauth_app):
    await _create_user("oauth-dan@example.com")
    client_id = await _register(oauth_app)
    verifier, challenge = _pkce_pair()
    redirect_uri = "https://app.example.com/cb"
    code = await _get_code(
        oauth_app, client_id=client_id, redirect_uri=redirect_uri, challenge=challenge,
        email="oauth-dan@example.com",
    )
    tok = await oauth_app.post(
        "/oauth/token",
        data={"grant_type": "authorization_code", "code": code,
              "redirect_uri": "https://evil.example.com/cb", "client_id": client_id,
              "code_verifier": verifier},
    )
    assert tok.status_code == 400
    assert tok.json()["error"] == "invalid_grant"


async def test_authorize_rejects_unregistered_redirect(oauth_app):
    await _create_user("oauth-erin@example.com")
    client_id = await _register(oauth_app, redirect_uri="https://app.example.com/cb")
    _verifier, challenge = _pkce_pair()
    # GET with a redirect_uri that doesn't EXACTLY match the registered one → 400 error page, no redirect.
    g = await oauth_app.get(
        "/oauth/authorize",
        params={"client_id": client_id, "redirect_uri": "https://app.example.com/cb/extra",
                "response_type": "code", "state": "s", "code_challenge": challenge,
                "code_challenge_method": "S256"},
    )
    assert g.status_code == 400
    assert "Cannot connect" in g.text


async def test_authorize_requires_s256(oauth_app):
    client_id = await _register(oauth_app)
    _verifier, challenge = _pkce_pair()
    g = await oauth_app.get(
        "/oauth/authorize",
        params={"client_id": client_id, "redirect_uri": "https://app.example.com/cb",
                "response_type": "code", "state": "s", "code_challenge": challenge,
                "code_challenge_method": "plain"},
    )
    assert g.status_code == 400


async def test_authorize_wrong_password_no_code(oauth_app):
    await _create_user("oauth-frank@example.com")
    client_id = await _register(oauth_app)
    _verifier, challenge = _pkce_pair()
    redirect_uri = "https://app.example.com/cb"
    p = await oauth_app.post(
        "/oauth/authorize",
        data={"email": "oauth-frank@example.com", "password": "WRONG", "client_id": client_id,
              "redirect_uri": redirect_uri, "response_type": "code", "state": "s",
              "code_challenge": challenge, "code_challenge_method": "S256"},
    )
    assert p.status_code == 401
    assert "location" not in {k.lower(): v for k, v in p.headers.items()}  # no code leaked via redirect


# ----------------------------------------------------------- refresh rotation ----
async def test_refresh_token_rotation(oauth_app):
    uid = await _create_user("oauth-grace@example.com")
    client_id = await _register(oauth_app)
    verifier, challenge = _pkce_pair()
    redirect_uri = "https://app.example.com/cb"
    code = await _get_code(
        oauth_app, client_id=client_id, redirect_uri=redirect_uri, challenge=challenge,
        email="oauth-grace@example.com",
    )
    tok = await oauth_app.post(
        "/oauth/token",
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
              "client_id": client_id, "code_verifier": verifier},
    )
    refresh1 = tok.json()["refresh_token"]

    r2 = await oauth_app.post(
        "/oauth/token", data={"grant_type": "refresh_token", "refresh_token": refresh1, "client_id": client_id}
    )
    assert r2.status_code == 200, r2.text
    refresh2 = r2.json()["refresh_token"]
    assert refresh2 and refresh2 != refresh1  # rotated
    assert await verify_mcp_bearer(r2.json()["access_token"]) == uid

    # The OLD refresh token is now revoked — replay fails.
    r3 = await oauth_app.post(
        "/oauth/token", data={"grant_type": "refresh_token", "refresh_token": refresh1, "client_id": client_id}
    )
    assert r3.status_code == 400 and r3.json()["error"] == "invalid_grant"

    # The NEW one rotates again.
    r4 = await oauth_app.post(
        "/oauth/token", data={"grant_type": "refresh_token", "refresh_token": refresh2, "client_id": client_id}
    )
    assert r4.status_code == 200 and r4.json()["refresh_token"] != refresh2


async def test_unsupported_grant_type(oauth_app):
    r = await oauth_app.post("/oauth/token", data={"grant_type": "password"})
    assert r.status_code == 400
    assert r.json()["error"] == "unsupported_grant_type"


# --------------------------------------------------- verify_mcp_bearer scope ----
async def test_verify_accepts_plain_phase1_jwt(oauth_app):
    """A Phase-1 plain JWT (no aud) minted by /auth/login must STILL work on /mcp (back-compat)."""
    uid = await _create_user("oauth-heidi@example.com")
    plain = mint_token(uid)  # no aud
    assert await verify_mcp_bearer(plain) == uid


async def test_verify_rejects_foreign_audience(oauth_app):
    uid = await _create_user("oauth-ivan@example.com")
    foreign = mint_token(uid, extra={"aud": "some-other-resource"})
    assert await verify_mcp_bearer(foreign) is None


async def test_verify_rejects_garbage(oauth_app):
    assert await verify_mcp_bearer("not-a-token") is None
    assert await verify_mcp_bearer("") is None


# ------------------------------------------------------ /auth/providers gating ----
async def test_providers_password_only_by_default(oauth_app, monkeypatch):
    for v in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"):
        monkeypatch.delenv(v, raising=False)
    r = await oauth_app.get("/auth/providers")
    assert r.status_code == 200
    body = r.json()
    assert body == {"password": True, "google": False, "facebook": False}


async def test_providers_reflect_env(oauth_app, monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "gsecret")
    monkeypatch.delenv("FACEBOOK_CLIENT_ID", raising=False)
    monkeypatch.delenv("FACEBOOK_CLIENT_SECRET", raising=False)
    r = await oauth_app.get("/auth/providers")
    assert r.json() == {"password": True, "google": True, "facebook": False}


async def test_unconfigured_social_start_501(oauth_app, monkeypatch):
    for v in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"):
        monkeypatch.delenv(v, raising=False)
    r = await oauth_app.get("/auth/oauth/google/start")
    assert r.status_code == 501
    assert r.json()["detail"] == "provider not configured"
    r2 = await oauth_app.get("/auth/oauth/unknown/start")
    assert r2.status_code == 404


# ------------------------------------------------- social hardening (linking + nonce) ----
async def test_social_cross_provider_link_refused(_db):
    """An email that already belongs to a password account must NOT be silently linkable via a
    social provider (account-takeover guard) — and vice versa across social providers."""
    from fastapi import HTTPException

    from app.oauth.social import _find_or_create_by_email

    email = "victim@example.com"
    await _create_user(email)  # auth_provider='password'

    with pytest.raises(HTTPException) as ei:
        await _find_or_create_by_email(email, "google")
    assert ei.value.status_code == 409

    # Fresh email via google -> creates a google account; same provider finds it again…
    created = await _find_or_create_by_email("social-only@example.com", "google")
    assert created["auth_provider"] == "google"
    again = await _find_or_create_by_email("social-only@example.com", "google")
    assert again["id"] == created["id"]
    # …but the OTHER social provider is refused too.
    with pytest.raises(HTTPException) as ei2:
        await _find_or_create_by_email("social-only@example.com", "facebook")
    assert ei2.value.status_code == 409


def test_signin_redirect_echoes_nonce_and_clears_cookie():
    """The callback redirect must echo the per-attempt nonce into the fragment (the SignIn page
    refuses tokens without a matching nonce) and expire the single-use relay cookie."""
    from app.oauth.social import _signin_redirect

    nonce = "ab" * 16
    resp = _signin_redirect("tok123", nonce)
    assert resp.headers["location"].endswith(f"/signin#token=tok123&nonce={nonce}")
    set_cookie = resp.headers.get("set-cookie", "")
    assert "sutra_oauth_nonce" in set_cookie  # delete_cookie -> expired Set-Cookie

    # Without a nonce (legacy/manual hit) the fragment carries only the token.
    bare = _signin_redirect("tok123")
    assert bare.headers["location"].endswith("/signin#token=tok123")
