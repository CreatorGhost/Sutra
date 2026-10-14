// Meeting notes: the "Brief" and "Detailed" styles, per-meeting Q&A, and Markdown export.
//   • Brief    — free: built from the extraction (summary, decisions, action items, open questions).
//   • Detailed — one extra text-only call on demand (topics with details, next steps), cached per meeting
//                in the notes table and invalidated whenever the meeting is re-extracted.
import type { Provider } from "../providers/provider";
import { ASK_MEETING_SCHEMA, ASK_MEETING_SYSTEM, NOTES_DETAILED_SCHEMA, NOTES_DETAILED_SYSTEM } from "./aiPrompts";
import * as repo from "./repo";
import { speakerName } from "./speakers";

export type NoteStyle = "brief" | "detailed";
export const NOTE_STYLES: Record<NoteStyle, string> = { brief: "Brief", detailed: "Detailed" };

export interface ActionRow { id?: number; text: string; owner?: string | null; due?: string | null; status?: string }
export interface DetailedNotes {
  overview: string;
  topics: { heading: string; points: string[] }[];
  decisions: string[];
  action_items: { text: string; owner: string | null }[];
  open_questions: string[];
  next_steps: string[];
}

type Detail = NonNullable<Awaited<ReturnType<typeof repo.conversationDetail>>>;

/** Transcript as "Name: text" lines, capped so a very long meeting still fits one request. */
export function transcriptText(turns: any[], maxChars = 90000): string {
  const lines = turns.map((t) => `${speakerName(t)}: ${String(t.text ?? "").trim()}`);
  let text = lines.join("\n");
  if (text.length > maxChars) {
    // Keep the start and the end — decisions and next steps cluster at the end of meetings.
    const head = text.slice(0, Math.floor(maxChars * 0.6));
    const tail = text.slice(-Math.floor(maxChars * 0.4));
    text = `${head}\n[… middle of the meeting omitted for length …]\n${tail}`;
  }
  return text;
}

/** Detailed notes for a meeting — cached; generated on first request (or when `force`). */
export async function detailedNotes(cid: number, provider: Provider, force = false): Promise<DetailedNotes> {
  if (!force) {
    const cached = await repo.getNotes(cid, "detailed");
    if (cached && Array.isArray((cached as any).topics)) return cached as unknown as DetailedNotes;
  }
  const d = await repo.conversationDetail(cid);
  if (!d || !d.turns.length) throw new Error("This meeting has no transcript yet.");
  const date = String(d.conversation.started_at ?? "").slice(0, 10);
  const user = (date ? `Meeting date: ${date}.\n\n` : "") + transcriptText(d.turns);
  const out = (await provider.extract(NOTES_DETAILED_SCHEMA, NOTES_DETAILED_SYSTEM, user)) as DetailedNotes;
  const clean: DetailedNotes = {
    overview: String(out?.overview ?? ""),
    topics: Array.isArray(out?.topics) ? out.topics : [],
    decisions: Array.isArray(out?.decisions) ? out.decisions : [],
    action_items: Array.isArray(out?.action_items) ? out.action_items : [],
    open_questions: Array.isArray(out?.open_questions) ? out.open_questions : [],
    next_steps: Array.isArray(out?.next_steps) ? out.next_steps : [],
  };
  await repo.setNotes(cid, "detailed", clean);
  return clean;
}

/** Answer a question about ONE meeting from its notes + transcript. */
export async function askMeeting(cid: number, question: string, provider: Provider, history: { q: string; a: string }[] = []): Promise<string> {
  question = question.trim();
  if (!question) return "";
  const d = await repo.conversationDetail(cid);
  if (!d) throw new Error("Meeting not found.");
  const m: any = d.memory;
  const notes = m
    ? [`Title: ${m.title}`, `Summary: ${m.summary}`,
       m.decisions?.length ? `Decisions: ${m.decisions.join("; ")}` : "",
       d.actions.length ? `Action items: ${(d.actions as any[]).map((a) => (a.owner ? `${a.owner}: ` : "") + a.text).join("; ")}` : "",
      ].filter(Boolean).join("\n")
    : "(no notes yet)";
  const prior = history.slice(-4).map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n\n");
  // What the user added to this meeting (answers they kept, notes they wrote) is part of its record.
  const added = (await repo.meetingAdditions(cid).catch(() => []))
    .map((a) => (a.question ? `- (${a.question}) ${a.content}` : `- ${a.content}`)).join("\n").slice(0, 12000);
  const user = `# Notes\n${notes}\n\n` + (added ? `# Added to this meeting by the user\n${added}\n\n` : "") + `# Transcript\n${transcriptText(d.turns, 60000)}\n\n` +
    (prior ? `# Earlier questions\n${prior}\n\n` : "") + `# Question\n${question}`;
  // A meeting in a project with linked code folders: the agent may read them too (read-only).
  const scope = await repo.askScopeForConversation(cid).catch(() => null);
  const out = await provider.chat(ASK_MEETING_SCHEMA, ASK_MEETING_SYSTEM, user, scope);
  return String(out?.answer ?? "").trim() || "I couldn't find that in this meeting.";
}

