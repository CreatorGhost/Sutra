// The on-device speech pipeline, run inside the speech utility process (worker.ts wires it to the
// main process; kept separate so it can be exercised from plain Node — see __tests__/pipeline.test.ts).
//
// Per window: VAD cuts speech into phrases (≤ 20 s — Whisper decodes 30 s at most and Qwen3-ASR has
// no timestamps of its own) → the diarizer finds who spoke when → phrases are split at speaker changes
// → each piece is transcribed → each piece gets its diarizer speaker (most overlap) and a voiceprint.
// Audio arrives as an in-memory WAV and is never written anywhere.
import type * as Sherpa from "sherpa-onnx-node";
import { MIN_EMBED_SECONDS, assignSpeakers, normalizeEmbedding, parseWav, resampleLinear, splitAtSpeakerChanges, type ModelFiles, type Span, type SpeakerTurn } from "../../src/shared/speechAlign";
import { extractTarBz2, listFiles } from "./archive";
import type { AsrConfig, TranscribeJob, TranscribeResult, WorkerRequest, WorkerSegment } from "./protocol";

const SR = 16000;
let sherpa: typeof Sherpa | null = null;

/** Load the native runtime (lazily — extraction works even where it can't load). */
export async function loadSherpa(): Promise<typeof Sherpa> {
  if (sherpa) return sherpa;
  // Plain require (kept as-is in the CJS bundle): Electron maps the addon's .node file inside app.asar
  // to app.asar.unpacked, where its onnxruntime libraries sit beside it (electron-builder asarUnpack).
  sherpa = require("sherpa-onnx-node") as typeof Sherpa;
  return sherpa;
}

// One of each, rebuilt only when the model changes; dropping the reference frees it on GC.
let recognizer: { key: string; r: Sherpa.OfflineRecognizer } | null = null;
let vad: { key: string; v: Sherpa.Vad } | null = null;
let diarizer: { key: string; d: Sherpa.OfflineSpeakerDiarization } | null = null;
let embedder: { key: string; e: Sherpa.SpeakerEmbeddingExtractor } | null = null;

function recognizerConfig(a: AsrConfig, threads: number): object {
  const common = { numThreads: threads, provider: "cpu", debug: 0 };
  const f = a.files;
  switch (a.family) {
    case "qwen3-asr":
      return { featConfig: { sampleRate: SR, featureDim: 128 }, modelConfig: { qwen3Asr: { convFrontend: f.convFrontend, encoder: f.encoder, decoder: f.decoder, tokenizer: f.tokenizer }, tokens: "", ...common } };
    case "whisper":
      return { featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { whisper: { encoder: f.encoder, decoder: f.decoder, language: a.whisperLanguage, task: a.whisperTask, tailPaddings: -1 }, tokens: f.tokens, ...common } };
    case "transducer":
      return { featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner }, tokens: f.tokens, modelType: "nemo_transducer", ...common }, decodingMethod: "greedy_search" };
    case "omnilingual":
      return { featConfig: { sampleRate: SR, featureDim: 80 }, modelConfig: { omnilingual: { model: f.model }, tokens: f.tokens, ...common } };
  }
}

async function getRecognizer(a: AsrConfig, threads: number) {
  if (recognizer?.key !== a.key) {
    recognizer = null;
    const s = await loadSherpa();
    recognizer = { key: a.key, r: await s.OfflineRecognizer.createAsync(recognizerConfig(a, threads)) };
  }
  return recognizer.r;
}

