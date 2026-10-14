import { describe, expect, it } from "vitest";
import {
  folderDigest, folderName, parseGitAuthors, hasAgentFile, isAgentFile, keepEntry, parseFillSuggestion, projectPrompt, tidyAgentsFile, workspacePreamble,
  type FolderScan,
} from "../projectFolders";
import { agentInvocation, buildAgentPrompt, READ_ONLY_CLAUDE_TOOLS } from "../agentProtocol";

const scan = (over: Partial<FolderScan> = {}): FolderScan => ({
  path: "/code/acme", name: "acme", granted: true, exists: true, entries: ["src/", "package.json"],
  files: [{ rel: "README.md", text: "# Acme\nShips widgets.", truncated: false }], ...over,
});

describe("project folders — files", () => {
  it("knows which files are agent instructions", () => {
    for (const f of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".github/copilot-instructions.md", ".cursor/rules/style.mdc"]) expect(isAgentFile(f)).toBe(true);
    for (const f of ["README.md", "package.json", "docs/AGENTS.md"]) expect(isAgentFile(f)).toBe(false);
    expect(hasAgentFile(scan())).toBe(false);
    expect(hasAgentFile(scan({ files: [{ rel: "CLAUDE.md", text: "x", truncated: false }] }))).toBe(true);
  });

  it("lists the layout without dependency or build noise", () => {
    expect(["src", ".github", ".cursor", "README.md"].every(keepEntry)).toBe(true);
    expect(["node_modules", ".git", "dist", ".env", ".DS_Store"].some(keepEntry)).toBe(false);
    expect(folderName("/Users/a/code/acme/")).toBe("acme");
    expect(folderName("C:\\code\\acme")).toBe("acme");
  });

  it("summarises folders for a prompt within a budget, skipping folders it can't open", () => {
    const big = scan({ files: [{ rel: "README.md", text: "x".repeat(5000), truncated: false }, { rel: "package.json", text: "{}", truncated: false }] });
    const d = folderDigest([big, scan({ name: "gone", granted: false })], 1200);
    expect(d).toContain('<folder name="acme">');
    expect(d).toContain("Top level: src/, package.json");
    expect(d).toContain("…(truncated)");
    expect(d).not.toContain("gone");
    expect(d.length).toBeLessThan(1600);
  });

  it("puts the user's own project context ahead of the files", () => {
    const p = projectPrompt({ name: "Acme", brief: "Widgets for shops.", people: [{ name: "Riya", role: "PM" }], terms: [{ canonical: "Supabase" }] }, [scan()]);
    expect(p.indexOf("Widgets for shops.")).toBeLessThan(p.indexOf("# Project files"));
    expect(p).toContain("- Riya — PM");
    expect(p).toContain("Glossary: Supabase");
  });
});

describe("project folders — suggestions", () => {
  it("drops what the project already has, tidies and caps", () => {
    const s = parseFillSuggestion({
      brief: "  Acme ships widgets.  ",
      people: [{ name: "Riya", role: "PM" }, { name: "  Dev  Kumar ", role: "" }, { name: "dev kumar", role: "dup" }, { name: "" }],
      terms: [{ canonical: "Supabase", heardAs: ["super base", "Supabase", "soupa base", "x", "y"] }, { canonical: "AiSensy", heardAs: [] }],
    }, { people: ["riya"], terms: ["aisensy"] });
    expect(s.brief).toBe("Acme ships widgets.");
    expect(s.people).toEqual([{ name: "Dev Kumar", role: null }]);
    expect(s.terms).toEqual([{ canonical: "Supabase", heardAs: ["super base", "soupa base", "x"] }]);
    expect(parseFillSuggestion(null)).toEqual({ brief: "", people: [], terms: [] });
  });

  it("suggests everyone who commits, most active first, with the AI's roles where it found them", () => {
    const contributors = parseGitAuthors([
      "Riya Sharma\triya@acme.dev", "Riya Sharma\triya@acme.dev", "Dev Kumar\tdev@acme.dev", "renovate[bot]\tbot@renovatebot.com",
      "Asha\t123+asha@users.noreply.github.com", "github-actions\tactions@github.com", "Riya Sharma\triya@acme.dev",
    ].join("\n"));
    expect(contributors).toEqual([
      { name: "Riya Sharma", email: "riya@acme.dev", commits: 3 },
      { name: "Asha", email: null, commits: 1 },
      { name: "Dev Kumar", email: "dev@acme.dev", commits: 1 },
    ]);
    const s = parseFillSuggestion({ brief: "", terms: [], people: [{ name: "Dev Kumar", role: "Dashboard" }, { name: "Mira", role: "Designer" }] },
      { people: ["asha"], contributors });
    expect(s.people).toEqual([
      { name: "Riya Sharma", role: null, commits: 3 },
      { name: "Dev Kumar", role: "Dashboard", commits: 1 },
      { name: "Mira", role: "Designer" },
    ]); // Asha is already on the project
    expect(folderDigest([{ ...scan(), contributors }])).toContain("Contributors (git, by commits): Riya Sharma (3), Asha (1), Dev Kumar (1)");
  });

  it("writes AGENTS.md as plain markdown, unwrapped from a code fence", () => {
    expect(tidyAgentsFile("```markdown\n# Acme\n\nHi\n```")).toBe("# Acme\n\nHi\n");
    expect(tidyAgentsFile("  # Acme  ")).toBe("# Acme\n");
    expect(tidyAgentsFile("")).toBe("");
  });
});

