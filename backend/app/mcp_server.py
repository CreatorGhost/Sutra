"""Tier B hosted MCP — the SAME 10 read tools as Tier A (mcp-plan.md §4/§5), but multi-tenant.

Each tool is backed by the user-scoped services in ``app.services.tenant`` (every function takes
``user_id`` first and is fully scoped — a missing scope would be a cross-user leak). The bearer token
on the inbound request is validated LOCALLY with the foundation's JWT logic (``decode_token`` +
re-fetch the user row, exactly like ``auth.deps.current_user``) and NEVER forwarded anywhere. No tool
answers without a valid token; every tool is scoped to that token's ``user_id`` (default-deny).

Privacy mirrors Tier A: the tenant services already whitelist every output field server-side
(no voiceprint, no embedding, no redacted turns, no draft body, no graph turn_ids, no token, no
vendor/model names), and ``get_your_context`` emits ONLY share_cloud=1 AND (confirmed OR user) priors.
This module adds no new fields — it relays the already-whitelisted dict/list straight through.

Mounted on the FastAPI server variant in ``app.main`` via::

    mcp_app = mcp.http_app(path="/", stateless_http=True)
    api.mount("/mcp", mcp_app)
    FastAPI(..., lifespan=mcp_app.lifespan)   # the python-sdk issue #1367 handoff

search_memory / ask_memory call the provider (embeddings/LLM) server-to-server through the existing
provider abstraction — inside the trust boundary; the key is already server-side. The stateless proxy
(app.proxy) is untouched.
"""
from __future__ import annotations

import datetime as dt
import uuid

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_headers

from .auth.security import auth_enabled
from .db import get_pool
from .mcp_write_settings import write_allowed
from .oauth import verify_mcp_bearer
from .services import graph as graph_svc
from .services import tenant

mcp: FastMCP = FastMCP(name="sutra-memory")

# Shown verbatim when a write tool is invoked but the user has not enabled it (master OR per-tool off).
# No vendor/model name; points the user at the exact toggle.
CONSENT_DENIED = "Memory updates are disabled. Enable them in Sutra Settings → Cloud sync."


# ---------------------------------------------------------------- auth ----
async def _require_user() -> uuid.UUID:
    """Resolve the inbound bearer JWT -> user_id, mirroring auth.deps.current_user EXACTLY.

    The token is validated locally (HS256 signature + expiry) and the user row is re-fetched so a
    deleted account can't keep acting. Never forwarded. Default-deny: any failure raises ToolError,
    so no tool ever runs without a valid token. Error strings carry no token, no vendor names, and
    no internals.
    """
    if not auth_enabled():
        raise ToolError("account features are not enabled on this server")
    headers = get_http_headers()
    authorization = headers.get("authorization")
    if not authorization:
        raise ToolError("missing bearer token")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise ToolError("malformed authorization header")
    token = parts[1].strip()
    # verify_mcp_bearer accepts BOTH Phase-1 plain JWTs (no aud — back-compat for CLI/testing) AND
    # OAuth-connector JWTs (aud="sutra-mcp"); it verifies HS256 signature + expiry with the SAME secret
    # the foundation uses, rejects any other audience, and re-fetches the user row so a deleted account
    # can't keep acting. The token is validated locally and never forwarded.
    uid = await verify_mcp_bearer(token)
    if uid is None:
        raise ToolError("invalid token")
    return uid


def _parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


# --------------------------------------------------------------- write ----
# Helpers shared by the 5 write tools (Tier B Phase 2). Every write: (1) resolves the user from the
# bearer JWT, (2) checks master AND per-tool consent for THIS request (default-deny), (3) mutates ONLY
# the caller's rows non-destructively, (4) writes one audit_log row with whitelisted before/after
# snapshots, and (5) stamps origin='mcp' so the row survives the next phone /sync. Foreign or
# already-superseded ids resolve to nothing under the user_id scope -> a "not found" ToolError that
# NEVER reveals another user's data. Returns are explicit whitelisted dicts (no row spreads).

