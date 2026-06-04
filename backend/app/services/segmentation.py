"""Group a session's turns into conversations: silence-gap split + lexical topic-shift split."""
from __future__ import annotations

import re

from ..config import settings
from ..db import get_pool


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"\w+", text.lower()))


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 1.0
    return len(a & b) / len(a | b)


def _split_indices(turns: list[dict]) -> list[int]:
    """Return start indices of each conversation within the ordered turn list."""
    if not turns:
        return []
    starts = [0]
    gap = settings.segment_gap_seconds
    topic = settings.segment_topic_shift.lower() == "on"
    block = 5
    for i in range(1, len(turns)):
        prev, cur = turns[i - 1], turns[i]
        # silence gap (uses absolute timeline)
        dt_gap = (cur["abs_start"] - prev["abs_start"]).total_seconds() if prev["abs_start"] and cur["abs_start"] else 0
        if dt_gap >= gap:
            starts.append(i)
            continue
        # topic shift: compare the trailing block with the leading block, only in long runs
        if topic and (i - starts[-1]) >= 2 * block:
            a = set().union(*[_tokens(t["text"]) for t in turns[max(starts[-1], i - block):i]])
            b = set().union(*[_tokens(t["text"]) for t in turns[i:i + block]]) if i + 1 < len(turns) else set()
            if b and _jaccard(a, b) < 0.05:
                starts.append(i)
    return starts


async def segment_session(session_id: int) -> list[int]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id, text, abs_start, person_id FROM turns "
        "WHERE session_id=$1 AND conversation_id IS NULL AND redacted=FALSE "
        "ORDER BY window_index, start_ts, id",
        session_id,
    )
    turns = [dict(r) for r in rows]
    if not turns:
        return []
    starts = _split_indices(turns)
    bounds = starts + [len(turns)]
    conv_ids: list[int] = []
    for k in range(len(starts)):
        group = turns[bounds[k]:bounds[k + 1]]
        if not group:
            continue
        participants = sorted({t["person_id"] for t in group if t["person_id"] is not None})
        conv_id = await pool.fetchval(
            "INSERT INTO conversations(session_id, title, started_at, ended_at, participant_person_ids) "
            "VALUES($1,$2,$3,$4,$5) RETURNING id",
            session_id, None, group[0]["abs_start"], group[-1]["abs_start"], participants,
        )
        ids = [t["id"] for t in group]
        await pool.execute("UPDATE turns SET conversation_id=$1 WHERE id = ANY($2::bigint[])", conv_id, ids)
        conv_ids.append(conv_id)
    return conv_ids
