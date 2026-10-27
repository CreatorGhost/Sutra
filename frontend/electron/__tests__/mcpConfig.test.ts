import { describe, expect, it } from "vitest";
import {
  claudeAddArgs, jsonServerToken, mergeJsonServer, removeJsonServer, removeTomlServer, shellQuote, snippetFor,
  tomlServerToken, upsertTomlServer, type ServerSpec,
} from "../mcpConfig";

const spec: ServerSpec = {
  command: "/Applications/Sutra.app/Contents/MacOS/Sutra",
  args: ["/Applications/Sutra.app/Contents/Resources/mcp-server/sutra-mcp.cjs"],
  env: { SUTRA_MCP_TOKEN: "abc123", ELECTRON_RUN_AS_NODE: "1" },
};

describe("JSON configs (Cursor / Gemini / Claude Desktop)", () => {
  it("adds Sutra next to existing servers and settings without touching them", () => {
    const before = JSON.stringify({ theme: "dark", mcpServers: { github: { command: "gh-mcp", args: [] } } });
    const out = JSON.parse(mergeJsonServer(before, spec));
    expect(out.theme).toBe("dark");
    expect(out.mcpServers.github).toEqual({ command: "gh-mcp", args: [] });
    expect(out.mcpServers.sutra).toEqual({ command: spec.command, args: spec.args, env: spec.env });
  });

  it("creates the file content from nothing and replaces an older Sutra entry", () => {
    const first = mergeJsonServer(null, { ...spec, env: { SUTRA_MCP_TOKEN: "old" } });
    expect(jsonServerToken(first)).toBe("old");
    const second = mergeJsonServer(first, spec);
    expect(jsonServerToken(second)).toBe("abc123");
    expect(Object.keys(JSON.parse(second).mcpServers)).toEqual(["sutra"]);
  });

  it("refuses to rewrite files it can't parse faithfully", () => {
    expect(() => mergeJsonServer("{ // comment\n \"a\": 1 }", spec)).toThrow(/comments/);
    expect(() => mergeJsonServer("[1,2]", spec)).toThrow(/object/);
    expect(() => mergeJsonServer(JSON.stringify({ mcpServers: [] }), spec)).toThrow(/mcpServers/);
  });

  it("removes only Sutra, and reports when there was nothing to remove", () => {
    const text = mergeJsonServer(JSON.stringify({ mcpServers: { other: { command: "x" } } }), spec);
    expect(JSON.parse(removeJsonServer(text)!).mcpServers).toEqual({ other: { command: "x" } });
    expect(removeJsonServer(JSON.stringify({ mcpServers: { other: {} } }))).toBeNull();
    expect(jsonServerToken(JSON.stringify({ mcpServers: {} }))).toBeUndefined();
  });
});

describe("Codex config.toml", () => {
  const existing = [
    "# my codex config",
    'model = "o3"',
    "",
    "[mcp_servers.github]",
    'command = "gh-mcp"',
    "",
    "[mcp_servers.sutra]",
    'command = "/old/path"',
    'args = ["/old/server.js"]',
    "",
    "[mcp_servers.sutra.env]",
    'SUTRA_MCP_TOKEN = "stale"',
    "",
    '[profiles."work"]',
    'model = "gpt-5"',
    "",
  ].join("\n");

  it("writes the same shape `codex mcp add` does", () => {
    expect(upsertTomlServer(null, spec)).toBe([
      "[mcp_servers.sutra]",
      `command = "${spec.command}"`,
      `args = ["${spec.args[0]}"]`,
      "",
      "[mcp_servers.sutra.env]",
      'SUTRA_MCP_TOKEN = "abc123"',
      'ELECTRON_RUN_AS_NODE = "1"',
      "",
    ].join("\n"));
  });

  it("replaces the old Sutra tables and keeps comments, other servers and later tables", () => {
    expect(tomlServerToken(existing)).toBe("stale");
    const out = upsertTomlServer(existing, spec);
    expect(out).toContain("# my codex config");
    expect(out).toContain('[mcp_servers.github]\ncommand = "gh-mcp"');
    expect(out).toContain('[profiles."work"]\nmodel = "gpt-5"');
    expect(out).not.toContain("/old/path");
    expect(out.match(/\[mcp_servers\.sutra\]/g)).toHaveLength(1);
    expect(tomlServerToken(out)).toBe("abc123");
  });

  it("escapes Windows paths and quotes as TOML basic strings", () => {
    const out = upsertTomlServer("", { command: 'C:\\Program Files\\Sutra\\Sutra.exe', args: ['C:\\a "b"\\s.cjs'], env: {} });
    expect(out).toContain('command = "C:\\\\Program Files\\\\Sutra\\\\Sutra.exe"');
    expect(out).toContain('args = ["C:\\\\a \\"b\\"\\\\s.cjs"]');
  });

  it("removes Sutra cleanly and refuses inline definitions", () => {
    const out = removeTomlServer(existing)!;
    expect(out).not.toContain("sutra");
    expect(out).toContain('[profiles."work"]');
    expect(removeTomlServer('model = "o3"\n')).toBeNull();
    expect(() => upsertTomlServer('[mcp_servers]\nsutra = { command = "x" }\n', spec)).toThrow(/inline/);
  });
});

describe("Claude Code + display", () => {
  it("builds a user-scope `claude mcp add` with env before the command", () => {
    expect(claudeAddArgs(spec)).toEqual([
      "mcp", "add", "-s", "user", "sutra", "-e", "SUTRA_MCP_TOKEN=abc123", "-e", "ELECTRON_RUN_AS_NODE=1",
      "--", spec.command, spec.args[0],
    ]);
  });

  it("quotes paths with spaces for the shell", () => {
    expect(shellQuote("/a b/it's", "darwin")).toBe(`'/a b/it'\\''s'`);
    expect(shellQuote("C:\\Program Files\\x", "win32")).toBe('"C:\\Program Files\\x"');
    expect(snippetFor("claude-cli", { ...spec, command: "/a b/Sutra" }, "darwin")).toMatch(/^claude mcp add -s user sutra -e SUTRA_MCP_TOKEN=abc123 .* -- '\/a b\/Sutra' /);
    expect(JSON.parse(snippetFor("json", spec)).mcpServers.sutra.env.SUTRA_MCP_TOKEN).toBe("abc123");
  });
});
