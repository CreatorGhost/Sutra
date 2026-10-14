// The paired-Mac provider over a REAL secure link to a fake Mac: audio goes up in chunks, every text job
// maps to ai.call with the phone's engine pick, and ingest treats it like the desktop's local speech.
import { describe, it, expect, vi, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { adapt } from "../../storage/desktopAdapter";
import { runMigrations } from "../../storage/migrate";
import { fromB64u, generateIdentity } from "../../shared/pairing/crypto";
import { acceptPhone, connectPhone, type SecureLink } from "../../shared/pairing/link";
import { BLOB_CHUNK_BYTES } from "../../shared/pairing/protocol";
import { hostFixture, socketPair } from "../../pairing/__tests__/fixtures";
import { PairedMacProvider } from "../pairedMacProvider";

const raw = new Database(":memory:");
runMigrations({
  exec: (sql) => raw.exec(sql),
  getUserVersion: () => Number(raw.pragma("user_version", { simple: true })),
  setUserVersion: (v) => raw.exec(`PRAGMA user_version=${v};`),
  columns: (t) => (raw.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => String(r.name)),
});
const store = adapt(raw as any);
vi.mock("../../local/db", () => ({ q: (s: string, p?: any[]) => store.q(s, p), run: (s: string, p?: any[]) => store.run(s, p), exec: (s: string) => store.exec(s), persist: async () => {} }));

type Call = { m: string; p: any };
const calls: Call[] = [];
let answer: (m: string, p: any) => unknown = () => null;

async function pairedLink(): Promise<SecureLink> {
  const { auth, identity: mac } = await hostFixture();
  const [phoneSock, hostSock] = socketPair();
  const host = acceptPhone(hostSock, auth);
  const phone = await connectPhone(phoneSock, { hostId: auth.hostId, hostKey: mac.publicKey, identity: await generateIdentity(), pairing: { code: "ABCDEFGHJKMN", deviceName: "Pixel", platform: "android" } });
  (await host).link.onRequest(async (m, p) => { calls.push({ m, p }); return answer(m, p); });
  return phone.link;
}

let link: SecureLink;
const provider = (engine: any = null, model: string | null = null) => new PairedMacProvider(() => ({ whenOnline: async () => link }), { engine, model });
beforeAll(async () => { link = await pairedLink(); });

describe("PairedMacProvider", () => {
  it("uploads audio in ordered chunks, then asks the Mac to transcribe it", async () => {
    calls.length = 0;
    const audio = new Uint8Array(BLOB_CHUNK_BYTES * 2 + 10).map((_, i) => i % 251);
    answer = (m) => (m === "blob.put" ? { received: 1 } : { text: "hi", duration: 3, segments: [], translated: false });
    const r = await provider().transcribeDiarize(new Blob([audio], { type: "audio/ogg;codecs=opus" }), "window-0.ogg", { language: "hinglish", voiceprints: true });
    expect(r).toEqual({ text: "hi", duration: 3, segments: [], translated: false });
    const puts = calls.filter((c) => c.m === "blob.put").map((c) => c.p);
    expect(puts.map((p) => [p.seq, p.last])).toEqual([[0, false], [1, false], [2, true]]);
    expect(new Set(puts.map((p) => p.id)).size).toBe(1);
    const joined = Buffer.concat(puts.map((p) => fromB64u(p.data)));
    expect(joined.equals(Buffer.from(audio))).toBe(true);
    const stt = calls.find((c) => c.m === "stt.transcribe")!.p;
    expect(stt).toMatchObject({ blobId: puts[0].id, mime: "audio/ogg;codecs=opus", filename: "window-0.ogg", opts: { language: "hinglish", voiceprints: true } });
    expect(calls.at(-1)!.m).toBe("stt.transcribe");
  });

  it("sends an empty recording as one final chunk", async () => {
    calls.length = 0;
    answer = (m) => (m === "blob.put" ? { received: 0 } : { text: "", duration: 0, segments: [] });
    await provider().transcribeDiarize(new Blob([], { type: "audio/webm" }), "w.webm");
    expect(calls.filter((c) => c.m === "blob.put").map((c) => [c.p.seq, c.p.last, c.p.data])).toEqual([[0, true, ""]]);
  });

  it("maps every text job to ai.call with the phone's engine pick", async () => {
    calls.length = 0;
    answer = (_m, p) => (p.fn === "translate" || p.fn === "refine" ? p.args[0].map((t: string) => t.toUpperCase()) : p.fn === "rerank" ? [0.5] : { ok: p.fn });
    const p = provider("codex", "gpt-5");
    expect(await p.extract({ s: 1 }, "sys", "user")).toEqual({ ok: "extract" });
    expect(await p.chat({ s: 2 }, "sys2", "q")).toEqual({ ok: "chat" });
    expect(await p.translate(["namaste"])).toEqual(["NAMASTE"]);
    expect(await p.refine(["a"], { mode: "english" })).toEqual(["A"]);
    expect(await p.rerank("q", ["d"])).toEqual([0.5]);
    expect(calls.map((c) => [c.p.fn, c.p.engine, c.p.model])).toEqual([
      ["extract", "codex", "gpt-5"], ["chat", "codex", "gpt-5"], ["translate", "codex", "gpt-5"], ["refine", "codex", "gpt-5"], ["rerank", "codex", "gpt-5"],
    ]);
    expect(calls[0].p.args).toEqual([{ s: 1 }, "sys", "user"]);
    expect(calls[3].p.args).toEqual([["a"], { mode: "english" }]);
    // No engine picked on the phone = the Mac's own choice.
    calls.length = 0;
    await provider().chat({}, "s", "u");
    expect(calls[0].p).toMatchObject({ engine: null, model: null });
  });

  it("can't embed (search falls back to keywords) and says so when the Mac is away", async () => {
    const p = provider();
    expect(p.canEmbed).toBe(false);
    expect(p.sttId).toBe("local");
    await expect(p.embed()).rejects.toThrow(/Embeddings/);
    const away = new PairedMacProvider(() => ({ whenOnline: async () => { throw new Error("Your Mac isn't reachable right now."); } }), { engine: null, model: null });
    await expect(away.chat({}, "s", "u")).rejects.toThrow(/isn't reachable/);
    await expect(away.transcribeDiarize(new Blob([new Uint8Array(4)]), "w.ogg")).rejects.toThrow(/isn't reachable/);
  });
});

describe("ingest through the Mac", () => {
  let repo: typeof import("../../local/repo");
  let ingest: typeof import("../../local/ingest");
  beforeAll(async () => { repo = await import("../../local/repo"); ingest = await import("../../local/ingest"); });

  it("asks for voiceprints and translates when the Mac's model kept the spoken language", async () => {
    await repo.putSettings({ transcript_lang: "english" });
    const s = await repo.createSession("mic", "ambient", null);
    calls.length = 0;
    const vp = new Array(16).fill(0).map((_, i) => (i === 2 ? 1 : 0));
    answer = (m, p) => m === "blob.put" ? { received: 1 }
      : m === "stt.transcribe" ? { text: "", duration: 4, translated: false, segments: [{ speaker: "0", start: 0, end: 2, text: "kal milte hain", embedding: vp }] }
      : p.args[0].map(() => "see you tomorrow");
    const r = await ingest.ingestWindow(s.id, new Blob([new Uint8Array(8)], { type: "audio/ogg" }), 0, provider(), "window-0.ogg", Date.now());
    expect(calls.find((c) => c.m === "stt.transcribe")!.p.opts).toMatchObject({ voiceprints: true, language: "english" });
    expect(calls.some((c) => c.m === "ai.call" && c.p.fn === "translate")).toBe(true);
    expect(r.turns.map((t: any) => t.text)).toEqual(["see you tomorrow"]);
    expect((await repo.turnsForClustering(s.id)).map((x: any) => x.vec?.length)).toEqual([16]);
  });
});
