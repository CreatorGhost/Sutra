import type { Provider, Transcription, TranscribeOpts, RefineOpts } from "./provider";
import { readToken } from "../lib/auth";

/** Fired when the proxy rejects our token (expired account session). App listens and shows the
 *  sign-in gate — deferred while a capture is live so a recording is never interrupted. */
export const AUTH_EXPIRED_EVENT = "sutra:auth-expired";

/** Strips a single leaked ordinal prefix ("1. ", "2. ", "12. " …) that the model sometimes echoes back
 *  from our numbered prompt. ANCHORED at start; REQUIRES the trailing space, so decimals/versions like
 *  "1.5 million" or "v2.0" are never touched. One occurrence only — a real "3. step" further in stays. */
const ORDINAL_PREFIX = /^\s*\d{1,3}\.\s+/;
const stripOrdinal = (s: string): string => s.replace(ORDINAL_PREFIX, "");
/** Any Devanagari codepoint — used to detect untranslated Hindi leaking through English mode. */
const DEVANAGARI = /[ऀ-ॿ]/;

/** Calls the thin stateless intelligence proxy (holds OUR key server-side). Audio only hits /transcribe,
 *  in-flight, never stored. Everything else is text. */
export class CloudProvider implements Provider {
  readonly id = "cloud";
  // Optional shared secret. When VITE_PROXY_SECRET is set (hosted/LAN proxy), every request carries
  // X-Sutra-Secret; when unset (USB/dev), nothing is added so behavior is unchanged. During the
  // account transition we send BOTH the secret and the per-user Bearer token (plan §6.2).
  private readonly secret: string | undefined = import.meta.env.VITE_PROXY_SECRET || undefined;
  constructor(private base: string) {}

