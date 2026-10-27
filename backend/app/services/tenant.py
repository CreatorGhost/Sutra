"""Tier B scoped data layer — every read service the hosted MCP exposes, with user_id threaded into
EVERY WHERE clause. No function here issues a global (unscoped) query: a missing scope is a cross-user
leak, which is the #1 release blocker (tier-b-plan.md §4.1).

These mirror the single-tenant server services (ranking.search, chat.chat, graph.expand, people.list,
the api.py conversation/action/event handlers) AND the Tier-A field whitelists (mcp-plan.md §5):
NO voiceprint, NO embedding, NO redacted turns, NO generated_draft body, NO graph turn_ids, and
get_your_context emits ONLY share_cloud=1 AND (confirmed OR user) priors.

The MCP read tools wrap these 1:1 — each takes `user_id: uuid.UUID` first and returns plain dict/list
JSON-safe structures (no DB rows spread blindly; sensitive columns are never SELECTed).

search_memory/ask_memory still call the provider (embeddings/LLM) server-to-server through the
existing provider abstraction — clean here since the server is inside our trust boundary.
"""
from __future__ import annotations

import datetime as dt
import uuid

from ..db import get_pool
from ..providers import get_provider
from . import graph as graph_svc

# ---- recency decay, mirrors ranking._recency (avoids importing the global-settings coupling) ----
from ..config import get_runtime_settings, refresh_runtime_settings


def _recency(created_at: dt.datetime | None, half_life_days: float, on: bool) -> float:
    if not on or created_at is None:
        return 1.0
    age_days = (dt.datetime.now(dt.timezone.utc) - created_at).total_seconds() / 86400.0
    return 0.5 ** (age_days / max(0.5, half_life_days))


# ---------- search_memory ----------
async def search(user_id: uuid.UUID, query: str, top_n: int | None = None) -> list[dict]:
    """Hybrid (semantic + lexical) retrieval over THIS user's memories only. RRF + recency + importance.
    Returns whitelisted memory cards (no embedding column ever leaves)."""
    query = (query or "").strip()
    if not query:
        return []
    pool = await get_pool()
    await refresh_runtime_settings()
    rt = get_runtime_settings()
    top_n = top_n or rt.search_topn
    prefetch = rt.search_prefetch
    provider = get_provider()

    qvec = (await provider.embed([query]))[0]
    sem = await pool.fetch(
        """SELECT m.id, 1 - (m.embedding <=> $1) AS sim
           FROM memories m WHERE m.user_id=$3 AND m.embedding IS NOT NULL
           ORDER BY m.embedding <=> $1 LIMIT $2""",
        qvec, prefetch, user_id,
    )
    lex = await pool.fetch(
        """SELECT m.id, ts_rank(m.search_tsv, websearch_to_tsquery('simple', $1)) AS rank
           FROM memories m
           WHERE m.user_id=$3 AND m.search_tsv @@ websearch_to_tsquery('simple', $1)
           ORDER BY rank DESC LIMIT $2""",
        query, prefetch, user_id,
    )

    k = rt.rank_rrf_k
    rrf: dict[int, float] = {}
    for pos, r in enumerate(sem):
        rrf[r["id"]] = rrf.get(r["id"], 0.0) + 1.0 / (k + pos + 1)
    for pos, r in enumerate(lex):
        rrf[r["id"]] = rrf.get(r["id"], 0.0) + 1.0 / (k + pos + 1)
    if not rrf:
        return []

    rmax = max(rrf.values()) or 1.0
    ids = list(rrf.keys())
    rows = await pool.fetch(
        """SELECT m.id, m.conversation_id, m.title, m.summary, m.facts, m.importance_score,
                  m.created_at, c.title AS conv_title, c.started_at
           FROM memories m JOIN conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
           WHERE m.user_id=$2 AND m.id = ANY($1::bigint[])""",
        ids, user_id,
    )
    on_recency = rt.rank_recency.lower() == "on"
    out = []
    for r in rows:
        rrf_norm = rrf[r["id"]] / rmax
        score = rt.rank_w_rrf * rrf_norm * _recency(r["created_at"], rt.rank_half_life_days, on_recency) * (
            1.0 + rt.rank_w_importance * float(r["importance_score"])
        )
        out.append({
            "conversation_id": r["conversation_id"],
            "title": r["title"] or r["conv_title"],
            "summary": r["summary"],
            "facts": r["facts"],
            "importance": float(r["importance_score"]),
            "started_at": r["started_at"].isoformat() if r["started_at"] else None,
            "score": round(score, 6),
        })
    out.sort(key=lambda x: x["score"], reverse=True)
    return out[:top_n]


