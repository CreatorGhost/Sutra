import type { Provider } from "../providers/provider";
import { ANSWER_SCHEMA, CHAT_SYSTEM } from "./aiPrompts";
import { expand, nearestEntities } from "./graph";
import { getSettings, topPriors } from "./repo";
import { searchMemories } from "./search";

export async function chat(message: string, provider: Provider, history: { role: string; content: string }[] = []) {
  message = (message || "").trim();
  if (!message) return { answer: "Please ask a question.", supported: false, citations: [], retrieved: [] };
  const memories = await searchMemories(message, provider, 8) as any[];
  const [qvec] = await provider.embed([message]);
  const seeds = await nearestEntities(qvec, 5);
  const sub = await expand(seeds, 2, 40);

  // "Your Context": the user's standing priors (people/projects/role) — beliefs, NON-CITABLE, may be
  // stale. Gated on the context_enabled master toggle; in cloud mode only share_cloud=1 priors ride
  // along. Prepended BEFORE the memories so the model uses it only to resolve who/what the user means.
  const settings = await getSettings();
  const contextEnabled = settings["context_enabled"] !== false;
  const cloudMode = provider.id === "cloud";
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
  if (sub.nodes.length) {
    const name: Record<number, string> = {};
    sub.nodes.forEach((n: any) => (name[n.id] = n.canonical_name));
    ctx.push("\n# Knowledge graph");
    for (const e of sub.edges as any[]) ctx.push(`${name[e.src] ?? "?"} --${e.relation}--> ${name[e.dst] ?? "?"}`);
  }
  const body = memories.length || sub.nodes.length ? ctx.join("\n") : "(no memories found)";
  const context = priorsBlock ? priorsBlock + "\n" + body : body;
  const hist = history.slice(-6).map((h) => `${h.role}: ${h.content}`).join("\n");
  const user = (hist ? `Conversation so far:\n${hist}\n\n` : "") + `Context:\n${context}\n\nUser question: ${message}`;

  const data = await provider.chat(ANSWER_SCHEMA, CHAT_SYSTEM, user);
  const cited = new Set<number>(data.citation_conversation_ids ?? []);
  const cite = (m: any) => ({ conversation_id: m.conversation_id, title: m.title, date: m.started_at ? String(m.started_at).slice(0, 10) : null });
  let citations: any[] = [];
  if (data.supported) {
    const matched = memories.filter((m) => cited.has(m.conversation_id));
    const src = matched;
    const seen = new Set<number>();
    citations = src.filter((m) => (seen.has(m.conversation_id) ? false : (seen.add(m.conversation_id), true))).map(cite);
  }
  return { answer: data.answer ?? "", supported: !!data.supported, citations,
           retrieved: memories.map((m) => ({ conversation_id: m.conversation_id, title: m.title, score: m.score })) };
}
