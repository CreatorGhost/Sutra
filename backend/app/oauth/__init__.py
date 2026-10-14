"""Tier B P3 — OAuth 2.1 connector + social sign-in scaffold (self-contained package).

Makes the hosted ``/mcp`` endpoint addable as a one-click "custom connector" (browser login + consent
via PKCE/DCR), while Phase-1 plain bearer JWTs KEEP working for CLI/testing. Reuses the foundation auth
layer (JWT shape, password verify, user lookup) without editing it — imports FROM ``app.auth`` only.

The verifier wires this in (it owns main.py / schema apply):

    from .oauth import oauth_router, oauth_schema_sql, verify_mcp_bearer
    app.include_router(oauth_router)                 # in main.py, alongside auth_router/sync_router
    # apply oauth_schema_sql once at startup (append to schema.sql apply, or run after apply_schema())
    # in the /mcp auth layer, use verify_mcp_bearer(token) and add the WWW-Authenticate header on 401.

Exports:
  - ``oauth_router``       — FastAPI router with discovery, DCR, authorize, token, and social endpoints.
  - ``oauth_schema_sql``   — idempotent CREATE TABLE IF NOT EXISTS string for the 3 OAuth tables.
  - ``verify_mcp_bearer``  — async (token) -> user_id|None; accepts BOTH Phase-1 plain JWTs and OAuth
                             JWTs with aud="sutra-mcp".
"""
from .router import router as oauth_router
from .schema import oauth_schema_sql
from .security import verify_mcp_bearer

__all__ = ["oauth_router", "oauth_schema_sql", "verify_mcp_bearer"]
