// Text engine backed by a local AI agent CLI (Claude Code / Codex / Cursor Agent) through the Electron
// bridge. Transcripts and notes go to the agent you're signed into; nothing goes to the Sutra service.
// Agents can't produce embeddings, so search runs on keywords only with this engine.
import type { Provider, Transcription } from "./provider";
import type { AgentId } from "../shared/agentProtocol";
import { desktop } from "../desktop/bridge";

const inner = (s: any) => (s && typeof s === "object" && "schema" in s ? s.schema : s);

export class AgentProvider implements Provider {
  readonly id: string;
  readonly canEmbed = false;
  constructor(private readonly agent: AgentId, private readonly model: string | null) {
    this.id = `agent:${agent}`;
  }

  private async json(schema: object, system: string, user: string): Promise<any> {
    if (!desktop) throw new Error("Local agents are only available in the desktop app.");
    const r = await desktop.ai.run(this.agent, { system, user, schema: inner(schema), model: this.model });
    return r.json;
  }

  async transcribeDiarize(): Promise<Transcription> { throw new Error("Agents don't transcribe audio."); }
  extract(schema: object, system: string, user: string) { return this.json(schema, system, user); }
  chat(schema: object, system: string, user: string) { return this.json(schema, system, user); }

  async translate(texts: string[]): Promise<string[]> {
    if (!texts.length) return [];
    const schema = { type: "object", properties: { translations: { type: "array", items: { type: "string" } } }, required: ["translations"], additionalProperties: false };
    const out = await this.json(schema, "Translate each numbered line to natural English, keeping names verbatim. Return exactly one translation per line, same order, without numbers.",
      texts.map((t, i) => `${i + 1}. ${t}`).join("\n"));
    const tr: unknown[] = Array.isArray(out?.translations) ? out.translations : [];
    return texts.map((t, i) => (typeof tr[i] === "string" && (tr[i] as string).trim() ? (tr[i] as string) : t));
  }
  async refine(texts: string[]): Promise<string[]> { return texts; }
  async embed(): Promise<number[][]> { throw new Error("embeddings unavailable with a local agent"); }
  async rerank(): Promise<number[]> { throw new Error("rerank unavailable with a local agent"); }
}
