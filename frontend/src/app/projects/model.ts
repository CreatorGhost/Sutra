// PURE helpers for the Projects screens and the meeting's project chip (no DB, no React).
import type { ProjectTerm } from "../../local/repo";

/** Muted dots that read on both the dark and the light panel (same family as the speaker colours). */
export const PROJECT_COLORS = ["#7aa2ff", "#f5a97f", "#8bd5ca", "#c6a0f6", "#e5c07b", "#f0a6ca", "#91d7e3", "#a6da95"];

export interface ProjectLike { id: number; name?: string | null; color?: string | null }

/** A project's colour: the one the user picked, else a stable one from its id. */
export function projectColor(p: ProjectLike | null | undefined): string {
  if (!p) return "var(--text-3)";
  return p.color || PROJECT_COLORS[Math.abs(Number(p.id) || 0) % PROJECT_COLORS.length];
}

export function projectName(p: { name?: string | null } | null | undefined): string {
  return p?.name?.trim() || "Untitled project";
}

export type ChipState =
  | { kind: "mapped"; project: ProjectLike; auto: boolean }
  | { kind: "suggested"; project: ProjectLike }
  | { kind: "none" };

/** What the meeting's project chip shows: the mapping (with undo when it was automatic), a pending
 *  suggestion to confirm, or nothing yet. A suggestion for a deleted project is ignored. */
export function chipState(
  c: { project_id?: number | null; project_auto?: boolean | number | null; suggested_project_id?: number | null },
  projects: ProjectLike[],
): ChipState {
  if (c.project_id != null) {
    const project = projects.find((p) => p.id === c.project_id) ?? { id: Number(c.project_id) };
    return { kind: "mapped", project, auto: !!c.project_auto };
  }
  if (c.suggested_project_id != null) {
    const project = projects.find((p) => p.id === c.suggested_project_id);
    if (project) return { kind: "suggested", project };
  }
  return { kind: "none" };
}

/** Meetings per project id, from the sidebar's conversation rows. */
export function meetingCounts(rows: { project_id?: number | null }[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of rows) if (r.project_id != null) out.set(r.project_id, (out.get(r.project_id) ?? 0) + 1);
  return out;
}

/** "AI sensor, AI Sensi" → ["AI sensor", "AI Sensi"] (trimmed, blanks dropped). */
export function splitVariants(s: string): string[] {
  return s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Add a glossary term, or merge new "heard as" variants into an existing one (case-insensitive). */
export function addTerm(terms: ProjectTerm[], canonical: string, heardAs: string[] = []): ProjectTerm[] {
  const c = canonical.trim();
  if (!c) return terms;
  const i = terms.findIndex((t) => same(t.canonical, c));
  if (i < 0) return [...terms, { canonical: c, heardAs: dedupe(heardAs, c) }];
  return terms.map((t, k) => (k === i ? { ...t, heardAs: dedupe([...t.heardAs, ...heardAs], t.canonical) } : t));
}

export function removeTerm(terms: ProjectTerm[], canonical: string): ProjectTerm[] {
  return terms.filter((t) => !same(t.canonical, canonical));
}

export function removeHeardAs(terms: ProjectTerm[], canonical: string, variant: string): ProjectTerm[] {
  return terms.map((t) => (same(t.canonical, canonical) ? { ...t, heardAs: t.heardAs.filter((h) => !same(h, variant)) } : t));
}

function dedupe(xs: string[], canonical: string): string[] {
  const out: string[] = [];
  for (const x of xs.map((s) => s.trim())) {
    if (x && !same(x, canonical) && !out.some((o) => same(o, x))) out.push(x);
  }
  return out;
}

/** "Aditya, Ravi +2" — compact people line for the projects list. */
export function peopleLine(names: string[], count: number): string {
  if (!count) return "No people yet";
  const shown = names.slice(0, 2).join(", ");
  return count > 2 ? `${shown} +${count - 2}` : shown;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface Folder<M> { project: ProjectLike | null; meetings: M[]; total: number }

/** The sidebar's Projects view: one folder per project (most recently active first), then "Not in a
 *  project". With a query, a folder keeps only its matching meetings — all of them when the project's
 *  own name matches — and folders with nothing to show are dropped. `matches` is the meeting search. */
export function projectFolders<M extends { project_id?: number | null; started_at?: string | null; created_at?: string | null }>(
  rows: M[], projects: ProjectLike[], query: string, matches: (m: M, q: string) => boolean,
): Folder<M>[] {
  const q = query.trim().toLowerCase();
  const when = (m: M) => String(m.started_at ?? m.created_at ?? "");
  const sorted = [...rows].sort((a, b) => when(b).localeCompare(when(a)));
  const ids = new Set(projects.map((p) => p.id));
  const folders: (Folder<M> & { last: string })[] = [...projects, null].map((p) => {
    const all = sorted.filter((m) => (p ? m.project_id === p.id : m.project_id == null || !ids.has(m.project_id)));
    const nameHit = !!p && !!q && projectName(p).toLowerCase().includes(q);
    const meetings = !q || nameHit ? all : all.filter((m) => matches(m, q));
    return { project: p, meetings, total: all.length, last: all[0] ? when(all[0]) : "" };
  });
  return folders
    .filter((f) => (q ? f.meetings.length > 0 || (!!f.project && projectName(f.project).toLowerCase().includes(q)) : f.project || f.total))
    .sort((a, b) => (!a.project ? 1 : !b.project ? -1 : b.last.localeCompare(a.last)))
    .map(({ last: _last, ...f }) => f);
}