def _clamp_str(value, max_len: int) -> str | None:
    """Trim to max_len and strip; None/empty -> None. Pure server-side clamp (defense in depth)."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    return s[:max_len]


async def _require_consent(user_id: uuid.UUID, tool: str) -> None:
    """Default-deny gate: raise the consent error unless master AND the tool's per-tool flag are on."""
    if not await write_allowed(user_id, tool):
        raise ToolError(CONSENT_DENIED)


async def _audit(conn, user_id: uuid.UUID, tool: str, args_summary: dict,
                 before: dict | None, after: dict | None) -> None:
    """Insert one audit row. before/after are whitelisted snapshots only — never embeddings, voiceprints,
    tokens, or draft bodies. Written in the SAME transaction as the mutation so they commit together."""
    await conn.execute(
        "INSERT INTO audit_log(user_id, tool, args_summary, before, after) VALUES($1,$2,$3,$4,$5)",
        user_id, tool, args_summary or {}, before, after,
    )


# --------------------------------------------------------------- tools ----
# Names, params, clamps, and descriptions mirror Tier A (mcp-server/src/server.ts) 1:1. The clamps
# are re-applied here (defense in depth) on top of the service-side clamps. All read-only.

@mcp.tool(
    name="search_memory",
    description=(
        "Search your captured conversations and return ranked memory cards "
        "(title, summary, key facts, importance, date). Read-only."
    ),
)
async def search_memory(query: str, topN: int = 10) -> dict:
    user_id = await _require_user()
    top_n = max(1, min(50, int(topN)))
    results = await tenant.search(user_id, query, top_n)
    return {"query": query, "results": results}


@mcp.tool(
    name="get_conversation",
    description=(
        "Get one conversation's details — summary, memory, participants, events, minutes, and "
        "(if shared) its turns. Read-only."
    ),
)
async def get_conversation(id: int) -> dict | None:
    user_id = await _require_user()
    return await tenant.conversation(user_id, int(id), allow_transcripts=True)


@mcp.tool(
    name="list_conversations",
    description=(
        "List recent conversations with their summaries, importance, tags, and action counts. "
        "Read-only."
    ),
)
async def list_conversations(limit: int = 50) -> list[dict]:
    user_id = await _require_user()
    return await tenant.list_conversations(user_id, max(1, min(200, int(limit))))


@mcp.tool(
    name="list_people",
    description="List the people known across your conversations (names, whether enrolled, notes). Read-only.",
)
async def list_people() -> list[dict]:
    user_id = await _require_user()
    return await tenant.list_people(user_id)


@mcp.tool(
    name="get_graph_neighborhood",
    description=(
        "Explore the knowledge graph of people, projects, and topics around an entity — or get an "
        "overview if none is given. Read-only."
    ),
)
async def get_graph_neighborhood(entity: str | int | None = None, hops: int = 2, limit: int = 120) -> dict:
    user_id = await _require_user()
    hops = max(0, min(3, int(hops)))
    limit = max(1, min(240, int(limit)))
    entity_id: int | None = None
    entity_name: str | None = None
    if isinstance(entity, bool):  # guard: bool is an int subclass
        entity = None
    if isinstance(entity, int):
        entity_id = entity
    elif isinstance(entity, str) and entity.strip():
        s = entity.strip()
        if s.lstrip("-").isdigit():
            entity_id = int(s)
        else:
            entity_name = s
    return await tenant.graph_neighborhood(user_id, entity_id=entity_id, entity=entity_name, hops=hops, limit=limit)


@mcp.tool(
    name="list_action_items",
    description="List action items extracted from conversations, filtered by status. Read-only.",
)
async def list_action_items(status: str = "open") -> list[dict]:
    user_id = await _require_user()
    status = status if status in ("open", "done", "all") else "open"
    return await tenant.list_action_items(user_id, status)


@mcp.tool(
    name="upcoming_events",
    description="List upcoming dated events extracted from conversations. Read-only.",
)
async def upcoming_events(from_: str | None = None, limit: int = 50) -> list[dict]:
    user_id = await _require_user()
    return await tenant.upcoming_events(user_id, _parse_iso(from_), max(1, min(50, int(limit))))


