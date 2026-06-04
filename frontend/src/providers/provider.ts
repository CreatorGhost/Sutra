// TS mirror of backend/app/providers/base.py — the seam between cloud (default) and on-device (later).
// `embedding` is a per-turn ECAPA voiceprint (192-d) the proxy computes from the SAME in-flight audio
// when voiceprints are requested (hybrid speaker-ID); audio is never persisted, only the vector returns.
export interface DiarizedSegment { speaker: string; start: number; end: number; text: string; embedding?: number[] | null; }
export interface Transcription { text: string; duration: number; segments: DiarizedSegment[]; }

/** Per-language transcription options (from the user's transcript_lang choice → LANGS). `prompt`
 *  primes the ASR for the chosen script/language; `""` means "no prompt" (Verbatim, no normalization).
 *  `translate` is informational (English mode translates via its prompt today). `voiceprints` asks the
 *  proxy for per-turn ECAPA embeddings (hybrid-only speaker-ID). */
export interface TranscribeOpts { prompt?: string; translate?: boolean; voiceprints?: boolean }

export interface Provider {
  /** Diarized STT. The ONLY method that ever receives audio. Audio is in-flight only, never persisted. */
  transcribeDiarize(audio: Blob, filename: string, opts?: TranscribeOpts): Promise<Transcription>;
  /** Structured extraction against a strict JSON schema. Text only. */
  extract(jsonSchema: object, system: string, user: string): Promise<any>;
  /** Text embeddings. Text only. */
  embed(texts: string[]): Promise<number[][]>;
  /** Cross-encoder / LLM relevance scores in [0,1]. Text only. */
  rerank(query: string, docs: string[]): Promise<number[]>;
  /** Grounded chat answer against a strict JSON schema. Text only. */
  chat(jsonSchema: object, system: string, user: string): Promise<any>;
  readonly id: string;
}
