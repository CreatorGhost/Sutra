"""OAuth 2.1 Authorization Server endpoints (self-contained; makes /mcp a one-click connector).

Endpoints (all on this router):
  GET  /.well-known/oauth-protected-resource   (RFC 9728)
  GET  /.well-known/oauth-authorization-server  (RFC 8414)
  POST /oauth/register                          (DCR — RFC 7591, public client)
  GET  /oauth/authorize                         (validate + render login+consent HTML)
  POST /oauth/authorize                         (authenticate + issue single-use code)
  POST /oauth/token                             (authorization_code w/ PKCE, refresh_token rotation)

Security (per contract): exact redirect_uri match, S256 PKCE only + REQUIRED, state echoed, codes &
refresh tokens hashed at rest, constant-time compares, no open redirect, nothing secret logged.

Plain Phase-1 bearer JWTs KEEP working on /mcp; OAuth tokens just additionally carry aud="sutra-mcp".
"""
from __future__ import annotations

import html
import logging
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from ..auth import service as auth_service
from ..auth.deps import require_auth_enabled
from . import oconfig, store
from .security import (
    constant_time_eq,
    mint_oauth_access_token,
    valid_code_verifier,
    verify_pkce_s256,
)
from .social import router as social_router

log = logging.getLogger("sutra.oauth")

router = APIRouter(tags=["oauth"])
# Mount the social-sign-in scaffold on the same router so the verifier includes ONE router.
router.include_router(social_router)


# ----------------------------------------------------------- discovery ----
@router.get("/.well-known/oauth-protected-resource")
async def protected_resource_metadata() -> dict:
    """RFC 9728: tells a client which authorization server protects the /mcp resource."""
    base = oconfig.public_url()
    return {
        "resource": f"{base}/mcp",
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
    }


@router.get("/.well-known/oauth-authorization-server")
async def authorization_server_metadata() -> dict:
    """RFC 8414: the AS metadata clients use to drive the PKCE+DCR flow."""
    base = oconfig.public_url()
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["mcp"],
    }


# ----------------------------------------------------------------- DCR ----
@router.post("/oauth/register")
async def register(body: dict) -> JSONResponse:
    """Dynamic Client Registration (RFC 7591). Public client — issues client_id, NO secret."""
    require_auth_enabled()
    if not isinstance(body, dict):
        raise HTTPException(400, "invalid client metadata")
    redirect_uris = body.get("redirect_uris")
    if not isinstance(redirect_uris, list) or not redirect_uris or not all(
        isinstance(u, str) and _is_safe_redirect(u) for u in redirect_uris
    ):
        raise HTTPException(400, "invalid redirect_uris")
    name = body.get("client_name")
    if name is not None and not isinstance(name, str):
        name = None
    client = await store.register_client(name, list(redirect_uris))
    return JSONResponse(
        status_code=201,
        content={
            "client_id": client["client_id"],
            "client_name": client["name"],
            "redirect_uris": client["redirect_uris"],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        },
    )


def _is_safe_redirect(uri: str) -> bool:
    """Reject obviously-unsafe redirect targets at registration (no open-redirect surface)."""
    try:
        parts = urlsplit(uri)
    except ValueError:
        return False
    if parts.scheme in ("http", "https"):
        return bool(parts.netloc)
    # Allow custom-scheme native redirects (e.g. an app deeplink) but require a scheme + body.
    return bool(parts.scheme) and bool(parts.path or parts.netloc)


# ----------------------------------------------------- authorize (GET) ----
def _validate_authorize_params(
    *, client: dict | None, redirect_uri: str, response_type: str,
    code_challenge: str, code_challenge_method: str,
) -> str | None:
    """Return an error string if the request is invalid, else None. Performed BEFORE we render or
    redirect anything so we never bounce a request to an unverified URI (no open redirect)."""
    if client is None:
        return "unknown client_id"
    uris = client.get("redirect_uris") or []
    if not any(constant_time_eq(redirect_uri, u) for u in uris):
        return "redirect_uri does not match a registered URI"
    if response_type != "code":
        return "unsupported response_type (only 'code')"
    if code_challenge_method != "S256":
        return "PKCE S256 is required (code_challenge_method must be S256)"
    if not code_challenge or len(code_challenge) < 43:
        return "missing or malformed code_challenge"
    return None