# ---------- get_conversation ----------
async def conversation(user_id: uuid.UUID, conversation_id: int, *, allow_transcripts: bool = True) -> dict | None:
    """Whitelisted conversation detail scoped to the user. Redacted turns are filtered IN SQL
    (defense-in-depth: a redacted turn can never reach an external consumer)."""
    pool = await get_pool()
    conv = await pool.fetchrow(
        "SELECT id, title, started_at, ended_at, is_meeting, refined, participant_person_ids "
        "FROM conversations WHERE id=$1 AND user_id=$2",
        conversation_id, user_id,
    )
    if conv is None:
        return None
    mem = await pool.fetchrow(
        "SELECT title, summary, facts, action_items, decisions, importance_score, type_tags "
        "FROM memories WHERE conversation_id=$1 AND user_id=$2",
        conversation_id, user_id,
    )
    turns = []
    if allow_transcripts:
        turn_rows = await pool.fetch(
            """SELECT t.session_speaker_label, t.person_id, p.canonical_name AS person_name,
                      p.is_me, t.text, t.abs_start
               FROM turns t LEFT JOIN people p ON p.id=t.person_id AND p.user_id=t.user_id
               WHERE t.conversation_id=$1 AND t.user_id=$2 AND t.redacted=FALSE
               ORDER BY t.window_index, t.start_ts, t.id""",
            conversation_id, user_id,
        )
        turns = [
            {
                "speaker": t["session_speaker_label"],
                "person_id": t["person_id"],
                "person_name": t["person_name"],
                "is_me": bool(t["is_me"]),
                "text": t["text"],
                "abs_start": t["abs_start"].isoformat() if t["abs_start"] else None,
            }
            for t in turn_rows
        ]
    parts = await pool.fetch(
        "SELECT id, canonical_name, is_me FROM people WHERE user_id=$2 AND id = ANY($1::bigint[])",
        list(conv["participant_person_ids"] or []), user_id,
    )
    events = await pool.fetch(
        "SELECT id, title, when_text, start_ts, kind FROM events "
        "WHERE conversation_id=$1 AND user_id=$2 ORDER BY (start_ts IS NULL), start_ts, id",
        conversation_id, user_id,
    )
    mins = await pool.fetchrow(
        "SELECT data, generated_at FROM minutes WHERE conversation_id=$1 AND user_id=$2",
        conversation_id, user_id,
    )
    minutes = None
    if mins is not None:
        data = mins["data"] or {}
        minutes = {**(data if isinstance(data, dict) else {}),
                   "generated_at": mins["generated_at"].isoformat() if mins["generated_at"] else None}
    return {
        "conversation": {
            "id": conv["id"], "title": conv["title"],
            "started_at": conv["started_at"].isoformat() if conv["started_at"] else None,
            "ended_at": conv["ended_at"].isoformat() if conv["ended_at"] else None,
            "is_meeting": bool(conv["is_meeting"]), "refined": bool(conv["refined"]),
            "participant_person_ids": list(conv["participant_person_ids"] or []),
        },
        "memory": None if mem is None else {
            "title": mem["title"], "summary": mem["summary"], "facts": mem["facts"],
            "action_items": mem["action_items"], "decisions": mem["decisions"],
            "importance": float(mem["importance_score"]), "type_tags": list(mem["type_tags"] or []),
        },
        "turns": turns,
        "transcripts_shared": bool(allow_transcripts),
        "participants": [{"id": p["id"], "canonical_name": p["canonical_name"], "is_me": bool(p["is_me"])} for p in parts],
        "events": [{"id": e["id"], "title": e["title"], "when_text": e["when_text"],
                    "start_ts": e["start_ts"].isoformat() if e["start_ts"] else None, "kind": e["kind"]} for e in events],
        "minutes": minutes,
    }


