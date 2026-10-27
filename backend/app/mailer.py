"""Transactional mail (forgot-password). Two backends, picked via settings.mail_provider:

- "log" (default): just logs the message — safe for dev/test with no provider configured.
- "resend": sends via the Resend HTTP API (https://resend.com). Real keys live in the gitignored .env.

`send` NEVER raises — a mail-provider hiccup must never break the request that triggered it (e.g.
POST /auth/request-reset always returns 200 regardless of delivery success). Failures are logged.
"""
from __future__ import annotations

import logging

import httpx

from .config import settings

log = logging.getLogger("sutra.mailer")

_RESEND_URL = "https://api.resend.com/emails"


async def send(to: str, subject: str, text: str) -> None:
    """Best-effort send. Errors are caught and logged, never raised."""
    try:
        if settings.mail_provider == "resend" and settings.resend_api_key:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(
                    _RESEND_URL,
                    headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                    json={"from": settings.mail_from, "to": [to], "subject": subject, "text": text},
                )
                r.raise_for_status()
        else:
            log.info("[mail:log] to=%s subject=%s\n%s", to, subject, text)
    except Exception as e:  # never let a mail failure break the caller's request
        log.warning("mail send failed to=%s subject=%s: %s", to, subject, e)
