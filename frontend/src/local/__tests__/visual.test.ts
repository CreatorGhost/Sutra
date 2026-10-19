// Notes that see the screen: which screenshots go to the engine, how its reply is checked, and the whole
// pass against a fake recording store + engine (the REAL repo on an in-memory SQLite).
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

const T0 = Date.UTC(2026, 9, 14, 10, 0, 0);
const media = {
  frames: vi.fn(async () => [0, 1, 2, 3].map((i) => ({ name: `shot-${T0 + i * 60_000}.jpg`, at: T0 + i * 60_000, score: 0.2 + i / 10 }))),
  keep: vi.fn(async () => ""), deleteSession: vi.fn(async () => {}),
};
(globalThis as any).sutraDesktop = { isDesktop: true, platform: "darwin", db: () => null, media };

let repo: typeof import("../repo");
let visual: typeof import("../visual");
beforeAll(async () => { repo = await import("../repo"); visual = await import("../visual"); });

async function meeting() {
  const s = await repo.createSession("electron", "meeting", "Zoom");
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", text: "The plan is on the slide.", start_ts: 0, end_ts: 2, abs_start: new Date(T0 + 10_000).toISOString() });
  const { segmentSession } = await import("../segmentation");
  const [cid] = await segmentSession(s.id);
  return { cid, sid: s.id };
}

describe("choosing and labelling screenshots", () => {
  it("spreads the picks over the meeting, biggest change per stretch, in time order", () => {
    const frames = Array.from({ length: 40 }, (_, i) => ({ name: `shot-${i}.jpg`, at: i * 1000, score: i % 5 === 0 ? 0.9 : 0.1 }));
    const picked = visual.pickShots(frames, 8);
    expect(picked).toHaveLength(8);
    expect(picked.map((f) => f.at)).toEqual([...picked.map((f) => f.at)].sort((a, b) => a - b));
    expect(picked.every((f) => f.score === 0.9)).toBe(true);
    expect(visual.pickShots(frames.slice(0, 3), 8)).toHaveLength(3);
    expect(visual.labelShots(picked.slice(0, 2), 0).map((s) => `${s.label} ${s.offset}`)).toEqual(["S01 00:00", "S02 00:05"]);
  });

  it("times the transcript from the start", () => {
    expect(visual.timedTranscript([{ abs_start: new Date(T0 + 754_000).toISOString(), session_speaker_label: "me", text: "Hi" }], T0)).toBe("[12:34] Me: Hi");
  });

  it("keeps only screenshots it was shown, once each, and caps the facts", () => {
    const shots = visual.labelShots([{ name: "shot-1.jpg", at: 1, score: 0 }, { name: "shot-2.jpg", at: 2, score: 0 }], 0);
    const r = visual.parseVisual({
      screen_facts: ["  [S01]  Q3 target $1.2M  ", "", ...Array(30).fill("x")],
      moments: [{ shot: "S01", caption: "Q3 plan", keep: true }, { shot: "[s01]", caption: "dup", keep: true }, { shot: "S09", caption: "made up", keep: true }, { shot: "S02", caption: "desktop", keep: false }],
    }, shots);
    expect(r.facts[0]).toBe("[S01] Q3 target $1.2M");
    expect(r.facts).toHaveLength(visual.MAX_FACTS);
    expect(r.keep.map((k) => [k.frame.name, k.caption])).toEqual([["shot-1.jpg", "Q3 plan"]]);
    // A fact citing a shot the AI said not to keep doesn't bring it back; an unmentioned one is kept.
    expect(visual.withCitedShots([], ["[S02] Desktop", "[S01] Plan"], shots, r.rejected).map((k) => k.frame.name)).toEqual(["shot-1.jpg"]);
  });

  it("names speakers only from shots it was shown, and drops conflicting names", () => {
    const shots = visual.labelShots([{ name: "shot-1.jpg", at: 1, score: 0 }, { name: "shot-2.jpg", at: 2, score: 0 }], 0);
    const r = visual.parseVisual({ screen_facts: [], moments: [], speakers: [
      { speaker: "Speaker 1", name: "Venkata Pappula", shot: "S01" },
      { speaker: "Speaker 1", name: "Venkata Pappula", shot: "S02" },
      { speaker: "Speaker 2", name: "Tanay Mehta", shot: "S09" },     // shot it never saw
      { speaker: "Speaker 3", name: "Owais Bhat", shot: "S01" },
      { speaker: "Speaker 3", name: "Ajith Kumar", shot: "S02" },     // two names for one voice
      { speaker: "Speaker 4", name: "Harsh Kumar", shot: "S01" },
      { speaker: "Speaker 5", name: "Harsh Kumar", shot: "S02" },     // one name for two voices
      { speaker: "Me", name: "Aditya Singh", shot: "S01" },
    ] }, shots);
    expect([...r.speakers]).toEqual([["Speaker 1", "Venkata Pappula"]]);
  });
});

