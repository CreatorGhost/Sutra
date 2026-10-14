// "Connect Sutra to your AI tool" — MAIN process side. Sutra's memory reaches Claude Code, Codex,
// Cursor, Gemini CLI and Claude Desktop through the local MCP server in mcp-server/: each tool
// launches it over stdio, the server listens on 127.0.0.1:8765, and the renderer's bridge
// (src/lib/mcpBridge.ts) dials out to it with the pairing token.
//
// How a tool launches the server: with THIS app's own binary in Node mode (ELECTRON_RUN_AS_NODE=1),
// so users don't need Node installed. The server is a single bundled file:
//   • packaged — <resources>/mcp-server/sutra-mcp.cjs (electron-builder extraResources)
//   • dev      — <repo>/mcp-server/dist/sutra-mcp.cjs (cd mcp-server && npm install && npm run build)
//
// Installing never clobbers: we merge only Sutra's entry (electron/mcpConfig.ts), back the file up
// first (<file>.sutra-backup-<time>), and return exactly what was written so the UI can show it.
import { app } from "electron";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  SERVER_NAME, claudeAddArgs, jsonServerToken, mergeJsonServer, removeJsonServer, removeTomlServer,
  snippetFor, tomlServerToken, upsertTomlServer, type ConfigFormat, type ServerSpec,
} from "./mcpConfig";
import { findBinary, runProcess } from "./proc";

export type McpClientId = "claude-code" | "codex" | "cursor" | "gemini" | "claude-desktop";

interface ClientDef {
  id: McpClientId;
  label: string;
  format: ConfigFormat;
  binaries: string[];
  /** The config file Sutra edits (or, for Claude Code, reads to check the connection). */
  file: () => string;
  /** Where the user can get the tool, for the "not found" hint. */
  install: string;
}

const home = () => homedir();
const CLIENTS: ClientDef[] = [
  { id: "claude-code", label: "Claude Code", format: "claude-cli", binaries: ["claude"],
    file: () => join(process.env["CLAUDE_CONFIG_DIR"] || home(), ".claude.json"), install: "npm install -g @anthropic-ai/claude-code" },
  { id: "codex", label: "Codex", format: "toml", binaries: ["codex"],
    file: () => join(process.env["CODEX_HOME"] || join(home(), ".codex"), "config.toml"), install: "npm install -g @openai/codex" },
  { id: "cursor", label: "Cursor", format: "json", binaries: ["cursor", "cursor-agent"],
    file: () => join(home(), ".cursor", "mcp.json"), install: "https://cursor.com" },
  { id: "gemini", label: "Gemini CLI", format: "json", binaries: ["gemini"],
    file: () => join(process.env["GEMINI_CLI_HOME"] || home(), ".gemini", "settings.json"), install: "npm install -g @google/gemini-cli" },
  { id: "claude-desktop", label: "Claude Desktop", format: "json", binaries: [],
    file: () => join(app.getPath("appData"), "Claude", "claude_desktop_config.json"), install: "https://claude.ai/download" },
];
// Claude Desktop has no Linux build.
const clients = () => CLIENTS.filter((c) => !(c.id === "claude-desktop" && process.platform === "linux"));

// ---- the server Sutra hands to each tool ------------------------------------------------------

function serverScript(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "mcp-server", "sutra-mcp.cjs")]
    : [resolve(app.getAppPath(), "..", "mcp-server", "dist", "sutra-mcp.cjs"), resolve(__dirname, "../../../mcp-server/dist/sutra-mcp.cjs")];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The port the renderer's bridge dials, when it isn't the server's default 8765. */
function portFrom(url?: string): string | null {
  const m = /^wss?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i.exec(String(url ?? ""));
  return m && m[1] !== "8765" ? m[1] : null;
}

export function serverSpec(token: string, bridgeUrl?: string): ServerSpec {
  const script = serverScript() ?? (app.isPackaged ? join(process.resourcesPath, "mcp-server", "sutra-mcp.cjs") : resolve(app.getAppPath(), "..", "mcp-server", "dist", "sutra-mcp.cjs"));
  const env: Record<string, string> = { SUTRA_MCP_TOKEN: token, ELECTRON_RUN_AS_NODE: "1" };
  const port = portFrom(bridgeUrl);
  if (port) env["SUTRA_BRIDGE_PORT"] = port;
  return { command: process.execPath, args: [script], env };
}

// ---- status ----------------------------------------------------------------------------------

export type McpConfigured = "no" | "yes" | "stale";
export interface McpClientStatus { id: McpClientId; label: string; format: ConfigFormat; detected: boolean; configured: McpConfigured; configPath: string; install: string }
export interface McpServerStatus { ready: boolean; script: string | null; hint: string | null }

const readText = (p: string) => readFile(p, "utf8").catch(() => null);

