"""M1 ingest: diarize a window -> resolve speakers (ECAPA voiceprint) -> persist turns.

The audio bytes live only for the duration of this call. They are sent to the transcription
provider and (optionally) decoded in-memory for voiceprints, then discarded. Nothing is stored.
"""
from __future__ import annotations

import datetime as dt
import logging

import numpy as np

from ..config import settings
from ..db import get_pool
from ..providers import get_provider
from . import voiceprint
from .util import detect_lang

log = logging.getLogger("sutra.ingest")


async def create_session(device: str | None) -> dict:
    pool = await get_pool()
    row = await pool.fetchrow(
        "INSERT INTO sessions(device, status) VALUES($1,'active') RETURNING id, started_at, status",
        device,
    )
    return dict(row)


async def close_session(session_id: int) -> None:
    pool = await get_pool()
    await pool.execute(
        "UPDATE sessions SET status='closed', ended_at=now() WHERE id=$1", session_id
    )


async def _load_voiceprints(pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT id, canonical_name, is_me, provisional, voiceprint FROM people WHERE voiceprint IS NOT NULL"
    )
    return [dict(r) for r in rows]


async def _next_speaker_name(pool) -> str:
    n = await pool.fetchval("SELECT count(*) FROM people WHERE provisional") or 0
    return f"Speaker {int(n) + 1}"


async def _resolve_person(pool, emb: np.ndarray, known: list[dict]) -> tuple[int, float]:
    """Return (person_id, confidence). Creates a provisional person for novel speakers."""
    best_id, best_sim = None, -1.0
    for p in known:
        sim = float(np.dot(emb, np.asarray(p["voiceprint"], dtype="float32")))  # both L2-normalized
        if sim > best_sim:
            best_id, best_sim = p["id"], sim
    # Two-threshold ECAPA matching:
    #   best_sim >= voiceprint_accept -> confident same speaker (merge into known identity)
    #   best_sim <  voiceprint_accept -> do NOT merge (avoid misattribution); create a provisional
    #       identity. If best_sim >= voiceprint_new it is a *possible* duplicate of best_id, flagged
    #       in notes so the user can merge it later.
    if best_id is not None and best_sim >= settings.voiceprint_accept:
        return best_id, best_sim
    name = await _next_speaker_name(pool)
    possible = best_id if (best_id is not None and best_sim >= settings.voiceprint_new) else None
    notes = f"possible match: person {possible} (sim {best_sim:.2f})" if possible else None
    new_id = await pool.fetchval(
        "INSERT INTO people(canonical_name, provisional, voiceprint, enroll_count, notes) "
        "VALUES($1, TRUE, $2, 1, $3) RETURNING id",
        name, emb.tolist(), notes,
    )
    known.append({"id": new_id, "canonical_name": name, "is_me": False, "provisional": True, "voiceprint": emb})
    return new_id, None


async def ingest_window(
    session_id: int, audio: bytes, filename: str, content_type: str, window_index: int = 0
) -> dict:
    pool = await get_pool()
    sess = await pool.fetchrow("SELECT started_at FROM sessions WHERE id=$1", session_id)
    if sess is None:
        raise ValueError(f"session {session_id} not found")
    started_at: dt.datetime = sess["started_at"]

    provider = get_provider()
    tr = await provider.transcribe_diarize(audio, filename, content_type)
    segments = tr["segments"]

    # --- speaker identity via voiceprint (audio decoded in-memory, then discarded) ---
    label_to_person: dict[str, tuple[int, float]] = {}
    if settings.use_voiceprint and segments:
        known = await _load_voiceprints(pool)
        embs = await voiceprint.embed_segments(audio, segments)
        for label, emb in embs.items():
            try:
                label_to_person[label] = await _resolve_person(pool, emb, known)
            except Exception as e:
                log.warning("speaker resolve failed (%s): %s", label, e)

    # --- persist turns (consent mode gates unknown speakers) ---
    consent = settings.consent_mode.lower()
    inserted = []
    for s in segments:
        label = str(s["speaker"])
        pid, conf = label_to_person.get(label, (None, None))
        is_unknown = pid is None or await _is_provisional(pool, pid)
        text = s["text"]
        redacted = False
        if consent in ("drop", "redact") and is_unknown:
            if consent == "drop":
                continue
            text, redacted = "[redacted — unenrolled speaker]", True
        abs_start = started_at + dt.timedelta(seconds=float(s["start"]))
        row = await pool.fetchrow(
            """INSERT INTO turns
               (session_id, window_index, session_speaker_label, person_id, speaker_confidence,
                text, lang, start_ts, end_ts, abs_start, redacted)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               RETURNING id, session_speaker_label, person_id, text, lang, start_ts, end_ts, speaker_confidence""",
            session_id, window_index, label, pid, conf, text, detect_lang(text),
            float(s["start"]), float(s["end"]), abs_start, redacted,
        )
        d = dict(row)
        if pid is not None:
            d["person_name"] = await pool.fetchval("SELECT canonical_name FROM people WHERE id=$1", pid)
        inserted.append(d)

    return {"session_id": session_id, "window_index": window_index, "duration": tr["duration"], "turns": inserted}


async def _is_provisional(pool, person_id: int) -> bool:
    return bool(await pool.fetchval("SELECT provisional FROM people WHERE id=$1", person_id))
