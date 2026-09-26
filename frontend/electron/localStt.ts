// Local speech-to-text with whisper.cpp (`whisper-cli`). Models are downloaded on demand into
// <userData>/models; the WAV for one window is written to a private 0700 temp dir only for the duration
// of that call and deleted in `finally` — nothing audio survives the call. Pure bits (catalog, args,
// output parsing) live in src/shared/localModels.ts.
import { app, net } from "electron";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { WHISPER_MODELS, findWhisperModel, parseWhisperJson, whisperArgs, whisperLanguageArgs, whisperModelUrl } from "../src/shared/localModels";
import { findBinary, runProcess } from "./proc";

const modelsDir = () => join(app.getPath("userData"), "models");
const audioTmp = () => join(app.getPath("userData"), "tmp-audio");

export interface SttStatus {
  binary: string | null;
  installed: string[];
  downloading: { id: string; received: number; total: number } | null;
}

let downloading: { id: string; received: number; total: number; abort: AbortController } | null = null;

export async function sttStatus(): Promise<SttStatus> {
  const files = existsSync(modelsDir()) ? await readdir(modelsDir()) : [];
  const installed = WHISPER_MODELS.filter((m) => files.includes(m.file)).map((m) => m.id);
  const binary = await findBinary(["whisper-cli", "whisper-cpp"]);
  return { binary, installed, downloading: downloading && { id: downloading.id, received: downloading.received, total: downloading.total } };
}

/** Download a model (resumable across app restarts is not needed: files are < 3 GB and cached). */
export async function downloadModel(id: string, onProgress: (p: { id: string; received: number; total: number; done?: boolean; error?: string }) => void): Promise<void> {
  const model = findWhisperModel(id);
  if (!model) throw new Error(`Unknown model ${id}`);
  if (downloading) throw new Error(`Already downloading ${downloading.id}`);
  await mkdir(modelsDir(), { recursive: true });
  const final = join(modelsDir(), model.file);
  const part = `${final}.part`;
  const abort = new AbortController();
  downloading = { id, received: 0, total: model.sizeMB * 1024 * 1024, abort };
  try {
    const res = await net.fetch(whisperModelUrl(model), { signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length")) || downloading.total;
    downloading.total = total;
    let last = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        downloading!.received += chunk.byteLength;
        if (Date.now() - last > 250) { last = Date.now(); onProgress({ id, received: downloading!.received, total }); }
        ctrl.enqueue(chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as any), createWriteStream(part));
    const size = (await stat(part)).size;
    if (size < 1024 * 1024) throw new Error("Download was incomplete.");
    await rename(part, final);
    onProgress({ id, received: size, total: size, done: true });
  } catch (e: any) {
    await rm(part, { force: true }).catch(() => {});
    const msg = abort.signal.aborted ? "Download cancelled." : String(e?.message ?? e);
    onProgress({ id, received: 0, total: 0, error: msg });
    throw new Error(msg);
  } finally {
    downloading = null;
  }
}

export function cancelDownload(): void {
  downloading?.abort.abort();
}

export async function deleteModel(id: string): Promise<void> {
  const model = findWhisperModel(id);
  if (model) await rm(join(modelsDir(), model.file), { force: true });
}

/** One transcription at a time — whisper already uses every core; parallel runs only thrash. */
let queue: Promise<unknown> = Promise.resolve();

export function transcribeLocal(wav: ArrayBuffer, opts: { model: string; language?: string | null }) {
  const job = queue.then(() => transcribeNow(wav, opts));
  queue = job.catch(() => {});
  return job;
}

async function transcribeNow(wav: ArrayBuffer, opts: { model: string; language?: string | null }) {
  const model = findWhisperModel(opts.model);
  if (!model) throw new Error("Choose a local transcription model in Settings.");
  const modelPath = join(modelsDir(), model.file);
  if (!existsSync(modelPath)) throw new Error(`The ${model.label} model isn't downloaded yet — download it in Settings.`);
  const bin = await findBinary(["whisper-cli", "whisper-cpp"]);
  if (!bin) throw new Error("whisper.cpp isn't installed. On a Mac: brew install whisper-cpp");

  await mkdir(audioTmp(), { recursive: true, mode: 0o700 });
  const base = join(audioTmp(), randomUUID());
  const wavPath = `${base}.wav`;
  try {
    await writeFile(wavPath, Buffer.from(wav), { mode: 0o600 });
    const lang = whisperLanguageArgs(opts.language);
    const args = whisperArgs({ modelPath, wavPath, outPrefix: base, ...lang, threads: Math.max(2, Math.min(8, cpus().length - 1)) });
    const r = await runProcess(bin, args, { timeoutMs: 10 * 60 * 1000 });
    if (r.timedOut) throw new Error("Local transcription timed out — try a smaller model.");
    const json = await readFile(`${base}.json`, "utf8").catch(() => null);
    if (!json) throw new Error(`whisper.cpp failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    return parseWhisperJson(json);
  } finally {
    await rm(wavPath, { force: true }).catch(() => {});
    await rm(`${base}.json`, { force: true }).catch(() => {});
  }
}
