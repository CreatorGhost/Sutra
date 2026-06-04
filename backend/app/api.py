"""All HTTP endpoints under /api. Audio uploaded to /windows is processed in-flight and discarded."""
from __future__ import annotations

import datetime as dt
import logging

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from .config import settings
from .db import get_pool
from .schemas import ChatRequest, RelabelRequest, SearchRequest, SessionCreate, SettingsUpdate
from .services import chat as chat_svc
from .services import extraction, graph, ingest, recap
from .services import people as people_svc
from .services import ranking

log = logging.getLogger("sutra.api")
router = APIRouter(prefix="/api")

# settings keys that may be changed at runtime via the Settings page
OVERRIDABLE = [
    "ai_provider", "model_transcribe", "model_extract", "model_rerank", "model_embed",
    "speaker_id_mode", "voiceprint_accept", "voiceprint_new", "consent_mode",
    "segment_gap_seconds", "segment_topic_shift", "rank_w_rrf", "rank_w_importance",
    "rank_half_life_days", "rank_rrf_k", "rank_recency", "rerank", "search_topn",
    "search_prefetch", "entity_sim_threshold", "recap_enabled", "recap_to", "recap_time",
    "retention_days",
]


# ---------- health & settings ----------
@router.get("/health")
async def health() -> dict:
    pool = await get_pool()
    try:
        db = bool(await pool.fetchval("SELECT 1"))
    except Exception:
        db = False
    return {
        "status": "ok", "db": db, "provider": settings.ai_provider,
        "speaker_id_mode": settings.speaker_id_mode, "consent_mode": settings.consent_mode,
        "models": {"transcribe": settings.model_transcribe, "extract": settings.model_extract, "embed": settings.model_embed},
        "privacy": "audio is never persisted",
    }


@router.get("/settings")
async def get_settings_ep() -> dict:
    return {k: getattr(settings, k) for k in OVERRIDABLE}


@router.put("/settings")
async def put_settings_ep(body: SettingsUpdate) -> dict:
    pool = await get_pool()
    data = body.data or {}
    applied = {}
    for k, v in data.items():
        if k in OVERRIDABLE:
            try:
                cur = getattr(settings, k)
                setattr(settings, k, type(cur)(v) if not isinstance(cur, bool) else bool(v))
                applied[k] = getattr(settings, k)
            except Exception as e:
                log.warning("setting %s rejected: %s", k, e)
    await pool.execute(
        "UPDATE settings SET data = data || $1 WHERE id=1", applied
    )
    return {"applied": applied}


# ---------- sessions & capture ----------
@router.post("/sessions")
async def create_session_ep(body: SessionCreate = Body(default=SessionCreate())) -> dict:
    return await ingest.create_session(body.device)


@router.get("/sessions")
async def list_sessions_ep() -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        """SELECT s.id, s.device, s.status, s.started_at, s.ended_at,
                  (SELECT count(*) FROM turns t WHERE t.session_id=s.id) AS turn_count
           FROM sessions s ORDER BY s.started_at DESC LIMIT 200"""
    )
    return [dict(r) for r in rows]


@router.post("/sessions/{sid}/windows")
async def ingest_window_ep(sid: int, file: UploadFile = File(...), window_index: int = Form(0)) -> dict:
    audio = await file.read()  # in-memory only; never written to disk
    try:
        return await ingest.ingest_window(
            sid, audio, file.filename or "window.webm", file.content_type or "audio/webm", window_index
        )
    except ValueError as e:
        raise HTTPException(404, str(e))
    finally:
        del audio


@router.post("/sessions/{sid}/close")
async def close_session_ep(sid: int) -> dict:
    pool = await get_pool()
    if not await pool.fetchval("SELECT 1 FROM sessions WHERE id=$1", sid):
        raise HTTPException(404, "session not found")
    await ingest.close_session(sid)
    return {"session_id": sid, "status": "closed"}


@router.post("/sessions/{sid}/process")
async def process_session_ep(sid: int) -> dict:
    pool = await get_pool()
    if not await pool.fetchval("SELECT 1 FROM sessions WHERE id=$1", sid):
        raise HTTPException(404, "session not found")
    return await extraction.process_session(sid)


@router.get("/sessions/{sid}/turns")
async def session_turns_ep(sid: int) -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        """SELECT t.id, t.session_speaker_label, t.person_id, p.canonical_name AS person_name,
                  p.is_me, t.speaker_confidence, t.text, t.lang, t.start_ts, t.end_ts,
                  t.conversation_id, t.redacted
           FROM turns t LEFT JOIN people p ON p.id=t.person_id
           WHERE t.session_id=$1 ORDER BY t.window_index, t.start_ts, t.id""",
        sid,
    )
    return [dict(r) for r in rows]


# ---------- people ----------
@router.get("/people")
async def list_people_ep() -> list[dict]:
    return await people_svc.list_people()


@router.post("/people/enroll")
async def enroll_ep(
    name: str = Form(..., min_length=1, max_length=120), is_me: bool = Form(False),
    notes: str | None = Form(None, max_length=2000), file: UploadFile | None = File(None),
) -> dict:
    audio = await file.read() if file is not None else None
    return await people_svc.enroll_person(name, is_me, audio, notes)


@router.post("/sessions/{sid}/speakers/{label}")
async def relabel_ep(sid: int, label: str, body: RelabelRequest) -> dict:
    try:
        return await people_svc.relabel_speaker(sid, label, body.person_id, body.name, body.is_me)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/people/{pid}")
async def del_person_ep(pid: int) -> dict:
    await people_svc.delete_person(pid)
    return {"deleted": pid}