# ---------- list_conversations ----------
async def list_conversations(user_id: uuid.UUID, limit: int = 50) -> list[dict]:
    pool = await get_pool()
    limit = max(1, min(200, int(limit)))
    rows = await pool.fetch(
        """SELECT c.id, c.title, c.started_at, c.ended_at, c.is_meeting,
                  m.summary, m.importance_score, m.type_tags,
                  jsonb_array_length(m.action_items) AS action_count
           FROM conversations c LEFT JOIN memories m ON m.conversation_id=c.id AND m.user_id=c.user_id
           WHERE c.user_id=$1
           ORDER BY c.started_at DESC NULLS LAST LIMIT $2""",
        user_id, limit,
    )
    return [
        {
            "id": r["id"], "title": r["title"],
            "started_at": r["started_at"].isoformat() if r["started_at"] else None,
            "ended_at": r["ended_at"].isoformat() if r["ended_at"] else None,
            "is_meeting": bool(r["is_meeting"]), "summary": r["summary"],
            "importance_score": None if r["importance_score"] is None else float(r["importance_score"]),
            "type_tags": list(r["type_tags"] or []), "action_count": r["action_count"],
        }
        for r in rows
    ]


# ---------- list_people (NEVER voiceprint / has_voiceprint / created_at) ----------
async def list_people(user_id: uuid.UUID) -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id, canonical_name, is_me, provisional, enroll_count, notes FROM people "
        "WHERE user_id=$1 ORDER BY is_me DESC, provisional, id",
        user_id,
    )
    return [
        {"id": r["id"], "canonical_name": r["canonical_name"], "is_me": bool(r["is_me"]),
         "provisional": bool(r["provisional"]), "enroll_count": r["enroll_count"], "notes": r["notes"]}
        for r in rows
    ]


# ---------- get_graph_neighborhood ----------
def _strip_evidence(ev) -> list[dict]:
    """Emit DEDUPED [{conversation_id}] only — turn_ids NEVER leave (kills the redacted-turn-id leak)."""
    seen: set[int] = set()
    out: list[dict] = []
    for it in (ev or []):
        cid = it.get("conversation_id") if isinstance(it, dict) else None
        if cid is None or cid in seen:
            continue
        seen.add(cid)
        out.append({"conversation_id": cid})
    return out


async def graph_neighborhood(user_id: uuid.UUID, entity_id: int | None = None,
                             entity: str | None = None, hops: int = 2, limit: int = 120) -> dict:
    """User-scoped graph neighborhood. Accepts an entity id, an entity name (norm/LIKE lookup), or
    neither (top entities overview). Evidence is stripped to {conversation_id} only."""
    pool = await get_pool()
    hops = max(0, min(3, int(hops)))
    limit = max(1, min(240, int(limit)))

    seed_ids: list[int]
    if entity_id is not None:
        owns = await pool.fetchval("SELECT 1 FROM entities WHERE id=$1 AND user_id=$2", entity_id, user_id)
        seed_ids = [entity_id] if owns else []
    elif entity:
        nn = graph_svc.norm_name(entity)
        rows = await pool.fetch(
            "SELECT id FROM entities WHERE user_id=$1 AND (norm_name=$2 OR norm_name LIKE $3) "
            "ORDER BY mention_count DESC, importance DESC LIMIT 5",
            user_id, nn, f"%{nn}%",
        )
        seed_ids = [r["id"] for r in rows]
    else:
        rows = await pool.fetch(
            "SELECT id FROM entities WHERE user_id=$1 ORDER BY mention_count DESC, importance DESC LIMIT 80",
            user_id,
        )
        seed_ids = [r["id"] for r in rows]
        hops = min(hops, 1)
    if not seed_ids:
        return {"nodes": [], "edges": []}
    return await _expand_scoped(user_id, seed_ids, hops, limit)


