"""Auth endpoints: POST /auth/signup, POST /auth/login, GET /auth/me, DELETE /auth/account, plus the
forgot-password flow (POST /auth/request-reset, GET /auth/reset-page, POST /auth/reset). No
passwords/tokens logged.

OAuth later adds POST /auth/oauth/{provider}/callback on this SAME router; signup/login/me are unchanged.
"""
from __future__ import annotations

import hashlib
import html
import os
import secrets

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse

from .. import mailer
from ..ratelimit import rate_limit
from ..schemas import DeleteAccountRequest, LoginRequest, RequestResetBody, ResetBody, SignupRequest
from . import service
from .deps import User, current_user, require_auth_enabled
from .security import mint_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

# Throttle credential-stuffing / signup abuse per client IP (in-process; see ratelimit.py).
_auth_rl = rate_limit("auth")
_reset_rl = rate_limit("reset")


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _public_url() -> str:
    """The externally-reachable base URL of this server (no trailing slash). Mirrors
    ``oauth/oconfig.public_url`` (kept separate so `app.auth` never imports `app.oauth` — auth is the
    base layer OAuth builds on, not the reverse). Defaults to localhost for dev; set SUTRA_PUBLIC_URL
    behind a reverse proxy / public deployment."""
    return (os.getenv("SUTRA_PUBLIC_URL") or "http://localhost:8000").rstrip("/")


def _token_response(user: dict) -> dict:
    return {"access_token": mint_token(user["id"]), "token_type": "bearer"}


@router.post("/signup")
async def signup_ep(body: SignupRequest, _rl: None = Depends(_auth_rl)) -> dict:
    require_auth_enabled()
    try:
        user = await service.create_user(body.email, body.password)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return _token_response(user)


@router.post("/login")
async def login_ep(body: LoginRequest, _rl: None = Depends(_auth_rl)) -> dict:
    require_auth_enabled()
    user = await service.authenticate(body.email, body.password)
    if user is None:
        # Single generic message — never reveal whether the email exists.
        raise HTTPException(401, "invalid email or password")
    return _token_response(user)


@router.post("/request-reset")
async def request_reset_ep(body: RequestResetBody, _rl: None = Depends(_reset_rl)) -> dict:
    """Kick off a password reset. ALWAYS returns 200 {"ok": true} — never reveals whether the email
    is registered (anti user-enumeration). A matching account gets a time-limited, single-use reset
    link by email; an unknown email is a silent no-op (still hashes a throwaway token so response
    timing doesn't leak the difference)."""
    require_auth_enabled()
    user = await service.get_user_by_email(body.email)
    if user is not None:
        token = secrets.token_urlsafe(32)
        await service.create_password_reset_token(user["id"], _hash_token(token))
        link = f"{_public_url()}/auth/reset-page?token={token}"
        await mailer.send(
            user["email"],
            "Reset your Sutra password",
            "Someone requested a password reset for your Sutra account.\n\n"
            f"Reset it here (valid {service.RESET_TOKEN_TTL_MINUTES} minutes): {link}\n\n"
            "If you didn't request this, you can safely ignore this email.",
        )
    else:
        _hash_token(secrets.token_urlsafe(32))  # dummy work — keep timing roughly uniform
    return {"ok": True}


@router.get("/reset-page", response_class=HTMLResponse)
async def reset_page_ep(token: str = "") -> HTMLResponse:
    """Minimal, dependency-free password-reset form (inline CSS, no external assets). Submits JSON to
    POST /auth/reset via fetch(). The token is only ever HTML-escaped into the page, never executed."""
    return HTMLResponse(_RESET_PAGE_HTML.replace("__TOKEN__", html.escape(token, quote=True)))


@router.post("/reset")
async def reset_ep(body: ResetBody) -> dict:
    """Redeem a reset token minted by /auth/request-reset. Single-use + expiring: the token row is
    atomically claimed (used_at set) before the password is changed, so a token can't be replayed."""
    require_auth_enabled()
    row = await service.consume_password_reset_token(_hash_token(body.token))
    if row is None:
        raise HTTPException(400, "invalid or expired reset link")
    await service.set_password(row["user_id"], body.new_password)
    return {"ok": True}


