import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escapeWindowsShellArg, findExecutable, knownCliDirs, parseCmdShim, resolveSpawn, windowsPathExts } from "../proc";

const shim = (name: string) => readFileSync(join(__dirname, "fixtures", "shims", name), "utf8");
const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";

describe("Windows .cmd shims", () => {
  it("parses npm's cmd-shim (node script), its .exe form, and pnpm's older form", () => {
    expect(parseCmdShim(shim("npm-claude.cmd"))).toEqual({ script: "node_modules\\@anthropic-ai\\claude-code\\cli.js", node: true });
    expect(parseCmdShim(shim("npm-exe-target.cmd"))).toEqual({ script: "node_modules\\@openai\\codex\\vendor\\codex.exe", node: false });
    expect(parseCmdShim(shim("pnpm-gemini.cmd"))).toEqual({ script: "..\\@google\\gemini-cli\\bundle\\gemini.js", node: true });
    expect(parseCmdShim(shim("custom.cmd"))).toBeNull();
  });

  const files = new Map<string, string>([
    [`${NPM}\\claude.cmd`, shim("npm-claude.cmd")],
    [`${NPM}\\codex.cmd`, shim("npm-exe-target.cmd")],
    [`${NPM}\\tool.cmd`, shim("custom.cmd")],
  ]);
  const exists = new Set([
    `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`,
    `${NPM}\\node_modules\\@openai\\codex\\vendor\\codex.exe`,
  ]);
  const base = { platform: "win32" as const, readFile: (p: string) => { const c = files.get(p); if (c == null) throw new Error("ENOENT"); return c; }, fileExists: (p: string) => exists.has(p) };
  const args = ["-p", "--json-schema", '{"type":"object"}', "--settings", "a&b|c%PATH%"];

  it("runs a node shim as `node <script>` — no cmd.exe, arguments untouched", () => {
    expect(resolveSpawn(`${NPM}\\claude.cmd`, args, { ...base, nodePath: "C:\\Program Files\\nodejs\\node.exe" }))
      .toEqual({ command: "C:\\Program Files\\nodejs\\node.exe", args: [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`, ...args], shell: false });
  });
  it("prefers a node.exe next to the shim, else Electron as Node", () => {
    const withBundled = { ...base, fileExists: (p: string) => exists.has(p) || p === `${NPM}\\node.exe` };
    expect(resolveSpawn(`${NPM}\\claude.cmd`, ["x"], withBundled).command).toBe(`${NPM}\\node.exe`);
    expect(resolveSpawn(`${NPM}\\claude.cmd`, ["x"], { ...base, nodePath: null, execPath: "C:\\Sutra\\Sutra.exe" }))
      .toEqual({ command: "C:\\Sutra\\Sutra.exe", args: [`${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`, "x"], shell: false, env: { ELECTRON_RUN_AS_NODE: "1" } });
  });
  it("starts an .exe shim target directly", () => {
    expect(resolveSpawn(`${NPM}\\codex.cmd`, ["exec", "-"], base)).toEqual({ command: `${NPM}\\node_modules\\@openai\\codex\\vendor\\codex.exe`, args: ["exec", "-"], shell: false });
  });
  it("falls back to cmd.exe only for unknown shims, with every argument escaped", () => {
    const r = resolveSpawn(`${NPM}\\tool.cmd`, ["a&b", 'say "hi"'], base);
    expect(r.shell).toBe(true);
    expect(r.args).toEqual(["^\"a^&b^\"", '^"say^ \\^"hi\\^"^"']);
  });
  it("leaves .exe and non-Windows binaries alone", () => {
    expect(resolveSpawn("C:\\x\\claude.exe", ["-p"], base)).toEqual({ command: "C:\\x\\claude.exe", args: ["-p"], shell: false });
    expect(resolveSpawn("/usr/local/bin/claude", ["-p"], { platform: "darwin" })).toEqual({ command: "/usr/local/bin/claude", args: ["-p"], shell: false });
  });
  it("escapes cmd metacharacters like cross-spawn", () => {
    expect(escapeWindowsShellArg("plain")).toBe('^"plain^"');
    expect(escapeWindowsShellArg("%PATH%")).toBe('^"^%PATH^%^"');
    expect(escapeWindowsShellArg("trail\\")).toBe('^"trail\\\\^"');
  });
});

describe("finding CLIs", () => {
  it("Windows: PATHEXT order, never the bare npm sh-script", () => {
    const present = new Set(["C:\\npm\\claude", "C:\\npm\\claude.cmd", "C:\\bin\\claude.exe"]);
    const o = { platform: "win32" as const, pathValue: "C:\\npm;\"C:\\bin\"", pathext: [".COM", ".EXE", ".BAT", ".CMD"], fileExists: (p: string) => present.has(p) };
    expect(findExecutable("claude", o)).toBe("C:\\npm\\claude.cmd");
    expect(findExecutable("claude", { ...o, pathValue: "C:\\bin;C:\\npm" })).toBe("C:\\bin\\claude.exe");
    expect(findExecutable("claude.exe", o)).toBe("C:\\bin\\claude.exe");
    expect(findExecutable("gemini", o)).toBeNull();
  });
  it("POSIX: needs the executable bit", () => {
    const o = { platform: "darwin" as const, pathValue: "/a:/b", fileExists: (p: string) => p === "/a/grok" || p === "/b/grok", canExec: (p: string) => p === "/b/grok" };
    expect(findExecutable("grok", o)).toBe("/b/grok");
  });
  it("PATHEXT parsing and known install dirs", () => {
    expect(windowsPathExts({ PATHEXT: ".com;.EXE;bat;;.CMD;.exe" })).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
    expect(windowsPathExts({})).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
    const dirs = knownCliDirs("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" }, "C:\\Users\\me");
    expect(dirs).toContain(NPM);
    expect(dirs).toContain("C:\\Users\\me\\.local\\bin");
    expect(knownCliDirs("darwin", {}, "/Users/me")).toContain("/opt/homebrew/bin");
  });
});
