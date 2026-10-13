// PURE: what the Ask bar's model picker lists. One entry per (engine, model) the user can pick —
// "Default" (the engine's own choice) first, then the models the engine reports — plus favorites and
// search. The picker writes ai_engine / ai_model_<id>, the same settings as Settings → Intelligence.
import { AGENTS, agentReady, safeModel, type AgentId, type AgentStatus } from "../shared/agentProtocol";

export interface ModelOption {
  key: string;            // "<engine>:<model>" ("<engine>:" for Default) — stable, used for favorites
  engine: AgentId;
  model: string | null;   // null = let the engine choose
  name: string;           // shown on the row
  hint: string | null;    // e.g. the default model's name
}

export const FAVORITES_KEY = "ai_model_favorites";
export const optionKey = (engine: AgentId, model: string | null) => `${engine}:${model ?? ""}`;

const UPPER = new Set(["gpt", "ai", "asr", "cli", "xl"]);
/** "gpt-5-codex" → "GPT-5 Codex", "gemini-2.5-pro" → "Gemini 2.5 Pro", "sonnet" → "Sonnet". */
export function prettyModel(slug: string): string {
  const parts = slug.split(/[-_\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    const word = UPPER.has(lower) ? lower.toUpperCase() : /^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1);
    // Glue a version straight onto "GPT" ("GPT-5"), as vendors write it.
    if (/^\d/.test(word) && out.length && out[out.length - 1] === "GPT") out[out.length - 1] = `GPT-${word}`;
    else out.push(word);
  }
  return out.join(" ") || slug;
}

export function engineOptions(st: AgentStatus, current: string | null): ModelOption[] {
  const models = [...new Set([...(st.models ?? []), ...(current ? [current] : [])])].filter((m) => safeModel(m));
  return [
    { key: optionKey(st.id, null), engine: st.id, model: null, name: "Default", hint: st.defaultModel ? prettyModel(st.defaultModel) : null },
    ...models.map((m) => ({ key: optionKey(st.id, m), engine: st.id, model: m, name: prettyModel(m), hint: null })),
  ];
}

export function parseFavorites(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function toggleFavorite(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

/** Rows for the picker's current view: a search across every ready engine, the favorites, or one engine. */
export function visibleOptions(input: {
  agents: AgentStatus[];
  settings: Record<string, unknown>;
  tab: "favorites" | AgentId;
  query: string;
}): ModelOption[] {
  const ready = input.agents.filter(agentReady);
  const all = ready.flatMap((a) => engineOptions(a, safeModel(input.settings[`ai_model_${a.id}`])));
  const q = input.query.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/);
    return all.filter((o) => {
      const hay = `${o.name} ${o.model ?? ""} ${AGENTS[o.engine].label} ${AGENTS[o.engine].vendor} ${o.hint ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (input.tab === "favorites") {
    const favs = parseFavorites(input.settings[FAVORITES_KEY]);
    return favs.map((k) => all.find((o) => o.key === k)).filter((o): o is ModelOption => !!o);
  }
  return all.filter((o) => o.engine === input.tab);
}
