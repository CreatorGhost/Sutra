import type { Provider } from "../providers/provider";
import { isFullTextEngine } from "../providers";
import { ANSWER_SCHEMA, CHAT_SYSTEM } from "./aiPrompts";
import { expand, nearestEntities, relatedConversations } from "./graph";
import { actionsForConversations, askScopeForProject, conversationsBetween, getProject, getSettings, listProjects, memoryCardsForConversations, projectConversationIds, searchTurns, topPriors } from "./repo";
import { speakerName } from "./speakers";
import { searchMemories } from "./search";

const DAY = 86_400_000;
const sqlTs = (d: Date) => d.toISOString(); // compared against started_at with any " " turned into "T"
/** The period a question names ("today", "yesterday", "this week", "last week", "this month", "last 3
 *  days"), as [from, to) in the stored timestamp format — or null. Weeks start on Monday, in local time. */
export function timeWindow(message: string, now = new Date()): [string, string] | null {
  const m = message.toLowerCase();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = new Date(day0.getTime() - ((day0.getDay() + 6) % 7) * DAY);
  const end = new Date(day0.getTime() + DAY);
  let from: Date | null = null, to = end;
  const n = /\b(?:last|past)\s+(\d{1,2})\s+days?\b/.exec(m);
  if (n) from = new Date(day0.getTime() - (Number(n[1]) - 1) * DAY);
  else if (/\btoday\b/.test(m)) from = day0;
  else if (/\byesterday\b/.test(m)) { from = new Date(day0.getTime() - DAY); to = day0; }
  else if (/\blast week\b/.test(m)) { from = new Date(monday.getTime() - 7 * DAY); to = monday; }
  else if (/\bthis week\b|\bweek\b/.test(m)) from = monday;
  else if (/\blast month\b/.test(m)) { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 1); }
  else if (/\bthis month\b/.test(m)) from = new Date(now.getFullYear(), now.getMonth(), 1);
  return from ? [sqlTs(from), sqlTs(to)] : null;
}

const STOP = new Set("the and for are was were what who whom whose when where which why how did does do about with from that this these those have has had you your our they them their there then than into onto over said say says tell told any all can could would should will just also like something anything about on in of to a an is it me my i we us he she his her".split(" "));

/** The words worth finding in a transcript: not filler, not the project's own name. */
export function questionWords(message: string, projectName?: string | null): string[] {
  const skip = new Set(String(projectName ?? "").toLowerCase().split(/\s+/));
  const words = (message.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu) ?? [])
    .filter((w) => w.length >= 3 && !STOP.has(w) && !skip.has(w));
  return [...new Set(words)].slice(0, 8);
}