@router.get("/oauth/authorize")
async def authorize_form(request: Request):
    """Validate the request, then render a minimal inline login+consent page. PKCE S256 REQUIRED."""
    require_auth_enabled()
    q = request.query_params
    client_id = q.get("client_id", "")
    redirect_uri = q.get("redirect_uri", "")
    response_type = q.get("response_type", "")
    state = q.get("state", "")
    code_challenge = q.get("code_challenge", "")
    code_challenge_method = q.get("code_challenge_method", "")

    client = await store.get_client(client_id) if client_id else None
    err = _validate_authorize_params(
        client=client, redirect_uri=redirect_uri, response_type=response_type,
        code_challenge=code_challenge, code_challenge_method=code_challenge_method,
    )
    if err:
        # The redirect_uri is unverified at this point → render an error page, NEVER redirect.
        return HTMLResponse(_error_page(err), status_code=400)

    return HTMLResponse(
        _consent_page(
            client_name=client.get("name") or client_id,
            client_id=client_id,
            redirect_uri=redirect_uri,
            state=state,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
        )
    )


# ---------------------------------------------------- authorize (POST) ----
@router.post("/oauth/authorize")
async def authorize_submit(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    client_id: str = Form(...),
    redirect_uri: str = Form(...),
    response_type: str = Form("code"),
    state: str = Form(""),
    code_challenge: str = Form(...),
    code_challenge_method: str = Form("S256"),
):
    """Authenticate via the existing auth service, then issue a single-use code bound to
    user+client+challenge+redirect_uri and 302 back to the EXACT registered redirect_uri with code+state.
    """
    require_auth_enabled()
    client = await store.get_client(client_id) if client_id else None
    err = _validate_authorize_params(
        client=client, redirect_uri=redirect_uri, response_type=response_type,
        code_challenge=code_challenge, code_challenge_method=code_challenge_method,
    )
    if err:
        # Params no longer trustworthy (tampered form) → error page, never redirect.
        return HTMLResponse(_error_page(err), status_code=400)

    user = await auth_service.authenticate(email, password)
    if user is None:
        # Re-render the consent page with a generic error — never reveal which factor failed.
        return HTMLResponse(
            _consent_page(
                client_name=client.get("name") or client_id, client_id=client_id,
                redirect_uri=redirect_uri, state=state, code_challenge=code_challenge,
                code_challenge_method=code_challenge_method, error="Invalid email or password.",
            ),
            status_code=401,
        )

    code = await store.issue_code(
        user_id=user["id"], client_id=client_id, redirect_uri=redirect_uri, code_challenge=code_challenge,
    )
    params = {"code": code}
    if state:
        params["state"] = state  # echo state verbatim (CSRF binding)
    sep = "&" if urlsplit(redirect_uri).query else "?"
    return RedirectResponse(url=f"{redirect_uri}{sep}{urlencode(params)}", status_code=302)


# --------------------------------------------------------------- token ----
def _token_error(error: str, status: int = 400) -> JSONResponse:
    """RFC 6749 §5.2 error body. No secret/verifier/code is ever included."""
    return JSONResponse(status_code=status, content={"error": error})


@router.post("/oauth/token")
async def token(
    grant_type: str = Form(...),
    # authorization_code grant
    code: str = Form(""),
    redirect_uri: str = Form(""),
    client_id: str = Form(""),
    code_verifier: str = Form(""),
    # refresh_token grant
    refresh_token: str = Form(""),
):
    """Token endpoint: authorization_code (PKCE S256 verify, single-use, expiry) and refresh_token
    (rotating). Access token = the /auth/login JWT shape PLUS aud=\"sutra-mcp\"; refresh tokens hashed.
    """
    require_auth_enabled()

    if grant_type == "authorization_code":
        if not code or not client_id or not redirect_uri:
            return _token_error("invalid_request")
        if not valid_code_verifier(code_verifier):
            return _token_error("invalid_request")
        # consume_code enforces single-use + expiry + client_id/redirect_uri binding atomically.
        bound = await store.consume_code(code, client_id=client_id, redirect_uri=redirect_uri)
        if bound is None:
            return _token_error("invalid_grant")
        if not verify_pkce_s256(code_verifier, bound["code_challenge"]):
            # PKCE failed — the code was already consumed above, so it cannot be retried (single-use).
            return _token_error("invalid_grant")
        return await _issue_tokens(user_id=bound["user_id"], client_id=client_id)

    if grant_type == "refresh_token":
        if not refresh_token or not client_id:
            return _token_error("invalid_request")
        rotated = await store.rotate_refresh_token(refresh_token, client_id=client_id)
        if rotated is None:
            return _token_error("invalid_grant")
        return await _issue_tokens(user_id=rotated["user_id"], client_id=client_id)

    return _token_error("unsupported_grant_type")


