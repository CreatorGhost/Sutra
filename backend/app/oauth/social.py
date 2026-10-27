"""Social sign-in scaffold (Google / Facebook) via authlib — env-gated and honest about untestability.

These endpoints are inert until GOOGLE_/FACEBOOK_ CLIENT_ID+SECRET are configured (then /auth/providers
flips the provider true and the SignIn page renders the button). Unconfigured → 501. On a successful
callback we find-or-create the user by their VERIFIED email, set auth_provider, leave password_hash NULL,
and mint the SAME JWT as /auth/login (returned to the web app via a redirect to /signin#token=...).

NOTE (docs): Google/Facebook can only be live-tested once real app credentials exist. Nothing else in
Tier B depends on them — they are a clean add-on over the existing users table + JWT.
"""
from __future__ import annotations

import logging
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from ..auth import service as auth_service
from ..auth.security import auth_enabled, mint_token
from ..db import get_pool
from . import oconfig

log = logging.getLogger("sutra.oauth.social")

router = APIRouter(tags=["auth-social"])

_PROVIDERS = ("google", "facebook")

# authlib's discovery URLs / endpoints. Facebook is not full OIDC, so we fetch the userinfo explicitly.
_OIDC = {
    "google": {
        "server_metadata_url": "https://accounts.google.com/.well-known/openid-configuration",
        "client_kwargs": {"scope": "openid email profile"},
    },
    "facebook": {
        "access_token_url": "https://graph.facebook.com/v18.0/oauth/access_token",
        "authorize_url": "https://www.facebook.com/v18.0/dialog/oauth",
        "api_base_url": "https://graph.facebook.com/v18.0/",
        "client_kwargs": {"scope": "email"},
    },
}


def _oauth_registry():
    """Build an authlib Starlette OAuth registry from whatever providers are configured. Lazy so the
    module imports even when authlib isn't installed and no provider is configured."""
    from authlib.integrations.starlette_client import OAuth  # lazy import

    oauth = OAuth()
    g = oconfig.google_creds()
    if g:
        oauth.register(name="google", client_id=g[0], client_secret=g[1], **_OIDC["google"])
    f = oconfig.facebook_creds()
    if f:
        oauth.register(name="facebook", client_id=f[0], client_secret=f[1], **_OIDC["facebook"])
    return oauth


def _redirect_uri(request: Request, provider: str) -> str:
    """The provider's redirect_uri — prefer the configured public base so it matches the app registration."""
    return f"{oconfig.public_url()}/auth/oauth/{provider}/callback"


async def _find_or_create_by_email(email: str, provider: str) -> dict:
    """Find an existing account by verified email or create a password-less social account.

    Cross-provider linking is REFUSED: if the email already belongs to an account created with a
    different method (password or the other social provider), we never silently merge — a provider
    that mis-issues an email claim must not be able to take over an existing account. The user signs
    in with their original method instead (explicit linking can come later, behind a confirmation).
    """
    email = email.strip()
    existing = await auth_service.get_user_by_email(email)
    if existing:
        if existing["auth_provider"] != provider:
            raise HTTPException(
                409,
                "an account with this email already exists — sign in with the method you used before",
            )
        return existing
    pool = await get_pool()
    row = await pool.fetchrow(
        "INSERT INTO users(email, password_hash, auth_provider) VALUES($1, NULL, $2) "
        "RETURNING id, email, auth_provider, created_at",
        email, provider,
    )
    log.info("social user created via %s: %s", provider, row["id"])  # id only — never the email
    return dict(row)


# Login-CSRF guard: the SignIn page generates a per-attempt CSPRNG nonce, passes it to /start, and
# only adopts a token whose fragment echoes the SAME nonce. The nonce rides a short-lived HttpOnly
# cookie between /start and /callback (no SessionMiddleware dependency). Hex-only so it can never
# inject into the fragment we build.
_NONCE_RE = re.compile(r"^[0-9a-f]{16,64}$")
_NONCE_COOKIE = "sutra_oauth_nonce"


def _signin_redirect(token: str, nonce: str | None = None) -> RedirectResponse:
    """Hand the freshly minted JWT to the web app via the URL fragment the SignIn page consumes."""
    base = oconfig.public_url()
    frag = f"token={token}" + (f"&nonce={nonce}" if nonce else "")
    resp = RedirectResponse(url=f"{base}/signin#{frag}", status_code=302)
    resp.delete_cookie(_NONCE_COOKIE, path="/auth/oauth")  # single-use
    return resp


@router.get("/auth/providers")
async def providers() -> dict:
    """Which sign-in methods this deployment offers. password is always available when auth is enabled."""
    return {
        "password": bool(auth_enabled()),
        "google": oconfig.provider_configured("google"),
        "facebook": oconfig.provider_configured("facebook"),
    }


def _guard(provider: str) -> None:
    if provider not in _PROVIDERS:
        raise HTTPException(404, "unknown provider")
    if not oconfig.provider_configured(provider):
        # Honest 501: the feature exists but this deployment has no credentials for it.
        raise HTTPException(501, "provider not configured")


@router.get("/auth/oauth/{provider}/start")
async def social_start(provider: str, request: Request, nonce: str | None = None):
    _guard(provider)
    oauth = _oauth_registry()
    client = oauth.create_client(provider)
    resp = await client.authorize_redirect(request, _redirect_uri(request, provider))
    # Stash the client's anti-CSRF nonce so the callback can echo it into the token fragment.
    # Lax survives the provider's top-level redirect back; 10 min outlives any consent screen.
    if nonce and _NONCE_RE.fullmatch(nonce):
        resp.set_cookie(
            _NONCE_COOKIE, nonce, max_age=600, httponly=True, samesite="lax",
            secure=oconfig.public_url().startswith("https"), path="/auth/oauth",
        )
    return resp


@router.get("/auth/oauth/{provider}/callback")
async def social_callback(provider: str, request: Request):
    _guard(provider)
    oauth = _oauth_registry()
    client = oauth.create_client(provider)
    try:
        token = await client.authorize_access_token(request)
    except Exception:
        # Never echo the provider's raw error (may carry codes/tokens); generic failure only.
        raise HTTPException(400, "social sign-in failed")

    email: str | None = None
    if provider == "google":
        userinfo = token.get("userinfo") or {}
        if userinfo.get("email_verified"):
            email = userinfo.get("email")
    elif provider == "facebook":
        # Don't rely on Facebook's historical "email is only returned when verified" behavior —
        # require the explicit `verified` flag on the Graph user too before trusting the claim.
        resp = await client.get("me?fields=id,email,verified", token=token)
        data = resp.json() if resp is not None else {}
        if data.get("verified") is True:
            email = data.get("email")

    if not email:
        raise HTTPException(400, "social account did not provide a verified email")

    user = await _find_or_create_by_email(email, provider)
    # Control plane: social accounts get the default-plan entitlement too (lazy + idempotent).
    from ..auth.service import ensure_entitlement
    await ensure_entitlement(user["id"])
    nonce = request.cookies.get(_NONCE_COOKIE)
    if nonce and not _NONCE_RE.fullmatch(nonce):
        nonce = None  # never echo a malformed value into the fragment
    return _signin_redirect(mint_token(user["id"]), nonce)
