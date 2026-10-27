"""Graph-RAG chat: hybrid retrieve -> expand graph along edges -> answer with citations."""
from __future__ import annotations

import json
import logging

from ..db import get_pool
from ..providers import get_provider
from . import graph, ranking

log = logging.getLogger("sutra.chat")

_ANSWER_SCHEMA = {
    "name": "grounded_answer",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "supported": {"type": "boolean", "description": "true only if the context supports the answer"},
            "citation_conversation_ids": {"type": "array", "items": {"type": "integer"}},
        },
        "required": ["answer", "supported", "citation_conversation_ids"],
        "additionalProperties": False,
    },
}

SYSTEM = (
    "You are Sutra, the user's personal memory. Answer ONLY from the provided context "
    "(memories from past conversations and a knowledge-graph neighborhood). If the context does "
    "not contain the answer, set supported=false and say you don't have a record of it — never "
    "invent facts. Cite the conversation ids you used. Be concise. The source material may be "
    "Hindi-English; answer in the user's language."
)


async def _seed_entities(qvec) -> list[int]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id FROM entities WHERE embedding IS NOT NULL ORDER BY embedding <=> $1 LIMIT 5", qvec
    )
    return [r["id"] for r in rows]


async def chat(message: str, history: list[dict] | None = None) -> dict:
    message = (message or "").strip()
    if not message:
        return {"answer": "Please ask a question.", "supported": False, "citations": [], "retrieved": []}
    provider = get_provider()
    memories = await ranking.search(message, top_n=8)

    qvec = (await provider.embed([message]))[0]
    seeds = await _seed_entities(qvec)
    sub = await graph.expand(seeds, hops=2, limit=40)

    ctx_lines = ["# Memories"]
    for m in memories:
        date = m["started_at"].date().isoformat() if m["started_at"] else "?"
        facts = "; ".join(m["facts"]) if isinstance(m["facts"], list) else ""
        ctx_lines.append(f"[C{m['conversation_id']}] ({date}) {m['title']}: {m['summary']} Facts: {facts}")
    if sub["nodes"]:
        name = {n["id"]: n["canonical_name"] for n in sub["nodes"]}
        ctx_lines.append("\n# Knowledge graph")
        for e in sub["edges"]:
            ctx_lines.append(f"{name.get(e['src'],'?')} --{e['relation']}--> {name.get(e['dst'],'?')}")
    context = "\n".join(ctx_lines) if memories or sub["nodes"] else "(no memories found)"

    hist = "\n".join(f"{h.get('role')}: {h.get('content')}" for h in (history or [])[-6:])
    prefix = f"Conversation so far:\n{hist}\n\n" if hist else ""
    user = f"{prefix}Context:\n{context}\n\nUser question: {message}"
    try:
        data = await provider.extract(_ANSWER_SCHEMA, SYSTEM, user)
    except Exception as e:
        log.warning("chat answer generation failed, degrading gracefully: %s", e)
        return {
            "answer": "I couldn't generate an answer right now.",
            "supported": False,
            "citations": [],
            "retrieved": [
                {"conversation_id": m["conversation_id"], "title": m["title"], "score": m["score"]}
                for m in memories
            ],
        }

    cited = set(data.get("citation_conversation_ids", []) or [])
    citations = [
        {
            "conversation_id": m["conversation_id"],
            "title": m["title"],
            "date": m["started_at"].date().isoformat() if m["started_at"] else None,
        }
        for m in memories
        if m["conversation_id"] in cited
    ] or [
        {
            "conversation_id": m["conversation_id"],
            "title": m["title"],
            "date": m["started_at"].date().isoformat() if m["started_at"] else None,
        }
        for m in memories[:3]
    ]
    return {
        "answer": data.get("answer", ""),
        "supported": bool(data.get("supported", False)),
        "citations": citations if data.get("supported") else [],
        "retrieved": [{"conversation_id": m["conversation_id"], "title": m["title"], "score": m["score"]} for m in memories],
    }
