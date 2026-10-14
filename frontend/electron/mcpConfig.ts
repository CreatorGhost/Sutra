// Pure config-file helpers for "Connect Sutra to your AI tool" (electron/mcpConnect.ts does the I/O).
// Every writer MERGES: it replaces only Sutra's own entry and leaves everything else in the file —
// other MCP servers, comments in TOML, unrelated settings — exactly as it was. Formats verified
// against the tools themselves (`codex mcp add`, `gemini mcp add -s user`, `claude mcp add -s user`
// write the same shapes):
//   • Claude Code      — `claude mcp add -s user sutra -e K=V -- <command> <args…>` (we drive its CLI)
//   • Codex            — ~/.codex/config.toml   [mcp_servers.sutra] command/args + [mcp_servers.sutra.env]
//   • Cursor           — ~/.cursor/mcp.json     { "mcpServers": { "sutra": { command, args, env } } }
//   • Gemini CLI       — ~/.gemini/settings.json (same mcpServers shape)
//   • Claude Desktop   — claude_desktop_config.json (same mcpServers shape)

export const SERVER_NAME = "sutra";

/** How an AI tool launches the Sutra MCP server (stdio). */
export interface ServerSpec { command: string; args: string[]; env: Record<string, string> }

export type ConfigFormat = "claude-cli" | "toml" | "json";

// ---- JSON (Cursor, Gemini CLI, Claude Desktop, generic) ------------------------------------------

function parseObject(text: string | null): Record<string, any> {
  if (text == null || !text.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(text); }
  catch { throw new Error("The existing file isn't plain JSON (it may contain comments), so Sutra won't rewrite it. Add the snippet by hand instead."); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("The existing file isn't a JSON object, so Sutra won't rewrite it.");
  return v as Record<string, any>;
}

export function jsonEntry(spec: ServerSpec): Record<string, unknown> {
  return { command: spec.command, args: spec.args, env: spec.env };
}

/** Set mcpServers.sutra in a JSON config, keeping every other key. Throws rather than clobber. */
export function mergeJsonServer(text: string | null, spec: ServerSpec, name = SERVER_NAME): string {
  const root = parseObject(text);
  const servers = root.mcpServers ?? {};
  if (typeof servers !== "object" || Array.isArray(servers)) throw new Error("\"mcpServers\" in the existing file isn't an object, so Sutra won't rewrite it.");
  root.mcpServers = { ...servers, [name]: jsonEntry(spec) };
  return JSON.stringify(root, null, 2) + "\n";
}

export function removeJsonServer(text: string | null, name = SERVER_NAME): string | null {
  const root = parseObject(text);
  if (!root.mcpServers || typeof root.mcpServers !== "object" || !(name in root.mcpServers)) return null;
  const { [name]: _gone, ...rest } = root.mcpServers;
  root.mcpServers = rest;
  return JSON.stringify(root, null, 2) + "\n";
}

/** The token a JSON config currently gives Sutra (to tell "connected" from "needs the new token"). */
export function jsonServerToken(text: string | null, name = SERVER_NAME): string | null | undefined {
  try {
    const s = parseObject(text).mcpServers?.[name];
    if (!s) return undefined;
    return typeof s.env?.SUTRA_MCP_TOKEN === "string" ? s.env.SUTRA_MCP_TOKEN : null;
  } catch { return undefined; }
}

// ---- TOML (Codex) ------------------------------------------------------------------------------

// JSON string escapes (\" \\ \n \uXXXX) are valid TOML basic-string escapes.
const tomlStr = (s: string) => JSON.stringify(s);
const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));

export function tomlBlock(spec: ServerSpec, name = SERVER_NAME): string {
  const lines = [
    `[mcp_servers.${tomlKey(name)}]`,
    `command = ${tomlStr(spec.command)}`,
    `args = [${spec.args.map(tomlStr).join(", ")}]`,
  ];
  const env = Object.entries(spec.env);
  if (env.length) {
    lines.push("", `[mcp_servers.${tomlKey(name)}.env]`);
    for (const [k, v] of env) lines.push(`${tomlKey(k)} = ${tomlStr(v)}`);
  }
  return lines.join("\n") + "\n";
}

/** Normalized dotted key of a table header line (`[mcp_servers."sutra".env]` → mcp_servers.sutra.env),
 *  or null if the line isn't a header. Array-of-tables headers count as headers too. */
function headerKey(line: string): string | null {
  const m = /^\s*\[\[?\s*([^\[\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
  if (!m) return null;
  return m[1].split(".").map((p) => p.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")).join(".");
}

/** Drop every [mcp_servers.<name>] / [mcp_servers.<name>.*] table, keeping all other lines. */
function stripTomlServer(text: string, name: string): { text: string; found: boolean } {
  const own = (k: string) => k === `mcp_servers.${name}` || k.startsWith(`mcp_servers.${name}.`);
  const out: string[] = [];
  let skipping = false;
  let found = false;
  let table = "";
  for (const line of text.split(/\r?\n/)) {
    const key = headerKey(line);
    if (key != null) { table = key; skipping = own(key); if (skipping) found = true; }
    // An inline `sutra = { … }` under [mcp_servers] (or a dotted key) we can't safely rewrite.
    if (!skipping && ((table === "mcp_servers" && new RegExp(`^\\s*"?${name}"?\\s*[.=]`).test(line)) ||
        (table === "" && new RegExp(`^\\s*mcp_servers\\s*\\.\\s*"?${name}"?\\s*[.=]`).test(line)))) {
      throw new Error("Your Codex config defines Sutra inline, so Sutra won't rewrite it. Replace that entry with the snippet by hand.");
    }
    if (!skipping) out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return { text: out.join("\n"), found };
}

export function upsertTomlServer(text: string | null, spec: ServerSpec, name = SERVER_NAME): string {
  const kept = stripTomlServer(text ?? "", name).text;
  return (kept ? kept + "\n\n" : "") + tomlBlock(spec, name);
}

export function removeTomlServer(text: string | null, name = SERVER_NAME): string | null {
  const r = stripTomlServer(text ?? "", name);
  return r.found ? (r.text ? r.text + "\n" : "") : null;
}

export function tomlServerToken(text: string | null, name = SERVER_NAME): string | null | undefined {
  let table = "";
  let seen = false;
  for (const line of (text ?? "").split(/\r?\n/)) {
    const key = headerKey(line);
    if (key != null) { table = key; if (key === `mcp_servers.${name}`) seen = true; continue; }
    if (table === `mcp_servers.${name}.env` || table === `mcp_servers.${name}`) {
      const m = /^\s*SUTRA_MCP_TOKEN\s*=\s*"([^"]*)"/.exec(line);
      if (m) return m[1];
    }
  }
  return seen ? null : undefined;
}

// ---- Claude Code CLI + display --------------------------------------------------------------------

export function claudeAddArgs(spec: ServerSpec, name = SERVER_NAME): string[] {
  const env = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["mcp", "add", "-s", "user", name, ...env, "--", spec.command, ...spec.args];
}

/** Quote one argument for display in the user's shell. */
export function shellQuote(arg: string, platform: string = process.platform): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  if (platform === "win32") return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** What to show the user for one tool: the exact command or file contents to add. */
export function snippetFor(format: ConfigFormat, spec: ServerSpec, platform: string = process.platform): string {
  if (format === "claude-cli") return ["claude", ...claudeAddArgs(spec)].map((a) => shellQuote(a, platform)).join(" ");
  if (format === "toml") return tomlBlock(spec);
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: jsonEntry(spec) } }, null, 2);
}
