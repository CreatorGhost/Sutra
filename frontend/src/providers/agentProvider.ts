// Text engine backed by the user's own AI agent CLI (Claude Code, Codex, Cursor, Gemini CLI, Grok, Droid,
// Command Code) through the Electron bridge. Transcripts and notes go to the agent you're signed into;
// nothing goes to the Sutra service. Agents can't produce embeddings or rerank, so search runs on
// keywords with this engine (callers already fall back when embed/rerank throw).
import type { AskScope, ExtractOpts, Provider, RefineOpts, Transcription } from "./provider";
import { AGENTS, type AgentId } from "../shared/agentProtocol";
import { desktop } from "../desktop/bridge";

export const NO_ENGINE_MESSAGE =
  "No AI engine is connected. Connect an AI engine in Settings → Intelligence (Claude Code, Codex, Cursor, Gemini, Grok, Droid or Command Code), then retry.";

/** An engine that's out of quota / rate-limited / overloaded: worth retrying on another signed-in engine. */
export const OUT_OF_QUOTA = /usage limit|rate[ _-]?limit|quota|\b429\b|resource[_ ]exhausted|too many requests|credit balance|out of credits|limit reached|overloaded/i;

const inner = (s: any) => (s && typeof s === "object" && "schema" in s ? s.schema : s);

/** Same 1:1 line discipline as the cloud engine: strip a single echoed "N. " ordinal (never "1.5"). */
const ORDINAL_PREFIX = /^\s*\d{1,3}\.\s+/;
const stripOrdinal = (s: string) => s.replace(ORDINAL_PREFIX, "");
const DEVANAGARI = /[ऀ-ॿ]/;
const LINES_SCHEMA = (key: string) => ({ type: "object", properties: { [key]: { type: "array", items: { type: "string" } } }, required: [key], additionalProperties: false });
const numbered = (texts: string[]) => texts.map((t, i) => `${i + 1}. ${t}`).join("\n");

export class AgentProvider implements Provider {
  readonly id: string;
  readonly canEmbed = false;
  /** `agent` null = automatic: the first installed, signed-in engine. `modelFor` reads ai_model_<id>. */
  constructor(private readonly agent: AgentId | null, private readonly modelFor: (id: AgentId) => string | null) {
    this.id = `agent:${agent ?? "auto"}`;
  }

  private async engine(): Promise<AgentId> {
    if (!desktop) throw new Error("AI engines run in the Sutra desktop app.");
    if (this.agent) return this.agent;
    const found = await desktop.ai.detect().catch(() => []);
    const pick = found.find((s) => s.installed && s.signedIn === true) ?? found.find((s) => s.installed && s.signedIn !== false);
    if (!pick) throw new Error(NO_ENGINE_MESSAGE);
    return pick.id;
  }

  /** The engine that answered last (differs from the chosen one after a fallback). */
  lastEngine: AgentId | null = null;

  private async json(schema: object, system: string, user: string, workspace?: string[], images?: ExtractOpts["images"]): Promise<any> {
    const run = async (id: AgentId) => {
      const r = await desktop!.ai.run(id, { system, user, schema: inner(schema), model: this.modelFor(id), ...(workspace?.length ? { workspace } : {}), ...(images?.frames.length ? { images } : {}) });
      this.lastEngine = id;
      return r.json;
    };
    const first = await this.engine();
    try { return await run(first); }
    catch (e: any) {
      if (!OUT_OF_QUOTA.test(String(e?.message ?? e))) throw e;
      // Out of quota: the same job on each other engine the user explicitly enabled in Settings →
      // Intelligence (their consent to send it there), signed in, and able to see screenshots if any —
      // with that engine's chosen model. Never chosen a list = no fallback.
      // ponytail: tried in Settings order, no memory of which one is out.
      const allowed = (await desktop!.prefs.get().catch(() => null))?.enabledEngines;
      if (!allowed?.length) throw e;
      const others = (await desktop!.ai.detect().catch(() => []))
        .filter((st) => st.id !== first && allowed.includes(st.id) && st.installed && st.signedIn === true && (!images?.frames.length || AGENTS[st.id]?.vision));
      for (const st of others) {
        try {
          const out = await run(st.id);
          console.warn(`${AGENTS[first]?.label ?? first} is out of quota — used ${AGENTS[st.id]?.label ?? st.id} instead.`);
          return out;
        } catch (e2: any) { if (!OUT_OF_QUOTA.test(String(e2?.message ?? e2))) console.warn("fallback engine failed", st.id, e2); }
      }
      throw e;
    }
  }

