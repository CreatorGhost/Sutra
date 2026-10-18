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

/** `exclude`: entities kept out of the result (and so out of the edge limit). */
export async function expand(entityIds: number[], hops = 2, limit = 120, exclude: number[] = []) {
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
  const skip = new Set(exclude);
  let ids = reach.map((r) => r.id).filter((id) => !skip.has(id));
  if (!ids.length) return { nodes: [], edges: [] };
  if (ids.length > 400) ids = ids.slice(0, 400); // cap so doubled IN(...) binding stays under SQLite's 999-var limit
  const ph = ids.map(() => "?").join(",");
  const edges = (await q(
    `SELECT id,src_entity src,dst_entity dst,relation,weight,evidence FROM edges
     WHERE src_entity IN (${ph}) AND dst_entity IN (${ph})
     ORDER BY weight * (CASE WHEN EXISTS(SELECT 1 FROM json_each(?) WHERE value IN (src_entity,dst_entity)) THEN 2 ELSE 1 END) DESC, last_seen DESC
     LIMIT ?`, [...ids, ...ids, seed, limit])) as any[]; // seed edges count double, as in relatedConversations
  let nodeIds = [...new Set<number>(ids)];
  edges.forEach((e) => { nodeIds.push(e.src); nodeIds.push(e.dst); });
  nodeIds = [...new Set<number>(nodeIds)];
  if (nodeIds.length > 800) nodeIds = nodeIds.slice(0, 800); // keep node binding under SQLite's 999-var limit
  const nph = nodeIds.map(() => "?").join(",");
  const nodes = await q(`SELECT id,type,canonical_name,importance,mention_count FROM entities WHERE id IN (${nph})`, [...nodeIds]);
  return { nodes, edges: edges.map((e) => { let ev = []; try { ev = JSON.parse(e.evidence || "[]"); } catch {} return { ...e, evidence: ev }; }) };
}

/** The graph page's first view: the most-mentioned entities and their strongest links. Entities left
 *  without a drawn link are dropped (they only float loose and shrink everything else on "fit"), and so
 *  is the owner ("Me"), who is linked to everything and pulls the graph into a star. */
export async function graphOverview() {
  const top = (await q("SELECT id FROM entities WHERE norm_name NOT IN ('me','i','myself') ORDER BY mention_count DESC, importance DESC LIMIT 80")) as any[];
  if (!top.length) return { nodes: [], edges: [] };
  // The owner is excluded in the query, so its many edges don't use up the 300.
  const owner = ((await q("SELECT id FROM entities WHERE norm_name IN ('me','i','myself')")) as any[]).map((o) => o.id);
  const g = await expand(top.map((t) => t.id), 1, 300, owner);
  const edges = g.edges;
  const linked = new Set(edges.flatMap((e: any) => [e.src, e.dst]));
  return { nodes: (g.nodes as any[]).filter((n) => linked.has(n.id)), edges };
}

/** The k entities closest to a query; below `minSim` nothing is close enough to count as a match. */
export async function nearestEntities(qvec: number[], k = 5, minSim = 0): Promise<number[]> {
  const cands = (await q("SELECT id,embedding FROM entities WHERE embedding IS NOT NULL")) as any[];
  return cands.map((c) => ({ id: c.id, sim: c.embedding ? cosine(qvec, blobToVec(c.embedding)) : -1 }))
    .filter((x) => x.sim >= minSim)
    .sort((a, b) => b.sim - a.sim).slice(0, k).map((x) => x.id);
}

/** Meetings the graph connects to the question (GraphRAG-style "source units"): every edge in the
 *  expanded neighbourhood votes for the conversations in its evidence, by its weight — double when it
 *  touches a seed entity. `exclude`: meetings already found by search. Best first. */
export function relatedConversations(edges: { src: number; dst: number; weight?: number; evidence?: { conversation_id?: number }[] }[],
  seeds: number[], exclude: Set<number>, limit = 4): number[] {
  const seed = new Set(seeds), score = new Map<number, number>();
  for (const e of edges) {
    const w = (e.weight ?? 1) * (seed.has(e.src) || seed.has(e.dst) ? 2 : 1);
    for (const cid of new Set((e.evidence ?? []).map((x) => Number(x?.conversation_id)).filter(Number.isFinite))) {
      if (!exclude.has(cid)) score.set(cid, (score.get(cid) ?? 0) + w);
    }
  }
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([cid]) => cid);
}