async def _expand_scoped(user_id: uuid.UUID, entity_ids: list[int], hops: int, limit: int) -> dict:
    """Recursive-CTE neighborhood, every edge/node constrained to user_id (mirrors graph.expand)."""
    pool = await get_pool()
    edge_rows = await pool.fetch(
        """
        WITH RECURSIVE reach(id, depth) AS (
            SELECT unnest($1::bigint[]) AS id, 0 AS depth
            UNION
            SELECT nb.id, r.depth + 1
            FROM reach r
            JOIN LATERAL (
                SELECT dst_entity AS id FROM edges WHERE user_id=$4 AND src_entity = r.id
                UNION
                SELECT src_entity AS id FROM edges WHERE user_id=$4 AND dst_entity = r.id
            ) nb ON TRUE
            WHERE r.depth < $2
        )
        SELECT DISTINCT e.id, e.src_entity, e.dst_entity, e.relation, e.weight, e.evidence
        FROM edges e
        WHERE e.user_id=$4
          AND e.src_entity IN (SELECT id FROM reach) AND e.dst_entity IN (SELECT id FROM reach)
        LIMIT $3
        """,
        entity_ids, hops, limit, user_id,
    )
    node_ids = set(entity_ids)
    for r in edge_rows:
        node_ids.add(r["src_entity"])
        node_ids.add(r["dst_entity"])
    node_rows = await pool.fetch(
        "SELECT id, type, canonical_name, importance, mention_count FROM entities "
        "WHERE user_id=$2 AND id = ANY($1::bigint[])",
        list(node_ids), user_id,
    )
    return {
        "nodes": [{"id": r["id"], "type": r["type"], "canonical_name": r["canonical_name"],
                   "importance": float(r["importance"]), "mention_count": r["mention_count"]} for r in node_rows],
        "edges": [{"src": r["src_entity"], "dst": r["dst_entity"], "relation": r["relation"],
                   "weight": float(r["weight"]), "evidence": _strip_evidence(r["evidence"])} for r in edge_rows],
    }


# ---------- list_action_items (has_draft only; the generated_draft BODY never leaves) ----------
async def list_action_items(user_id: uuid.UUID, status: str = "open") -> list[dict]:
    pool = await get_pool()
    if status in ("open", "done", "dropped"):
        rows = await pool.fetch(
            "SELECT id, text, owner, status, due, source_conversation, generated_draft "
            "FROM action_items WHERE user_id=$1 AND status=$2 ORDER BY created_at DESC",
            user_id, status,
        )
    else:  # "all"
        rows = await pool.fetch(
            "SELECT id, text, owner, status, due, source_conversation, generated_draft "
            "FROM action_items WHERE user_id=$1 ORDER BY created_at DESC LIMIT 300",
            user_id,
        )
    return [
        {"id": r["id"], "text": r["text"], "owner": r["owner"], "status": r["status"],
         "due": r["due"].isoformat() if r["due"] else None,
         "source_conversation": r["source_conversation"], "has_draft": r["generated_draft"] is not None}
        for r in rows
    ]


