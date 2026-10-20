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

  it("gives the AI times and screenshot tags to cite", async () => {
    const cid = await meeting();
    const sid = (await repo.sessionForConversation(cid))!;
    await repo.addMeetingImage(cid, { name: "s.jpg", at: Date.parse("2026-10-01T10:12:34Z"), caption: "Pricing slide" });
    const [img] = await repo.listMeetingImages(cid);
    await repo.setMeetingVisual(cid, { session_id: sid, facts: [`[img:${img.id}] $0.60 / M input`, "[S03] an old-style fact"] });
    const chat = vi.fn(async () => ({ answer: "ok" }));
    await notes.askMeeting(cid, "Price?", { chat } as any);
    const [, system, user] = chat.mock.calls[0] as any[];
    expect(system).toContain("[img:7]");
    expect(user).toContain(`- [img:${img.id}] (12:34) screenshot: Pricing slide\n- [img:${img.id}] $0.60 / M input\n- an old-style fact`);
    expect(user).toContain("[0:00] Me (me): GLM 5.3 via OpenRouter.");
  });

  it("goes when the meeting is deleted", async () => {
    const cid = await meeting();
    await repo.addMeetingChat(cid, { role: "note", content: "x", pinned: true });
    await repo.deleteConversation(cid);
    expect(await repo.listMeetingChat(cid)).toEqual([]);
  });
});

describe("questions about a period", () => {
  it("finds the period a question names", async () => {
    const { timeWindow } = await import("../chat");
    const now = new Date(2026, 9, 21, 15, 0); // Wed 21 Oct 2026, local
    const day = (y: number, m: number, d: number) => new Date(y, m, d).toISOString();
    expect(timeWindow("what did I promise this week?", now)).toEqual([day(2026, 9, 19), day(2026, 9, 22)]);
    expect(timeWindow("decisions from last week", now)).toEqual([day(2026, 9, 12), day(2026, 9, 19)]);
    expect(timeWindow("anything yesterday", now)).toEqual([day(2026, 9, 20), day(2026, 9, 21)]);
    expect(timeWindow("last 3 days", now)).toEqual([day(2026, 9, 19), day(2026, 9, 22)]);
    expect(timeWindow("what is the pricing plan", now)).toBeNull();
  });
});

describe("meetings in a period", () => {
  it("matches stored ISO start times", async () => {
    const cid = await meeting(); // started 2026-10-01T10:00Z
    await repo.upsertMemory({ conversation_id: cid, title: "GLM", summary: "Model choice.", facts: [], action_items: [], decisions: [], open_questions: [], importance: 0.5, type_tags: [] });
    expect(await repo.conversationsBetween("2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z")).toContain(cid);
    expect(await repo.conversationsBetween("2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z")).not.toContain(cid);
  });
});

describe("placeholder owner", () => {
  it("moves a second \"Me\" owner's lines to the real owner", async () => {
    const real = await repo.insertPerson("Aditya", true);
    const s = await repo.createSession("electron", "meeting", "Zoom");
    await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", person_id: real, text: "Earlier, as Aditya.", start_ts: 0, end_ts: 1, abs_start: "2026-10-01T09:00:00.000Z" });
    const fake = await repo.insertPerson("Me", true); // what the old bug did: "Aditya" stops being the owner
    const t = await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", person_id: fake, text: "My update.", start_ts: 0, end_ts: 1, abs_start: "2026-10-01T10:00:00.000Z" });
    expect(await repo.mergePlaceholderOwner()).toBe(1);
    const people = (await repo.listPeople()) as any[];
    expect(people.filter((p) => p.is_me).map((p) => p.canonical_name)).toEqual(["Aditya"]);
    const row = (await (await import("../db")).q("SELECT person_id FROM turns WHERE id=?", [t]))[0] as any;
    expect(row.person_id).toBe(real);
  });
});
