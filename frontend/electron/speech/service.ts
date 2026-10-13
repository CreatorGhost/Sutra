// Main-process speech service: model downloads, the speech utility process and the transcription queue.
//
// Layout under <userData>/models (all paths built with path.join — Windows-safe):
//   sherpa/<model id>/          extracted model + manifest.json (the files detectModelFiles found)
//   sherpa/speakers/            VAD + speaker segmentation + speaker embedding (the speaker pack)
//   <ggml file>.bin             whisper.cpp models (same place as before, so existing downloads count)
// Downloads go through Electron's net.fetch (system proxy / certificates) into a staging folder that is
// renamed into place only once complete, so a half-finished model never looks installed.
import { app, net, utilityProcess, type UtilityProcess } from "electron";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { toRomanHinglish } from "../../src/shared/hinglish";
import { detectModelFiles, type ModelFiles, type SherpaFamily } from "../../src/shared/speechAlign";
import {
  SPEAKER_PACK_ID, SPEECH_MODELS, downloadPlan, findSpeechModel, speechPlan,
  type LocalTranscription, type SpeechModel, type SpeechProgress, type SpeechStatus, type SpeechTranscribeOpts,
} from "../../src/shared/speechModels";
import { detectHardware } from "../hardware";
import type { TranscribeJob, TranscribeResult, WorkerRequest, WorkerResponse } from "./protocol";
import { findWhisperCli, transcribeWhisperCpp } from "./whisperCpp";

const modelsDir = () => join(app.getPath("userData"), "models");
const sherpaDir = (id: string) => join(modelsDir(), "sherpa", id);
const stagingDir = (id: string) => join(modelsDir(), "sherpa", `.${id}.partial`);
const audioTmp = () => join(app.getPath("userData"), "tmp-audio");
const ggmlPath = (m: SpeechModel) => join(modelsDir(), m.assets[0].file);
const threads = () => Math.max(2, Math.min(6, cpus().length - 2));

// ---- runtime ----------------------------------------------------------------------------------------

/** Whether sherpa-onnx ships a native build for this OS/arch — checked by resolving the platform
 *  package (no dlopen in the main process; the worker loads it). */
function runtimeStatus(): { ok: boolean; error: string | null } {
  const plat = process.platform === "win32" ? "win" : process.platform;
  try {
    require.resolve(`sherpa-onnx-${plat}-${process.arch}/package.json`);
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: `The speech engine has no build for ${process.platform}-${process.arch}.` };
  }
}

// ---- utility process --------------------------------------------------------------------------------

let worker: UtilityProcess | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let idleTimer: NodeJS.Timeout | null = null;
/** Models use 1–5 GB of RAM; give it back when nobody has transcribed for a while. */
const IDLE_MS = 5 * 60 * 1000;

function spawnWorker(): UtilityProcess {
  if (worker) return worker;
  // speechWorker.cjs is built next to main.cjs (electron.vite.config.ts).
  const w = utilityProcess.fork(join(__dirname, "speechWorker.cjs"), [], { serviceName: "Sutra Speech", stdio: "inherit" });
  w.on("message", (m: WorkerResponse) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error));
  });
  w.on("exit", (code) => {
    if (worker === w) worker = null;
    // onnxruntime aborts the process on a corrupt model; surface that instead of hanging the caller.
    const err = new Error(code === 0 ? "The speech engine stopped." : `The speech engine stopped unexpectedly (code ${code}). If this repeats, delete and re-download the model in Settings.`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });
  worker = w;
  return w;
}

type Request = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never;

function call<T>(req: Request): Promise<T> {
  const w = spawnWorker();
  if (idleTimer) clearTimeout(idleTimer);
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...req, id });
  }).finally(() => {
    if (!pending.size) idleTimer = setTimeout(() => { if (!pending.size) worker?.kill(); }, IDLE_MS);
  });
}

// ---- status -----------------------------------------------------------------------------------------

let downloading: (SpeechProgress & { abort: AbortController }) | null = null;

async function installedIds(): Promise<string[]> {
  const ids: string[] = [];
  for (const m of [...SPEECH_MODELS, findSpeechModel(SPEAKER_PACK_ID)!]) {
    if (m.engine === "whisper-cpp" ? existsSync(ggmlPath(m)) : existsSync(join(sherpaDir(m.id), "manifest.json"))) ids.push(m.id);
  }
  return ids;
}