@mcp.tool(
    name="get_minutes",
    description="Get the meeting minutes for a conversation, if any were generated. Read-only.",
)
async def get_minutes(conversationId: int) -> dict | None:
    user_id = await _require_user()
    return await tenant.minutes(user_id, int(conversationId))


@mcp.tool(
    name="get_your_context",
    description=(
        "Get the standing beliefs the user has chosen to share about people, projects, and "
        "themselves. These are user-shared beliefs that may be outdated and are not ground truth — "
        "prefer the actual conversations. Read-only."
    ),
)
async def get_your_context(query: str | None = None, topN: int = 8) -> dict:
    user_id = await _require_user()
    priors = await tenant.top_priors(user_id, query or "", max(1, min(20, int(topN))))
    return {
        "note": "Beliefs the user chose to share — may be outdated; not ground truth.",
        "priors": priors,
    }


@mcp.tool(
    name="ask_memory",
    description=(
        "Ask a natural-language question and get a grounded, cited answer synthesized from your "
        "memory. Read-only."
    ),
)
async def ask_memory(question: str, history: list[dict] | None = None) -> dict:
    user_id = await _require_user()
    hist = None
    if isinstance(history, list):
        hist = [
            {"role": h.get("role"), "content": h.get("content")}
            for h in history[:10]
            if isinstance(h, dict) and h.get("role") in ("user", "assistant")
        ]
    return await tenant.ask(user_id, question, hist)


# --------------------------------------------------------- WRITE tools ----
# Tier B Phase 2. Curated, consented (default-OFF master + per-tool), audit-logged, reversible, and
# strictly non-destructive — none deletes a row or touches another user. Each is scoped to the token's
# user_id and stamps origin='mcp' so the change persists across the next phone sync.

_VALID_KINDS = ("person", "project", "org", "role", "topic", "goal", "pref")


@mcp.tool(
    name="add_fact",
    description=(
        "Add a standing fact to the user's cloud memory (e.g. a preference, a person, a project). "
        "Only works when the user has enabled memory updates in Settings. Recorded in the update log "
        "and reversible."
    ),
)
async def add_fact(subject: str, value: str | None = None, kind: str = "pref") -> dict:
    user_id = await _require_user()
    await _require_consent(user_id, "add_fact")
    subj = _clamp_str(subject, 200)
    if not subj:
        raise ToolError("subject is required")
    val = _clamp_str(value, 500)
    k = kind if kind in _VALID_KINDS else "pref"
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """INSERT INTO priors(user_id, kind, subject, norm_subject, value, provenance, status,
                       confidence, share_cloud, is_prior, origin, valid_from, last_confirmed_at)
                   VALUES($1,$2,$3,$4,$5,'user','confirmed',0.8,TRUE,TRUE,'mcp',now(),now())
                   RETURNING id, kind, subject, value, status""",
                user_id, k, subj, graph_svc.norm_name(subj), val,
            )
            after = {"id": row["id"], "kind": row["kind"], "subject": row["subject"],
                     "value": row["value"], "status": row["status"]}
            await _audit(conn, user_id, "add_fact",
                         {"subject": subj, "kind": k, "value": val}, None, after)
    return after


