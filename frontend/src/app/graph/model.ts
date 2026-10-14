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
export interface GNode { id: number; name: string; type: EntityType; val: number }
export interface GLink { source: number; target: number; relation: string }

/** Graph data for the canvas with hidden types removed (and any link touching them). */
export function buildGraph(data: RawGraph | null, hidden: ReadonlySet<EntityType>): { nodes: GNode[]; links: GLink[] } {
  if (!data) return { nodes: [], links: [] };
  const nodes = data.nodes
    .map((n) => ({ id: n.id, name: n.canonical_name, type: typeKey(n.type), val: 1 + (n.mention_count || 1) }))
    .filter((n) => !hidden.has(n.type));
  const keep = new Set(nodes.map((n) => n.id));
  const links = data.edges
    .filter((e) => keep.has(e.src) && keep.has(e.dst))
    .map((e) => ({ source: e.src, target: e.dst, relation: e.relation }));
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