async function dirSizeMB(dir: string): Promise<number> {
  let bytes = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) bytes += (await stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return Math.round(bytes / (1024 * 1024));
}

export async function speechStatus(): Promise<SpeechStatus> {
  const [hardware, installed, whisperCli, diskMB] = await Promise.all([detectHardware(), installedIds(), findWhisperCli(), dirSizeMB(modelsDir())]);
  const d = downloading;
  return {
    runtime: runtimeStatus(), hardware, installed, whisperCli, diskMB,
    downloading: d && { id: d.id, item: d.item, phase: d.phase, received: d.received, total: d.total },
  };
}

// ---- downloads --------------------------------------------------------------------------------------

type Progress = (p: SpeechProgress) => void;

async function fetchTo(url: string, dest: string, signal: AbortSignal, onBytes: (n: number, total: number | null) => void, sha256?: string): Promise<void> {
  const res = await net.fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || null;
  const hash = sha256 ? createHash("sha256") : null;
  let got = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) { got += chunk.byteLength; hash?.update(chunk); onBytes(chunk.byteLength, total); ctrl.enqueue(chunk); },
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as any), createWriteStream(dest));
  if (total && got !== total) throw new Error("Download was incomplete — try again.");
  if (got < 1024) throw new Error("Download was empty — try again.");
  if (hash && hash.digest("hex") !== sha256) throw new Error("Download didn't match its checksum — try again.");
}

async function installOne(m: SpeechModel, requested: string, onProgress: Progress, signal: AbortSignal): Promise<void> {
  const state = downloading!;
  state.item = m.id;
  state.phase = "download";
  let last = 0;
  const tick = (force = false) => {
    if (force || Date.now() - last > 250) { last = Date.now(); onProgress({ id: requested, item: m.id, phase: state.phase, received: state.received, total: state.total }); }
  };

  // Totals start from the catalog's estimates; swap in the server's real size once it is known.
  const counter = (estimateMB: number) => {
    let adjusted = false;
    return (n: number, total: number | null) => {
      if (!adjusted && total) { state.total += total - estimateMB * 1024 * 1024; adjusted = true; }
      state.received += n;
      tick();
    };
  };

  if (m.engine === "whisper-cpp") {
    await mkdir(modelsDir(), { recursive: true });
    const part = `${ggmlPath(m)}.part`;
    try {
      await fetchTo(m.assets[0].url, part, signal, counter(m.assets[0].sizeMB), m.assets[0].sha256);
      await rename(part, ggmlPath(m));
    } finally { await rm(part, { force: true }).catch(() => {}); }
    return;
  }

  const stage = stagingDir(m.id);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    for (const a of m.assets) {
      const file = join(stage, a.file);
      await fetchTo(a.url, file, signal, counter(a.sizeMB), a.sha256);
      if (a.kind === "tar.bz2") {
        state.phase = "extract";
        tick(true);
        // Each archive gets its own folder so a failed extraction can be wiped without touching the rest.
        await call({ type: "extract", archive: file, dest: join(stage, basename(a.file, ".tar.bz2")) });
        await rm(file, { force: true });
        state.phase = "download";
      }
      if (signal.aborted) throw new Error("Download cancelled.");
    }
    const files = await call<string[]>({ type: "list", root: stage });
    const manifest = detectModelFiles(m.family as SherpaFamily, files);
    await writeFile(join(stage, "manifest.json"), JSON.stringify({ id: m.id, family: m.family, files: manifest }, null, 2));
    await rm(sherpaDir(m.id), { recursive: true, force: true });
    await rename(stage, sherpaDir(m.id));
  } catch (e) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Download a model — plus the speaker pack, the first time — reporting combined progress. */
export async function downloadSpeechModel(id: string, onProgress: Progress): Promise<void> {
  const model = findSpeechModel(id);
  if (!model) throw new Error(`Unknown model ${id}`);
  if (downloading) throw new Error("Another model is downloading — wait for it or cancel it first.");
  const plan = downloadPlan(id, await installedIds());
  const abort = new AbortController();
  downloading = { id, received: 0, total: plan.reduce((s, m) => s + m.sizeMB * 1024 * 1024, 0), abort };
  try {
    for (const m of plan) await installOne(m, id, onProgress, abort.signal);
    onProgress({ id, received: downloading.total, total: downloading.total, done: true });
  } catch (e: any) {
    const msg = abort.signal.aborted ? "Download cancelled." : String(e?.message ?? e);
    onProgress({ id, received: 0, total: 0, error: msg });
    throw new Error(msg);
  } finally {
    downloading = null;
  }
}

