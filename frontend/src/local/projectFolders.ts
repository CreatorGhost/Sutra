// A project's code folders, renderer side (desktop): link / unlink, read what the Mac app found in them,
// and the two drafting jobs over those files — "Fill from folder" (a brief plus suggested people and
// glossary terms; the user accepts each) and "Create AGENTS.md" (a draft the user edits before it's
// written). The prompts and parsing are in shared/projectFolders.ts; the file access is main's.
import type { Provider } from "../providers/provider";
import { desktop } from "../desktop/bridge";
import {
  AGENTS_SCHEMA, AGENTS_SYSTEM, FILL_SCHEMA, FILL_SYSTEM, parseFillSuggestion, projectPrompt, tidyAgentsFile,
  type FillSuggestion, type FolderScan,
} from "../shared/projectFolders";
import * as repo from "./repo";

const folders = () => {
  if (!desktop?.folders) throw new Error("Code folders are linked in the Sutra desktop app.");
  return desktop.folders;
};

/** Pick a folder in the system dialog and link it; null when the user cancelled. */
export async function linkFolder(projectId: number): Promise<string | null> {
  const path = await folders().pick();
  if (!path) return null;
  await repo.addProjectFolder(projectId, path);
  return path;
}

export async function unlinkFolder(projectId: number, path: string): Promise<void> {
  await repo.removeProjectFolder(projectId, path);
  // The Mac app keeps its permission while any project still links the folder.
  if (!(await repo.folderStillLinked(path))) await folders().forget(path).catch(() => {});
}

export const scanFolders = (paths: string[]): Promise<FolderScan[]> => Promise.all(paths.map((p) => folders().scan(p)));

async function projectAndScans(projectId: number) {
  const p: any = await repo.getProject(projectId);
  if (!p) throw new Error("Project not found.");
  const scans = (await scanFolders(p.folders ?? [])).filter((s) => s.granted && s.exists);
  if (!scans.length) throw new Error("Link a code folder first.");
  const people = (p.people ?? []).map((m: any) => ({ name: String(m.canonical_name ?? ""), role: m.role ?? null })).filter((m: any) => m.name);
  return { p, scans, people };
}

/** Read the project's folders and suggest a brief, people and glossary terms (nothing is saved here). */
export async function suggestFromFolders(projectId: number, provider: Provider): Promise<FillSuggestion> {
  const { p, scans, people } = await projectAndScans(projectId);
  const out = await provider.extract(FILL_SCHEMA, FILL_SYSTEM, projectPrompt({ name: p.name, brief: p.brief, people, terms: p.terms }, scans));
  // Everyone who commits to the code (git history) is suggested too, most active first.
  const contributors = scans.flatMap((s) => s.contributors ?? []);
  return parseFillSuggestion(out, { people: people.map((m: any) => m.name), terms: (p.terms ?? []).map((t: any) => t.canonical), briefCap: repo.BRIEF_CAP, contributors });
}

/** Draft an AGENTS.md for one of the project's folders from its files and the project's people/glossary. */
export async function draftAgentsFile(projectId: number, folder: string, provider: Provider): Promise<string> {
  const { p, scans, people } = await projectAndScans(projectId);
  const target = scans.filter((s) => s.path === folder);
  if (!target.length) throw new Error("Sutra can't open that folder — link it again.");
  const out = await provider.extract(AGENTS_SCHEMA, AGENTS_SYSTEM, projectPrompt({ name: p.name, brief: p.brief, people, terms: p.terms }, target));
  const text = tidyAgentsFile(out?.content);
  if (!text) throw new Error("The AI didn't return a draft — try again.");
  return text;
}

export const saveAgentsFile = (folder: string, content: string) => folders().writeAgents(folder, content);
