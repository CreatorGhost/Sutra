// The Mac app's folder access: only folders picked in the system dialog are opened, reads stay inside
// them, and AGENTS.md is only ever created (never overwritten).
import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const userData = mkdtempSync(join(tmpdir(), "sutra-ud-"));
const handlers: Record<string, (...a: any[]) => any> = {};
const pickResult = { canceled: false, filePaths: [] as string[] };
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  dialog: { showOpenDialog: vi.fn(async () => pickResult) },
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => { handlers[ch] = fn; } },
  BrowserWindow: { fromWebContents: () => null },
  shell: { showItemInFolder: vi.fn() },
}));

let mod: typeof import("../projectFolders");
const ev = { sender: {} };
const repo = realpathSync(mkdtempSync(join(tmpdir(), "sutra-repo-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "sutra-secret-")));

beforeAll(async () => {
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "node_modules"));
  mkdirSync(join(repo, ".cursor/rules"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Acme\nShips widgets.");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "acme", scripts: { test: "vitest" } }));
  writeFileSync(join(repo, ".cursor/rules/style.mdc"), "Use tabs.");
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  symlinkSync(join(outside, "secret.txt"), join(repo, "CLAUDE.md")); // a link pointing out of the folder
  mod = await import("../projectFolders");
  mod.registerProjectFolderIpc();
});

describe("project folders on the Mac", () => {
  it("opens nothing the user didn't pick", async () => {
    await expect(mod.scanFolder(repo)).resolves.toMatchObject({ granted: false, exists: true, files: [] });
    expect(() => mod.writeAgentsFile(repo, "# hi")).toThrow(/can't write to that folder/);
    expect(mod.grantedWorkspace([repo, 42, "/etc"])).toEqual([]);
  });

  it("remembers a picked folder and reads its context files, staying inside it", async () => {
    pickResult.filePaths = [repo];
    expect(await handlers["sutra:folders:pick"](ev)).toBe(repo);
    expect(JSON.parse(readFileSync(join(userData, "project-folders.json"), "utf8")).folders).toEqual([repo]);
    const s = await mod.scanFolder(repo);
    expect(s.granted).toBe(true);
    expect(s.files.map((f) => f.rel)).toEqual(["README.md", "package.json", ".cursor/rules/style.mdc"]);
    expect(JSON.stringify(s)).not.toContain("TOP SECRET");       // the symlinked CLAUDE.md isn't followed out
    expect(s.entries).toEqual([".cursor/", "src/", "CLAUDE.md", "package.json", "README.md"]); // no node_modules
    expect(mod.grantedWorkspace([repo, outside])).toEqual([repo]);
  });

  it("creates AGENTS.md once and never overwrites it", async () => {
    const p = mod.writeAgentsFile(repo, "# Acme\n");
    expect(readFileSync(p, "utf8")).toBe("# Acme\n");
    expect(() => mod.writeAgentsFile(repo, "# Other\n")).toThrow(/already exists/);
    expect(readFileSync(p, "utf8")).toBe("# Acme\n");
    expect((await mod.scanFolder(repo)).files[0].rel).toBe("AGENTS.md");
  });

  it("names the people who commit to the code, from the git history", async () => {
    const git = (args: string[], name: string, email: string) => execFileSync("git", args, { cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const commit = (name: string, email: string, n: number) => {
      for (let i = 0; i < n; i++) git(["commit", "-q", "--allow-empty", "-m", `c${i}`], name, email);
    };
    commit("Riya Sharma", "riya@acme.dev", 3);
    commit("riya sharma", "riya.s@gmail.com", 1);          // the same person, another email
    commit("Dev Kumar", "dev@acme.dev", 2);
    commit("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com", 5);
    const s = await mod.scanFolder(repo);
    expect(s.contributors).toEqual([
      { name: "Riya Sharma", email: "riya.s@gmail.com", commits: 4 },
      { name: "Dev Kumar", email: "dev@acme.dev", commits: 2 },
    ]);
  });

  it("forgets a folder when asked", async () => {
    await handlers["sutra:folders:forget"](ev, repo);
    expect((await mod.scanFolder(repo)).granted).toBe(false);
    pickResult.canceled = true;
    expect(await handlers["sutra:folders:pick"](ev)).toBeNull();
  });
});
