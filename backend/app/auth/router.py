"""Auth endpoints: POST /auth/signup, POST /auth/login, GET /auth/me. No passwords/tokens logged.

OAuth later adds POST /auth/oauth/{provider}/callback on this SAME router; signup/login/me are unchanged.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..schemas import DeleteAccountRequest, LoginRequest, SignupRequest
from . import service
from .deps import User, current_user, require_auth_enabled
from .security import mint_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


def _token_response(user: dict) -> dict:
    return {"access_token": mint_token(user["id"]), "token_type": "bearer"}


@router.post("/signup")
async def signup_ep(body: SignupRequest) -> dict:
    require_auth_enabled()
    try:
        user = await service.create_user(body.email, body.password)
    except ValueError as e:
        raise HTTPException(409, str(e))
    return _token_response(user)


@router.post("/login")
async def login_ep(body: LoginRequest) -> dict:
    require_auth_enabled()
    user = await service.authenticate(body.email, body.password)
    if user is None:
        # Single generic message — never reveal whether the email exists.
        raise HTTPException(401, "invalid email or password")
    return _token_response(user)


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
