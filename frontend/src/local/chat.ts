import type { Provider } from "../providers/provider";
import { isFullTextEngine } from "../providers";
import { ANSWER_SCHEMA, CHAT_SYSTEM } from "./aiPrompts";
import { expand, nearestEntities, relatedConversations } from "./graph";
import { askScopeForProject, getProject, getSettings, memoryCardsForConversations, projectConversationIds, topPriors } from "./repo";
import { searchMemories } from "./search";

/** `projectId`: Ask about one project — only its meetings, its brief, and (desktop, code access on) its
 *  linked code folders, which the agent may read. */
export async function chat(message: string, provider: Provider, history: { role: string; content: string }[] = [], projectId: number | null = null) {
  message = (message || "").trim();
  if (!message) return { answer: "Please ask a question.", supported: false, citations: [], retrieved: [] };
  const project = projectId != null ? await getProject(projectId).catch(() => null) as any : null;
  let memories = await searchMemories(message, provider, project ? 24 : 8) as any[];
  if (project) {
    const ids = new Set(await projectConversationIds(project.id));
    memories = memories.filter((m) => ids.has(m.conversation_id)).slice(0, 8);
  }
  let seeds: number[] = [];
  if (provider.canEmbed !== false) {
    try { const [qvec] = await provider.embed([message]); seeds = await nearestEntities(qvec, 5, 0.25); } catch { /* keyword-only */ }
  }
  const sub = await expand(seeds, 2, 40);
  // Meetings the graph links to the question that search didn't surface — including other projects'
  // ("you worked on something like this in X"). They're context and citable, like the search hits.
  const relatedIds = relatedConversations(sub.edges as any[], seeds, new Set(memories.map((m) => m.conversation_id)), project ? 3 : 4);
  const related = (await memoryCardsForConversations(relatedIds).catch(() => []) as any[])
    .sort((a, b) => relatedIds.indexOf(a.conversation_id) - relatedIds.indexOf(b.conversation_id));

  // "Your Context": the user's standing priors (people/projects/role) — beliefs, NON-CITABLE, may be
  // stale. Gated on the context_enabled master toggle; in cloud mode only share_cloud=1 priors ride
  // along. Prepended BEFORE the memories so the model uses it only to resolve who/what the user means.
  const settings = await getSettings();
  const contextEnabled = settings["context_enabled"] !== false;
  // An agent engine sends the prompt off this device too (to the agent's vendor), so it gets the same
  // share_cloud filter as the Sutra cloud.
  const cloudMode = isFullTextEngine(provider);
  let priorsBlock = "";
  if (contextEnabled) {
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
  if (related.length) {
    ctx.push("\n# Related meetings (linked through the knowledge graph; may be from other projects)");
    for (const m of related) {
      const date = m.started_at ? String(m.started_at).slice(0, 10) : "?";
      const where = m.project_id == null ? "" : project && m.project_id === project.id ? " [this project]" : ` [project: ${m.project_name || "Untitled project"}]`;
      ctx.push(`[C${m.conversation_id}] (${date})${where} ${m.title}: ${m.summary}`);
    }
  }
  if (sub.nodes.length) {
    const name: Record<number, string> = {};
    sub.nodes.forEach((n: any) => (name[n.id] = n.canonical_name));
    ctx.push("\n# Knowledge graph");
    for (const e of sub.edges as any[]) ctx.push(`${name[e.src] ?? "?"} --${e.relation}--> ${name[e.dst] ?? "?"}`);
  }
  const body = memories.length || related.length || sub.nodes.length ? ctx.join("\n") : "(no memories found)";
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
    const matched = [...memories, ...related].filter((m) => cited.has(m.conversation_id));
    const src = matched;
    const seen = new Set<number>();
    citations = src.filter((m) => (seen.has(m.conversation_id) ? false : (seen.add(m.conversation_id), true))).map(cite);
  }
  return { answer: data.answer ?? "", supported: !!data.supported, citations,
           retrieved: memories.map((m) => ({ conversation_id: m.conversation_id, title: m.title, score: m.score })) };
}
