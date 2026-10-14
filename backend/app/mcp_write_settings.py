"""Tier B Phase 2 consent — the per-user MCP-write flags (default-deny) + their GET/PUT endpoints.

Every MCP write tool checks the MASTER flag (`mcp_write_enabled`) AND its own per-tool flag per request
(see app/mcp_server.py). An absent `user_settings` row, an absent key, or any non-true value all read as
False, so a write tool refuses until the user has explicitly opted in twice over (master + per-tool) from
Settings -> Cloud sync. The PUT endpoint accepts ONLY the six whitelisted keys — arbitrary keys are
ignored, never stored — so the consent surface can never be widened from the client.

Storage is a single JSONB blob per user (`user_settings.data`), mirroring the existing single-row
`settings` table style. Nothing here logs tokens or passwords.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Body, Depends

from .auth import User, current_user
from .db import get_pool

router = APIRouter(tags=["settings"])

# The master switch first, then one flag per write tool. These six are the ONLY accepted keys.
MASTER_KEY = "mcp_write_enabled"
TOOL_KEYS: tuple[str, ...] = (
    "mcp_write_add_fact",
    "mcp_write_correct_fact",
    "mcp_write_add_action",
    "mcp_write_update_action",
    "mcp_write_relabel_person",
)
WRITE_FLAG_KEYS: tuple[str, ...] = (MASTER_KEY, *TOOL_KEYS)

# Each write tool maps to the per-tool key it is gated on.
TOOL_FLAG_FOR: dict[str, str] = {
    "add_fact": "mcp_write_add_fact",
    "correct_fact": "mcp_write_correct_fact",
    "add_action_item": "mcp_write_add_action",
    "update_action_item": "mcp_write_update_action",
    "relabel_person": "mcp_write_relabel_person",
}


def _defaults() -> dict[str, bool]:
    """Default-deny: master + every per-tool flag start False."""
    return {k: False for k in WRITE_FLAG_KEYS}


async def get_write_flags(user_id: uuid.UUID) -> dict[str, bool]:
    """Return the user's six write flags, defaulting any absent/non-true value to False.

    A missing row == all-False (the table is created lazily on first PUT). Only whitelisted keys are
    surfaced; anything else that somehow sits in the blob is ignored.
    """
    pool = await get_pool()
    row = await pool.fetchrow("SELECT data FROM user_settings WHERE user_id=$1", user_id)
    stored = (row["data"] if row else {}) or {}
    flags = _defaults()
    if isinstance(stored, dict):
        for k in WRITE_FLAG_KEYS:
            flags[k] = stored.get(k) is True
    return flags


async def write_allowed(user_id: uuid.UUID, tool: str) -> bool:
    """True only if the master flag AND the tool's own per-tool flag are both enabled (default-deny)."""
    per_tool = TOOL_FLAG_FOR.get(tool)
    if per_tool is None:
        return False
    flags = await get_write_flags(user_id)
    return bool(flags.get(MASTER_KEY)) and bool(flags.get(per_tool))


async def set_write_flags(user_id: uuid.UUID, patch: dict) -> dict[str, bool]:
    """Merge a partial flags patch (whitelisted keys only) and return the full resulting flag set.

    Non-whitelisted keys are dropped. Values are coerced to a strict bool. The merged blob is upserted
    onto the user's row (created on first call).
    """
    clean: dict[str, bool] = {}
    if isinstance(patch, dict):
        for k in WRITE_FLAG_KEYS:
            if k in patch:
                clean[k] = patch[k] is True
    pool = await get_pool()
    current = await get_write_flags(user_id)
    current.update(clean)
    # Persist ONLY the whitelisted keys (never echo back arbitrary client input into the blob).
    to_store = {k: current[k] for k in WRITE_FLAG_KEYS}
    await pool.execute(
        "INSERT INTO user_settings(user_id, data) VALUES($1, $2) "
        "ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data",
        user_id, to_store,
    )
    return to_store


@router.get("/settings/mcp-write")
async def get_mcp_write_ep(user: User = Depends(current_user)) -> dict:
    """Current MCP-write consent flags for the signed-in user (all default False)."""
    return await get_write_flags(user.id)


@router.put("/settings/mcp-write")
async def put_mcp_write_ep(user: User = Depends(current_user), body: dict = Body(default_factory=dict)) -> dict:
    """Merge a partial flags patch and return the full flag set. Only the six whitelisted keys apply."""
    return await set_write_flags(user.id, body)
