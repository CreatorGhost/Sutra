// Messages between the main process (speech/service.ts) and the speech utility process (speech/worker.ts).
import type { ModelFiles, SherpaFamily, Span } from "../../src/shared/speechAlign";

export interface AsrConfig {
  /** Cache key: a recognizer is rebuilt only when this changes. */
  key: string;
  family: Exclude<SherpaFamily, "speakers">;
  files: ModelFiles;
  whisperLanguage: string;
  whisperTask: "transcribe" | "translate";
}

export interface TranscribeJob {
  wav: ArrayBuffer;
  /** null → the text came from elsewhere (whisper.cpp); only separate speakers for `segments`. */
  asr: AsrConfig | null;
  /** Pre-transcribed segments when `asr` is null. */
  segments?: (Span & { text: string })[];
  speakers: ModelFiles;
  /** Diarize + voiceprints (off for the owner's own mic channel). */
  separate: boolean;
  threads: number;
}

export interface WorkerSegment { start: number; end: number; text: string; speaker: number | null; embedding: number[] | null }
export interface TranscribeResult { duration: number; segments: WorkerSegment[] }

export type WorkerRequest =
  | { id: number; type: "transcribe"; job: TranscribeJob }
  | { id: number; type: "extract"; archive: string; dest: string }
  | { id: number; type: "list"; root: string };

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