  async transcribeDiarize(): Promise<Transcription> { throw new Error("AI engines don't transcribe audio."); }
  extract(schema: object, system: string, user: string, opts?: ExtractOpts) { return this.json(schema, system, user, undefined, opts?.images); }
  /** The engine Sutra would use now (to know if it can look at screenshots). */
  async engineId(): Promise<AgentId> { return this.engine(); }
  /** Ask about a project: the agent may read its folders (read-only); main re-checks each one. */
  chat(schema: object, system: string, user: string, scope?: AskScope | null) { return this.json(schema, system, user, scope?.folders); }

  private async translateBatch(texts: string[]): Promise<(string | undefined)[]> {
    const out = await this.json(LINES_SCHEMA("translations"),
      "Translate each input line to natural English. Keep proper nouns and names verbatim. " +
      "Return exactly one translation per input, in the same order. Do not merge or split lines. " +
      "Do not prefix lines with numbers. Output MUST be entirely Latin script: romanize or translate " +
      "any Devanagari/Hindi, and keep proper nouns as spoken (romanized).",
      numbered(texts));
    const tr: unknown[] = Array.isArray(out?.translations) ? out.translations : [];
    return texts.map((_, i) => {
      const t = tr[i];
      if (typeof t !== "string") return undefined;
      const s = stripOrdinal(t);
      return s.trim() ? s : undefined;
    });
  }

  // English mode's translation pass, as in CloudProvider: retry Devanagari leftovers once in one batch,
  // then fall back to the original line for anything missing/empty/still untranslated.
  async translate(texts: string[]): Promise<string[]> {
    if (!texts.length) return [];
    const first = await this.translateBatch(texts);
    const retryIdx = first.map((t, i) => (typeof t === "string" && DEVANAGARI.test(t) ? i : -1)).filter((i) => i >= 0);
    if (retryIdx.length) {
      try {
        const retry = await this.translateBatch(retryIdx.map((i) => texts[i]));
        retryIdx.forEach((i, k) => { const r = retry[k]; if (typeof r === "string" && !DEVANAGARI.test(r)) first[i] = r; });
      } catch { /* degrade to the raw line below */ }
    }
    return texts.map((orig, i) => { const t = first[i]; return typeof t === "string" && t.trim() && !DEVANAGARI.test(t) ? t : orig; });
  }

  // Conservative transcript cleanup — the same prompt and 1:1 guarantees as CloudProvider.refine: a
  // minimal-edit corrector, optional project glossary (spelling only) and delimited brief, padded back to
  // texts.length with the original line for anything missing, so cleanup can never lose content.
  async refine(texts: string[], opts?: RefineOpts): Promise<string[]> {
    if (!texts.length) return [];
    const ctx: string[] = [];
    if (opts?.roleConstraint) ctx.push(opts.roleConstraint);
    if (opts?.glossary) {
      ctx.push(opts.glossary +
        " Apply this ONLY to correct a name/term to its canonical form: fix its spelling, or replace a " +
        "listed mis-hearing with the correct term; do not otherwise change wording or meaning.");
    }
    if (opts?.brief) ctx.push(`<project_brief>\n${opts.brief}\n</project_brief>`);
    const system =
      "You are a transcript-cleanup function for a memory app. Return a cleaned version of EACH input line, " +
      "exactly one per input, same order. You are a corrector NOT an author: NEVER add/summarize/rephrase; " +
      "never change meaning, negation, numbers, names, or product names; if a line is already clean or you " +
      "are unsure, return it unchanged. Fix only clear ASR mishearings and remove pure noise, using the other " +
      "lines as context. Normalize a term that appears inconsistently to the single correct form the " +
      "conversation is about (e.g. a filename heard as 'dot M_V_ file' / '.md5' / 'MD5' / '.mdfi' should " +
      "become '.md'). " +
      (opts?.mode === "english"
        ? "Output natural English with NO Devanagari; translate any Hindi faithfully, keeping names verbatim."
        : "Do NOT translate; keep the original language/script, only de-noise.") +
      (ctx.length ? "\n\n" + ctx.join("\n\n") : "");
    const out = await this.json(LINES_SCHEMA("lines"), system, numbered(texts));
    const lines: unknown[] = Array.isArray(out?.lines) ? out.lines : [];
    return texts.map((orig, i) => {
      const c = lines[i];
      if (typeof c !== "string") return orig;
      const s = stripOrdinal(c);
      return s.trim() ? s : orig;
    });
  }

  async embed(): Promise<number[][]> { throw new Error("Embeddings aren't available with an AI agent engine."); }
  async rerank(): Promise<number[]> { throw new Error("Reranking isn't available with an AI agent engine."); }
}