# ---------- upcoming_events ----------
async def upcoming_events(user_id: uuid.UUID, from_ts: dt.datetime | None = None, limit: int = 50) -> list[dict]:
    pool = await get_pool()
    limit = max(1, min(50, int(limit)))
    from_ts = from_ts or dt.datetime.now(dt.timezone.utc)
    rows = await pool.fetch(
        """SELECT e.id, e.title, e.when_text, e.start_ts, e.kind, e.conversation_id, c.title AS conv_title
           FROM events e LEFT JOIN conversations c ON c.id=e.conversation_id AND c.user_id=e.user_id
           WHERE e.user_id=$1 AND e.start_ts IS NOT NULL AND e.start_ts >= $2
           ORDER BY e.start_ts LIMIT $3""",
        user_id, from_ts, limit,
    )
    return [
        {"id": r["id"], "title": r["title"], "when_text": r["when_text"],
         "start_ts": r["start_ts"].isoformat() if r["start_ts"] else None, "kind": r["kind"],
         "conversation_id": r["conversation_id"], "conv_title": r["conv_title"]}
        for r in rows
    ]


# ---------- get_minutes ----------
async def minutes(user_id: uuid.UUID, conversation_id: int) -> dict | None:
    pool = await get_pool()
    row = await pool.fetchrow(
        "SELECT data, generated_at FROM minutes WHERE conversation_id=$1 AND user_id=$2",
        conversation_id, user_id,
    )
    if row is None:
        return None
    data = row["data"] or {}
    return {**(data if isinstance(data, dict) else {}),
            "generated_at": row["generated_at"].isoformat() if row["generated_at"] else None}


# ---------- get_your_context (priors) — ONLY share_cloud=1 AND (confirmed OR user) ----------
def _prior_recency(last: dt.datetime | None, half_life_days: float) -> float:
    if last is None:
        return 1.0
    age_days = (dt.datetime.now(dt.timezone.utc) - last).total_seconds() / 86400.0
    return 0.5 ** (age_days / max(0.5, half_life_days))


async def top_priors(user_id: uuid.UUID, query: str = "", k: int = 8) -> list[dict]:
    """Active, cloud-shared priors for this user. Mirrors repo.topPriors(cloud=true): confirmed-or-user,
    not superseded, not expired, share_cloud=1. effective_confidence scored + sorted. The whole `attrs`
    blob, source_turn_ids, entity_id, norm_subject, and share_cloud are NEVER emitted."""
    pool = await get_pool()
    await refresh_runtime_settings()
    rt = get_runtime_settings()
    half_life = float(getattr(rt, "prior_half_life_days", 60) or 60)
    rows = await pool.fetch(
        """SELECT kind, subject, value, attrs, confidence, supported, contradicted, status,
                  last_confirmed_at, created_at
           FROM priors
           WHERE user_id=$1 AND (status='confirmed' OR provenance='user')
             AND superseded_by IS NULL AND valid_to IS NULL AND share_cloud=TRUE""",
        user_id,
    )
    scored = []
    for r in rows:
        support = max(0.5, min(1.5, 1 + 0.1 * ((r["supported"] or 0) - (r["contradicted"] or 0))))
        rec = _prior_recency(r["last_confirmed_at"] or r["created_at"], half_life)
        eff = (float(r["confidence"]) if r["confidence"] is not None else 0.5) * rec * support
        attrs = r["attrs"] if isinstance(r["attrs"], dict) else {}
        scored.append({
            "kind": r["kind"], "subject": r["subject"], "value": r["value"],
            "relationship_to_user": attrs.get("relationship_to_user"),
            "effective_confidence": round(eff, 3), "status": r["status"],
        })
    scored.sort(key=lambda x: x["effective_confidence"], reverse=True)
    return scored[: max(1, int(k))]


# ---------- ask_memory (Graph-RAG chat, user-scoped) ----------
_ANSWER_SCHEMA = {
    "name": "grounded_answer", "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "supported": {"type": "boolean"},
            "citation_conversation_ids": {"type": "array", "items": {"type": "integer"}},
        },
        "required": ["answer", "supported", "citation_conversation_ids"],
        "additionalProperties": False,
    },
}
_SYSTEM = (
    "You are the user's personal memory. Answer ONLY from the provided context (memories from past "
    "conversations and a knowledge-graph neighborhood). If the context does not contain the answer, set "
    "supported=false and say you don't have a record of it — never invent facts. Cite the conversation ids "
    "you used. Be concise. The source material may be Hindi-English; answer in the user's language."
)


