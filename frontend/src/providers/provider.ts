// TS mirror of backend/app/providers/base.py — the seam between cloud (default) and on-device (later).
// `embedding` is a per-turn ECAPA voiceprint (192-d) the proxy computes from the SAME in-flight audio
// when voiceprints are requested (hybrid speaker-ID); audio is never persisted, only the vector returns.
// `channel`/`is_me` are set only by multichannel (online-meeting) capture: channel 0 / is_me=true is the
// device owner ("Me"), channel 1 is the remotes (see docs/MEETING-CAPTURE-SPEC.md). Absent on single-channel
// (ambient) capture, where attribution falls through to the diarizer `speaker` unchanged. F4 uses these.
export interface DiarizedSegment { speaker: string; start: number; end: number; text: string; embedding?: number[] | null; channel?: number; is_me?: boolean; }
export interface Transcription { text: string; duration: number; segments: DiarizedSegment[]; }

/** Per-language transcription options (from the user's transcript_lang choice → LANGS). `prompt`
 *  primes the ASR for the chosen script/language; `""` means "no prompt" (Verbatim, no normalization).
 *  `translate` selects English mode, which runs a real text→text translation pass (Provider.translate)
 *  after transcription. `voiceprints` asks the proxy for per-turn ECAPA embeddings (hybrid-only speaker-ID). */
export interface TranscribeOpts { prompt?: string; translate?: boolean; voiceprints?: boolean; multichannel?: boolean; language?: string }

/** Cleanup options. `mode` picks English-translate vs keep-script. The optional project-context fields are
 *  user-authored grounding: `glossary` is a canonical-spelling line (spelling correction ONLY) and `brief`/
 *  `roleConstraint` are delimited, untrusted-transcript-guarded background. All optional — absent = today. */
export interface RefineOpts { mode?: string; glossary?: string; brief?: string; roleConstraint?: string }

export interface Provider {
  /** Diarized STT. The ONLY method that ever receives audio. Audio is in-flight only, never persisted. */
  transcribeDiarize(audio: Blob, filename: string, opts?: TranscribeOpts): Promise<Transcription>;
  /** Structured extraction against a strict JSON schema. Text only. */
  extract(jsonSchema: object, system: string, user: string): Promise<any>;
  /** Text→text translation to English (English mode). 1:1 by index; returns English translations,
   *  proper nouns/names kept verbatim. Text only. */
  translate(texts: string[]): Promise<string[]>;
  /** Conservative transcript cleanup. 1:1 by index; fixes clear ASR mishearings, removes pure noise,
   *  and normalizes inconsistently-heard terms to one correct form — never adds/rephrases/changes meaning.
   *  English mode (opts.mode==='english') translates leftover Hindi; otherwise keeps the original script.
   *  `glossary`/`brief` are optional, user-authored project context: the glossary is a canonical-spelling
   *  line (enables spelling correction ONLY, never a meaning rewrite); the brief is delimited background.
   *  Text only. */
  refine(texts: string[], opts?: RefineOpts): Promise<string[]>;
  /** Text embeddings. Text only. */
  embed(texts: string[]): Promise<number[][]>;
  /** Cross-encoder / LLM relevance scores in [0,1]. Text only. */
  rerank(query: string, docs: string[]): Promise<number[]>;
  /** Grounded chat answer against a strict JSON schema. Text only. */
  chat(jsonSchema: object, system: string, user: string): Promise<any>;
  readonly id: string;
  /** Which engine transcribes, when it differs from `id` ("cloud" | "local"). Voiceprints and the
   *  English translate pass only exist on the cloud path. */
  readonly sttId?: string;
  /** False when this engine can't embed text (local agents): search falls back to keywords only. */
  readonly canEmbed?: boolean;
}