async function getVad(files: ModelFiles) {
  if (vad?.key !== files.vad) {
    const s = await loadSherpa();
    vad = { key: files.vad, v: new s.Vad({
      // 0.4 s of silence ends a phrase; long monologues are force-split at 20 s.
      sileroVad: { model: files.vad, threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
      sampleRate: SR, numThreads: 1, provider: "cpu", debug: 0,
    }, 120) };
  }
  return vad.v;
}

async function getDiarizer(files: ModelFiles, threads: number) {
  const key = `${files.segmentation}|${files.embedding}`;
  if (diarizer?.key !== key) {
    const s = await loadSherpa();
    diarizer = { key, d: new s.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: files.segmentation }, numThreads: threads, provider: "cpu", debug: 0 },
      embedding: { model: files.embedding, numThreads: threads, provider: "cpu", debug: 0 },
      // Unknown speaker count; sherpa-onnx's recommended threshold for this embedding model.
      clustering: { numClusters: -1, threshold: 0.5 },
      minDurationOn: 0.3, minDurationOff: 0.5,
    }) };
  }
  return diarizer.d;
}

async function getEmbedder(files: ModelFiles, threads: number) {
  if (embedder?.key !== files.embedding) {
    const s = await loadSherpa();
    embedder = { key: files.embedding, e: new s.SpeakerEmbeddingExtractor({ model: files.embedding, numThreads: threads, provider: "cpu", debug: 0 }) };
  }
  return embedder.e;
}

function speechSpans(v: Sherpa.Vad, samples: Float32Array): Span[] {
  v.reset();
  const out: Span[] = [];
  const drain = () => { while (!v.isEmpty()) { const s = v.front(false); out.push({ start: s.start / SR, end: (s.start + s.samples.length) / SR }); v.pop(); } };
  const W = 512;
  for (let i = 0; i + W <= samples.length; i += W) { v.acceptWaveform(samples.subarray(i, i + W)); drain(); }
  v.flush();
  drain();
  return out;
}

const slice = (x: Float32Array, s: Span) => x.subarray(Math.max(0, Math.floor(s.start * SR)), Math.min(x.length, Math.ceil(s.end * SR)));

function embed(e: Sherpa.SpeakerEmbeddingExtractor, samples: Float32Array): number[] | null {
  const st = e.createStream();
  st.acceptWaveform({ samples, sampleRate: SR });
  st.inputFinished();
  if (!e.isReady(st)) return null;
  return normalizeEmbedding(e.compute(st, false));
}

export async function transcribe(job: TranscribeJob): Promise<TranscribeResult> {
  const wav = parseWav(job.wav);
  const samples = resampleLinear(wav.samples, wav.sampleRate, SR);
  const duration = samples.length / SR;
  const turns: SpeakerTurn[] = job.separate
    ? (await getDiarizer(job.speakers, job.threads)).process(samples).map((t) => ({ start: t.start, end: t.end, speaker: t.speaker }))
    : [];

  let pieces: (Span & { text: string })[];
  if (job.asr) {
    const spans = splitAtSpeakerChanges(speechSpans(await getVad(job.speakers), samples), turns);
    const rec = await getRecognizer(job.asr, job.threads);
    pieces = [];
    for (const sp of spans) {
      const stream = rec.createStream();
      stream.acceptWaveform({ samples: slice(samples, sp), sampleRate: SR });
      const text = String((await rec.decodeAsync(stream)).text ?? "").trim();
      if (text) pieces.push({ ...sp, text });
    }
  } else {
    pieces = job.segments ?? [];
  }

  const speakers = job.separate ? assignSpeakers(pieces, turns) : pieces.map(() => null);
  const e = job.separate && pieces.length ? await getEmbedder(job.speakers, job.threads) : null;
  const segments: WorkerSegment[] = pieces.map((p, i) => ({
    start: p.start, end: p.end, text: p.text, speaker: speakers[i],
    embedding: e && p.end - p.start >= MIN_EMBED_SECONDS ? embed(e, slice(samples, p)) : null,
  }));
  return { duration, segments };
}

export async function handle(msg: WorkerRequest): Promise<unknown> {
  switch (msg.type) {
    case "transcribe": return transcribe(msg.job);
    case "extract": return extractTarBz2(msg.archive, msg.dest);
    case "list": return listFiles(msg.root);
  }
}