describe("the pass after a recording", () => {
  it("sends the screenshots with the timed transcript, keeps the picks, saves the facts", async () => {
    const { cid, sid } = await meeting();
    const extract = vi.fn(async () => ({ screen_facts: ["[S02] $1.2M ARR", "[S04] Launch Nov 3", "[S09] made up"], moments: [{ shot: "S02", caption: "Q3 slide", keep: true }] }));
    const facts = await visual.visualPass(cid, sid, { extract, engineId: async () => "claude" } as any);
    const imgs = await repo.listMeetingImages(cid);
    // Every fact cites the screenshot it came from — S04 is kept for it even though it wasn't a "moment".
    expect(imgs.map((i) => [i.name, i.caption])).toEqual([[`shot-${T0 + 60_000}.jpg`, "Q3 slide"], [`shot-${T0 + 180_000}.jpg`, "Launch Nov 3"]]);
    expect(facts).toEqual([`[img:${imgs[0].id}] $1.2M ARR`, `[img:${imgs[1].id}] Launch Nov 3`, "made up"]);
    const [, , user, opts] = extract.mock.calls[0] as any[];
    expect(user).toContain("S01 00:00, S02 01:00, S03 02:00, S04 03:00");
    expect(user).toContain("[00:10] Me: The plan is on the slide.");
    expect(opts.images).toEqual({ session: sid, frames: [0, 1, 2, 3].map((i) => ({ name: `shot-${T0 + i * 60_000}.jpg`, label: `S0${i + 1}` })) });
    expect(media.keep).toHaveBeenCalledWith(sid, `shot-${T0 + 60_000}.jpg`, cid);
    expect(await repo.getMeetingVisual(cid)).toMatchObject({ facts, frames_seen: 4, frames_total: 4, engine: "claude", error: null, confirmed: false });
    expect(await repo.sessionForConversation(cid)).toBe(sid);
  });

  it("an engine that can't see is noted, not fatal; confirming deletes the recording", async () => {
    const { cid, sid } = await meeting();
    const extract = vi.fn();
    expect(await visual.visualPass(cid, sid, { extract, engineId: async () => "commandcode" } as any)).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    expect((await repo.getMeetingVisual(cid))?.error).toMatch(/Command Code can't look at screenshots/);
    await visual.confirmRecording(cid);
    expect(media.deleteSession).toHaveBeenCalledWith(sid);
    expect((await repo.getMeetingVisual(cid))?.confirmed).toBe(true);
  });

  it("screen facts reach the notes extraction", async () => {
    const { cid, sid } = await meeting();
    await repo.setMeetingVisual(cid, { session_id: sid, facts: ["[S01] Q3 target $1.2M ARR"] });
    const { extractConversation } = await import("../extraction");
    const extract = vi.fn(async () => ({ title: "Plan", summary: "s", facts: [], entities: [], relations: [] }));
    await extractConversation(cid, { extract, canEmbed: false, id: "agent:claude" } as any).catch(() => {});
    expect((extract.mock.calls[0] as any[])[2]).toContain("# On screen during the meeting (from screenshots; use it where it makes the notes more precise)\n- Q3 target $1.2M ARR");
  });
});

describe("naming speakers from the call's screen", () => {
  it("names an unnamed remote speaker the call app showed talking, before the notes", async () => {
    const s = await repo.createSession("electron", "meeting", "Google Meet");
    await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", text: "Over to you.", start_ts: 0, end_ts: 1, abs_start: new Date(T0 + 5_000).toISOString() });
    await repo.insertTurn({ session_id: s.id, session_speaker_label: "c1", text: "Thanks, the rollout is on track.", start_ts: 1, end_ts: 4, abs_start: new Date(T0 + 62_000).toISOString() });
    const { segmentSession } = await import("../segmentation");
    const [cid] = await segmentSession(s.id);
    const extract = vi.fn(async (_s: any, _sys: string, user: string) => {
      const label = user.match(/\] (Speaker \d+): Thanks/)![1];
      return { screen_facts: [], moments: [], speakers: [{ speaker: label, name: "Venkata Pappula", shot: "S02" }] };
    });
    await visual.visualPass(cid, s.id, { extract, engineId: async () => "claude" } as any);
    const detail: any = await repo.conversationDetailSafe(cid);
    expect(detail.turns.find((t: any) => t.text.startsWith("Thanks"))?.person_name).toBe("Venkata Pappula");
    expect(detail.turns.find((t: any) => t.text.startsWith("Over"))?.person_name ?? null).not.toBe("Venkata Pappula");
  });
});