@mcp.tool(
    name="correct_fact",
    description=(
        "Correct a standing fact by replacing it with an updated version. The old version is preserved "
        "(superseded, not deleted) so the change is fully reversible from the update log. Only works "
        "when the user has enabled memory updates in Settings."
    ),
)
async def correct_fact(prior_id: int, subject: str | None = None, value: str | None = None) -> dict:
    user_id = await _require_user()
    await _require_consent(user_id, "correct_fact")
    new_subject = _clamp_str(subject, 200)
    new_value = _clamp_str(value, 500)
    if new_subject is None and value is None:
        # require at least one field; value="" is a valid clear-intent, so check `value is None` not falsy
        raise ToolError("provide a new subject or value")
    try:
        pid = int(prior_id)
    except (ValueError, TypeError):
        raise ToolError("fact not found")
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Scope to user_id AND active (not already superseded / not expired): a foreign or
            # already-corrected id resolves to nothing -> "fact not found", never another user's row.
            old = await conn.fetchrow(
                "SELECT id, kind, subject, value, attrs, confidence FROM priors "
                "WHERE id=$1 AND user_id=$2 AND superseded_by IS NULL AND valid_to IS NULL",
                pid, user_id,
            )
            if old is None:
                raise ToolError("fact not found")
            # Copy unspecified fields from the old row. `value` is honoured whenever it was passed
            # (including an empty string -> clear the value); subject falls back to the old subject.
            final_subject = new_subject if new_subject is not None else old["subject"]
            final_value = new_value if value is not None else old["value"]
            new_row = await conn.fetchrow(
                """INSERT INTO priors(user_id, kind, subject, norm_subject, value, attrs, provenance,
                       status, confidence, share_cloud, is_prior, origin, valid_from, last_confirmed_at)
                   VALUES($1,$2,$3,$4,$5,$6,'user','confirmed',$7,TRUE,TRUE,'mcp',now(),now())
                   RETURNING id, subject, value""",
                user_id, old["kind"], final_subject, graph_svc.norm_name(final_subject),
                final_value, old["attrs"] or {},
                float(old["confidence"]) if old["confidence"] is not None else 0.8,
            )
            await conn.execute(
                "UPDATE priors SET superseded_by=$1, valid_to=now() WHERE id=$2 AND user_id=$3",
                new_row["id"], pid, user_id,
            )
            before = {"id": old["id"], "subject": old["subject"], "value": old["value"]}
            after = {"id": new_row["id"], "subject": new_row["subject"], "value": new_row["value"]}
            await _audit(conn, user_id, "correct_fact",
                         {"prior_id": pid, "subject": new_subject, "value": new_value}, before, after)
    return {"old_id": pid, "new_id": new_row["id"], "subject": new_row["subject"], "value": new_row["value"]}


@mcp.tool(
    name="add_action_item",
    description=(
        "Add a to-do / action item to the user's cloud memory. Only works when the user has enabled "
        "memory updates in Settings. Recorded in the update log and reversible."
    ),
)
async def add_action_item(text: str, owner: str | None = None, due: str | None = None) -> dict:
    user_id = await _require_user()
    await _require_consent(user_id, "add_action_item")
    txt = _clamp_str(text, 300)
    if not txt:
        raise ToolError("text is required")
    own = _clamp_str(owner, 100)
    due_dt = _parse_iso(due)
    due_date = due_dt.date() if due_dt is not None else None
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "INSERT INTO action_items(user_id, text, owner, status, due, origin) "
                "VALUES($1,$2,$3,'open',$4,'mcp') RETURNING id, text, owner, status, due",
                user_id, txt, own, due_date,
            )
            after = {"id": row["id"], "text": row["text"], "owner": row["owner"],
                     "status": row["status"], "due": row["due"].isoformat() if row["due"] else None}
            await _audit(conn, user_id, "add_action_item",
                         {"text": txt, "owner": own, "due": after["due"]}, None, after)
    return after