# ---------- conversations & memories ----------
@router.get("/conversations")
async def list_conversations_ep() -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        """SELECT c.id, c.title, c.started_at, c.ended_at, c.participant_person_ids,
                  m.summary, m.importance_score, m.type_tags,
                  jsonb_array_length(m.action_items) AS action_count
           FROM conversations c LEFT JOIN memories m ON m.conversation_id=c.id
           ORDER BY c.started_at DESC NULLS LAST LIMIT 200"""
    )
    return [dict(r) for r in rows]


@router.get("/conversations/{cid}")
async def conversation_detail_ep(cid: int) -> dict:
    pool = await get_pool()
    conv = await pool.fetchrow("SELECT * FROM conversations WHERE id=$1", cid)
    if conv is None:
        raise HTTPException(404, "conversation not found")
    mem = await pool.fetchrow(
        "SELECT id, conversation_id, summary, facts, action_items, decisions, "
        "importance_score, type_tags, created_at FROM memories WHERE conversation_id=$1",
        cid,
    )
    turns = await pool.fetch(
        """SELECT t.id, t.session_speaker_label, p.canonical_name AS person_name, p.is_me,
                  t.text, t.lang, t.start_ts FROM turns t LEFT JOIN people p ON p.id=t.person_id
           WHERE t.conversation_id=$1 ORDER BY t.window_index, t.start_ts, t.id""",
        cid,
    )
    parts = await pool.fetch(
        "SELECT id, canonical_name, is_me FROM people WHERE id = ANY($1::bigint[])",
        list(conv["participant_person_ids"] or []),
    )
    return {
        "conversation": dict(conv),
        "memory": dict(mem) if mem else None,
        "turns": [dict(t) for t in turns],
        "participants": [dict(p) for p in parts],
    }


# ---------- graph ----------
@router.get("/graph")
async def graph_ep(entity_id: int | None = None, hops: int = 2) -> dict:
    pool = await get_pool()
    if entity_id is not None:
        return await graph.expand([entity_id], hops=hops)
    top = await pool.fetch(
        "SELECT id FROM entities ORDER BY mention_count DESC, importance DESC LIMIT 80"
    )
    ids = [r["id"] for r in top]
    return await graph.expand(ids, hops=1, limit=200) if ids else {"nodes": [], "edges": []}


@router.get("/entities")
async def entities_ep() -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id, type, canonical_name, importance, mention_count, first_seen, last_seen "
        "FROM entities ORDER BY mention_count DESC, importance DESC LIMIT 300"
    )
    return [dict(r) for r in rows]


# ---------- search & chat ----------
@router.post("/search")
async def search_ep(body: SearchRequest) -> dict:
    results = await ranking.search(body.q, body.top_n)
    return {"query": body.q, "results": results}


@router.post("/chat")
async def chat_ep(body: ChatRequest) -> dict:
    return await chat_svc.chat(body.message, body.history)


# ---------- action items ----------
@router.get("/action_items")
async def action_items_ep(status: str | None = None) -> list[dict]:
    pool = await get_pool()
    if status:
        rows = await pool.fetch(
            "SELECT * FROM action_items WHERE status=$1 ORDER BY created_at DESC", status
        )
    else:
        rows = await pool.fetch("SELECT * FROM action_items ORDER BY created_at DESC LIMIT 300")
    return [dict(r) for r in rows]


@router.patch("/action_items/{aid}")
async def update_action_ep(aid: int, body: dict = Body(...)) -> dict:
    pool = await get_pool()
    status = body.get("status")
    if status not in ("open", "done", "dropped"):
        raise HTTPException(400, "invalid status")
    res = await pool.execute("UPDATE action_items SET status=$1 WHERE id=$2", status, aid)
    if res.endswith(" 0"):
        raise HTTPException(404, "action item not found")
    return {"id": aid, "status": status}


@router.post("/action_items/{aid}/draft")
async def draft_action_ep(aid: int) -> dict:
    pool = await get_pool()
    ai = await pool.fetchrow("SELECT * FROM action_items WHERE id=$1", aid)
    if ai is None:
        raise HTTPException(404, "action item not found")
    from .providers import get_provider

    schema = {
        "name": "draft", "strict": True,
        "schema": {"type": "object", "properties": {"draft": {"type": "string"}},
                   "required": ["draft"], "additionalProperties": False},
    }
    out = await get_provider().extract(
        schema,
        "Write a short, polite email draft to accomplish this action item. Output only the email body.",
        f"Action item: {ai['text']}\nOwner: {ai['owner']}\nDue: {ai['due']}",
    )
    draft = out.get("draft", "")
    await pool.execute("UPDATE action_items SET generated_draft=$1 WHERE id=$2", draft, aid)
    return {"id": aid, "draft": draft}


# ---------- recap ----------
@router.post("/recap/run")
async def run_recap_ep(body: dict = Body(default={})) -> dict:
    raw = body.get("day")
    if raw:
        try:
            day = dt.date.fromisoformat(str(raw))
        except (ValueError, TypeError):
            raise HTTPException(400, "invalid day; expected YYYY-MM-DD")
    else:
        day = dt.datetime.now(dt.timezone.utc).date()
    emailed = await recap.send_recap_email(day)
    roll = await get_pool()
    r = await roll.fetchrow("SELECT * FROM daily_rollups WHERE day=$1", day)
    return {"emailed": emailed, "rollup": dict(r) if r else None}


@router.get("/rollups")
async def rollups_ep() -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch("SELECT * FROM daily_rollups ORDER BY day DESC LIMIT 90")
    return [dict(r) for r in rows]
