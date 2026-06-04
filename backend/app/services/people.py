"""People management: enrollment (voiceprint) and one-tap speaker relabel/merge."""
from __future__ import annotations

import logging

from ..config import settings
from ..db import get_pool
from . import voiceprint

log = logging.getLogger("sutra.people")


async def list_people() -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        "SELECT id, canonical_name, is_me, provisional, enroll_count, notes, "
        "(voiceprint IS NOT NULL) AS has_voiceprint, created_at FROM people ORDER BY is_me DESC, provisional, id"
    )
    return [dict(r) for r in rows]


async def enroll_person(name: str, is_me: bool, audio: bytes | None, notes: str | None = None) -> dict:
    pool = await get_pool()
    vp = None
    if audio and settings.use_voiceprint:
        emb = await voiceprint.embed_enrollment(audio)
        vp = emb.tolist() if emb is not None else None
    if is_me:
        await pool.execute("UPDATE people SET is_me=FALSE WHERE is_me=TRUE")
    row = await pool.fetchrow(
        "INSERT INTO people(canonical_name, is_me, provisional, voiceprint, enroll_count, notes) "
        "VALUES($1,$2,FALSE,$3,$4,$5) RETURNING id, canonical_name, is_me, provisional",
        name, is_me, vp, 1 if vp is not None else 0, notes,
    )
    return dict(row)


async def relabel_speaker(session_id: int, label: str, person_id: int | None, name: str | None, is_me: bool) -> dict:
    """Map a session's per-call speaker label to a real person, merging any provisional identity
    (and inheriting its voiceprint so future windows auto-match)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            prov_id = await conn.fetchval(
                "SELECT DISTINCT person_id FROM turns WHERE session_id=$1 AND session_speaker_label=$2 "
                "AND person_id IS NOT NULL LIMIT 1",
                session_id, label,
            )
            if person_id is not None and not await conn.fetchval(
                "SELECT 1 FROM people WHERE id=$1", person_id
            ):
                raise ValueError("person not found")
            if person_id is None:
                if not name:
                    raise ValueError("person_id or name required")
                person_id = await conn.fetchval(
                    "SELECT id FROM people WHERE lower(canonical_name)=lower($1) AND NOT provisional", name
                )
                if person_id is None:
                    if is_me:
                        await conn.execute("UPDATE people SET is_me=FALSE WHERE is_me=TRUE")
                    person_id = await conn.fetchval(
                        "INSERT INTO people(canonical_name, is_me, provisional) VALUES($1,$2,FALSE) RETURNING id",
                        name, is_me,
                    )
            if prov_id and prov_id != person_id:
                await conn.execute(
                    "UPDATE people SET voiceprint=COALESCE(people.voiceprint, prov.voiceprint), "
                    "enroll_count=GREATEST(people.enroll_count,1) FROM people prov "
                    "WHERE people.id=$1 AND prov.id=$2",
                    person_id, prov_id,
                )
                await conn.execute("UPDATE turns SET person_id=$1 WHERE person_id=$2", person_id, prov_id)
                await conn.execute("DELETE FROM people WHERE id=$1 AND provisional", prov_id)
            await conn.execute(
                "UPDATE turns SET person_id=$1 WHERE session_id=$2 AND session_speaker_label=$3",
                person_id, session_id, label,
            )
    return {"session_id": session_id, "label": label, "person_id": person_id}


async def delete_person(person_id: int) -> None:
    pool = await get_pool()
    await pool.execute("DELETE FROM people WHERE id=$1", person_id)