describe("Ask inside a project folder", () => {
  const req = { system: "sys", user: "q", workspace: ["/code/acme", "/code/acme-api"] };

  it("tells the agent it may read the folder, never change it", () => {
    const p = buildAgentPrompt(req, false);
    expect(p).toContain(workspacePreamble(req.workspace));
    expect(p).toContain("Never create, edit or delete files");
    expect(p).not.toContain("Do not use tools");
    expect(buildAgentPrompt({ system: "s", user: "u" }, false)).toContain("Do not use tools");
  });

  it("Claude Code gets only read/search tools, pre-approved, with every folder added and no project MCP", () => {
    const a = agentInvocation("claude", req, "/tmp/x").args;
    expect(a[a.indexOf("--tools") + 1]).toBe(READ_ONLY_CLAUDE_TOOLS);
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob");
    expect(a.filter((_, i) => a[i - 1] === "--add-dir")).toEqual(["/code/acme", "/code/acme-api"]);
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("dontAsk");
    const plain = agentInvocation("claude", { system: "s", user: "u" }, "/tmp/x").args;
    expect(plain[plain.indexOf("--tools") + 1]).toBe("");
    expect(plain).not.toContain("--allowedTools");
  });

  it("Codex stays in its read-only sandbox, never rooted in the folder; Gemini stays in plan mode", () => {
    const c = agentInvocation("codex", req, "/tmp/x").args;
    expect(c.slice(c.indexOf("-s"), c.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);
    // Rooting Codex in the project (-C) would load that project's own config.
    expect(c).not.toContain("-C");
    const g = agentInvocation("gemini", req, "/tmp/x").args;
    expect(g[g.indexOf("--approval-mode") + 1]).toBe("plan");
    expect(g[g.indexOf("--include-directories") + 1]).toBe("/code/acme,/code/acme-api");
  });
});

describe("screenshots in an agent run", () => {
  const req = { system: "s", user: "u", imageFiles: ["/tmp/run/S01.jpg", "/tmp/run/S02.jpg"] };
  it("Claude opens them with Read only; Codex attaches each; Command Code refuses", () => {
    const a = agentInvocation("claude", req, "/tmp/run").args;
    expect(a[a.indexOf("--tools") + 1]).toBe("Read");
    expect(a[a.indexOf("--allowedTools") + 1]).toBe("Read");
    const c = agentInvocation("codex", req, "/tmp/run").args;
    expect(c.slice(0, 3)).toEqual(["exec", "--image=/tmp/run/S01.jpg", "--image=/tmp/run/S02.jpg"]);
    expect(c.at(-1)).toBe("-");
    expect(() => agentInvocation("commandcode", req, "/tmp/run")).toThrow(/can't look at screenshots/);
    const p = buildAgentPrompt(req, false);
    expect(p).toContain("Screenshots taken during the meeting are provided (2): S01.jpg, S02.jpg");
    expect(p).not.toContain("Do not use tools");
  });
});