describe("a display name is the participant's own claim", () => {
  it("never touches a known person's voiceprint and never becomes the owner", async () => {
    const riya = await repo.insertPerson("Riya", false, [1, 0, 0]);
    await repo.insertPerson("Aditya Singh", true);
    const before = (await repo.listPeople()).find((p: any) => p.id === riya) as any;
    const s = await repo.createSession("electron", "meeting", "Google Meet");
    await repo.insertTurn({ session_id: s.id, session_speaker_label: "c1", text: "I am totally Riya.", start_ts: 0, end_ts: 3, abs_start: new Date(T0 + 5_000).toISOString(), voiceprint: [0, 1, 0] });
    await repo.insertTurn({ session_id: s.id, session_speaker_label: "c2", text: "And I am the owner.", start_ts: 3, end_ts: 6, abs_start: new Date(T0 + 65_000).toISOString(), voiceprint: [0, 0, 1] });
    const { segmentSession } = await import("../segmentation");
    const [cid] = await segmentSession(s.id);
    const extract = vi.fn(async (_s: any, _sys: string, user: string) => ({ screen_facts: [], moments: [], speakers: [
      { speaker: user.match(/\] (Speaker \d+): I am totally/)![1], name: "Riya", shot: "S01" },
      { speaker: user.match(/\] (Speaker \d+): And I am/)![1], name: "Aditya Singh", shot: "S02" },
    ] }));
    await visual.visualPass(cid, s.id, { extract, engineId: async () => "claude" } as any);
    const after = (await repo.listPeople()).find((p: any) => p.id === riya) as any;
    expect(after.enroll_count).toBe(before.enroll_count);
    const detail: any = await repo.conversationDetailSafe(cid);
    expect(detail.turns.find((t: any) => t.text.startsWith("And"))?.person_name ?? null).not.toBe("Aditya Singh");
  });
});

describe("the owner marker can't be borrowed", () => {
  it("a screen-read name keeps only name characters, and can't be just Me", async () => {
    const { relabelSpeaker } = await import("../people");
    const s = await repo.createSession("electron", "meeting", "Google Meet");
    await repo.insertTurn({ session_id: s.id, session_speaker_label: "c1", text: "Hello there everyone.", start_ts: 0, end_ts: 3, abs_start: new Date(T0).toISOString() });
    for (const name of ["Mallory (me)", "Eve （m\u200be）", "Bob: (me)", "O'Neil-Smith [me]"]) {
      const r = await relabelSpeaker(s.id, "c1", { name, untrusted: true });
      const p = (await repo.listPeople()).find((x: any) => x.id === r.person_id) as any;
      expect(p.canonical_name).toMatch(/^[\p{L}\p{M} '.-]+$/u);
    }
    for (const bad of ["(ME)", "（me）", "m\u200be", "[me]", "you:", "Ме", "M.e", "y-o-u", "yoυ"]) await expect(relabelSpeaker(s.id, "c1", { name: bad, untrusted: true })).rejects.toThrow();
  });
});

describe("naming voices from the participant list", () => {
  it("applies a screen_roster name to that meeting only, without learning a voiceprint", async () => {
    const s = await repo.createSession("electron", "meeting", "Google Meet");
    await repo.insertTurn({ session_id: s.id, session_speaker_label: "c1", text: "Hi Lawrence, good morning, how are you doing?", start_ts: 0, end_ts: 3, abs_start: new Date(T0).toISOString(), voiceprint: [1, 0, 0] });
    await repo.insertTurn({ session_id: s.id, session_speaker_label: "c2", text: "Doing well, thanks Vijay.", start_ts: 3, end_ts: 6, abs_start: new Date(T0 + 4_000).toISOString(), voiceprint: [0, 1, 0] });
    const { segmentSession } = await import("../segmentation");
    const [cid] = await segmentSession(s.id);
    const { extractConversation } = await import("../extraction");
    const extract = vi.fn(async (_s: any, _sys: string, user: string) => ({
      title: "Weekly review", subtitle: "", summary: "Greetings.", participants: [], facts: [], action_items: [], decisions: [], open_questions: [],
      entities: [], relations: [], importance_score: 0.3, type_tags: [], events: [], is_meeting: true,
      speaker_names: [{ speaker: user.match(/(Speaker \d+): Doing well/)![1], name: "Lawrence Taylor", basis: "self_introduction", confidence: "high" }], // basis lied about
    }));
    await extractConversation(cid, { id: "agent:claude", canEmbed: false, extract } as any, ["contributors: Aditya Pratap Singh, Lawrence Taylor, Vijay Gupta"]);
    expect(extract.mock.calls[0][2]).toContain("Lawrence Taylor, Vijay Gupta");
    const detail: any = await repo.conversationDetailSafe(cid);
    expect(detail.turns.find((t: any) => t.text.startsWith("Doing"))?.person_name).toBe("Lawrence Taylor");
    const lawrence = (await repo.listPeople()).find((p: any) => p.canonical_name === "Lawrence Taylor") as any;
    expect(lawrence.enroll_count ?? 0).toBe(0);
  });
});