@mcp.tool(
    name="update_action_item",
    description=(
        "Update an existing to-do (mark it done, or edit its text/owner/due date). Never deletes. Only "
        "works when the user has enabled memory updates in Settings. Recorded in the update log and "
        "reversible. Items that came from the user's phone may be replaced on the next phone sync."
    ),
)
async def update_action_item(id: int, status: str | None = None, text: str | None = None,
                             owner: str | None = None, due: str | None = None) -> dict:
    user_id = await _require_user()
    await _require_consent(user_id, "update_action_item")
    try:
        aid = int(id)
    except (ValueError, TypeError):
        raise ToolError("not found")
    new_status = status if status in ("open", "done") else None
    new_text = _clamp_str(text, 300)
    new_owner = _clamp_str(owner, 100)
    due_provided = due is not None
    due_dt = _parse_iso(due)
    new_due = due_dt.date() if due_dt is not None else None
    if new_status is None and new_text is None and new_owner is None and not due_provided:
        raise ToolError("provide at least one field to update")
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            old = await conn.fetchrow(
                "SELECT id, text, owner, status, due, origin FROM action_items "
                "WHERE id=$1 AND user_id=$2",
                aid, user_id,
            )
            if old is None:
                raise ToolError("not found")
            fields = []
            params: list = []
            i = 1
            if new_status is not None:
                fields.append(f"status=${i}"); params.append(new_status); i += 1
            if new_text is not None:
                fields.append(f"text=${i}"); params.append(new_text); i += 1
            if new_owner is not None:
                fields.append(f"owner=${i}"); params.append(new_owner); i += 1
            if due_provided:
                fields.append(f"due=${i}"); params.append(new_due); i += 1
            params.extend([aid, user_id])
            row = await conn.fetchrow(
                f"UPDATE action_items SET {', '.join(fields)} WHERE id=${i} AND user_id=${i+1} "
                "RETURNING id, text, owner, status, due, origin",
                *params,
            )
            before = {"id": old["id"], "text": old["text"], "owner": old["owner"],
                      "status": old["status"], "due": old["due"].isoformat() if old["due"] else None}
            after = {"id": row["id"], "text": row["text"], "owner": row["owner"], "status": row["status"],
                     "due": row["due"].isoformat() if row["due"] else None}
            await _audit(conn, user_id, "update_action_item",
                         {"id": aid, "status": new_status, "text": new_text, "owner": new_owner,
                          "due": new_due.isoformat() if new_due else None}, before, after)
    result = {"id": after["id"], "text": after["text"], "owner": after["owner"],
              "status": after["status"], "due": after["due"]}
    if (old["origin"] or "device") == "device":
        result["note"] = "This item came from your phone; the change may be replaced on the next sync."
    return result


@mcp.tool(
    name="relabel_person",
    description=(
        "Rename a known person in the user's cloud memory (set their canonical name). The previous name "
        "is preserved in the update log so the change is reversible. Only works when the user has "
        "enabled memory updates in Settings."
    ),
)
async def relabel_person(person_id: int, name: str) -> dict:
    user_id = await _require_user()
    await _require_consent(user_id, "relabel_person")
    new_name = _clamp_str(name, 100)
    if not new_name:
        raise ToolError("name is required")
    try:
        person = int(person_id)
    except (ValueError, TypeError):
        raise ToolError("not found")
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            old = await conn.fetchrow(
                "SELECT id, canonical_name FROM people WHERE id=$1 AND user_id=$2",
                person, user_id,
            )
            if old is None:
                raise ToolError("not found")
            row = await conn.fetchrow(
                "UPDATE people SET canonical_name=$1 WHERE id=$2 AND user_id=$3 "
                "RETURNING id, canonical_name",
                new_name, person, user_id,
            )
            before = {"id": old["id"], "canonical_name": old["canonical_name"]}
            after = {"id": row["id"], "canonical_name": row["canonical_name"]}
            await _audit(conn, user_id, "relabel_person",
                         {"person_id": person, "name": new_name}, before, after)
    return {"id": after["id"], "canonical_name": after["canonical_name"]}


@mcp.tool(
    name="list_memory_updates",
    description=(
        "List recent changes made to the user's cloud memory by memory-update tools (most recent "
        "first), so the user can review and trust the trail. Read-only."
    ),
)
async def list_memory_updates(limit: int = 20) -> list[dict]:
    user_id = await _require_user()
    lim = max(1, min(100, int(limit)))
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id, tool, args_summary, ts FROM audit_log WHERE user_id=$1 ORDER BY ts DESC, id DESC LIMIT $2",
        user_id, lim,
    )
    # before/after are intentionally OMITTED from the tool output (kept in the DB for reversibility).
    return [
        {"id": r["id"], "tool": r["tool"], "args_summary": r["args_summary"],
         "ts": r["ts"].isoformat() if r["ts"] else None}
        for r in rows
    ]
