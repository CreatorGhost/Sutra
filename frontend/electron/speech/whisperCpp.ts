// OPTIONAL engine: whisper.cpp's `whisper-cli`, for users who already have it (ggml models, incl. the
// Roman-Hinglish fine-tune). Never required — the bundled sherpa-onnx runtime covers the default path.
// The WAV for one window is written to a private 0700 temp dir only for the duration of the call and
// deleted in `finally` — nothing audio survives the call.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseWhisperJson, whisperArgs, whisperLanguageArgs, type LocalSegment } from "../../src/shared/localModels";
import { findBinary, runProcess } from "../proc";

export const findWhisperCli = () => findBinary(["whisper-cli", "whisper-cpp"]);

export async function transcribeWhisperCpp(wav: ArrayBuffer, o: { modelPath: string; language: string | null; tmpDir: string }): Promise<{ duration: number; segments: LocalSegment[] }> {
  const bin = await findWhisperCli();
  if (!bin) throw new Error("whisper.cpp isn't installed. Pick a built-in model in Settings, or install whisper-cpp.");
  await mkdir(o.tmpDir, { recursive: true, mode: 0o700 });
  const base = join(o.tmpDir, randomUUID());
  const wavPath = `${base}.wav`;
  try {
    await writeFile(wavPath, Buffer.from(wav), { mode: 0o600 });
    const args = whisperArgs({ modelPath: o.modelPath, wavPath, outPrefix: base, ...whisperLanguageArgs(o.language), threads: Math.max(2, Math.min(8, cpus().length - 1)) });
    const r = await runProcess(bin, args, { timeoutMs: 10 * 60 * 1000 });
    if (r.timedOut) throw new Error("Local transcription timed out — try a smaller model.");
    const json = await readFile(`${base}.json`, "utf8").catch(() => null);
    if (!json) throw new Error(`whisper.cpp failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    const parsed = parseWhisperJson(json);
    return { duration: parsed.duration, segments: parsed.segments };
  } finally {
    await rm(wavPath, { force: true }).catch(() => {});
    await rm(`${base}.json`, { force: true }).catch(() => {});
  }
}