async def _issue_tokens(*, user_id, client_id: str) -> JSONResponse:
    from ..config import settings

    access = mint_oauth_access_token(user_id)
    refresh = await store.issue_refresh_token(user_id=user_id, client_id=client_id)
    return JSONResponse(
        content={
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": int(settings.sutra_jwt_ttl_minutes) * 60,
            "refresh_token": refresh,
            "scope": "mcp",
        },
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


# ----------------------------------------------------------- HTML pages ----
_STYLE = (
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
    "background:#0b0b10;color:#e8e8ef;margin:0;display:flex;min-height:100vh;align-items:center;"
    "justify-content:center}.card{background:#15151d;border:1px solid #26263a;border-radius:16px;"
    "padding:28px 26px;max-width:380px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,.4)}"
    "h1{font-size:18px;margin:0 0 4px}p{color:#a6a6bb;font-size:13px;line-height:1.5;margin:6px 0}"
    "label{display:block;font-size:12px;color:#a6a6bb;margin:14px 0 4px}"
    "input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2c2c44;"
    "background:#0e0e16;color:#e8e8ef;font-size:14px}button{margin-top:18px;width:100%;padding:11px;"
    "border:0;border-radius:10px;background:#5b5bf0;color:#fff;font-size:14px;font-weight:600;cursor:pointer}"
    "ul{margin:8px 0;padding-left:18px;color:#a6a6bb;font-size:12.5px}.err{color:#ff8585;font-size:12.5px;"
    "margin-top:10px}.muted{color:#74748a;font-size:11.5px;margin-top:16px}"
)


def _hidden(name: str, value: str) -> str:
    return f'<input type="hidden" name="{html.escape(name)}" value="{html.escape(value)}">'


def _consent_page(
    *, client_name: str, client_id: str, redirect_uri: str, state: str,
    code_challenge: str, code_challenge_method: str, error: str | None = None,
) -> str:
    """A minimal self-contained login+consent page. All form values are HTML-escaped (no injection)."""
    err_html = f'<div class="err">{html.escape(error)}</div>' if error else ""
    safe_client = html.escape(client_name)
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>Connect to Sutra</title><style>{_STYLE}</style></head><body><div class='card'>"
        "<h1>Connect to Sutra</h1>"
        f"<p><b>{safe_client}</b> wants to connect to your Sutra memory.</p>"
        "<p>It will be able to:</p><ul>"
        "<li>Read your conversations, people, action items, events and the context you chose to share</li>"
        "<li>Make updates to your memory only if you turned that on in Sutra Settings &rarr; Cloud sync</li>"
        "</ul>"
        "<form method='post' action='/oauth/authorize'>"
        "<label>Email</label><input type='email' name='email' autocomplete='username' required>"
        "<label>Password</label>"
        "<input type='password' name='password' autocomplete='current-password' required>"
        + _hidden("client_id", client_id)
        + _hidden("redirect_uri", redirect_uri)
        + _hidden("response_type", "code")
        + _hidden("state", state)
        + _hidden("code_challenge", code_challenge)
        + _hidden("code_challenge_method", code_challenge_method)
        + "<button type='submit'>Sign in &amp; allow</button>"
        + err_html
        + "<p class='muted'>Every change a connected tool makes is recorded and reversible. "
        "Updates are off by default.</p>"
        "</form></div></body></html>"
    )


def _error_page(message: str) -> str:
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>Sutra</title><style>{_STYLE}</style></head><body><div class='card'>"
        "<h1>Cannot connect</h1>"
        f"<p>{html.escape(message)}</p>"
        "<p class='muted'>This connection request was rejected for your safety.</p>"
        "</div></body></html>"
    )
