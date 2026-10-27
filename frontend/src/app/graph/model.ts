// PURE helpers for the knowledge-graph page (no React, no canvas).

export const ENTITY_TYPES = ["person", "project", "topic", "org", "place", "event", "commitment"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number] | "other";

/** Normalise an extractor type ("Organization", "people") onto the legend's buckets. */
export function typeKey(t: string | null | undefined): EntityType {
  const s = String(t ?? "").toLowerCase().trim();
  if ((ENTITY_TYPES as readonly string[]).includes(s)) return s as EntityType;
  if (/^(people|persons?)$/.test(s)) return "person";
  if (/^(organi[sz]ation|company|team)$/.test(s)) return "org";
  if (/^(location|city|country)$/.test(s)) return "place";
  if (/^(meeting|deadline)$/.test(s)) return "event";
  if (/^(task|action|promise)$/.test(s)) return "commitment";
  return "other";
}

export interface RawGraph { nodes: { id: number; type: string; canonical_name: string; mention_count?: number }[]; edges: { id?: number; src: number; dst: number; relation: string }[] }
export interface GNode { id: number; name: string; type: EntityType; val: number; degree: number; hub: boolean }
export interface GLink { source: number; target: number; relation: string; relations: string[] }

/** Graph data for the canvas with hidden types removed (and any link touching them). Several relations
 *  between the same two entities become one link (listing them all), so lines don't stack. A node's size
 *  follows how connected it is (plus a little for mentions); the best-connected ~15% are "hubs", the
 *  only names drawn before zooming in. */
export function buildGraph(data: RawGraph | null, hidden: ReadonlySet<EntityType>): { nodes: GNode[]; links: GLink[] } {
  if (!data) return { nodes: [], links: [] };
  const base = data.nodes.map((n) => ({ ...n, t: typeKey(n.type) })).filter((n) => !hidden.has(n.t));
  const keep = new Set(base.map((n) => n.id));
  const pairs = new Map<string, GLink>();
  for (const e of data.edges) {
    if (!keep.has(e.src) || !keep.has(e.dst) || e.src === e.dst) continue;
    const k = e.src < e.dst ? `${e.src}:${e.dst}` : `${e.dst}:${e.src}`;
    const l = pairs.get(k);
    if (!l) pairs.set(k, { source: e.src, target: e.dst, relation: e.relation, relations: [e.relation] });
    else if (!l.relations.includes(e.relation)) { l.relations.push(e.relation); l.relation = l.relations.join(", "); }
  }
  const links = [...pairs.values()];
  const degree = new Map<number, number>();
  for (const l of links) for (const id of [l.source, l.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const nodes = base.map((n) => {
    const d = degree.get(n.id) ?? 0;
    return { id: n.id, name: n.canonical_name, type: n.t, degree: d, val: 1 + d + Math.log2(1 + (n.mention_count || 1)), hub: false };
  });
  const ranked = [...nodes].sort((a, b) => b.val - a.val);
  ranked.slice(0, Math.max(5, Math.ceil(nodes.length * 0.15))).forEach((n) => (n.hub = true));
  return { nodes, links };
}

/** Types present in the data, in legend order, with counts. */
export function typeCounts(data: RawGraph | null): { type: EntityType; count: number }[] {
  const m = new Map<EntityType, number>();
  for (const n of data?.nodes ?? []) { const k = typeKey(n.type); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...ENTITY_TYPES, "other" as const].filter((t) => m.has(t)).map((t) => ({ type: t, count: m.get(t)! }));
}

/** Search box matches: names starting with the query first, then containing it. */
export function searchNodes<T extends { name: string }>(nodes: T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts = nodes.filter((n) => n.name.toLowerCase().startsWith(q));
  const contains = nodes.filter((n) => !n.name.toLowerCase().startsWith(q) && n.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}

/** Merge an expanded neighbourhood into what is already drawn (no duplicate nodes or edges). */
export function mergeGraph(prev: RawGraph | null, sub: RawGraph): RawGraph {
  if (!prev) return sub;
  const nIds = new Set(prev.nodes.map((n) => n.id));
  const eKey = (e: RawGraph["edges"][number]) => `${e.src}:${e.dst}:${e.relation}`;
  const eIds = new Set(prev.edges.map(eKey));
  return {
    nodes: [...prev.nodes, ...sub.nodes.filter((n) => !nIds.has(n.id))],
    edges: [...prev.edges, ...sub.edges.filter((e) => !eIds.has(eKey(e)))],
  };
}

/** "works_on" → "works on". */
export const relationLabel = (r: string) => String(r ?? "").replace(/_/g, " ");
