"""Tier B sync intake — POST /sync (authenticated). One-way phone -> server push (sync v1).

The phone builds a `share_cloud`-respecting projection of its local SQLite memory and pushes it here.
The server UPSERTs the WHOLE projection under current_user.id, REPLACING that user's prior projection
(idempotent: re-sending the same body converges to the same state). The phone stays the source of
truth; the server holds a derived, privacy-filtered copy.

Projection shape (the phone sends client-assigned integer ids per entity; the server maps them to its
own BIGSERIAL ids per user, so two users' "conversation 1" never collide). Audio is never present —
there is no audio anywhere in this schema. Defense-in-depth whitelists (mirrors mcp-plan.md §5) are
RE-ENFORCED here, never trusting the client to have filtered:
  - turns:   redacted turns are DROPPED; voiceprint is never accepted (no column for it).
  - people:  voiceprint is never accepted.
  - edges:   evidence turn_ids are stripped; only {conversation_id} is kept.
  - actions: generated_draft (the draft body) is DROPPED.
  - priors:  ONLY share_cloud=1 priors are accepted; everything else is dropped.

Request body (all arrays optional; client ids are integers, local to the phone):
  {
    "client_synced_at": "<iso>"?,
    "people":        [{id, canonical_name, is_me, provisional, enroll_count, notes}],
    "conversations": [{id, title, started_at, ended_at, participant_person_ids:[clientPersonId],
                       is_meeting, refined}],
    "memories":      [{conversation_id, title, summary, facts:[], action_items:[], decisions:[],
                       importance, type_tags:[]}],
    "turns":         [{conversation_id, session_speaker_label, person_id?, is_me?, text, abs_start?,
                       window_index?, start_ts?, lang?}],   # redacted turns must already be absent; re-dropped here
    "entities":      [{id, type, canonical_name, norm_name?, importance?, mention_count?, attrs?}],
    "edges":         [{src, dst, relation, weight?, evidence:[{conversation_id}]}],   # src/dst are client entity ids
    "action_items":  [{text, owner?, status?, due?, source_conversation?}],
    "events":        [{conversation_id?, title, when_text?, start_ts?, kind?}],
    "minutes":       [{conversation_id, data:{...}, generated_at?}],
    "priors":        [{kind, subject, value?, attrs?, confidence?, status?, provenance?, share_cloud:1, ...}],
    "rollups":       [{day, summary?, highlights:[], open_actions:[]}]
  }
Response: {"ok": true, "synced_at": "<iso>", "counts": {...per entity...}}
"""
from __future__ import annotations

import datetime as dt
import logging
import uuid

from fastapi import APIRouter, Body, Depends

from .auth import User, current_user
from .db import get_pool
from .services import graph as graph_svc

log = logging.getLogger("sutra.sync")
router = APIRouter(tags=["sync"])


def _ts(v):
    """Parse an ISO datetime string (or pass through datetimes/None). Returns aware datetime or None."""
    if v is None or isinstance(v, dt.datetime):
        return v
    try:
        s = str(v).replace("Z", "+00:00")
        return dt.datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _date(v):
    if v is None:
        return None
    try:
        return dt.date.fromisoformat(str(v)[:10])
    except (ValueError, TypeError):
        return None


def _ints(v) -> list[int]:
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        try:
            out.append(int(x))
        except (ValueError, TypeError):
            continue
    return out


