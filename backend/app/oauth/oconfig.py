"""Self-contained OAuth/social env reads. Kept separate from app.config so this module never edits the
shared Settings class (the write-tools agent owns config). All values are read live from the environment
so tests can monkeypatch os.environ and the verifier can configure the deployment with plain env vars.
"""
from __future__ import annotations

import os


def public_url() -> str:
    """The externally-reachable base URL of this server (no trailing slash).

    Used to build discovery documents and OAuth endpoints. Defaults to localhost for dev. Behind a
    reverse proxy / public deployment, set SUTRA_PUBLIC_URL to the public https origin so the discovery
    docs advertise reachable URLs.
    """
    return (os.getenv("SUTRA_PUBLIC_URL") or "http://localhost:8000").rstrip("/")


def _pair(id_var: str, secret_var: str) -> tuple[str, str] | None:
    cid = (os.getenv(id_var) or "").strip()
    sec = (os.getenv(secret_var) or "").strip()
    if cid and sec:
        return cid, sec
    return None


def google_creds() -> tuple[str, str] | None:
    return _pair("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")


def facebook_creds() -> tuple[str, str] | None:
    return _pair("FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET")


def provider_configured(provider: str) -> bool:
    if provider == "google":
        return google_creds() is not None
    if provider == "facebook":
        return facebook_creds() is not None
    return False
