"""Hybrid retrieval: semantic + lexical -> RRF(k) -> recency decay -> importance -> optional rerank.

final(d) = w_rrf * norm(rrf(d)) * recency(d) * (1 + w_imp * importance(d))
"""
from __future__ import annotations

import datetime as dt
import logging

from ..config import get_runtime_settings, refresh_runtime_settings, settings
from ..db import get_pool
from ..providers import get_provider

log = logging.getLogger("sutra.ranking")
_cross_encoder = None


def _recency(created_at: dt.datetime, rt=settings) -> float:
    if rt.rank_recency.lower() != "on" or created_at is None:
        return 1.0
    age_days = (dt.datetime.now(dt.timezone.utc) - created_at).total_seconds() / 86400.0
    hl = max(0.5, rt.rank_half_life_days)
    return 0.5 ** (age_days / hl)


def _get_cross_encoder():
    global _cross_encoder
    if _cross_encoder is None:
        from sentence_transformers import CrossEncoder

        _cross_encoder = CrossEncoder(settings.rerank_model, max_length=512)
    return _cross_encoder


async def search(query: str, top_n: int | None = None) -> list[dict]:
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
           FROM memories m WHERE m.embedding IS NOT NULL
           ORDER BY m.embedding <=> $1 LIMIT $2""",
        qvec, prefetch,
    )
    lex = await pool.fetch(
        """SELECT m.id, ts_rank(m.search_tsv, websearch_to_tsquery('simple', $1)) AS rank
           FROM memories m
           WHERE m.search_tsv @@ websearch_to_tsquery('simple', $1)
           ORDER BY rank DESC LIMIT $2""",
        query, prefetch,
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
        """SELECT m.id, m.conversation_id, m.summary, m.facts, m.action_items, m.decisions,
                  m.importance_score, m.type_tags, m.created_at, c.title, c.started_at
           FROM memories m JOIN conversations c ON c.id=m.conversation_id
           WHERE m.id = ANY($1::bigint[])""",
        ids,
    )
    out = []
    for r in rows:
        d = dict(r)
        rrf_norm = rrf[r["id"]] / rmax
        score = rt.rank_w_rrf * rrf_norm * _recency(r["created_at"], rt) * (
            1.0 + rt.rank_w_importance * float(r["importance_score"])
        )
        d["rrf"] = round(rrf[r["id"]], 6)
        d["score"] = round(score, 6)
        out.append(d)
    out.sort(key=lambda x: x["score"], reverse=True)

    mode = rt.rerank.lower()
    head = out[: max(top_n, min(prefetch, len(out)))]
    if mode == "llm" and head:
        try:
            scores = await provider.rerank(query, [h["summary"] for h in head])
            for h, s in zip(head, scores):
                h["score"] = float(s)
            head.sort(key=lambda x: x["score"], reverse=True)
            out = head
        except Exception as e:
            log.warning("llm rerank failed, falling back to fused order: %s", e)
    elif mode == "crossencoder" and head:
        try:
            ce = _get_cross_encoder()
            pairs = [(query, h["summary"]) for h in head]
            scores = ce.predict(pairs)
            for h, s in zip(head, scores):
                h["score"] = float(s)
            head.sort(key=lambda x: x["score"], reverse=True)
            out = head
        except Exception as e:
            log.warning("crossencoder rerank failed, falling back to fused order: %s", e)

    return out[:top_n]