  /** fetch with a hard timeout — a flaky/hung proxy must not freeze the pipeline indefinitely.
   *  Injects auth on EVERY call: the per-user Bearer JWT (when signed in) + the optional legacy
   *  X-Sutra-Secret. Maps the proxy's machine-readable 401/402 bodies to app behavior. */
  private async fetchT(path: string, init: RequestInit, ms: number): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (this.secret) headers["X-Sutra-Secret"] = this.secret;
    const token = readToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let r: Response;
    try {
      r = await fetch(this.base + path, { ...init, headers, signal: ctrl.signal });
    } catch (e: any) {
      if (e?.name === "AbortError") throw new Error(`proxy ${path} timed out after ${Math.round(ms / 1000)}s — check your connection`);
      throw new Error(`proxy ${path} unreachable: ${e?.message ?? e}`);
    } finally {
      clearTimeout(t);
    }
    if (r.status === 401 || r.status === 402) {
      // The new proxy returns {"detail": {"code": ...}}. A legacy proxy's plain-string 401 is left
      // alone so a mere secret mismatch never signs the user out.
      let code = "", resets = "";
      try {
        const j: any = await r.clone().json();
        const d = j?.detail ?? j;
        code = typeof d?.code === "string" ? d.code : "";
        resets = typeof d?.resets_at === "string" ? d.resets_at : "";
      } catch { /* non-JSON body */ }
      if (r.status === 401 && (code === "token_expired" || code === "unauthorized")) {
        try { window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT)); } catch { /* non-DOM env */ }
        throw new Error("Your session expired — sign in again to continue. Nothing was lost; this recording is saved and will be processed after you sign in.");
      }
      if (r.status === 402 && code === "quota_exceeded") {
        const when = resets ? ` It resets on ${new Date(resets).toLocaleDateString()}.` : "";
        throw new Error(`Monthly limit reached.${when} Your memory is safe — processing resumes then.`);
      }
    }
    return r;
  }

  private async json<T>(path: string, body: unknown, ms = 180000): Promise<T> {
    const r = await this.fetchT(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, ms);
    if (!r.ok) throw new Error(`proxy ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  }

  async transcribeDiarize(audio: Blob, filename: string, opts?: TranscribeOpts): Promise<Transcription> {
    const fd = new FormData();
    fd.append("file", audio, filename);
    // Send the per-language prompt even when empty ("" = Verbatim, transcribe as-spoken). Only omit
    // it entirely if undefined, in which case the proxy falls back to its server default.
    if (opts?.prompt != null) fd.append("prompt", opts.prompt);
    // Hybrid speaker-ID: ask the proxy to also compute per-turn ECAPA voiceprints from the same
    // in-flight audio (vectors only; audio is never stored). Off unless the caller opts in.
    if (opts?.voiceprints) fd.append("voiceprints", "true");
    // Generous timeout: transcription + diarization + per-turn ECAPA can take a while (incl. first-call
    // model load), but not forever — a dead proxy must surface as an error, not a permanent hang.
    const r = await this.fetchT("/transcribe", { method: "POST", body: fd }, 180000);
    if (!r.ok) throw new Error(`proxy /transcribe ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  extract(jsonSchema: object, system: string, user: string) {
    return this.json<any>("/extract", { json_schema: jsonSchema, system, user });
  }
  // One /extract round-trip for a batch of lines to translate. The user message is a numbered list so
  // the model can't lose alignment; we strip any echoed ordinal back off each returned line below. Returns
  // a sparse array aligned to texts (missing/empty slots left undefined for the caller to fall back).
  private async translateBatch(texts: string[]): Promise<(string | undefined)[]> {
    const jsonSchema = {
      name: "translation_lines",
      strict: true,
      schema: {
        type: "object",
        properties: { translations: { type: "array", items: { type: "string" } } },
        required: ["translations"],
        additionalProperties: false,
      },
    };
    const system =
      "Translate each input line to natural English. Keep proper nouns and names verbatim. " +
      "Return exactly one translation per input, in the same order. Do not merge or split lines. " +
      "Do not prefix lines with numbers. Output MUST be entirely Latin script: romanize or translate " +
      "any Devanagari/Hindi, and keep proper nouns as spoken (romanized).";
    const user = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const out = await this.json<{ translations?: string[] }>("/extract", {
      json_schema: jsonSchema,
      system,
      user,
    });
    const translations = Array.isArray(out?.translations) ? out.translations : [];
    return texts.map((_, i) => {
      const t = translations[i];
      // Strip any leaked "N. " ordinal the model echoed from our numbered prompt, then re-check non-empty
      // so a line that was ONLY an ordinal can never collapse to "" and silently drop content.
      if (typeof t !== "string") return undefined;
      const s = stripOrdinal(t);
      return s.trim() ? s : undefined;
    });
  }

  // English mode's real translation pass — reuses the structured text channel (/extract). Strict schema
  // forces a 1:1 array so lines can't merge/split; we strip any leaked ordinal, retry once (batched) for
  // any line that still came back in Devanagari, then HONESTLY fall back to the original input for any
  // missing/empty/still-untranslated line. English mode is best-effort-English with a raw fallback —
  // never store a number-prefixed or half-translated string.
  async translate(texts: string[]): Promise<string[]> {
    if (texts.length === 0) return [];
    const first = await this.translateBatch(texts);
    // Collect indices whose translation still leaks Devanagari and retry them in ONE batched call.
    const retryIdx = first
      .map((t, i) => (typeof t === "string" && DEVANAGARI.test(t) ? i : -1))
      .filter((i) => i >= 0);
    if (retryIdx.length) {
      try {
        const retry = await this.translateBatch(retryIdx.map((i) => texts[i]));
        retryIdx.forEach((i, k) => {
          const r = retry[k];
          // Only accept the retry if it's clean Latin; otherwise leave first[i] for the degrade below.
          if (typeof r === "string" && !DEVANAGARI.test(r)) first[i] = r;
        });
      } catch { /* retry failed — degrade to raw fallback below */ }
    }
    return texts.map((orig, i) => {
      const t = first[i];
      // Degrade to the original line if missing/empty OR still Devanagari after retry — we never store a
      // half-translated string in English mode; raw text stays readable and recoverable.
      return typeof t === "string" && t.trim() && !DEVANAGARI.test(t) ? t : orig;
    });
  }
  // Conservative transcript cleanup — reuses the structured text channel (/extract), same 1:1 array
  // discipline as translate(). The model is a minimal-edit corrector, NOT an author: it only fixes
  // clear ASR mishearings, strips pure noise, and normalizes a term that's heard inconsistently to its
  // single correct form, using neighbouring lines as context. We pad/truncate to texts.length and fall
  // back to the original input for any missing/empty line, so cleanup can never lose content.
  async refine(texts: string[], opts?: RefineOpts): Promise<string[]> {
    if (texts.length === 0) return [];
    const jsonSchema = {
      name: "cleanup_lines",
      strict: true,
      schema: {
        type: "object",
        properties: { lines: { type: "array", items: { type: "string" } } },
        required: ["lines"],
        additionalProperties: false,
      },
    };
    // Optional, user-authored project context. The glossary enables Whisper-style spelling correction ONLY
    // (never a meaning rewrite); the brief is delimited background guarded by the untrusted-transcript role
    // constraint. Both are SEPARATE from the numbered transcript below — they never relax the 1:1, never-
    // empty, ordinal-strip, or Devanagari invariants enforced on the returned lines.
    const ctx: string[] = [];
    if (opts?.roleConstraint) ctx.push(opts.roleConstraint);
    if (opts?.glossary) {
      ctx.push(
        opts.glossary +
          " Apply this ONLY to correct a name/term to its canonical form: fix its spelling, or replace a " +
          "listed mis-hearing with the correct term; do not otherwise change wording or meaning.",
      );
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
    const user = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
    const out = await this.json<{ lines?: string[] }>("/extract", {
      json_schema: jsonSchema,
      system,
      user,
    });
    const lines = Array.isArray(out?.lines) ? out.lines : [];
    return texts.map((orig, i) => {
      const c = lines[i];
      // Strip any leaked "N. " ordinal echoed from our numbered prompt, then re-check non-empty so an
      // ordinal-only line falls back to the original instead of collapsing to "".
      if (typeof c !== "string") return orig;
      const s = stripOrdinal(c);
      return s.trim() ? s : orig;
    });
  }
  embed(texts: string[]) {
    return this.json<{ embeddings: number[][] }>("/embed", { texts }).then((d) => (Array.isArray(d?.embeddings) ? d.embeddings : []));
  }
  rerank(query: string, docs: string[]) {
    return this.json<{ scores: number[] }>("/rerank", { query, docs }).then((d) => d.scores);
  }
  chat(jsonSchema: object, system: string, user: string) {
    return this.json<any>("/chat", { json_schema: jsonSchema, system, user });
  }
}
