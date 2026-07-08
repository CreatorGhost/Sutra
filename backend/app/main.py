"""Sutra FastAPI app: API under /api + serves the built PWA. Audio is never persisted."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

import asyncpg
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .api import OVERRIDABLE
from .auth import auth_router
from .auth.security import auth_enabled
from .config import settings
from .db import apply_schema, close_pool, get_pool, init_pool
from .mcp_server import mcp
from .mcp_write_settings import router as mcp_write_settings_router
from .oauth import oauth_router, oauth_schema_sql
from .oauth.oconfig import google_creds, facebook_creds, public_url
from .scheduler import start_scheduler, stop_scheduler
from .sync import router as sync_router

# Tier B hosted MCP (Streamable HTTP). Built once at import: stateless_http=True (each request is
# self-contained — fits our per-request bearer-token -> user_id auth), path="/" so the tools live at
# the mount root (/mcp/). The lifespan MUST be handed to FastAPI() below or the MCP task group is
# never started (python-sdk issue #1367 -> "Task group is not initialized" + 404s).
mcp_app = mcp.http_app(path="/", stateless_http=True)

logging.basicConfig(level=settings.log_level.upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("sutra")
STATIC = Path(__file__).parent.parent / "static"


async def _load_overrides() -> None:
    pool = await get_pool()
    row = await pool.fetchrow("SELECT data FROM settings WHERE id=1")
    data = (row["data"] if row else {}) or {}
    for k, v in data.items():
        if k in OVERRIDABLE and hasattr(settings, k):
            try:
                cur = getattr(settings, k)
                setattr(settings, k, bool(v) if isinstance(cur, bool) else type(cur)(v))
            except Exception:
                pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    last = None
    for attempt in range(20):
        try:
            await init_pool()
            await apply_schema()
            # Tier B P3 — OAuth connector tables (oauth_clients/codes/tokens). Idempotent CREATE TABLE
            # IF NOT EXISTS; the 3 tables reference users(id), so this MUST run after apply_schema().
            pool = await get_pool()
            await pool.execute(oauth_schema_sql)
            break
        except Exception as e:  # db may still be starting
            last = e
            await asyncio.sleep(1.5)
    else:
        raise RuntimeError(f"DB not reachable: {last}")
    await _load_overrides()
    start_scheduler()
    log.info("Sutra up. provider=%s speaker_id=%s consent=%s", settings.ai_provider, settings.speaker_id_mode, settings.consent_mode)
    # Enter the FastMCP app's own lifespan so its session manager / task group is initialized.
    # Without this handoff the mounted /mcp endpoint 404s with "Task group is not initialized"
    # (python-sdk issue #1367). The MCP endpoint is always mounted, but every tool default-denies
    # until a valid Tier B bearer JWT is presented, so an unconfigured deployment serves nothing.
    async with mcp_app.lifespan(app):
        try:
            yield
        finally:
            stop_scheduler()
            await close_pool()


app = FastAPI(title="Sutra", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list or ["*"],
    allow_methods=["*"], allow_headers=["*"], allow_credentials=False,
)
# SECURITY: the legacy single-tenant /api/* router is intentionally NOT mounted. Every one of its
# routes was unauthenticated — anonymous read/tamper of the system-tenant memory plus paid LLM and
# SMTP side-effects — and it has zero clients today (the phone talks only to the proxy on :8787 and
# the Tier B routes below). api.py still exists solely to supply OVERRIDABLE to _load_overrides; its
# handlers are now unreachable. Retire the module + orphaned services in a follow-up. Unmatched
# /api/* requests fall through to the SPA catch-all, which 404s them. See docs/AUDIT-FIXES.md.
# Tier B (hosted, multi-tenant). Routers are always mounted; each endpoint 503s when SUTRA_JWT_SECRET
# is unset, so a deployment without a secret behaves exactly like the single-tenant server variant.
app.include_router(auth_router)
app.include_router(sync_router)
# Tier B Phase 2 consent: GET/PUT /settings/mcp-write (default-deny flags gating the MCP write tools).
app.include_router(mcp_write_settings_router)
# Tier B Phase 3: OAuth 2.1 connector (discovery / DCR / authorize / token) + social sign-in scaffold.
# Included BEFORE the catch-all SPA route below so /.well-known/* and /oauth/* resolve to the router.
app.include_router(oauth_router)
# Social sign-in (Google/Facebook) via authlib stores its OAuth state in the request session, so the
# SessionMiddleware is only needed when at least one social provider is configured. The /auth/providers
# probe and the 501-unconfigured path work without it; mounting it unconditionally is harmless but we
# gate it so an unconfigured deployment adds no cookie surface.
if google_creds() or facebook_creds():
    from starlette.middleware.sessions import SessionMiddleware

    secret = settings.sutra_jwt_secret
    if not secret:
        raise RuntimeError("SUTRA_JWT_SECRET is required when a social OAuth provider is configured")
    app.add_middleware(SessionMiddleware, secret_key=secret, https_only=True, same_site="lax")

# Hosted MCP read+write endpoint. Mounted BEFORE the catch-all SPA route below so /mcp resolves to the
# FastMCP ASGI app (Streamable HTTP) rather than the index.html fallback. Always mounted; each tool
# rejects until a valid Tier B bearer JWT is presented (default-deny), scoped to that user_id. The
# WWW-Authenticate shim below advertises the OAuth discovery doc on a missing/invalid bearer so MCP
# clients can auto-start the connector flow (RFC 9728).
_WWW_AUTH = f'Bearer resource_metadata="{public_url()}/.well-known/oauth-protected-resource"'


async def _mcp_with_www_authenticate(scope, receive, send):
    """ASGI shim around the mounted FastMCP app. When the inbound /mcp request carries no usable bearer
    token, short-circuit with a 401 that includes the WWW-Authenticate resource_metadata header so a
    remote MCP client discovers the OAuth flow. A present bearer is passed through untouched — FastMCP's
    own tool layer (verify_mcp_bearer) is the authority on whether it is valid."""
    if scope["type"] == "http":
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        authz = headers.get("authorization", "")
        parts = authz.split(" ", 1)
        has_bearer = len(parts) == 2 and parts[0].lower() == "bearer" and bool(parts[1].strip())
        if not has_bearer:
            await send({
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"www-authenticate", _WWW_AUTH.encode("latin-1")),
                    (b"content-type", b"application/json"),
                ],
            })
            await send({
                "type": "http.response.body",
                "body": b'{"error":"missing bearer token"}',
            })
            return
    await mcp_app(scope, receive, send)


app.mount("/mcp", _mcp_with_www_authenticate)
if auth_enabled():
    log.info("Tier B enabled: /auth + /sync + OAuth connector + hosted MCP (/mcp) active")


@app.exception_handler(asyncpg.DataError)
async def _data_error(request: Request, exc: asyncpg.DataError):
    return JSONResponse(status_code=422, content={"detail": "invalid input value"})


@app.exception_handler(OverflowError)
async def _overflow(request: Request, exc: OverflowError):
    return JSONResponse(status_code=422, content={"detail": "numeric value out of range"})


@app.exception_handler(httpx.HTTPStatusError)
async def _provider_error(request: Request, exc: httpx.HTTPStatusError):
    code = exc.response.status_code if exc.response is not None else 502
    # a 400 from the AI provider means our request/input was rejected -> client error;
    # anything else is an upstream failure.
    status = 422 if code == 400 else 502
    log.warning("AI provider error %s on %s", code, request.url.path)
    return JSONResponse(status_code=status, content={"detail": f"AI provider error ({code})"})


@app.exception_handler(httpx.RequestError)
async def _provider_unreachable(request: Request, exc: httpx.RequestError):
    log.warning("AI provider unreachable on %s: %s", request.url.path, type(exc).__name__)
    return JSONResponse(status_code=502, content={"detail": "AI provider unreachable"})


@app.get("/{full_path:path}")
async def spa(full_path: str):
    """Serve built PWA assets, with SPA fallback to index.html for client routes."""
    if full_path.startswith("api"):
        raise HTTPException(404, "not found")
    if full_path:
        try:
            resolved = (STATIC / full_path).resolve()
            root = str(STATIC.resolve())
            if str(resolved).startswith(root + os.sep) and resolved.is_file():
                return FileResponse(resolved)
        except Exception:
            pass
    index = STATIC / "index.html"
    if index.is_file():
        return FileResponse(index)
    raise HTTPException(404, "frontend not built (run `npm run build` or use the full Docker image)")
