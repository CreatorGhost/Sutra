"""Knowledge graph: entity upsert with resolution, typed edges, recursive-CTE traversal."""
from __future__ import annotations

import re

from ..config import settings
from ..db import get_pool
from .util import cosine


def norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip().lower())


async def upsert_entity(pool, etype: str, name: str, description: str | None, embedding, conv_id: int) -> int:
    nn = norm_name(name)
    if not nn:
        return 0
    # 1) exact (type, norm_name)
    existing = await pool.fetchrow("SELECT id FROM entities WHERE type=$1 AND norm_name=$2", etype, nn)
    if existing:
        eid = existing["id"]
        await pool.execute(
            "UPDATE entities SET mention_count=mention_count+1, last_seen=now(), "
            "importance=LEAST(1.0, importance+0.05) WHERE id=$1",
            eid,
        )
        return eid
    # 2) embedding near-duplicate within same type
    if embedding is not None:
        cands = await pool.fetch(
            "SELECT id, embedding FROM entities WHERE type=$1 AND embedding IS NOT NULL "
            "ORDER BY embedding <=> $2 LIMIT 1",
            etype, embedding,
        )
        if cands:
            sim = cosine(embedding, cands[0]["embedding"])
            if sim >= settings.entity_sim_threshold:
                eid = cands[0]["id"]
                await pool.execute(
                    "UPDATE entities SET mention_count=mention_count+1, last_seen=now() WHERE id=$1", eid
                )
                return eid
    # 3) insert new
    eid = await pool.fetchval(
        "INSERT INTO entities(type, canonical_name, norm_name, attrs, embedding, importance) "
        "VALUES($1,$2,$3,$4,$5,0.5) "
        "ON CONFLICT (type, norm_name) DO UPDATE SET mention_count=entities.mention_count+1, last_seen=now() "
        "RETURNING id",
        etype, name.strip(), nn, {"description": description} if description else {}, embedding,
    )
    return eid


async def upsert_edge(pool, src: int, dst: int, relation: str, conv_id: int, turn_ids: list[int]) -> None:
    if not src or not dst or src == dst:
        return
    ev = [{"conversation_id": conv_id, "turn_ids": turn_ids}]
    await pool.execute(
        """INSERT INTO edges(src_entity, dst_entity, relation, weight, evidence)
           VALUES($1,$2,$3,1.0,$4)
           ON CONFLICT (src_entity, dst_entity, relation)
           DO UPDATE SET weight=edges.weight+1.0, last_seen=now(),
                         evidence = edges.evidence || EXCLUDED.evidence""",
        src, dst, relation.strip().lower().replace(" ", "_"), ev,
    )


async def expand(entity_ids: list[int], hops: int = 1, limit: int = 60) -> dict:
    """Recursive-CTE neighborhood around seed entities (for graph-RAG + the graph browser)."""
    pool = await get_pool()
    if not entity_ids:
        return {"nodes": [], "edges": []}
    hops = max(0, min(hops, 3))
    edge_rows = await pool.fetch(
        """
        WITH RECURSIVE reach(id, depth) AS (
            SELECT unnest($1::bigint[]) AS id, 0 AS depth
            UNION
            SELECT nb.id, r.depth + 1
            FROM reach r
            JOIN LATERAL (
                SELECT dst_entity AS id FROM edges WHERE src_entity = r.id
                UNION
                SELECT src_entity AS id FROM edges WHERE dst_entity = r.id
            ) nb ON TRUE
            WHERE r.depth < $2
        )
        SELECT DISTINCT e.id, e.src_entity, e.dst_entity, e.relation, e.weight, e.evidence
        FROM edges e
        WHERE e.src_entity IN (SELECT id FROM reach) AND e.dst_entity IN (SELECT id FROM reach)
        LIMIT $3
        """,
        entity_ids, hops, limit,
    )
    node_ids = set(entity_ids)
    for r in edge_rows:
        node_ids.add(r["src_entity"])
        node_ids.add(r["dst_entity"])
    node_rows = await pool.fetch(
        "SELECT id, type, canonical_name, importance, mention_count FROM entities WHERE id = ANY($1::bigint[])",
        list(node_ids),
    )
    return {
        "nodes": [dict(r) for r in node_rows],
        "edges": [
            {"id": r["id"], "src": r["src_entity"], "dst": r["dst_entity"],
             "relation": r["relation"], "weight": r["weight"], "evidence": r["evidence"]}
            for r in edge_rows
        ],
    }
