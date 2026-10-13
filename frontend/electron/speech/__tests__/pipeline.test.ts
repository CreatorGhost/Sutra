// Node-level smoke tests for the speech utility process's code (no Electron needed).
//
// Real-model end-to-end (opt-in — models can't be downloaded in CI): after downloading a model in the
// app, point this at the app's models folder and a WAV with two or more people talking, e.g. on a Mac
//   SUTRA_MODELS_DIR="$HOME/Library/Application Support/Sutra/models" SUTRA_TEST_WAV=~/call.wav \
//   SUTRA_TEST_MODEL=qwen3-asr-0.6b npx vitest run electron/speech
// (Windows: %APPDATA%\Sutra\models). The WAV should be 16-bit PCM; any rate/channels are converted.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsExtract, listFiles } from "../archive";
import { loadSherpa, transcribe } from "../pipeline";
import type { ModelFiles } from "../../../src/shared/speechAlign";
import { findSpeechModel } from "../../../src/shared/speechModels";

const plat = process.platform === "win32" ? "win" : process.platform;
let nativeAvailable = false;
try { require.resolve(`sherpa-onnx-${plat}-${process.arch}/package.json`); nativeAvailable = true; } catch { /* no build for this platform */ }

describe("speech runtime", () => {
  it.runIf(nativeAvailable)("loads sherpa-onnx's prebuilt N-API addon", async () => {
    const s = await loadSherpa();
    expect(s.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof s.OfflineRecognizer.createAsync).toBe("function");
    expect(typeof s.OfflineSpeakerDiarization).toBe("function");
    expect(typeof s.SpeakerEmbeddingExtractor).toBe("function");
  });
});

const hasTar = (() => { try { execFileSync("tar", ["--version"], { stdio: "ignore" }); execFileSync("bzip2", ["--help"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("model archives", () => {
  it.runIf(hasTar)("extracts .tar.bz2 without external tools (the Windows fallback path)", async () => {
    const root = mkdtempSync(join(tmpdir(), "sutra-archive-"));
    const src = join(root, "src", "sherpa-onnx-test-model");
    mkdirSync(join(src, "tokenizer"), { recursive: true });
    writeFileSync(join(src, "encoder.int8.onnx"), Buffer.alloc(200_000, 7));
    writeFileSync(join(src, "tokenizer", "vocab.json"), "{}");
    const archive = join(root, "m.tar.bz2");
    execFileSync("tar", ["-cjf", archive, "-C", join(root, "src"), "sherpa-onnx-test-model"]);
    const out = join(root, "out");
    mkdirSync(out);
    await jsExtract(archive, out);
    expect((await listFiles(out)).sort()).toEqual(["sherpa-onnx-test-model/encoder.int8.onnx", "sherpa-onnx-test-model/tokenizer/vocab.json"]);
    expect(readFileSync(join(out, "sherpa-onnx-test-model/encoder.int8.onnx")).length).toBe(200_000);
  });
});

const modelsDir = process.env["SUTRA_MODELS_DIR"];
const wavPath = process.env["SUTRA_TEST_WAV"];
const modelId = process.env["SUTRA_TEST_MODEL"] ?? "qwen3-asr-0.6b";

function manifest(id: string): ModelFiles {
  const dir = join(modelsDir!, "sherpa", id);
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  return Object.fromEntries(Object.entries(m.files as ModelFiles).map(([k, v]) => [k, join(dir, ...v.split("/"))]));
}

describe("real models (opt-in)", () => {
  it.runIf(!!modelsDir && !!wavPath && existsSync(wavPath!))("transcribes, separates speakers and embeds turns", async () => {
    const model = findSpeechModel(modelId)!;
    const wav = readFileSync(wavPath!);
    const r = await transcribe({
      wav: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      asr: { key: modelId, family: model.family as any, files: manifest(modelId), whisperLanguage: "", whisperTask: "transcribe" },
      speakers: manifest("speakers"), separate: true, threads: 4,
    });
    console.log(JSON.stringify(r.segments.map((s) => ({ ...s, embedding: s.embedding?.length ?? null })), null, 1));
    expect(r.segments.length).toBeGreaterThan(0);
    expect(r.segments.some((s) => s.text.length > 0)).toBe(true);
    expect(r.segments.some((s) => s.embedding && s.embedding.length > 0)).toBe(true);
  }, 300_000);
});