/** A project the question names ("on MCS, what did …") — whole word, any case; the longest name wins. */
export function mentionedProject<T extends { name?: string | null }>(message: string, projects: T[]): T | null {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = projects.filter((p) => p.name && p.name.trim().length >= 2 && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(p.name.trim())}($|[^\\p{L}\\p{N}])`, "iu").test(message));
  return hits.sort((a, b) => b.name!.length - a.name!.length)[0] ?? null;
}

/** `projectId`: Ask about one project — only its meetings, its brief, and (desktop, code access on) its
 *  linked code folders, which the agent may read. */
/** `opts` (for outside callers like MCP): `transcripts` false keeps transcript lines out of the prompt (the
 *  user's transcript-sharing setting); `inferProject` false never picks a project from the question's words —
 *  picking one can open its code folders to the agent. */
export async function chat(message: string, provider: Provider, history: { role: string; content: string }[] = [], projectId: number | null = null,
                           opts: { transcripts?: boolean; inferProject?: boolean; priors?: boolean; graph?: boolean; outside?: boolean } = {}) {
  const { transcripts = true, inferProject = true, priors: priorsOn = true, graph = true, outside = false } = opts;
  message = (message || "").trim();
  if (!message) return { answer: "Please ask a question.", supported: false, citations: [], retrieved: [] };
  // No project picked, but the question names one ("on MCS …"): ask about that project.
  const project = projectId != null ? await getProject(projectId).catch(() => null) as any
    : inferProject ? mentionedProject(message, await listProjects().catch(() => []) as any[]) : null;
  let memories = await searchMemories(message, provider, project ? 24 : 8) as any[];
  if (project) {
    const ids = new Set(await projectConversationIds(project.id));
    memories = memories.filter((m) => ids.has(m.conversation_id)).slice(0, 8);
  }
  // A question about a period ("what did I promise this week"): that period's meetings and their action
  // items, whatever words they use — search alone matches words, not dates.
  const period = timeWindow(message);
  let periodActions: any[] = [];
  if (period) {
    let ids = await conversationsBetween(period[0], period[1]).catch(() => [] as number[]);
    if (project) { const mine = new Set(await projectConversationIds(project.id)); ids = ids.filter((id) => mine.has(id)); }
    const have = new Set(memories.map((m) => m.conversation_id));
    memories = [...memories, ...(await memoryCardsForConversations(ids.filter((id) => !have.has(id))).catch(() => []) as any[])];
    periodActions = await actionsForConversations(ids).catch(() => []) as any[];
  }
  let seeds: number[] = [];
  if (graph && provider.canEmbed !== false) {
    try { const [qvec] = await provider.embed([message]); seeds = await nearestEntities(qvec, 5, 0.25); } catch { /* keyword-only */ }
  }
  const sub = await expand(seeds, 2, 40);
  // Meetings the graph links to the question that search didn't surface — including other projects'
  // ("you worked on something like this in X"). They're context and citable, like the search hits.
  const relatedIds = relatedConversations(sub.edges as any[], seeds, new Set(memories.map((m) => m.conversation_id)), project ? 3 : 4);
  const related = (await memoryCardsForConversations(relatedIds).catch(() => []) as any[])
    .sort((a, b) => relatedIds.indexOf(a.conversation_id) - relatedIds.indexOf(b.conversation_id));

  // What people actually said: summaries leave out who-said-what, so quote matching transcript lines.
  const quotes = !transcripts ? [] : await searchTurns(questionWords(message, project?.name), project ? await projectConversationIds(project.id) : null).catch(() => [] as any[]);
  const known = new Set([...memories, ...related].map((m) => m.conversation_id));
  const quoted = await memoryCardsForConversations([...new Set(quotes.map((t) => t.conversation_id as number))].filter((id) => !known.has(id))).catch(() => []) as any[];

  // "Your Context": the user's standing priors (people/projects/role) — beliefs, NON-CITABLE, may be
  // stale. Gated on the context_enabled master toggle; in cloud mode only share_cloud=1 priors ride
  // along. Prepended BEFORE the memories so the model uses it only to resolve who/what the user means.
  const settings = await getSettings();
  const contextEnabled = settings["context_enabled"] !== false;
  // An agent engine sends the prompt off this device too (to the agent's vendor), so it gets the same
  // share_cloud filter as the Sutra cloud.
  const cloudMode = outside || isFullTextEngine(provider); // an outside caller only gets share_cloud priors
  let priorsBlock = "";
  if (contextEnabled && priorsOn) {
    try {
      const priors = await topPriors(message, 6, cloudMode) as any[];
      if (priors.length) {
        const lines = priors.map((p) => {
          const val = p.value ? `: ${p.value}` : "";
          return `- (${p.kind}) ${p.subject}${val}`;
        });
        priorsBlock = ["# Your Context (priors — may be outdated; prefer the conversations below, flag conflicts)", ...lines, ""].join("\n");
      }
    } catch (e) { console.warn("topPriors failed; chatting without Your Context", e); }
  }

  const ctx = ["# Memories"];
  for (const m of memories) {
    const date = m.started_at ? String(m.started_at).slice(0, 10) : "?";
    const facts = Array.isArray(m.facts) ? m.facts.join("; ") : "";
    ctx.push(`[C${m.conversation_id}] (${date}) ${m.title}: ${m.summary} Facts: ${facts}`);
  }
  if (periodActions.length) {
    ctx.push("\n# Action items from meetings in that period");
    for (const a of periodActions) ctx.push(`[C${a.source_conversation}] ${a.status === "done" ? "(done) " : ""}${a.owner ? `${a.owner}: ` : ""}${a.text}${a.due ? ` (due ${a.due})` : ""}`);
  }
  if (related.length) {
    ctx.push("\n# Related meetings (linked through the knowledge graph; may be from other projects)");
    for (const m of related) {
      const date = m.started_at ? String(m.started_at).slice(0, 10) : "?";
      const where = m.project_id == null ? "" : project && m.project_id === project.id ? " [this project]" : ` [project: ${m.project_name || "Untitled project"}]`;
      ctx.push(`[C${m.conversation_id}] (${date})${where} ${m.title}: ${m.summary}`);
    }
  }
  if (quoted.length) {
    ctx.push("\n# Meetings the lines below come from");
    for (const m of quoted) ctx.push(`[C${m.conversation_id}] (${m.started_at ? String(m.started_at).slice(0, 10) : "?"}) ${m.title}: ${m.summary}`);
  }
  if (quotes.length) {
    const at = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    ctx.push("\n# What was said (transcript lines matching the question)");
    for (const t of quotes) ctx.push(`[C${t.conversation_id}] (${at(Number(t.start_ts) || 0)}) ${speakerName(t)}: ${String(t.text).trim().slice(0, 400)}`);
  }
  if (sub.nodes.length) {
    const name: Record<number, string> = {};
    sub.nodes.forEach((n: any) => (name[n.id] = n.canonical_name));
    ctx.push("\n# Knowledge graph");
    for (const e of sub.edges as any[]) ctx.push(`${name[e.src] ?? "?"} --${e.relation}--> ${name[e.dst] ?? "?"}`);
  }
  const body = memories.length || related.length || quotes.length || sub.nodes.length ? ctx.join("\n") : "(no memories found)";
  const projectBlock = project
    ? `# Project: ${project.name || "Untitled project"}\n${project.context_enabled !== false && project.brief ? `<project_brief>\n${project.brief}\n</project_brief>\n` : ""}The user is asking about this project.\n`
    : "";
  const context = projectBlock + (priorsBlock ? priorsBlock + "\n" + body : body);
  const hist = history.slice(-6).map((h) => `${h.role}: ${h.content}`).join("\n");
  const user = (hist ? `Conversation so far:\n${hist}\n\n` : "") + `Context:\n${context}\n\nUser question: ${message}`;

  const scope = project ? await askScopeForProject(project.id).catch(() => null) : null;
  const data = await provider.chat(ANSWER_SCHEMA, CHAT_SYSTEM, user, scope);
  const cited = new Set<number>(data.citation_conversation_ids ?? []);
  const cite = (m: any) => ({ conversation_id: m.conversation_id, title: m.title, date: m.started_at ? String(m.started_at).slice(0, 10) : null });
  let citations: any[] = [];
  if (data.supported) {
    const matched = [...memories, ...related, ...quoted].filter((m) => cited.has(m.conversation_id));
    const src = matched;
    const seen = new Set<number>();
    citations = src.filter((m) => (seen.has(m.conversation_id) ? false : (seen.add(m.conversation_id), true))).map(cite);
  }
  return { answer: data.answer ?? "", supported: !!data.supported, citations, project: project ? { id: project.id, name: project.name } : null,
           retrieved: memories.map((m) => ({ conversation_id: m.conversation_id, title: m.title, score: m.score })) };
}
