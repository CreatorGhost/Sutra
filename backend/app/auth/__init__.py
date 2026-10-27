"""Tier B authentication: email+password accounts, argon2 hashing, HS256 JWT.

Built so Google/Facebook OAuth slot in LATER over the SAME `users` table + JWT: a new auth_provider
value + an oauth-identities table is all that is needed; the JWT shape (sub=user_id) and the
`current_user` dependency below do not change. Passwords and tokens are NEVER logged.
"""
from .deps import User, current_user, optional_current_user, require_auth_enabled
from .router import router as auth_router

__all__ = ["User", "current_user", "optional_current_user", "require_auth_enabled", "auth_router"]
