// PURE: shape stored Minutes of Meeting into what the Minutes style renders (empty sections dropped).
import type { Minutes } from "../../local/minutes";

export interface MinutesViewModel {
  title: string | null;
  summary: string | null;
  attendees: string[];
  sections: { key: string; heading: string; items: string[] }[];
  actions: { task: string; owner: string | null; due: string | null }[];
  nextSteps: string[];
  generatedAt: string | null;
  empty: boolean;
}

const list = (x: unknown): string[] =>
  Array.isArray(x) ? x.map((s) => String(s ?? "").trim()).filter(Boolean) : [];

export function minutesView(m: Minutes | null | undefined, meetingTitle?: string | null): MinutesViewModel | null {
  if (!m || typeof m !== "object") return null;
  const sections = ([["agenda", "Agenda"], ["discussion", "Discussion"], ["decisions", "Decisions"]] as const)
    .map(([key, heading]) => ({ key, heading, items: list((m as any)[key]) }))
    .filter((s) => s.items.length);
  const actions = (Array.isArray(m.action_items) ? m.action_items : [])
    .map((a: any) => ({ task: String(a?.task ?? "").trim(), owner: a?.owner ? String(a.owner).trim() : null, due: a?.due ? String(a.due).trim() : null }))
    .filter((a) => a.task);
  const title = String(m.title ?? "").trim();
  const summary = String(m.summary ?? "").trim() || null;
  const attendees = list(m.attendees);
  const nextSteps = list(m.next_steps);
  return {
    // Only repeat the minutes' own title when it says something the meeting title doesn't.
    title: title && title.toLowerCase() !== String(meetingTitle ?? "").trim().toLowerCase() ? title : null,
    summary,
    attendees,
    sections,
    actions,
    nextSteps,
    generatedAt: m.generated_at ?? null,
    empty: !summary && !attendees.length && !sections.length && !actions.length && !nextSteps.length,
  };
}

/** "Aditya · due Fri" for an action row. */
export function actionMeta(a: { owner: string | null; due: string | null }): string {
  return [a.owner, a.due ? `due ${a.due}` : null].filter(Boolean).join(" · ");
}
