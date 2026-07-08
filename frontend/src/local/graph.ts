// Knowledge graph (port of graph.py): entity upsert + resolution, bi-temporal typed edges,
// bidirectional recursive-CTE traversal — all in on-device SQLite.
import { q, run, persist } from "./db";
import { getSettings } from "./repo";
import { blobToVec, cosine, normName, vecToBlob } from "./util";

// KNOWN ISSUE (low-impact): mention_count/importance increment unconditionally per upsert, so
// re-extracting the SAME conversation (recovery path in extraction.ts) re-inflates these counters.
// This is guarded by "memory exists -> skip" in processSession/reprocessIncomplete, so it only
// happens for conversations that never completed extraction (rare). A per-conversation dedup of
// entity contributions is invasive/risky, so it is intentionally NOT implemented here.
export async function upsertEntity(type: string, name: string, description: string | null, embedding: number[] | null): Promise<number> {
  const nn = normName(name);
  if (!nn) return 0;
  const exact = (await q("SELECT id FROM entities WHERE type=? AND norm_name=?", [type, nn]))[0] as any;
  if (exact) {
    await run("UPDATE entities SET mention_count=mention_count+1,last_seen=datetime('now'),importance=MIN(1.0,importance+0.05) WHERE id=?", [exact.id]);
    return exact.id;
  }
  if (embedding) {
    const s = await getSettings();
    const thr = Number(s["entity_sim_threshold"] ?? 0.86);
    const cands = (await q("SELECT id,embedding FROM entities WHERE type=? AND embedding IS NOT NULL", [type])) as any[];
    let bestId = -1, best = -1;
    for (const c of cands) { const sim = cosine(embedding, blobToVec(c.embedding)); if (sim > best) { best = sim; bestId = c.id; } }
    if (bestId > 0 && best >= thr) {
      await run("UPDATE entities SET mention_count=mention_count+1,last_seen=datetime('now') WHERE id=?", [bestId]);
      return bestId;
    }
  }
  const { lastId } = await run(
    "INSERT INTO entities(type,canonical_name,norm_name,attrs,embedding,embed_dim,importance) VALUES(?,?,?,?,?,?,0.5)",
    [type, name.trim(), nn, JSON.stringify(description ? { description } : {}), embedding ? vecToBlob(embedding) : null, embedding?.length ?? null]);
  return lastId;
}

// KNOWN ISSUE (low-impact): weight increments unconditionally on conflict, so re-extracting the SAME
// conversation (recovery path in extraction.ts) re-inflates edge weight (and appends evidence again).
// Guarded by "memory exists -> skip", so it only affects conversations that never completed extraction.
// A per-conversation dedup of edge contributions is invasive/risky, so it is intentionally NOT done here.
export async function upsertEdge(src: number, dst: number, relation: string, convId: number, turnIds: number[], validFrom?: string, validTo?: string) {
  if (!src || !dst || src === dst) return;
  const rel = relation.trim().toLowerCase().replace(/\s+/g, "_");
  const ev = JSON.stringify([{ conversation_id: convId, turn_ids: turnIds }]);
  await run(
    `INSERT INTO edges(src_entity,dst_entity,relation,weight,evidence,valid_from,valid_to)
     VALUES(?,?,?,1.0,?,?,?)
     ON CONFLICT(src_entity,dst_entity,relation) DO UPDATE SET weight=edges.weight+1.0,last_seen=datetime('now'),
       valid_to=COALESCE(excluded.valid_to, edges.valid_to), evidence=json_insert(edges.evidence,'$[#]', json(?))`,
    [src, dst, rel, ev, validFrom ?? null, validTo ?? null, JSON.stringify({ conversation_id: convId, turn_ids: turnIds })]);
  await persist();
}

export async function expand(entityIds: number[], hops = 2, limit = 120) {
  if (!entityIds.length) return { nodes: [], edges: [] };
  hops = Math.max(0, Math.min(hops, 3));
  const seed = JSON.stringify(entityIds);
  const reach = (await q(
    `WITH RECURSIVE reach(id,depth) AS (
       SELECT value, 0 FROM json_each(?)
       UNION
       SELECT CASE WHEN e.src_entity=r.id THEN e.dst_entity ELSE e.src_entity END, r.depth+1
       FROM edges e JOIN reach r ON (e.src_entity=r.id OR e.dst_entity=r.id)
       WHERE r.depth < ?)
     SELECT DISTINCT id FROM reach`, [seed, hops])) as any[];
  let ids = reach.map((r) => r.id);
  if (!ids.length) return { nodes: [], edges: [] };
  if (ids.length > 400) ids = ids.slice(0, 400); // cap so doubled IN(...) binding stays under SQLite's 999-var limit
  const ph = ids.map(() => "?").join(",");
  const edges = (await q(
    `SELECT id,src_entity src,dst_entity dst,relation,weight,evidence FROM edges
     WHERE src_entity IN (${ph}) AND dst_entity IN (${ph}) LIMIT ?`, [...ids, ...ids, limit])) as any[];
  let nodeIds = [...new Set<number>(ids)];
  edges.forEach((e) => { nodeIds.push(e.src); nodeIds.push(e.dst); });
  nodeIds = [...new Set<number>(nodeIds)];
  if (nodeIds.length > 800) nodeIds = nodeIds.slice(0, 800); // keep node binding under SQLite's 999-var limit
  const nph = nodeIds.map(() => "?").join(",");
  const nodes = await q(`SELECT id,type,canonical_name,importance,mention_count FROM entities WHERE id IN (${nph})`, [...nodeIds]);
  return { nodes, edges: edges.map((e) => { let ev = []; try { ev = JSON.parse(e.evidence || "[]"); } catch {} return { ...e, evidence: ev }; }) };
}

export async function graphOverview() {
  const top = (await q("SELECT id FROM entities ORDER BY mention_count DESC, importance DESC LIMIT 80")) as any[];
  return top.length ? expand(top.map((t) => t.id), 1, 240) : { nodes: [], edges: [] };
}

export async function nearestEntities(qvec: number[], k = 5): Promise<number[]> {
  const cands = (await q("SELECT id,embedding FROM entities WHERE embedding IS NOT NULL")) as any[];
  return cands.map((c) => ({ id: c.id, sim: cosine(qvec, blobToVec(c.embedding)) }))
    .sort((a, b) => b.sim - a.sim).slice(0, k).map((x) => x.id);
}