export function cancelSpeechDownload(): void {
  if (!downloading) return;
  downloading.abort.abort();
  // An extraction in progress can't be interrupted from outside; stopping the worker ends it (its
  // pending call rejects, the staging folder is removed, and the next job starts a fresh worker).
  if (downloading.phase === "extract") worker?.kill();
}

export async function deleteSpeechModel(id: string): Promise<void> {
  const m = findSpeechModel(id);
  if (!m) return;
  if (m.engine === "whisper-cpp") await rm(ggmlPath(m), { force: true });
  else {
    // Free the files before deleting them (Windows refuses to delete files a process has open).
    worker?.kill();
    await rm(sherpaDir(m.id), { recursive: true, force: true });
  }
}

// ---- transcription ----------------------------------------------------------------------------------

async function manifest(id: string): Promise<ModelFiles> {
  const dir = sherpaDir(id);
  const raw = await readFile(join(dir, "manifest.json"), "utf8").catch(() => null);
  if (!raw) throw new Error(id === SPEAKER_PACK_ID ? "Speaker separation isn't downloaded yet — open Settings → Transcription." : "This model isn't downloaded yet — download it in Settings.");
  const files: ModelFiles = {};
  for (const [k, rel] of Object.entries(JSON.parse(raw).files as ModelFiles)) {
    const p = join(dir, ...rel.split("/"));
    if (!existsSync(p)) throw new Error("A model file is missing — delete the model in Settings and download it again.");
    files[k] = p;
  }
  return files;
}

/** One transcription at a time — a model already uses every core it is given. */
let queue: Promise<unknown> = Promise.resolve();

export function transcribeSpeech(wav: ArrayBuffer, opts: SpeechTranscribeOpts): Promise<LocalTranscription> {
  const job = queue.then(() => transcribeNow(wav, opts));
  queue = job.catch(() => {});
  return job;
}

async function transcribeNow(wav: ArrayBuffer, opts: SpeechTranscribeOpts): Promise<LocalTranscription> {
  const model = findSpeechModel(opts.model);
  if (!model || model.id === SPEAKER_PACK_ID) throw new Error("Choose a transcription model in Settings.");
  const plan = speechPlan(model, opts.language);
  const separate = opts.speakers !== false;
  let result: TranscribeResult;

  if (model.engine === "sherpa") {
    const rt = runtimeStatus();
    if (!rt.ok) throw new Error(rt.error!);
    const files = await manifest(model.id);
    const speakers = await manifest(SPEAKER_PACK_ID);
    const job: TranscribeJob = {
      wav, separate, speakers, threads: threads(),
      asr: { key: `${model.id}|${plan.whisperLanguage}|${plan.whisperTask}`, family: model.family as any, files, whisperLanguage: plan.whisperLanguage, whisperTask: plan.whisperTask },
    };
    result = await call<TranscribeResult>({ type: "transcribe", job });
  } else {
    if (!existsSync(ggmlPath(model))) throw new Error(`The ${model.label} model isn't downloaded yet — download it in Settings.`);
    const w = await transcribeWhisperCpp(wav, { modelPath: ggmlPath(model), language: opts.language ?? null, tmpDir: audioTmp() });
    // whisper.cpp has no diarization: when the speaker pack is present, separate speakers on the same
    // audio in the worker and attach them to whisper's segments.
    const speakers = separate && runtimeStatus().ok ? await manifest(SPEAKER_PACK_ID).catch(() => null) : null;
    result = speakers && w.segments.length
      ? await call<TranscribeResult>({ type: "transcribe", job: { wav, asr: null, segments: w.segments, speakers, separate: true, threads: threads() } })
      : { duration: w.duration, segments: w.segments.map((s) => ({ ...s, speaker: null, embedding: null })) };
  }

  const segments = result.segments
    .map((s) => ({ start: s.start, end: s.end, text: (plan.romanize ? toRomanHinglish(s.text) : s.text).trim(), speaker: String(s.speaker ?? 0), embedding: s.embedding }))
    .filter((s) => s.text);
  return { text: segments.map((s) => s.text).join(" "), duration: result.duration, segments, translated: plan.translated };
}