async def _seed_entities(user_id: uuid.UUID, qvec) -> list[int]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id FROM entities WHERE user_id=$2 AND embedding IS NOT NULL ORDER BY embedding <=> $1 LIMIT 5",
        qvec, user_id,
    )
    return [r["id"] for r in rows]


async def ask(user_id: uuid.UUID, question: str, history: list[dict] | None = None) -> dict:
    question = (question or "").strip()
    if not question:
        return {"answer": "Please ask a question.", "supported": False, "citations": [], "retrieved": []}
    provider = get_provider()
    memories = await search(user_id, question, top_n=8)
    qvec = (await provider.embed([question]))[0]
    seeds = await _seed_entities(user_id, qvec)
    sub = await _expand_scoped(user_id, seeds, hops=2, limit=40) if seeds else {"nodes": [], "edges": []}

    ctx_lines = ["# Memories"]
    for m in memories:
        date = (m.get("started_at") or "")[:10] or "?"
        facts = "; ".join(m["facts"]) if isinstance(m.get("facts"), list) else ""
        ctx_lines.append(f"[C{m['conversation_id']}] ({date}) {m.get('title')}: {m['summary']} Facts: {facts}")
    if sub["nodes"]:
        name = {n["id"]: n["canonical_name"] for n in sub["nodes"]}
        ctx_lines.append("\n# Knowledge graph")
        for e in sub["edges"]:
            ctx_lines.append(f"{name.get(e['src'], '?')} --{e['relation']}--> {name.get(e['dst'], '?')}")
    context = "\n".join(ctx_lines) if memories or sub["nodes"] else "(no memories found)"

    hist = "\n".join(f"{h.get('role')}: {h.get('content')}" for h in (history or [])[-6:])
    prefix = f"Conversation so far:\n{hist}\n\n" if hist else ""
    user_msg = f"{prefix}Context:\n{context}\n\nUser question: {question}"
    try:
        data = await provider.extract(_ANSWER_SCHEMA, _SYSTEM, user_msg)
    except Exception:
        return {"answer": "I couldn't generate an answer right now.", "supported": False, "citations": [],
                "retrieved": [{"conversation_id": m["conversation_id"], "title": m.get("title"), "score": m["score"]} for m in memories]}

    cited = set(data.get("citation_conversation_ids", []) or [])
    cite = [{"conversation_id": m["conversation_id"], "title": m.get("title"), "date": (m.get("started_at") or "")[:10] or None}
            for m in memories if m["conversation_id"] in cited]
    if not cite:
        cite = [{"conversation_id": m["conversation_id"], "title": m.get("title"), "date": (m.get("started_at") or "")[:10] or None}
                for m in memories[:3]]
    return {
        "answer": data.get("answer", ""),
        "supported": bool(data.get("supported", False)),
        "citations": cite if data.get("supported") else [],
        "retrieved": [{"conversation_id": m["conversation_id"], "title": m.get("title"), "score": m["score"]} for m in memories],
    }


# ---------- daily rollups (parity with the api.py /rollups list, user-scoped) ----------
async def daily_rollup(user_id: uuid.UUID, day: str) -> dict | None:
    pool = await get_pool()
    try:
        d = dt.date.fromisoformat(day[:10])
    except (ValueError, TypeError):
        return None
    row = await pool.fetchrow(
        "SELECT day, summary, highlights, open_actions FROM daily_rollups WHERE user_id=$1 AND day=$2",
        user_id, d,
    )
    if row is None:
        return None
    return {"day": row["day"].isoformat(), "summary": row["summary"],
            "highlights": row["highlights"], "open_actions": row["open_actions"]}
