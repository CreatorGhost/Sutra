import type { Provider, Transcription, TranscribeOpts } from "./provider";

/** Calls the thin stateless intelligence proxy (holds OUR key server-side). Audio only hits /transcribe,
 *  in-flight, never stored. Everything else is text. */
export class CloudProvider implements Provider {
  readonly id = "cloud";
  constructor(private base: string) {}

  /** fetch with a hard timeout — a flaky/hung proxy must not freeze the pipeline indefinitely. */
  private async fetchT(path: string, init: RequestInit, ms: number): Promise<Response> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(this.base + path, { ...init, signal: ctrl.signal });
    } catch (e: any) {
      if (e?.name === "AbortError") throw new Error(`proxy ${path} timed out after ${Math.round(ms / 1000)}s — check your connection`);
      throw new Error(`proxy ${path} unreachable: ${e?.message ?? e}`);
    } finally {
      clearTimeout(t);
    }
  }

  private async json<T>(path: string, body: unknown, ms = 60000): Promise<T> {
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
  embed(texts: string[]) {
    return this.json<{ embeddings: number[][] }>("/embed", { texts }).then((d) => d.embeddings);
  }
  rerank(query: string, docs: string[]) {
    return this.json<{ scores: number[] }>("/rerank", { query, docs }).then((d) => d.scores);
  }
  chat(jsonSchema: object, system: string, user: string) {
    return this.json<any>("/chat", { json_schema: jsonSchema, system, user });
  }
}
