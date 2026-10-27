// Runs Cloudflare's wrangler for one-click relay setup: `npx --yes wrangler@4 …` on the user's own
// Node 22+ when they have it, else on an official Node.js download (pinned by SHA-256, kept under
// userData/tools) — Sutra's Electron is Node 20, too old for wrangler 4, so it can't stand in. wrangler
// itself is fetched by npx as usual (it's ~100 MB with workerd, too big to ship).
// The relay Worker (out/relay-worker/worker.js, built by scripts/build-relay-worker.mjs) is staged
// into a temporary folder with a generated wrangler config for each setup.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { WRANGLER_PACKAGE, nodeDist, nodeMajor, stripAnsi, supportsSystemCa } from "../../src/shared/pairing/relaySetup";
import { findBinary, killTree, runProcess, spawnTool, userPath } from "../proc";

export interface RunResult { code: number; output: string }
export interface RunOptions {
  /** Written to stdin, then closed — the only way the host secret reaches wrangler. */
  input?: string;
  onOutput?: (text: string) => void;
  /** The Cloudflare account to act on (CLOUDFLARE_ACCOUNT_ID), when the sign-in has several. */
  accountId?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type Run = (args: string[], o?: RunOptions) => Promise<RunResult>;
export interface WranglerSession { run: Run; configPath: string; dispose(): Promise<void> }

/** Thrown with one plain sentence for the person (and, maybe, redacted tool output). */
export class SetupError extends Error {
  constructor(message: string, readonly details?: string, readonly installNode = false) { super(message); }
}

const RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 64_000;

/** The relay's wrangler config, written next to the staged worker.js. Mirrors infra/sutra-relay/wrangler.jsonc. */
export function wranglerConfig(name: string): string {
  return JSON.stringify({
    name,
    main: "worker.js",
    compatibility_date: "2026-10-01",
    workers_dev: true,
    durable_objects: { bindings: [{ name: "RELAY", class_name: "SutraRelay" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["SutraRelay"] }],
  }, null, 2);
}

interface Launch { command: string; prefix: string[]; env: Record<string, string> }

/** Node 22+ on PATH (with its npx), else null. */
async function systemNode(): Promise<Launch | null> {
  const node = await findBinary(["node"]);
  const npx = node ? await findBinary(["npx"]) : null;
  if (!node || !npx) return null;
  const v = await runProcess(node, ["--version"], { timeoutMs: 15_000 }).catch(() => null);
  const version = v?.stdout.trim() ?? "";
  if ((nodeMajor(version) ?? 0) < 22) return null;
  return { command: npx, prefix: ["--yes", WRANGLER_PACKAGE], env: supportsSystemCa(version) ? { NODE_OPTIONS: "--use-system-ca" } : {} };
}

/** The pinned Node under `cacheDir`, downloading and checking it the first time. */
async function downloadedNode(cacheDir: string, onDownload: () => void, fetchBytes: (url: string) => Promise<Uint8Array>): Promise<Launch> {
  const dist = nodeDist(process.platform, process.arch);
  if (!dist) throw new SetupError("Sutra can't set up Cloudflare's tools on this computer. Install Node.js 22 or newer (nodejs.org), then try again.", undefined, true);
  const dir = join(cacheDir, dist.folder);
  const win = process.platform === "win32";
  const nodeBin = win ? join(dir, "node.exe") : join(dir, "bin", "node");
  const npxCli = win ? join(dir, "node_modules", "npm", "bin", "npx-cli.js") : join(dir, "lib", "node_modules", "npm", "bin", "npx-cli.js");
  if (!existsSync(nodeBin) || !existsSync(npxCli)) {
    onDownload();
    let bytes: Uint8Array;
    try { bytes = await fetchBytes(dist.url); }
    catch (e: any) { throw new SetupError("Couldn't download Cloudflare's tools. Check your internet connection and try again.", String(e?.message ?? e)); }
    if (createHash("sha256").update(bytes).digest("hex") !== dist.sha256) {
      throw new SetupError("The Node.js download didn't match its checksum, so Sutra didn't use it. Try again.");
    }
    await mkdir(cacheDir, { recursive: true });
    const partial = await mkdtemp(join(cacheDir, "node-partial-"));
    try {
      const archive = join(partial, dist.zip ? "node.zip" : "node.tar.gz");
      await writeFile(archive, bytes);
      // bsdtar on macOS and Windows 10+ reads both .tar.gz and .zip; GNU tar on Linux reads .tar.gz.
      const x = await runProcess("tar", [dist.zip ? "-xf" : "-xzf", archive, "-C", partial], { timeoutMs: 5 * 60_000 });
      if (x.code !== 0) throw new SetupError("Couldn't unpack Cloudflare's tools on this computer. Try again.", x.stderr);
      await rm(dir, { recursive: true, force: true });
      await rename(join(partial, dist.folder), dir);
    } finally {
      await rm(partial, { recursive: true, force: true });
    }
  }
  const binDir = win ? dir : join(dir, "bin");
  // Whatever npx and wrangler start as `node` must find this one first.
  return { command: nodeBin, prefix: [npxCli, "--yes", WRANGLER_PACKAGE], env: { PATH: `${binDir}${delimiter}${await userPath()}`, NODE_OPTIONS: "--use-system-ca" } };
}

/** The relay Worker the build bundled (`npm run dev` and `build:desktop` both run the bundler first). */
async function workerSource(): Promise<string> {
  // out/main/main.cjs → out/relay-worker; from source (scripts, tests) → frontend/out/relay-worker.
  const candidates = [join(__dirname, "../relay-worker/worker.js"), join(__dirname, "../../out/relay-worker/worker.js")];
  const built = candidates.find((p) => existsSync(p));
  if (built) return readFile(built, "utf8");
  throw new SetupError("This build of Sutra doesn't include the relay. Update Sutra, then try again.", `Missing ${candidates[0]} (run scripts/build-relay-worker.mjs).`);
}

/** Find (or fetch) Node, stage the Worker, and hand back a runner for wrangler. */
export async function prepareWrangler(o: {
  cacheDir: string;
  workerName: string;
  onProgress: (message: string) => void;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** False skips the user's own Node (to exercise the download). */
  systemNode?: boolean;
}): Promise<WranglerSession> {
  const launch = (o.systemNode === false ? null : await systemNode()) ?? (await downloadedNode(o.cacheDir, () => o.onProgress("Getting Cloudflare's tools ready (one-time download)…"), o.fetchBytes));
  const stage = await mkdtemp(join(tmpdir(), "sutra-relay-"));
  await writeFile(join(stage, "worker.js"), await workerSource());
  const configPath = join(stage, "wrangler.json");
  await writeFile(configPath, wranglerConfig(o.workerName));

  const run: Run = (args, r = {}) => new Promise((resolve, reject) => {
    if (r.signal?.aborted) { reject(new SetupError("Cancelled.")); return; }
    const env: Record<string, string> = { ...launch.env, NO_COLOR: "1", FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false", ...(r.accountId ? { CLOUDFLARE_ACCOUNT_ID: r.accountId } : {}) };
    void spawnTool(launch.command, [...launch.prefix, ...args], { cwd: stage, env }).then((child) => {
      let output = "";
      const onData = (b: Buffer) => { const t = stripAnsi(b.toString("utf8")); output = (output + t).slice(-MAX_OUTPUT); r.onOutput?.(t); };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.stdin.on("error", () => {});
      child.stdin.end(r.input ?? "");
      const stop = () => killTree(child);
      const timer = setTimeout(stop, r.timeoutMs ?? RUN_TIMEOUT_MS);
      r.signal?.addEventListener("abort", stop, { once: true });
      child.once("error", (e) => { clearTimeout(timer); resolve({ code: 127, output: `${output}${String(e)}` }); });
      child.once("close", (code) => {
        clearTimeout(timer);
        r.signal?.removeEventListener("abort", stop);
        if (r.signal?.aborted) reject(new SetupError("Cancelled."));
        else resolve({ code: code ?? 1, output });
      });
    }, reject);
  });

  return { run, configPath, dispose: () => rm(stage, { recursive: true, force: true }) };
}
