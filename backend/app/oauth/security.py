"""OAuth crypto helpers: PKCE S256 verify, at-rest hashing, constant-time compares, and the MCP
bearer validator that accepts BOTH Phase-1 plain JWTs and OAuth JWTs (aud="sutra-mcp").

Reuses the foundation auth layer verbatim — ``decode_token``/``mint_token`` from ``auth.security`` and
``get_user_by_id`` from ``auth.service`` — so the JWT shape (HS256, sub=user_id) never diverges. We import
FROM auth; we never edit it. Secrets (tokens/verifiers/codes) are never logged.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import uuid

import jwt

from ..auth import service as auth_service
from ..auth.security import _ALG, _secret, auth_enabled

# RFC 9728 / 8414: this access-token audience marks an OAuth-issued token. Phase-1 plain JWTs have NO
# `aud` and KEEP working (back-compat) — verify_mcp_bearer accepts both.
MCP_AUDIENCE = "sutra-mcp"


def b64url(raw: bytes) -> str:
    """base64url WITHOUT padding (RFC 7636 / 4648 §5)."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def random_token(nbytes: int = 32) -> str:
    """A URL-safe high-entropy secret (codes, client_ids, refresh tokens)."""
    return secrets.token_urlsafe(nbytes)


def sha256_hex(value: str) -> str:
    """Hash a secret for at-rest storage. Codes + refresh tokens are stored only as this digest."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def constant_time_eq(a: str, b: str) -> bool:
    """Timing-safe string compare (PKCE challenge match, redirect_uri match, hash lookups)."""
    return hmac.compare_digest(a, b)


def pkce_s256_challenge(verifier: str) -> str:
    """Derive the S256 code_challenge from a code_verifier: base64url(sha256(verifier))."""
    return b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def verify_pkce_s256(verifier: str, challenge: str) -> bool:
    """True iff S256(verifier) == challenge, compared in constant time. S256 only (plain is rejected)."""
    if not verifier or not challenge:
        return False
    return constant_time_eq(pkce_s256_challenge(verifier), challenge)


def valid_code_verifier(verifier: str) -> bool:
    """RFC 7636 §4.1: 43..128 chars from the unreserved set [A-Za-z0-9-._~]."""
    if not verifier or not (43 <= len(verifier) <= 128):
        return False
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    return all(c in allowed for c in verifier)


def mint_oauth_access_token(user_id: str | uuid.UUID) -> str:
    """An access JWT with the SAME shape as /auth/login PLUS aud=\"sutra-mcp\".

    Reuses the foundation ``mint_token`` so HS256/secret/TTL/sub stay identical; only the audience
    claim is added so /mcp can tell an OAuth-connector token from a plain bearer.
    """
    from ..auth.security import mint_token  # local import keeps the auth boundary explicit

    return mint_token(user_id, extra={"aud": MCP_AUDIENCE})


async def verify_mcp_bearer(token: str) -> uuid.UUID | None:
    """Resolve a bearer token (Phase-1 plain JWT OR OAuth aud=sutra-mcp JWT) -> user_id, else None.

    Accepts BOTH:
      (a) Phase-1 tokens minted by /auth/login (no `aud`) — back-compat for CLI/testing.
      (b) OAuth tokens minted by /oauth/token (aud="sutra-mcp").
    Validation mirrors ``auth.deps.current_user`` exactly: HS256 signature + expiry, then re-fetch the
    user row so a deleted account can't keep acting. Returns None on ANY failure (the caller turns that
    into a 401). The token is validated locally and never logged or forwarded.
    """
    if not auth_enabled() or not token:
        return None
    try:
        # Decode with the SAME secret + algorithm the foundation uses (imported from auth.security, not
        # re-implemented), verifying signature + expiry. We disable PyJWT's built-in audience check and
        # enforce it ourselves below, because we must accept BOTH a plain Phase-1 token (no `aud`, which
        # PyJWT would otherwise pass) AND an OAuth token (aud="sutra-mcp", which PyJWT rejects unless an
        # `audience` is supplied). Any token carrying a DIFFERENT audience is rejected.
        claims = jwt.decode(token, _secret(), algorithms=[_ALG], options={"verify_aud": False})
    except jwt.PyJWTError:
        return None
    aud = claims.get("aud")
    if aud is not None and aud != MCP_AUDIENCE:
        # A token scoped to some other audience must not work on /mcp.
        return None
    try:
        uid = uuid.UUID(str(claims.get("sub")))
    except (ValueError, TypeError):
        return None
    row = await auth_service.get_user_by_id(uid)
    if row is None:
        return None
    return row["id"]
