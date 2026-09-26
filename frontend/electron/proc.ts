// Process helpers for the main process: find user-installed CLIs and run them safely.
//
// Apps launched from Finder/Dock get a minimal PATH (/usr/bin:/bin…), so `claude`, `codex`,
// `cursor-agent` and `whisper-cli` (Homebrew, npm -g, ~/.local/bin) wouldn't be found. We read the
// user's login-shell PATH once and add the usual install locations.
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

let cachedPath: Promise<string> | null = null;

function loginShellPath(): Promise<string> {
  if (process.platform === "win32") return Promise.resolve("");
  const shell = process.env["SHELL"] || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", 'printf "__SUTRA_PATH__%s__END__" "$PATH"'], { timeout: 5000 }, (_e, out) => {
      resolve(String(out ?? "").match(/__SUTRA_PATH__(.*)__END__/)?.[1] ?? "");
    });
  });
}

/** The PATH to run user CLIs with (login shell PATH + current PATH + common install dirs). */
export function userPath(): Promise<string> {
  cachedPath ??= loginShellPath().then((shellPath) => {
    const home = homedir();
    const extra = process.platform === "win32"
      ? [join(process.env["APPDATA"] ?? "", "npm"), join(home, ".local", "bin")]
      : ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".npm-global", "bin"),
         join(home, ".bun", "bin"), join(home, ".volta", "bin"), join(home, ".claude", "local"), join(home, ".cursor", "bin")];
    const parts = [...shellPath.split(delimiter), ...(process.env["PATH"] ?? "").split(delimiter), ...extra].filter(Boolean);
    return [...new Set(parts)].join(delimiter);
  });
  return cachedPath;
}

/** First executable matching one of `names` on the user PATH, or null. */
export async function findBinary(names: string[]): Promise<string | null> {
  const dirs = (await userPath()).split(delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = join(dir, name + ext);
        try {
          if (!existsSync(p)) continue;
          if (process.platform !== "win32") accessSync(p, constants.X_OK);
          return p;
        } catch { /* not executable */ }
      }
    }
  }
  return null;
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Run a binary with an argument ARRAY (never a shell string), optional stdin, and a hard timeout. */
export async function runProcess(bin: string, args: string[], opts: { input?: string; timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  const env = { ...process.env, PATH: await userPath(), NO_COLOR: "1", CI: "1" };
  // Windows npm shims (.cmd) can only be launched through cmd.exe; refuse to pass untrusted text as args there.
  const shell = process.platform === "win32" && /\.cmd$/i.test(bin);
  if (shell && args.some((a) => /[&|<>^"%\r\n]/.test(a))) throw new Error("This CLI is installed as a .cmd shim; install the native binary to use it from Sutra.");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env, shell, windowsHide: true });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000); }, opts.timeoutMs ?? 180000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