@router.post("/sync")
async def sync_ep(user: User = Depends(current_user), body: dict = Body(...)) -> dict:
    pool = await get_pool()
    uid: uuid.UUID = user.id
    counts: dict[str, int] = {}

    async with pool.acquire() as conn:
        async with conn.transaction():
            # ---- Replace this user's projection wholesale (idempotent upsert == delete-then-insert).
            # Order respects FKs: children before parents on delete; parents before children on insert.
            # priors + action_items are handled SEPARATELY below: the phone stays source of truth ONLY
            # for its own (origin='device') rows; rows an MCP write tool created (origin='mcp') SURVIVE
            # every sync (tier-b-phase23-contract.md P2.0). For all other tables the phone is the sole
            # writer, so a wholesale replace is correct.
            for t in ("minutes", "events", "turns", "memories", "edges",
                      "daily_rollups", "entities", "conversations", "people"):
                await conn.execute(f"DELETE FROM {t} WHERE user_id=$1", uid)
            # Replace ONLY device-origin priors/action_items; preserve MCP-authored rows across the sync.
            await conn.execute("DELETE FROM action_items WHERE user_id=$1 AND origin='device'", uid)
            await conn.execute("DELETE FROM priors WHERE user_id=$1 AND origin='device'", uid)

            # ---- people: map client person id -> server id. NEVER accept voiceprint.
            person_map: dict[int, int] = {}
            for p in (body.get("people") or []):
                cid = p.get("id")
                sid = await conn.fetchval(
                    "INSERT INTO people(user_id, canonical_name, is_me, provisional, enroll_count, notes) "
                    "VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
                    uid, str(p.get("canonical_name") or "Unknown"), bool(p.get("is_me")),
                    bool(p.get("provisional")), int(p.get("enroll_count") or 0), p.get("notes"),
                )
                if cid is not None:
                    person_map[int(cid)] = sid
            counts["people"] = len(person_map)

            # ---- conversations: map client conv id -> server id. Remap participant person ids.
            conv_map: dict[int, int] = {}
            for c in (body.get("conversations") or []):
                cid = c.get("id")
                part = [person_map[i] for i in _ints(c.get("participant_person_ids")) if i in person_map]
                sid = await conn.fetchval(
                    "INSERT INTO conversations(user_id, title, started_at, ended_at, "
                    "participant_person_ids, is_meeting, refined) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
                    uid, c.get("title"), _ts(c.get("started_at")), _ts(c.get("ended_at")),
                    part, bool(c.get("is_meeting")), bool(c.get("refined")),
                )
                if cid is not None:
                    conv_map[int(cid)] = sid
            counts["conversations"] = len(conv_map)

            # ---- memories (one per conversation). Recompute search_tsv server-side; embedding NULL
            # (the server re-embeds lazily on first search if desired — FTS still ranks meanwhile).
            mem_n = 0
            for m in (body.get("memories") or []):
                conv = conv_map.get(int(m.get("conversation_id"))) if m.get("conversation_id") is not None else None
                if conv is None:
                    continue
                facts = m.get("facts") or []
                tsv_src = f"{m.get('title') or ''} {m.get('summary') or ''} {' '.join(str(f) for f in facts)}"
                await conn.execute(
                    """INSERT INTO memories(user_id, conversation_id, title, summary, facts, action_items,
                       decisions, importance_score, type_tags, search_tsv)
                       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, to_tsvector('simple', $10))""",
                    uid, conv, m.get("title"), str(m.get("summary") or ""), facts,
                    m.get("action_items") or [], m.get("decisions") or [],
                    float(m.get("importance") if m.get("importance") is not None else 0.5),
                    [str(x) for x in (m.get("type_tags") or [])], tsv_src,
                )
                mem_n += 1
            counts["memories"] = mem_n

            # ---- turns: DROP redacted; remap conversation + person ids. We synthesize a sync session
            # per user so the NOT NULL session_id FK holds without the phone shipping raw sessions.
            sync_session = await conn.fetchval(
                "INSERT INTO sessions(user_id, device, status) VALUES($1,'sync','closed') RETURNING id", uid
            )
            turn_n = 0
            for t in (body.get("turns") or []):
                if t.get("redacted"):  # defense in depth — should already be absent
                    continue
                conv = conv_map.get(int(t.get("conversation_id"))) if t.get("conversation_id") is not None else None
                pid = person_map.get(int(t["person_id"])) if t.get("person_id") is not None else None
                await conn.execute(
                    "INSERT INTO turns(user_id, session_id, window_index, session_speaker_label, "
                    "person_id, text, lang, start_ts, abs_start, conversation_id, redacted) "
                    "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE)",
                    uid, sync_session, int(t.get("window_index") or 0),
                    str(t.get("session_speaker_label") or "A"), pid, str(t.get("text") or ""),
                    t.get("lang"), t.get("start_ts"), _ts(t.get("abs_start")), conv,
                )
                turn_n += 1
            counts["turns"] = turn_n

            # ---- entities: map client entity id -> server id.
            ent_map: dict[int, int] = {}
            for e in (body.get("entities") or []):
                cid = e.get("id")
                name = str(e.get("canonical_name") or "").strip()
                if not name:
                    continue
                nn = e.get("norm_name") or graph_svc.norm_name(name)
                sid = await conn.fetchval(
                    "INSERT INTO entities(user_id, type, canonical_name, norm_name, attrs, importance, "
                    "mention_count) VALUES($1,$2,$3,$4,$5,$6,$7) "
                    "ON CONFLICT (user_id, type, norm_name) DO UPDATE SET mention_count=entities.mention_count "
                    "RETURNING id",
                    uid, str(e.get("type") or "topic"), name, nn, e.get("attrs") or {},
                    float(e.get("importance") if e.get("importance") is not None else 0.5),
                    int(e.get("mention_count") or 1),
                )
                if cid is not None:
                    ent_map[int(cid)] = sid
            counts["entities"] = len(ent_map)

            # ---- edges: remap src/dst entity ids; STRIP evidence to {conversation_id} (remapped).
            edge_n = 0
            for ed in (body.get("edges") or []):
                src = ent_map.get(int(ed["src"])) if ed.get("src") is not None else None
                dst = ent_map.get(int(ed["dst"])) if ed.get("dst") is not None else None
                if not src or not dst or src == dst:
                    continue
                ev = []
                for it in (ed.get("evidence") or []):
                    raw = it.get("conversation_id") if isinstance(it, dict) else None
                    mapped = conv_map.get(int(raw)) if raw is not None and int(raw) in conv_map else None
                    if mapped is not None:
                        ev.append({"conversation_id": mapped})  # turn_ids intentionally dropped
                await conn.execute(
                    "INSERT INTO edges(user_id, src_entity, dst_entity, relation, weight, evidence) "
                    "VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, src_entity, dst_entity, relation) "
                    "DO UPDATE SET weight=EXCLUDED.weight, evidence=EXCLUDED.evidence",
                    uid, src, dst, str(ed.get("relation") or "related_to").strip().lower().replace(" ", "_"),
                    float(ed.get("weight") or 1.0), ev,
                )
                edge_n += 1
            counts["edges"] = edge_n

            # ---- action_items: DROP generated_draft body.
            ai_n = 0
            for a in (body.get("action_items") or []):
                src = conv_map.get(int(a["source_conversation"])) if a.get("source_conversation") is not None and int(a.get("source_conversation")) in conv_map else None
                await conn.execute(
                    "INSERT INTO action_items(user_id, text, owner, status, due, source_conversation) "
                    "VALUES($1,$2,$3,$4,$5,$6)",
                    uid, str(a.get("text") or ""), a.get("owner"),
                    a.get("status") if a.get("status") in ("open", "done", "dropped") else "open",
                    _date(a.get("due")), src,
                )
                ai_n += 1
            counts["action_items"] = ai_n

            # ---- events
            ev_n = 0
            for e in (body.get("events") or []):
                conv = conv_map.get(int(e["conversation_id"])) if e.get("conversation_id") is not None and int(e.get("conversation_id")) in conv_map else None
                await conn.execute(
                    "INSERT INTO events(user_id, conversation_id, title, when_text, start_ts, kind) "
                    "VALUES($1,$2,$3,$4,$5,$6)",
                    uid, conv, str(e.get("title") or ""), e.get("when_text"), _ts(e.get("start_ts")), e.get("kind"),
                )
                ev_n += 1
            counts["events"] = ev_n

            # ---- minutes (one per conversation)
            min_n = 0
            for mn in (body.get("minutes") or []):
                conv = conv_map.get(int(mn["conversation_id"])) if mn.get("conversation_id") is not None and int(mn.get("conversation_id")) in conv_map else None
                if conv is None:
                    continue
                await conn.execute(
                    "INSERT INTO minutes(user_id, conversation_id, data, generated_at) VALUES($1,$2,$3,$4) "
                    "ON CONFLICT (conversation_id) DO UPDATE SET data=EXCLUDED.data, generated_at=EXCLUDED.generated_at",
                    uid, conv, mn.get("data") or {}, _ts(mn.get("generated_at")) or dt.datetime.now(dt.timezone.utc),
                )
                min_n += 1
            counts["minutes"] = min_n

            # ---- priors: ONLY share_cloud=1 are accepted (defense in depth).
            pr_n = 0
            for pr in (body.get("priors") or []):
                if not pr.get("share_cloud"):
                    continue
                subject = str(pr.get("subject") or "").strip()
                if not subject:
                    continue
                src = conv_map.get(int(pr["source_conversation"])) if pr.get("source_conversation") is not None and int(pr.get("source_conversation")) in conv_map else None
                await conn.execute(
                    """INSERT INTO priors(user_id, kind, subject, norm_subject, value, attrs, confidence,
                       supported, contradicted, provenance, status, source_conversation, is_prior,
                       share_cloud, valid_from, last_confirmed_at)
                       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,TRUE,$13,$14)""",
                    uid, str(pr.get("kind") or "fact"), subject,
                    graph_svc.norm_name(pr.get("norm_subject") or subject), pr.get("value"),
                    pr.get("attrs") or {}, float(pr.get("confidence") if pr.get("confidence") is not None else 0.5),
                    int(pr.get("supported") or 1), int(pr.get("contradicted") or 0),
                    str(pr.get("provenance") or "derived"), str(pr.get("status") or "suggested"),
                    src, _ts(pr.get("valid_from")), _ts(pr.get("last_confirmed_at")),
                )
                pr_n += 1
            counts["priors"] = pr_n

            # ---- daily rollups
            roll_n = 0
            for r in (body.get("rollups") or []):
                day = _date(r.get("day"))
                if day is None:
                    continue
                await conn.execute(
                    "INSERT INTO daily_rollups(user_id, day, summary, highlights, open_actions) "
                    "VALUES($1,$2,$3,$4,$5) ON CONFLICT (user_id, day) DO UPDATE SET "
                    "summary=EXCLUDED.summary, highlights=EXCLUDED.highlights, open_actions=EXCLUDED.open_actions",
                    uid, day, r.get("summary"), r.get("highlights") or [], r.get("open_actions") or [],
                )
                roll_n += 1
            counts["rollups"] = roll_n

    synced_at = dt.datetime.now(dt.timezone.utc).isoformat()
    log.info("sync for user %s: %s", uid, counts)
    return {"ok": True, "synced_at": synced_at, "counts": counts}