async function configuredToken(c: ClientDef): Promise<string | null | undefined> {
  const text = await readText(c.file());
  if (text == null) return undefined;
  if (c.format === "toml") return tomlServerToken(text);
  return jsonServerToken(text); // Claude Code keeps user-scope servers in ~/.claude.json mcpServers
}

export async function mcpStatus(token: string): Promise<{ server: McpServerStatus; clients: McpClientStatus[] }> {
  const script = serverScript();
  const server: McpServerStatus = {
    ready: !!script,
    script,
    hint: script ? null : app.isPackaged
      ? "This build is missing its MCP server. Reinstall Sutra."
      : "Build the MCP server first: cd mcp-server && npm install && npm run build",
  };
  const list = await Promise.all(clients().map(async (c): Promise<McpClientStatus> => {
    const [bin, tok] = await Promise.all([c.binaries.length ? findBinary(c.binaries) : Promise.resolve(null), configuredToken(c)]);
    const dirExists = existsSync(dirname(c.file())) && c.id !== "claude-code"; // ~ always exists
    return {
      id: c.id, label: c.label, format: c.format, configPath: c.file(), install: c.install,
      detected: !!bin || dirExists || tok !== undefined,
      configured: tok === undefined ? "no" : tok && tok === token ? "yes" : "stale",
    };
  }));
  return { server, clients: list };
}

export function mcpSnippet(id: McpClientId | "other", token: string, bridgeUrl?: string): string {
  const c = CLIENTS.find((x) => x.id === id);
  return snippetFor(c?.format ?? "json", serverSpec(token, bridgeUrl));
}

// ---- install / remove ------------------------------------------------------------------------

export interface McpWriteResult { path: string; backup: string | null; written: string; message: string }

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function backup(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const to = `${path}.sutra-backup-${stamp()}`;
  await copyFile(path, to);
  await chmod(to, 0o600).catch(() => {}); // it holds tokens/credentials just like the original
  return to;
}

/** Atomic replace that keeps the original file mode (new files: 0600 — they hold the token). */
async function writeConfig(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = await stat(path).then((s) => s.mode & 0o777, () => 0o600);
  const tmp = `${path}.sutra-tmp-${process.pid}`;
  await writeFile(tmp, text, { mode });
  await rename(tmp, path);
}

async function claudeCli(): Promise<string> {
  const bin = await findBinary(["claude"]);
  if (!bin) throw new Error("Claude Code isn't installed (no `claude` on your PATH). Install it, or run the command below yourself.");
  return bin;
}

export async function mcpInstall(id: McpClientId, token: string, bridgeUrl?: string): Promise<McpWriteResult> {
  const c = CLIENTS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown tool: ${id}`);
  if (!/^[0-9a-f]{16,128}$/i.test(token)) throw new Error("Generate a pairing token first.");
  if (!serverScript()) throw new Error((await mcpStatus(token)).server.hint ?? "The MCP server isn't available.");
  const spec = serverSpec(token, bridgeUrl);
  const path = c.file();

  if (c.format === "claude-cli") {
    const bin = await claudeCli();
    const saved = await backup(path);
    // `mcp add` refuses to overwrite, so drop any earlier Sutra entry first (a no-op if none).
    await runProcess(bin, ["mcp", "remove", "-s", "user", SERVER_NAME], { timeoutMs: 30000 }).catch(() => null);
    const r = await runProcess(bin, claudeAddArgs(spec), { timeoutMs: 30000 });
    if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    return { path, backup: saved, written: snippetFor("claude-cli", spec), message: "Added to Claude Code (all projects). Start a new Claude Code session to use it." };
  }

  const before = await readText(path);
  const after = c.format === "toml" ? upsertTomlServer(before, spec) : mergeJsonServer(before, spec);
  const saved = await backup(path);
  await writeConfig(path, after);
  return { path, backup: saved, written: snippetFor(c.format, spec), message: `Added to ${c.label}. Restart ${c.label} to pick it up.` };
}

export async function mcpRemove(id: McpClientId): Promise<McpWriteResult> {
  const c = CLIENTS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown tool: ${id}`);
  const path = c.file();
  if (c.format === "claude-cli") {
    const bin = await claudeCli();
    const saved = await backup(path);
    await runProcess(bin, ["mcp", "remove", "-s", "user", SERVER_NAME], { timeoutMs: 30000 });
    return { path, backup: saved, written: "", message: "Removed from Claude Code." };
  }
  const before = await readText(path);
  const after = c.format === "toml" ? removeTomlServer(before) : removeJsonServer(before);
  if (after == null) return { path, backup: null, written: "", message: `Sutra wasn't set up in ${c.label}.` };
  const saved = await backup(path);
  await writeConfig(path, after);
  return { path, backup: saved, written: "", message: `Removed from ${c.label}.` };
}
