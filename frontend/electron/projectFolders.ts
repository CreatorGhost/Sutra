// A project's code folders on this Mac. The renderer stores which folders a project links (its own
// database), but this process only ever opens folders the user picked in the system folder dialog: those
// are remembered here (userData/project-folders.json) and every read, the AGENTS.md write and an agent's
// working directory are checked against that list. Reads are capped and stay inside the folder (no
// following symlinks out of it); the only write is a new AGENTS.md, never an overwrite.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync, lstatSync, openSync, readFileSync, readSync, closeSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  AGENTS_FILE, AGENTS_FILE_CAP, CONTEXT_FILES, CURSOR_RULES_DIR, FILE_CAP, GIT_AUTHORS_ARGS, MAX_RULE_FILES, folderName, keepEntry, parseGitAuthors,
  type Contributor, type FolderFile, type FolderScan,
} from "../src/shared/projectFolders";
import { findBinary, runProcess } from "./proc";

const grantsFile = () => join(app.getPath("userData"), "project-folders.json");
let grants: Set<string> | null = null;

function load(): Set<string> {
  if (grants) return grants;
  try {
    const raw = JSON.parse(readFileSync(grantsFile(), "utf8"));
    grants = new Set(Array.isArray(raw?.folders) ? raw.folders.filter((p: unknown) => typeof p === "string") : []);
  } catch { grants = new Set(); }
  return grants;
}
function save(): void {
  try { writeFileSync(grantsFile(), JSON.stringify({ folders: [...load()] }, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
}

const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

/** The folder's real path when the user granted it here, else null. */
export function grantedFolder(p: unknown): string | null {
  if (typeof p !== "string" || !p || p.length > 4096) return null;
  if (!load().has(p)) return null;
  return real(p) ? p : null;
}

/** Folders an agent may read for this request: granted ones only, at most 8. */
export const grantedWorkspace = (paths: unknown): string[] =>
  (Array.isArray(paths) ? paths : []).map(grantedFolder).filter((p): p is string => !!p).slice(0, 8);

/** First `cap` bytes of a regular file that really lives inside `root`. */
function readInside(root: string, rel: string, cap = FILE_CAP): FolderFile | null {
  const p = join(root, rel);
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return null;
    const r = real(p);
    const rootReal = real(root);
    if (!r || !rootReal || !r.startsWith(rootReal + sep)) return null;
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(Math.min(cap, st.size));
      const n = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString("utf8");
      if (text.includes("\u0000")) return null; // binary
      return { rel, text, truncated: st.size > cap };
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** Who commits in this folder's git repository (none when it isn't one, or git isn't installed). */
async function gitContributors(root: string): Promise<Contributor[]> {
  if (!existsSync(join(root, ".git"))) return [];
  const git = await findBinary(["git"]);
  if (!git) return [];
  try {
    const r = await runProcess(git, GIT_AUTHORS_ARGS, { cwd: root, timeoutMs: 6000, env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    return r.code === 0 ? parseGitAuthors(r.stdout) : [];
  } catch { return []; }
}

export async function scanFolder(p: string): Promise<FolderScan> {
  const scan = scanFiles(p);
  const root = scan.granted && scan.exists ? grantedFolder(p) : null;
  return root ? { ...scan, contributors: await gitContributors(root) } : scan;
}

function scanFiles(p: string): FolderScan {
  const name = folderName(p);
  const root = grantedFolder(p);
  if (!root) return { path: p, name, granted: load().has(p), exists: existsSync(p), files: [], entries: [] };
  const files: FolderFile[] = [];
  for (const rel of CONTEXT_FILES) {
    if (rel === "readme.md" && files.some((f) => f.rel === "README.md")) continue; // case-insensitive file systems
    const f = readInside(root, rel);
    if (f) files.push(f);
  }
  try {
    const rules = readdirSync(join(root, CURSOR_RULES_DIR)).filter((n) => /\.(mdc|md)$/i.test(n)).sort().slice(0, MAX_RULE_FILES);
    for (const n of rules) { const f = readInside(root, `${CURSOR_RULES_DIR}/${n}`, 8000); if (f) files.push(f); }
  } catch { /* no Cursor rules */ }
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => keepEntry(d.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 80).map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
  } catch { /* unreadable */ }
  return { path: p, name, granted: true, exists: true, files, entries };
}

/** Write a new AGENTS.md into a granted folder; refuses to replace an existing one. */
export function writeAgentsFile(p: string, content: unknown): string {
  const root = grantedFolder(p);
  if (!root) throw new Error("Sutra can't write to that folder — link it again from the project page.");
  const text = String(content ?? "");
  if (!text.trim()) throw new Error("The AGENTS.md draft is empty.");
  if (text.length > AGENTS_FILE_CAP) throw new Error("That AGENTS.md is too long.");
  const target = join(root, AGENTS_FILE);
  try { writeFileSync(target, text, { flag: "wx" }); }
  catch (e: any) {
    if (e?.code === "EEXIST") throw new Error(`${AGENTS_FILE} already exists in ${folderName(root)} — Sutra won't overwrite it.`);
    throw new Error(`Couldn't write ${AGENTS_FILE}: ${e?.message ?? e}`);
  }
  return target;
}

export function registerProjectFolderIpc(): void {
  ipcMain.handle("sutra:folders:pick", async (e) => {
    const owner = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts = { title: "Link a code folder", buttonLabel: "Link folder", properties: ["openDirectory" as const] };
    const r = owner ? await dialog.showOpenDialog(owner, opts) : await dialog.showOpenDialog(opts);
    const picked = r.canceled ? null : r.filePaths[0];
    const p = picked ? real(picked) : null;
    if (!p) return null;
    load().add(p);
    save();
    return p;
  });
  ipcMain.handle("sutra:folders:forget", (_e, p: string) => { if (load().delete(String(p))) save(); });
  ipcMain.handle("sutra:folders:scan", (_e, p: string) => scanFolder(String(p)));
  ipcMain.handle("sutra:folders:writeAgents", (_e, p: string, content: string) => writeAgentsFile(String(p), content));
  ipcMain.handle("sutra:folders:reveal", (_e, p: string, rel?: string) => {
    const root = grantedFolder(p);
    if (!root) return false;
    const target = typeof rel === "string" && rel && !rel.split(/[\\/]/).includes("..") ? join(root, rel) : root;
    if (!existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });
}