@router.get("/me")
async def me_ep(user: User = Depends(current_user)) -> dict:
    return {"id": str(user.id), "email": user.email, "auth_provider": user.auth_provider}


@router.delete("/account")
async def delete_account_ep(body: DeleteAccountRequest, user: User = Depends(current_user)) -> dict:
    """Delete my account — immediate and complete (ON DELETE CASCADE wipes every user-data table:
    memory projection, entitlements, usage, audit log, OAuth grants, settings). Requires a fresh
    confirmation: the password for password accounts, the typed email for social accounts. The
    phone keeps its local memory untouched and returns to the sign-in gate."""
    if str(user.id) == service.SYSTEM_USER_ID:
        # The single-tenant sentinel owns pre-Tier-B rows and must never be deletable via API.
        raise HTTPException(403, "this account cannot be deleted")
    if user.auth_provider == "password":
        row = await service.get_user_by_id(user.id)
        if not body.password or not verify_password(body.password, (row or {}).get("password_hash")):
            raise HTTPException(403, "password confirmation failed")
    else:
        confirmed = (body.confirm_email or "").strip().lower()
        if not confirmed or confirmed != user.email.strip().lower():
            raise HTTPException(403, "email confirmation failed")
    await service.delete_user(user.id)
    return {"deleted": True}


# Self-contained reset-password page: no external assets, no template engine — the token is the only
# variable and it is HTML-escaped by reset_page_ep before substitution.
_RESET_PAGE_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reset your Sutra password</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0b0b0f; color: #eee; display: flex; min-height: 100vh;
         align-items: center; justify-content: center; margin: 0; padding: 16px; }
  .card { width: 100%; max-width: 380px; background: #16161d; border: 1px solid #2a2a34;
          border-radius: 14px; padding: 28px; box-sizing: border-box; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p.sub { font-size: 13px; color: #999; margin: 0 0 20px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: #ccc; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 14px;
          border-radius: 8px; border: 1px solid #333; background: #0e0e13; color: #eee; font-size: 14px; }
  button { width: 100%; padding: 11px; border-radius: 8px; border: none; background: #6d5ef2;
           color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .msg { margin-top: 14px; font-size: 13px; }
  .msg.err { color: #ff8080; }
  .msg.ok { color: #7ee68f; }
</style>
</head>
<body>
  <div class="card">
    <h1>Reset your password</h1>
    <p class="sub">Choose a new password for your Sutra account.</p>
    <form id="f">
      <label for="pw">New password</label>
      <input id="pw" type="password" autocomplete="new-password" placeholder="At least 8 characters" minlength="8" required>
      <label for="pw2">Confirm new password</label>
      <input id="pw2" type="password" autocomplete="new-password" placeholder="Repeat password" minlength="8" required>
      <button type="submit" id="btn">Reset password</button>
      <div id="msg" class="msg"></div>
    </form>
  </div>
  <script>
    var TOKEN = "__TOKEN__";
    var form = document.getElementById("f");
    var msg = document.getElementById("msg");
    var btn = document.getElementById("btn");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var pw = document.getElementById("pw").value;
      var pw2 = document.getElementById("pw2").value;
      msg.className = "msg";
      msg.textContent = "";
      if (pw.length < 8) { msg.className = "msg err"; msg.textContent = "Password must be at least 8 characters."; return; }
      if (pw !== pw2) { msg.className = "msg err"; msg.textContent = "Passwords don't match."; return; }
      btn.disabled = true;
      fetch("/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: TOKEN, new_password: pw })
      }).then(function (r) {
        if (r.ok) {
          msg.className = "msg ok";
          msg.textContent = "Password reset. You can now sign in with your new password.";
          form.querySelectorAll("input,button").forEach(function (el) { el.disabled = true; });
        } else {
          return r.json().catch(function () { return {}; }).then(function (j) {
            msg.className = "msg err";
            msg.textContent = (j && j.detail) || "That reset link is invalid or has expired.";
            btn.disabled = false;
          });
        }
      }).catch(function () {
        msg.className = "msg err";
        msg.textContent = "Network error — please try again.";
        btn.disabled = false;
      });
    });
  </script>
</body>
</html>
"""
