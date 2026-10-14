// MCP method map (app-side): tool name -> handler. ALL read-only. Each handler validates + clamps its
// params, re-reads settings per request for scope gating (default-deny on the gated tools), calls the
// existing facade/repo read functions, and runs the output through a pure whitelist serializer (DB rows
// are never returned directly). Invalid params throw Error(<human message>); the bridge maps that to
// ok:false. No mutating facade/repo function is ever called here.
import { api } from "../sutra";
import * as repo from "../repo";
import { topPriors } from "../repo";
import { expand, graphOverview } from "../graph";
import { q } from "../db";
import { normName } from "../util";
import {
  SafeError,
  clampTopN, clampListLimit, clampHops, clampGraphLimit, clampEventsLimit, clampContextTopN,
  serializeSearch, serializeConversation, serializeConversationList, serializePeople, serializeGraph,
  serializeActionItems, serializeEvents, serializeMinutes, serializeYourContext, serializeAsk,
  serializePrivacy, serializeRollup,
} from "./serializers";

const settings = () => repo.getSettings();
// All scope flags default ON (!== false); the master mcp_enabled gate is enforced by the bridge per request.
const allowed = (s: Record<string, unknown>, key: string) => s[key] !== false;

const reqInt = (v: any, name: string): number => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) throw new SafeError(`${name} is required and must be a number`);
  return n;
};
const reqStr = (v: any, name: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) throw new SafeError(`${name} is required`);
  return v.trim().slice(0, max);
};

/** Resolve an entity reference to an id: number used directly; string resolved over the entities table
 *  (exact normName match first, then LIKE ordered by mention_count DESC). NO embed/proxy call. */
async function resolveEntityId(entity: string | number): Promise<number> {
  if (typeof entity === "number" && Number.isFinite(entity)) return Math.trunc(entity);
  const name = String(entity ?? "").trim();
  if (!name) throw new SafeError("entity not found");
  const nn = normName(name);
  const exact = (await q("SELECT id FROM entities WHERE norm_name=? ORDER BY mention_count DESC LIMIT 1", [nn]))[0] as any;
  if (exact?.id != null) return Number(exact.id);
  const like = (await q("SELECT id FROM entities WHERE norm_name LIKE ? ORDER BY mention_count DESC LIMIT 1", [`%${nn}%`]))[0] as any;
  if (like?.id != null) return Number(like.id);
  throw new SafeError("entity not found");
}

export const mcpHandlers: Record<string, (params: any) => Promise<unknown>> = {
  async search_memory(p) {
    const query = reqStr(p?.query, "query", 500);
    const topN = clampTopN(p?.topN);
    const r = await api.search(query, topN);
    return serializeSearch((r as any)?.query ?? query, (r as any)?.results ?? []);
  },

  async get_conversation(p) {
    const id = reqInt(p?.id, "id");
    const s = await settings();
    const detail = await repo.conversationDetailSafe(id);
    if (!detail) throw new SafeError("conversation not found");
    return serializeConversation(detail, allowed(s, "mcp_allow_transcripts"));
  },

  async list_conversations(p) {
    const limit = clampListLimit(p?.limit);
    const rows = await repo.listConversations();
    return serializeConversationList((rows as any[]).slice(0, limit));
  },

  async list_people() {
    const s = await settings();
    if (!allowed(s, "mcp_allow_people")) throw new SafeError("People sharing is disabled in Settings.");
    return serializePeople((await api.listPeople()) as any[]);
  },

  async get_graph_neighborhood(p) {
    const s = await settings();
    if (!allowed(s, "mcp_allow_graph")) throw new SafeError("Graph sharing is disabled in Settings.");
    const hops = clampHops(p?.hops);
    const limit = clampGraphLimit(p?.limit);
    const entity = p?.entity;
    let g: any;
    if (entity == null || entity === "") {
      g = await graphOverview();
    } else {
      const id = await resolveEntityId(entity);
      g = await expand([id], hops, limit);
    }
    return serializeGraph(g);
  },

  async list_action_items(p) {
    const raw = p?.status;
    const status = raw === "open" || raw === "done" ? raw : "open"; // "all" / unspecified -> no arg
    const arg = raw === "all" ? undefined : status;
    return serializeActionItems((await repo.listActions(arg)) as any[]);
  },

  async upcoming_events(p) {
    const from = typeof p?.from === "string" && p.from.trim() ? p.from.trim() : new Date().toISOString();
    const limit = clampEventsLimit(p?.limit);
    const rows = await repo.upcomingEvents(from);
    return serializeEvents((rows as any[]).slice(0, limit));
  },

  async get_minutes(p) {
    const id = reqInt(p?.conversationId, "conversationId");
    return serializeMinutes(await repo.minutesFor(id));
  },

  async get_your_context(p) {
    const s = await settings();
    if (!allowed(s, "mcp_allow_priors")) throw new SafeError("Your Context sharing is disabled in Settings.");
    const topN = clampContextTopN(p?.topN);
    const query = typeof p?.query === "string" ? p.query : "";
    // cloud MUST be true: an external AI is a cloud consumer, so only share_cloud=1 priors may leave.
    const priors = await topPriors(query, topN, true);
    return serializeYourContext(priors as any[]);
  },

  async ask_memory(p) {
    const question = reqStr(p?.question, "question", 2000);
    let history: { role: string; content: string }[] = [];
    if (Array.isArray(p?.history)) {
      history = p.history
        .filter((h: any) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
        .slice(0, 10)
        .map((h: any) => ({ role: h.role, content: String(h.content) }));
    }
    return serializeAsk(await api.chat(question, history));
  },

  async get_privacy() {
    return serializePrivacy(await api.health());
  },

  async get_daily_rollup(p) {
    const day = reqStr(p?.day, "day", 10);
    const rows = (await repo.listRollups()) as any[];
    const row = rows.find((r) => String(r?.day) === day) ?? null;
    return serializeRollup(row);
  },
};
