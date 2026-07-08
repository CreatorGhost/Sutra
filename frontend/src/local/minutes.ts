// Minutes-of-Meeting service. Derived & non-destructive: the transcript + memory stay the source of
// truth; minutes are generated on demand (or auto, for detected meetings) into their own table and can
// be regenerated or cleared anytime. Reuses the structured text channel (provider.extract) — no proxy
// change. Cloud (hybrid) is the supported path; on-device degrades to whatever its extract() returns.
import * as repo from "./repo";
import { MINUTES_JSON_SCHEMA, MINUTES_SYSTEM } from "./aiPrompts";
import { buildSpeakerDisplay } from "./util";
import { assembleProjectContext } from "./projectContext";
import type { Provider } from "../providers/provider";

export interface Minutes {
  title?: string;
  summary?: string;
  attendees?: string[];
  agenda?: string[];
  discussion?: string[];
  decisions?: string[];
  action_items?: { task: string; owner?: string | null; due?: string | null }[];
  next_steps?: string[];
  generated_at?: string;
}

/** Generate (or regenerate) minutes for a conversation from its transcript. Returns ok:false (raw data
 *  untouched) on empty/error so the caller can surface a friendly message. */
export async function generateMinutes(
  convId: number,
  provider: Provider,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    // Redaction-safe source: redacted turns must never be baked into minutes free-text, which the MCP
    // read layer exposes verbatim via get_minutes / get_conversation.minutes.
    const detail = await repo.conversationDetailSafe(convId);
    if (!detail) return { ok: false, reason: "not-found" };
    const turns = (detail.turns ?? []) as any[];
    if (!turns.length) return { ok: false, reason: "empty" };
    const c: any = detail.conversation;
    const convDate = String(c?.started_at ?? "").slice(0, 10);
    // Never feed raw cluster ids ("c1") to the model — display unnamed speakers as "Speaker N" and
    // always prefer the enrolled person_name (regenerated minutes pick up names added after generation).
    const display = buildSpeakerDisplay(turns);
    const transcript = turns
      .map((t) => `${t.person_name || display.get(t.session_speaker_label) || "Speaker"}: ${t.text}`)
      .join("\n");
    // Project grounding: if this conversation is mapped to a project with local context ON, PREPEND that
    // project's delimited <people>/<project_brief>/<terms> block + the anti-injection role constraint,
    // kept SEPARATE from the transcript. Empty/absent/disabled project => empty prefix (exact prior behavior).
    let projectPrefix = "";
    try {
      const project: any = await repo.projectForConversation(convId);
      if (project && project.context_enabled !== false) {
        const ctx = assembleProjectContext(project);
        if (ctx.minutesBlock) {
          projectPrefix = `${ctx.roleConstraint}\n\n${ctx.minutesBlock}\n\n<transcript>\n`;
        }
      }
    } catch (e) { console.warn("project context lookup skipped", convId, e); }
    const body = (convDate ? `Meeting date: ${convDate}.\n\n` : "") + transcript;
    // When grounding is active, fully wrap the transcript so the untrusted block is delimited on both sides.
    const user = projectPrefix ? projectPrefix + body + "\n</transcript>" : body;
    const data = await provider.extract(MINUTES_JSON_SCHEMA, MINUTES_SYSTEM, user);
    await repo.setMinutes(convId, data);
    // Generating minutes confirms this was a meeting — keep the flag in sync for the chip / lists.
    try { await repo.setConversationMeeting(convId, true); } catch { /* flag is best-effort */ }
    return { ok: true };
  } catch (e) {
    console.warn("generateMinutes failed", convId, e);
    return { ok: false, reason: "error" };
  }
}

export async function clearMinutes(convId: number): Promise<{ ok: boolean }> {
  await repo.clearMinutes(convId);
  return { ok: true };
}

/** Render minutes as shareable Markdown (used by the Share/Copy action). Skips empty sections. */
export function minutesToMarkdown(convTitle: string | undefined, m: Minutes | null | undefined): string {
  if (!m) return "";
  const L: string[] = [];
  L.push(`# ${m.title || convTitle || "Meeting minutes"}`);
  if (m.summary) L.push("", m.summary);
  const list = (heading: string, items?: string[]) => {
    if (items && items.length) { L.push("", `## ${heading}`, ...items.map((x) => `- ${x}`)); }
  };
  list("Attendees", m.attendees);
  list("Agenda", m.agenda);
  list("Discussion", m.discussion);
  list("Decisions", m.decisions);
  if (m.action_items && m.action_items.length) {
    L.push("", "## Action items");
    for (const a of m.action_items) {
      const meta = [a.owner ? `owner: ${a.owner}` : "", a.due ? `due: ${a.due}` : ""].filter(Boolean).join(", ");
      L.push(`- ${a.task}${meta ? ` (${meta})` : ""}`);
    }
  }
  list("Next steps", m.next_steps);
  return L.join("\n");
}
