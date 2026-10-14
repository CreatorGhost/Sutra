// A meeting's chat through the REAL repo on a REAL in-memory SQLite: saved per meeting, used as context,
// and what's added to the notes is kept, exported and given to the AI.
import { describe, it, expect, vi, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { adapt } from "../../storage/desktopAdapter";
import { runMigrations } from "../../storage/migrate";

const raw = new Database(":memory:");
runMigrations({
  exec: (sql) => raw.exec(sql),
  getUserVersion: () => Number(raw.pragma("user_version", { simple: true })),
  setUserVersion: (v) => raw.exec(`PRAGMA user_version=${v};`),
  columns: (t) => (raw.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => String(r.name)),
});
const store = adapt(raw as any);
vi.mock("../db", () => ({ q: (s: string, p?: any[]) => store.q(s, p), run: (s: string, p?: any[]) => store.run(s, p), exec: (s: string) => store.exec(s), persist: async () => {} }));

let repo: typeof import("../repo");
let notes: typeof import("../notes");
beforeAll(async () => { repo = await import("../repo"); notes = await import("../notes"); });

async function meeting() {
  const s = await repo.createSession("electron", "meeting", "Zoom");
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", text: "GLM 5.3 via OpenRouter.", start_ts: 0, end_ts: 2, abs_start: "2026-10-01T10:00:00.000Z" });
  const { segmentSession } = await import("../segmentation");
  const [cid] = await segmentSession(s.id);
  return cid;
}

describe("meeting chat", () => {
  it("saves each question and answer with its meeting, and uses earlier answers as context", async () => {
    const cid = await meeting(), other = await meeting();
    const answers = ["It's **GLM 5.3**.", "Via OpenRouter."];
    const chat = vi.fn(async () => ({ answer: answers.shift() }));
    await notes.chatMeeting(cid, "Which model?", { chat } as any);
    const r = await notes.chatMeeting(cid, "Through what?", { chat } as any);
    expect(r.answer).toMatchObject({ role: "assistant", content: "Via OpenRouter.", question: "Through what?", pinned: false, error: false });
    expect((await repo.listMeetingChat(cid)).map((m) => [m.role, m.content])).toEqual([
      ["user", "Which model?"], ["assistant", "It's **GLM 5.3**."], ["user", "Through what?"], ["assistant", "Via OpenRouter."],
    ]);
    expect((chat.mock.calls[1] as any[])[2]).toContain("Q: Which model?\nA: It's **GLM 5.3**.");
    expect(await repo.listMeetingChat(other)).toEqual([]);
  });

  it("keeps a failed answer as an error, not as context", async () => {
    const cid = await meeting();
    const r = await notes.chatMeeting(cid, "Anything?", { chat: async () => { throw new Error("Claude Code isn't signed in."); } } as any);
    expect(r.answer).toMatchObject({ error: true, content: "Claude Code isn't signed in." });
    const chat = vi.fn(async () => ({ answer: "ok" }));
    await notes.chatMeeting(cid, "Again?", { chat } as any);
    expect((chat.mock.calls[0] as any[])[2]).not.toContain("signed in");
  });

  it("what's added to the meeting stays through a cleared chat, is exported and reaches the AI", async () => {
    const cid = await meeting();
    const { answer } = await notes.chatMeeting(cid, "Cost?", { chat: async () => ({ answer: "Under **$1** per million tokens." }) } as any);
    await repo.setMeetingChatPinned(answer.id, true);
    await repo.addMeetingChat(cid, { role: "note", content: "Checked: $0.60 / M input.", pinned: true });
    await repo.clearMeetingChat(cid);
    expect((await repo.listMeetingChat(cid)).map((m) => m.role)).toEqual(["assistant", "note"]);
    const md = notes.notesToMarkdown({ conversation: { title: "Cost" } as any, memory: null as any, actions: [] }, "brief", null, false, await repo.meetingAdditions(cid));
    expect(md).toContain("## Added to this meeting\n\n### Cost?\n\nUnder **$1** per million tokens.\n\nChecked: $0.60 / M input.");
    const chat = vi.fn(async () => ({ answer: "ok" }));
    await notes.askMeeting(cid, "Rate?", { chat } as any);
    expect((chat.mock.calls[0] as any[])[2]).toContain("# Added to this meeting by the user\n- (Cost?) Under **$1** per million tokens.\n- Checked: $0.60 / M input.");
  });

  it("goes when the meeting is deleted", async () => {
    const cid = await meeting();
    await repo.addMeetingChat(cid, { role: "note", content: "x", pinned: true });
    await repo.deleteConversation(cid);
    expect(await repo.listMeetingChat(cid)).toEqual([]);
  });
});
