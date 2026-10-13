// Process helpers for the main process: find user-installed CLIs and run them safely, on macOS, Windows
// and Linux.
//
// Apps launched from Finder/Dock get a minimal PATH (/usr/bin:/bin…), so `claude`, `codex`,
// `cursor-agent` and `whisper-cli` (Homebrew, npm -g, ~/.local/bin) wouldn't be found. We read the
// user's login-shell PATH once and add the usual install locations.
//
// Windows: npm installs CLIs as `.cmd` shims, which Node can only start through cmd.exe — and cmd.exe
// re-parses every argument (`&`, `|`, `%VAR%`, newlines…). So we read the shim, find the script it
// launches and run `node <script>` directly; only a shim we can't read falls back to cmd.exe, with
// every argument escaped and anything multi-line refused. Prompts never travel in argv anyway (stdin).
// PATHEXT lookup, the known-dirs list and the cmd.exe escaping are ported from ViewCode's
// packages/shared/src/shell.ts (T3 Code fork, MIT, © T3 Tools Inc.) — see THIRD_PARTY_NOTICES.md.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, posix, win32 } from "node:path";

let cachedPath: Promise<string> | null = null;

function loginShellPath(): Promise<string> {
  if (process.platform === "win32") return Promise.resolve("");
  const shell = process.env["SHELL"] || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", 'printf "__SUTRA_PATH__%s__END__" "$PATH"'], { timeout: 5000 }, (_e, out) => {
      resolve(String(out ?? "").match(/__SUTRA_PATH__(.*)__END__/)?.[1] ?? "");
    });
  });
}

const readEnvPath = (env: NodeJS.ProcessEnv) => env["PATH"] ?? env["Path"] ?? env["path"] ?? "";

/** Where CLI installers put binaries when the app's inherited PATH doesn't include them. */
export function knownCliDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === "win32") {
    const appData = env["APPDATA"]?.trim(), local = env["LOCALAPPDATA"]?.trim(), profile = env["USERPROFILE"]?.trim() || home;
    return [
      ...(appData ? [win32.join(appData, "npm")] : []),
      ...(local ? [win32.join(local, "Programs", "nodejs"), win32.join(local, "Volta", "bin"), win32.join(local, "pnpm"), win32.join(local, "cursor-agent")] : []),
      win32.join(profile, ".local", "bin"), win32.join(profile, ".bun", "bin"), win32.join(profile, "scoop", "shims"),
    ];
  }
  return ["/opt/homebrew/bin", "/usr/local/bin", posix.join(home, ".local", "bin"), posix.join(home, ".npm-global", "bin"),
    posix.join(home, ".bun", "bin"), posix.join(home, ".volta", "bin"), posix.join(home, ".claude", "local"), posix.join(home, ".cursor", "bin"),
    posix.join(home, ".grok", "bin"), posix.join(home, ".factory", "bin")];
}

/** The PATH to run user CLIs with (login shell PATH + current PATH + common install dirs). */
export function userPath(): Promise<string> {
  cachedPath ??= loginShellPath().then((shellPath) => {
    const parts = [...shellPath.split(delimiter), ...readEnvPath(process.env).split(delimiter), ...knownCliDirs(process.platform, process.env, homedir())]
      .map((p) => p.trim().replace(/^"+|"+$/g, "")).filter(Boolean);
    const seen = new Set<string>();
    return parts.filter((p) => { const k = process.platform === "win32" ? p.toLowerCase() : p; return !seen.has(k) && !!seen.add(k); }).join(delimiter);
  });
  return cachedPath;
}

/** PATHEXT as upper-case extensions, in the order Windows tries them. */
export function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  const parsed = String(env["PATHEXT"] ?? "").split(";").map((e) => e.trim()).filter(Boolean).map((e) => (e.startsWith(".") ? e : `.${e}`).toUpperCase());
  return parsed.length ? [...new Set(parsed)] : [".COM", ".EXE", ".BAT", ".CMD"];
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isExecutable = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

/** First match for `name` on `pathValue`. On Windows only PATHEXT extensions count (a bare `claude`
 *  next to `claude.cmd` is npm's sh script for Git Bash, not something we can start). */
export function findExecutable(name: string, o: { platform: NodeJS.Platform; pathValue: string; pathext?: string[]; fileExists?: (p: string) => boolean; canExec?: (p: string) => boolean }): string | null {
  const win = o.platform === "win32";
  const path = win ? win32 : posix;
  const exists = o.fileExists ?? isFile;
  const exec = o.canExec ?? isExecutable;
  const exts = win ? (o.pathext ?? [".COM", ".EXE", ".BAT", ".CMD"]) : [""];
  const hasExt = win && exts.includes(path.extname(name).toUpperCase());
  const candidates = hasExt ? [name] : exts.map((e) => name + e.toLowerCase());
  for (const dir of o.pathValue.split(win ? ";" : ":").map((d) => d.trim().replace(/^"+|"+$/g, "")).filter(Boolean)) {
    for (const c of candidates) {
      const p = path.join(dir, c);
      if (exists(p) && (win || exec(p))) return p;
    }
  }
  return null;
}

/** First executable matching one of `names` on the user PATH, or null. */
export async function findBinary(names: string[]): Promise<string | null> {
  const pathValue = await userPath();
  for (const name of names) {
    const p = findExecutable(name, { platform: process.platform, pathValue, pathext: windowsPathExts(process.env) });
    if (p) return p;
  }
  return null;
}

