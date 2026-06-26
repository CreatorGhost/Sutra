"""M2 extraction: conversation transcript -> memory (summary/facts/actions/decisions) + graph."""
from __future__ import annotations

import datetime as dt
import json
import logging

from ..db import get_pool
from ..providers import get_provider
from ..schemas import EXTRACTION_JSON_SCHEMA
from . import graph
from .segmentation import segment_session

log = logging.getLogger("sutra.extraction")

# Bump when the extraction prompt/schema changes — recorded against every captured sample (corpus
# versioning). MUST stay textually in sync with frontend/src/local/aiPrompts.ts EXTRACT_SYSTEM:
# production runs the FRONTEND prompt via the proxy (the proxy forwards client system+schema verbatim);
# evals grade THIS constant. If they drift, the eval measures a prompt that never ships.
# See evals/test_prompt_sync.py (fails on divergence).
PROMPT_VERSION = "extract-v4"  # v4: + scheduled events (matches frontend)

SYSTEM = (
    "You extract durable memory from a conversation transcript. The transcript is often Hindi-English "
    "code-switched (Hinglish) — read both languages fluently and DO NOT translate; write the summary in "
    "clear English but keep proper nouns as spoken. Identify concrete action items (with owner and due "
    "date if stated), explicit decisions, key facts, and the real-world entities (people, projects, topics, "
    "orgs, places, events, commitments) plus relationships. importance_score in [0,1]: higher for "
    "decisions/commitments/plans. Use 'Me' for the device owner when known. "
    "Extract action items exactly as before — one item per distinct task; do not drop or merge any. For "
    "each item ADDITIONALLY fill steps with the ordered sub-steps or details discussed for that task, "
    "grounded in the transcript (do NOT invent; use an empty list if none); never move a separate action "
    "item into another item's steps. "
    "Also fill speaker_names: for each speaker label in the transcript (e.g. 'Speaker A'), give that person's "
    "real name ONLY from in-conversation evidence — a self-introduction ('I am Farha' / 'This is Farha' -> that "
    "speaker, confidence 'high', basis 'self_introduction'), or being addressed/named by another speaker "
    "('Hey Mark', 'Mark, can you...' -> the speaker being addressed, usually the OTHER party, confidence 'low', "
    "basis 'addressed_by_other'). Use 'Me' for the device owner if identifiable. If a speaker cannot be named "
    "from the transcript, set name null and basis 'unknown'. Never guess a name. "
    "Also fill events: every scheduled or time-bound thing discussed — meetings, calls, deadlines, "
    "appointments, or time-bound commitments (e.g. 'kal 11 baje meeting hai', 'at 5pm I'll send the files'). "
    "For each event give title (what it is), when (the date/time EXACTLY as spoken), datetime (resolved to "
    "ISO 8601 'YYYY-MM-DDTHH:MM' relative to the 'Today's date' line at the top of the transcript; null only "
    "if it genuinely cannot be resolved), and kind (one of meeting, call, deadline, reminder, other). Only "
    "extract times actually mentioned; never invent."
)


def _parse_due(s: str | None) -> dt.date | None:
    if not s:
        return None
    try:
        return dt.date.fromisoformat(s[:10])
    except ValueError:
        return None


async def extract_conversation(conversation_id: int) -> dict | None:
    pool = await get_pool()
    rows = await pool.fetch(
        """SELECT t.id, t.text, COALESCE(p.canonical_name, 'Speaker '||t.session_speaker_label) AS speaker
           FROM turns t LEFT JOIN people p ON p.id=t.person_id
           WHERE t.conversation_id=$1 AND t.redacted=FALSE
           ORDER BY t.window_index, t.start_ts, t.id""",
        conversation_id,
    )
    if not rows:
        return None
    turn_ids = [r["id"] for r in rows]
    transcript = "\n".join(f"{r['speaker']}: {r['text']}" for r in rows)

    provider = get_provider()
    data = await provider.extract(EXTRACTION_JSON_SCHEMA, SYSTEM, transcript)

    # batch embeddings: [summary, entity_1, entity_2, ...]
    entities = data.get("entities", []) or []
    ent_texts = [f"{e['name']} ({e['type']}): {e.get('description') or ''}".strip() for e in entities]
    summary = data.get("summary", "") or ""
    vecs = await provider.embed([summary or "(empty)"] + ent_texts)
    mem_vec, ent_vecs = vecs[0], vecs[1:]

    facts = data.get("facts", []) or []
    fact_blob = " ".join(facts)
    raw_importance = data.get("importance_score")
    importance = float(max(0.0, min(1.0, raw_importance if isinstance(raw_importance, (int, float)) else 0.5)))

    mem_id = await pool.fetchval(
        """INSERT INTO memories
           (conversation_id, summary, facts, action_items, decisions, importance_score, type_tags,
            embedding, search_tsv)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8, to_tsvector('simple', $9))
           ON CONFLICT (user_id, conversation_id) DO UPDATE SET
               summary=EXCLUDED.summary, facts=EXCLUDED.facts, action_items=EXCLUDED.action_items,
               decisions=EXCLUDED.decisions, importance_score=EXCLUDED.importance_score,
               type_tags=EXCLUDED.type_tags, embedding=EXCLUDED.embedding, search_tsv=EXCLUDED.search_tsv
           RETURNING id""",
        conversation_id, summary, facts, (data.get("action_items", []) or []),
        (data.get("decisions", []) or []), importance, data.get("type_tags", []) or [],
        mem_vec, f"{data.get('title','')} {summary} {fact_blob}",
    )

    await pool.execute(
        "UPDATE conversations SET title=$1 WHERE id=$2",
        data.get("title") or "Untitled conversation", conversation_id,
    )

    # graph: entities then edges
    name_to_id: dict[str, int] = {}
    for e, v in zip(entities, ent_vecs):
        eid = await graph.upsert_entity(pool, e["type"], e["name"], e.get("description"), v, conversation_id)
        if eid:
            name_to_id[graph.norm_name(e["name"])] = eid
    for rel in data.get("relations", []) or []:
        src = name_to_id.get(graph.norm_name(rel.get("src", "")))
        dst = name_to_id.get(graph.norm_name(rel.get("dst", "")))
        if src and dst:
            await graph.upsert_edge(pool, src, dst, rel.get("relation", "related_to"), conversation_id, turn_ids)

    # action items table (generated_draft filled lazily by the chat/draft endpoint)
    for ai in data.get("action_items", []) or []:
        await pool.execute(
            "INSERT INTO action_items(text, owner, status, due, source_conversation) "
            "VALUES($1,$2,'open',$3,$4)",
            ai.get("text", ""), ai.get("owner"), _parse_due(ai.get("due")), conversation_id,
        )

    return {
        "conversation_id": conversation_id,
        "memory_id": mem_id,
        "title": data.get("title"),
        "entities": len(name_to_id),
        "action_items": len(data.get("action_items", []) or []),
        "importance": importance,
    }


async def process_session(session_id: int) -> dict:
    """Segment a session into conversations and extract intelligence for each."""
    conv_ids = await segment_session(session_id)
    results = []
    last_error: str | None = None
    for cid in conv_ids:
        try:
            r = await extract_conversation(cid)
            if r:
                results.append(r)
        except Exception as e:
            last_error = str(e)
            log.exception("extraction failed for conversation %s: %s", cid, e)
    return {
        "session_id": session_id,
        "conversations": conv_ids,
        "extracted": results,
        "failed": len(conv_ids) - len(results),
        "last_error": last_error,
    }
