// Hybrid retrieval (port of ranking.py): semantic (brute-force cosine) + lexical (FTS5 BM25)
// -> RRF(k) -> recency decay -> importance. Stays identical to the documented formula.
import type { Provider } from "../providers/provider";
import { q } from "./db";
import { getSettings, memoriesForSearch, memoryCards } from "./repo";
import { cosine } from "./util";

const num = (s: any, k: string, d: number) => {
  const v = typeof s[k] === "number" ? s[k] : Number(s[k]);
  return Number.isFinite(v) ? v : d;
};

function ftsTokens(query: string): string {
  const toks = (query.match(/[\wऀ-ॿ]+/g) ?? []).slice(0, 24);
  return toks.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

function recency(createdAt: string, halfLifeDays: number): number {
  if (!createdAt) return 1;
  const t = Date.parse(createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return 1;
  const ageDays = (Date.now() - t) / 86400000;
  return Math.pow(0.5, ageDays / Math.max(0.5, halfLifeDays));
}

export async function searchMemories(query: string, provider: Provider, topNArg?: number) {
  query = (query || "").trim();
  if (!query) return [];
  const s = await getSettings();
  const k = num(s, "rank_rrf_k", 60), prefetch = num(s, "search_prefetch", 30);
  const topN = topNArg ?? num(s, "search_topn", 10);
  const halfLife = num(s, "rank_half_life_days", 30), wImp = num(s, "rank_w_importance", 0.5), wRrf = num(s, "rank_w_rrf", 1);
  const recencyOn = String(s["rank_recency"] ?? "on") === "on";

  let qvec: number[] | null = null;
  if (provider.canEmbed !== false) {
    try { [qvec] = await provider.embed([query]); } catch (e) { console.warn("query embedding skipped", e); }
  }
  // semantic (skipped when the engine can't embed — keyword search still works)
  const mem = qvec ? await memoriesForSearch() : [];
  const sem = mem.filter((m) => m.vec.length === qvec!.length).map((m) => ({ id: m.id, sim: cosine(qvec!, m.vec) }))
    .sort((a, b) => b.sim - a.sim).slice(0, prefetch);
  // lexical (FTS5 BM25; lower bm25 = better)
  let lex: { id: number }[] = [];
  const match = ftsTokens(query);
  if (match) {
    try {
      lex = (await q(`SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`, [match, prefetch])) as any;
    } catch { lex = []; }
  }
  // RRF
  const rrf = new Map<number, number>();
  sem.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (k + i + 1)));
  lex.forEach((r, i) => rrf.set(r.id, (rrf.get(r.id) ?? 0) + 1 / (k + i + 1)));
  if (!rrf.size) return [];
  const rmax = Math.max(...rrf.values()) || 1;
  const cards = (await memoryCards([...rrf.keys()])) as any[];
  const out = cards.map((c) => {
    const norm = (rrf.get(c.id) ?? 0) / rmax;
    const score = wRrf * norm * (recencyOn ? recency(c.created_at, halfLife) : 1) * (1 + wImp * (c.importance ?? 0.5));
    const facts = (() => { try { return JSON.parse(c.facts || "[]"); } catch { return []; } })();
    return { ...c, facts, rrf: rrf.get(c.id), score };
  }).sort((a, b) => b.score - a.score);

  const mode = String(s["rerank"] ?? "off");
  let head = out.slice(0, Math.max(topN, Math.min(prefetch, out.length)));
  if (mode === "llm" && head.length) {
    try {
      const scores = await provider.rerank(query, head.map((h) => h.summary));
      head = head.map((h, i) => ({ ...h, score: scores[i] ?? h.score })).sort((a, b) => b.score - a.score);
      return head.slice(0, topN);
    } catch { /* fall back to fused order */ }
  } else if (mode === "crossencoder") {
    console.warn("crossencoder rerank not available on device; using fused order");
  }
  return out.slice(0, topN);
}