const bullet = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
const task = (a: { text: string; owner?: string | null; status?: string }) =>
  `- [${a.status === "done" ? "x" : " "}] ${a.owner ? `**${a.owner}:** ` : ""}${a.text}`;

/** PURE: render a meeting's notes (either style) as Markdown for copy / export. */
export function notesToMarkdown(d: Pick<Detail, "conversation" | "memory" | "actions"> & { turns?: any[] }, style: NoteStyle, detailed?: DetailedNotes | null, withTranscript = false,
  additions: { content: string; question?: string | null }[] = []): string {
  const m: any = d.memory ?? {};
  const c: any = d.conversation ?? {};
  const title = m.title || c.title || "Meeting";
  const when = c.started_at ? new Date(String(c.started_at).includes("T") ? c.started_at : String(c.started_at).replace(" ", "T") + "Z").toLocaleString() : "";
  const out: string[] = [`# ${title}`];
  const meta = [when, c.source_app].filter(Boolean).join(" · ");
  if (meta) out.push(`_${meta}_`);
  if (m.subtitle) out.push(m.subtitle);
  const actions = (d.actions as ActionRow[] | undefined) ?? [];
  if (style === "detailed" && detailed) {
    if (detailed.overview) out.push("## Overview", detailed.overview);
    for (const t of detailed.topics) out.push(`## ${t.heading}`, bullet(t.points));
    if (detailed.decisions.length) out.push("## Decisions", bullet(detailed.decisions));
    const items = detailed.action_items.length ? detailed.action_items : actions;
    if (items.length) out.push("## Action items", items.map(task).join("\n"));
    if (detailed.open_questions.length) out.push("## Open questions", bullet(detailed.open_questions));
    if (detailed.next_steps.length) out.push("## Next steps", bullet(detailed.next_steps));
  } else {
    if (m.summary) out.push("## Summary", m.summary);
    out.push("## Decisions", m.decisions?.length ? bullet(m.decisions) : "- none");
    if (actions.length) out.push("## Action items", actions.map(task).join("\n"));
    if (m.open_questions?.length) out.push("## Open questions", bullet(m.open_questions));
  }
  if (additions.length) {
    out.push("## Added to this meeting", additions.map((a) => (a.question ? `### ${a.question}\n\n${a.content.trim()}` : a.content.trim())).join("\n\n"));
  }
  if (withTranscript && d.turns?.length) out.push("## Transcript", d.turns.map((t) => `**${speakerName(t)}:** ${t.text}`).join("\n\n"));
  return out.join("\n\n") + "\n";
}

/** One turn of a meeting's chat: the question and the answer (or the error) are saved with the meeting,
 *  and the last few exchanges are the context for the next question. */
export async function chatMeeting(cid: number, question: string, provider: Provider): Promise<{ question: repo.ChatMessage; answer: repo.ChatMessage }> {
  question = question.trim();
  if (!question) throw new Error("Ask a question first.");
  const earlier = await repo.listMeetingChat(cid);
  const history: { q: string; a: string }[] = [];
  for (let i = 0; i < earlier.length - 1; i++) {
    const a = earlier[i], b = earlier[i + 1];
    if (a.role === "user" && b.role === "assistant" && !b.error) history.push({ q: a.content, a: b.content });
  }
  const q = await repo.addMeetingChat(cid, { role: "user", content: question });
  try {
    const text = await askMeeting(cid, question, provider, history);
    return { question: q, answer: await repo.addMeetingChat(cid, { role: "assistant", content: text, question }) };
  } catch (e: any) {
    return { question: q, answer: await repo.addMeetingChat(cid, { role: "assistant", content: String(e?.message ?? e), question, error: true }) };
  }
}
