// Local (desktop) speech through the REAL ingest → repo → speakerId path, against an in-memory SQLite.
// The Electron bridge is faked: it returns what electron/speech/service.ts would — per-window diarizer
// speakers plus a voiceprint per segment — so this checks the renderer side stores and uses them.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { adapt } from "../../storage/desktopAdapter";
import { runMigrations } from "../../storage/migrate";
import type { LocalTranscription, SpeechTranscribeOpts } from "../../shared/speechModels";

const raw = new Database(":memory:");
runMigrations({
  exec: (sql) => raw.exec(sql),
  getUserVersion: () => Number(raw.pragma("user_version", { simple: true })),
  setUserVersion: (v) => raw.exec(`PRAGMA user_version=${v};`),
  columns: (t) => (raw.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => String(r.name)),
});
const store = adapt(raw as any);
vi.mock("../db", () => ({ q: (s: string, p?: any[]) => store.q(s, p), run: (s: string, p?: any[]) => store.run(s, p), exec: (s: string) => store.exec(s), persist: async () => {} }));

// Two clearly different voices (unit vectors, 256-d like a typical local embedding model).
const voice = (axis: number, jitter = 0) => { const v = new Array(256).fill(0); v[axis] = 1; v[(axis + 1) % 256] = jitter; return v; };
const A = (j = 0) => voice(3, j), B = (j = 0) => voice(40, j);

let next: LocalTranscription;
const transcribe = vi.fn(async (_wav: ArrayBuffer, _o: SpeechTranscribeOpts) => next);
(globalThis as any).sutraDesktop = { isDesktop: true, platform: "darwin", stt: { transcribe } };

let repo: typeof import("../repo");
let ingest: typeof import("../ingest");
let speakerId: typeof import("../speakerId");
let providers: typeof import("../../providers/localSttProvider");
beforeAll(async () => {
  repo = await import("../repo");
  ingest = await import("../ingest");
  speakerId = await import("../speakerId");
  providers = await import("../../providers/localSttProvider");
});
beforeEach(() => transcribe.mockClear());

const wav = () => new Blob([new Uint8Array(64)], { type: "audio/wav" });
const seg = (start: number, end: number, text: string, speaker: string, embedding: number[] | null) => ({ start, end, text, speaker, embedding });
const text = { id: "text", translate: vi.fn(async (t: string[]) => t.map((x) => `EN:${x}`)) } as any;
const local = () => new providers.ComposedProvider(new providers.LocalSpeechProvider("qwen3-asr-0.6b"), text);

describe("local speech → ingest", () => {
  it("stores remote speakers as r<speaker> with their voiceprints, and asks for speaker separation", async () => {
    await repo.putSettings({ transcript_lang: "hinglish" });
    const s = await repo.createSession("electron", "meeting", "Zoom");
    next = { text: "", duration: 90, translated: false, segments: [seg(0, 3, "kal deploy karte hain", "0", A()), seg(3.5, 6, "theek hai", "1", B())] };
    const r = await ingest.ingestWindow(s.id, wav(), 0, local(), "w.wav", Date.parse("2026-09-22T10:00:00Z"), { channel: 1 });
    expect(transcribe.mock.calls[0][1]).toMatchObject({ model: "qwen3-asr-0.6b", language: "hinglish", speakers: true });
    expect(r.turns.map((t: any) => t.session_speaker_label)).toEqual(["r0", "r1"]);
    const rows = await repo.turnsForClustering(s.id);
    expect(rows.map((x: any) => x.vec?.length)).toEqual([256, 256]);
    expect(text.translate).not.toHaveBeenCalled();
  });

  it("the owner's mic channel skips separation and stays “me” without a voiceprint", async () => {
    const s = await repo.createSession("electron", "meeting", "Zoom");
    next = { text: "", duration: 90, translated: false, segments: [seg(0, 2, "main bol raha hoon", "0", null)] };
    const r = await ingest.ingestWindow(s.id, wav(), 0, local(), "w.wav", undefined, { channel: 0 });
    expect(transcribe.mock.calls[0][1]).toMatchObject({ speakers: false });
    expect(r.turns[0].session_speaker_label).toBe("me");
    expect((await repo.turnsForClustering(s.id))[0].vec).toBeFalsy();
  });

  it("English mode translates through the text engine only when the local model didn't", async () => {
    await repo.putSettings({ transcript_lang: "english" });
    const s = await repo.createSession("electron", "meeting", "Zoom");
    next = { text: "", duration: 10, translated: false, segments: [seg(0, 2, "kal milte hain", "0", null)] };
    const r1 = await ingest.ingestWindow(s.id, wav(), 0, local(), "w.wav", undefined, { channel: 1 });
    expect(r1.turns[0].text).toBe("EN:kal milte hain");
    text.translate.mockClear();
    next = { text: "", duration: 10, translated: true, segments: [seg(0, 2, "See you tomorrow", "0", null)] };
    const r2 = await ingest.ingestWindow(s.id, wav(), 1, local(), "w.wav", undefined, { channel: 1 });
    expect(text.translate).not.toHaveBeenCalled();
    expect(r2.turns[0].text).toBe("See you tomorrow");
    await repo.putSettings({ transcript_lang: "hinglish" });
  });

  it("per-window diarizer labels are reconciled across windows by voiceprint, and enrolled people are named", async () => {
    const s = await repo.createSession("electron", "meeting", "Zoom");
    // Window 0: A is diarizer speaker 0, B is 1. Window 1: the diarizer happens to number them the other way.
    next = { text: "", duration: 90, translated: false, segments: [seg(0, 3, "one", "0", A(0.05)), seg(4, 7, "two", "1", B(0.05)), seg(8, 11, "three", "0", A(0.1))] };
    await ingest.ingestWindow(s.id, wav(), 0, local(), "w.wav", undefined, { channel: 1 });
    next = { text: "", duration: 90, translated: false, segments: [seg(0, 3, "four", "0", B(0.1)), seg(4, 7, "five", "1", A(0.02)), seg(8, 11, "six", "0", B(0.02))] };
    await ingest.ingestWindow(s.id, wav(), 1, local(), "w.wav", undefined, { channel: 1 });
    const priya = await repo.insertPerson("Priya", false, A());

    const res = await speakerId.clusterAndIdentify(s.id);
    expect(res).toEqual({ clusters: 2, matched: 1 });
    const rows = await store.q<any>("SELECT text, session_speaker_label l, person_id p FROM turns WHERE session_id=? ORDER BY window_index, start_ts", [s.id]);
    const byText = Object.fromEntries(rows.map((r: any) => [r.text, r]));
    // Same voice → same label across windows, regardless of the per-window diarizer number.
    expect(byText.one.l).toBe(byText.five.l);
    expect(byText.two.l).toBe(byText.four.l);
    expect(byText.one.l).not.toBe(byText.two.l);
    expect([byText.one.p, byText.three.p, byText.five.p]).toEqual([priya, priya, priya]);
    expect(byText.two.p).toBeNull();
  });
});