// ---- Windows .cmd shims ------------------------------------------------------------------------------

/** What an npm/pnpm/cmd-shim `.cmd` file launches: the script (relative to the shim's folder) and
 *  whether it runs under node. Recognises both the modern `"%_prog%" "%dp0%\…\cli.js" %*` form and the
 *  older `"%~dp0\node.exe" "%~dp0\…\cli.js" %*` / `node "%~dp0\…" %*` forms. */
export function parseCmdShim(content: string): { script: string; node: boolean } | null {
  const lines = content.split(/\r?\n/).filter((l) => /%\*/.test(l));
  for (const line of lines.reverse()) {
    const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const target = quoted.find((q) => /^%~?dp0%?/i.test(q) && !/\\node(\.exe)?$/i.test(q));
    if (!target) continue;
    const rel = target.replace(/^%~?dp0%?\\?/i, "");
    if (!rel || /[%!^&|<>]/.test(rel)) return null; // anything dynamic: don't guess
    const node = /%_prog%|node(\.exe)?"?\s/i.test(line) || /\.(c|m)?js$/i.test(rel);
    return { script: rel, node };
  }
  return null;
}

/** Escape one argument for `cmd.exe /d /s /c` (Node's shell mode on Windows): quote it for
 *  CommandLineToArgvW, then caret-escape every cmd metacharacter. Mirrors cross-spawn. */
export function escapeWindowsShellArg(arg: string): string {
  const s = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${s}"`.replace(/([()\][%!^"`<>&|;, *?])/g, "^$1");
}

export interface SpawnSpec { command: string; args: string[]; shell: boolean; env?: Record<string, string> }

/** How to actually start `bin args`: unchanged off Windows; on Windows `.exe` directly, a recognised
 *  `.cmd` shim as `node <script>`, anything else through cmd.exe with escaped arguments. */
export function resolveSpawn(bin: string, args: string[], o: {
  platform?: NodeJS.Platform; readFile?: (p: string) => string; fileExists?: (p: string) => boolean;
  /** `node` on the user PATH, if any; else Electron itself runs the script as Node. */
  nodePath?: string | null; execPath?: string;
} = {}): SpawnSpec {
  const platform = o.platform ?? process.platform;
  if (platform !== "win32") return { command: bin, args, shell: false };
  const ext = win32.extname(bin).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: bin, args, shell: false };
  let shim: ReturnType<typeof parseCmdShim> = null;
  try { shim = parseCmdShim((o.readFile ?? ((p) => readFileSync(p, "utf8")))(bin)); } catch { /* unreadable */ }
  const exists = o.fileExists ?? isFile;
  if (shim) {
    const dir = win32.dirname(bin);
    const script = win32.resolve(dir, shim.script);
    if (exists(script)) {
      if (!shim.node) return { command: script, args, shell: false };
      const bundled = win32.join(dir, "node.exe");
      if (exists(bundled)) return { command: bundled, args: [script, ...args], shell: false };
      if (o.nodePath) return { command: o.nodePath, args: [script, ...args], shell: false };
      return { command: o.execPath ?? process.execPath, args: [script, ...args], shell: false, env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
  }
  return { command: escapeWindowsShellArg(bin), args: args.map(escapeWindowsShellArg), shell: true };
}

let nodeOnPath: Promise<string | null> | null = null;

async function spawnSpec(bin: string, args: string[]): Promise<SpawnSpec> {
  if (process.platform !== "win32") return { command: bin, args, shell: false };
  nodeOnPath ??= findBinary(["node"]);
  const spec = resolveSpawn(bin, args, { nodePath: await nodeOnPath });
  // cmd.exe can't carry a newline (or a NUL) inside an argument; refuse rather than mangle it.
  if (spec.shell && args.some((a) => /[\r\n\0]/.test(a))) throw new Error(`${win32.basename(bin)} can't be started safely from Sutra. Reinstall it with npm, or install its native build.`);
  return spec;
}

/** Environment for user CLIs: their PATH (one key — Windows env names are case-insensitive), no colours. */
async function childEnv(extra?: Record<string, string>): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.toLowerCase() === "path") delete env[k];
  return { ...env, PATH: await userPath(), NO_COLOR: "1", CI: "1", ...extra };
}

/** Kill a CLI and whatever it spawned (on Windows `kill` only reaches the direct child). */
export function killTree(child: { pid?: number; kill: (s?: NodeJS.Signals) => boolean; exitCode: number | null }): void {
  if (child.exitCode != null) return;
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => { if (child.exitCode == null) child.kill("SIGKILL"); }, 3000).unref?.();
}

/** Start a long-lived CLI with piped stdio (ACP agents). Same PATH/shim handling as runProcess. */
export async function spawnTool(bin: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<ChildProcessWithoutNullStreams> {
  const spec = await spawnSpec(bin, args);
  return spawn(spec.command, spec.args, { cwd: opts.cwd, env: await childEnv({ ...opts.env, ...spec.env }), shell: spec.shell, windowsHide: true });
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Run a binary with an argument ARRAY (never a shell string), optional stdin, and a hard timeout. */
export async function runProcess(bin: string, args: string[], opts: { input?: string; timeoutMs?: number; cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  const child = await spawnTool(bin, args, { cwd: opts.cwd, env: opts.env });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs ?? 180000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.on("error", () => { /* CLI exited before reading stdin; its output says why */ });
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

