import { describe, expect, it, vi } from "vitest";
import { fromUtf8, newStorageKey, openAtRest, utf8 } from "../../shared/pairing/crypto";
import { MAX_ATTEMPTS, Outbox, type OutboxDeps, type OutboxEvent } from "../outbox";
import { memoryFs } from "./fixtures";

const KEY = newStorageKey();
const audio = (s: string) => new Blob([utf8(s) as Uint8Array<ArrayBuffer>], { type: "audio/ogg" });
const meta = (i: number) => ({ filename: `window-${i}.ogg`, windowStartMs: 1000 * i });

function setup(over: Partial<OutboxDeps> = {}) {
  const fs = memoryFs();
  let ready = true;
  const ingested: { sid: number; index: number; text: string }[] = [];
  const deps: OutboxDeps = {
    fs,
    storageKey: async () => KEY,
    ready: () => ready,
    ingest: vi.fn(async (sid: number, blob: Blob, index: number) => {
      const text = fromUtf8(new Uint8Array(await blob.arrayBuffer()));
      ingested.push({ sid, index, text });
      return { turns: [{ text }] };
    }),
    process: vi.fn(async () => ({ extracted: [1] })),
    conversations: vi.fn(async (sid: number) => [{ id: sid * 10, finished: true }]),
    sync: vi.fn(async () => {}),
    retryDelayMs: 1,
    ...over,
  };
  const box = new Outbox(deps);
  const events: OutboxEvent[] = [];
  box.subscribe((e) => events.push(e));
  return { box, fs, deps, ingested, events, setReady: (v: boolean) => { ready = v; } };
}
const binFiles = (fs: ReturnType<typeof memoryFs>) => [...fs.files.keys()].filter((k) => k.endsWith(".bin")).sort();

describe("audio queue", () => {
  it("writes each window sealed before anything else, and keeps it while the Mac is away", async () => {
    const { box, fs, deps, setReady } = setup();
    setReady(false);
    box.begin(1);
    await box.enqueue(1, 0, audio("first words"), meta(0));
    await box.drain();
    expect(deps.ingest).not.toHaveBeenCalled();
    const sealed = fs.files.get("sutra-queue/1/0.bin")!;
    expect(fromUtf8(sealed)).not.toContain("first words");
    expect(fromUtf8(await openAtRest(KEY, sealed))).toBe("first words");
    expect(JSON.parse(fromUtf8(fs.files.get("sutra-queue/1/0.json")!))).toMatchObject({ filename: "window-0.ogg", mime: "audio/ogg", windowStartMs: 0 });
    expect(await box.stats()).toEqual({ recordings: 1, windows: 1, failed: 0 });
  });

  it("sends windows in order and deletes each one once it's transcribed", async () => {
    const { box, fs, ingested, events, setReady } = setup();
    setReady(false);
    box.begin(1);
    for (const i of [2, 0, 1]) await box.enqueue(1, i, audio(`w${i}`), meta(i));
    setReady(true);
    await box.drain();
    expect(ingested.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(ingested.map((x) => x.text)).toEqual(["w0", "w1", "w2"]);
    expect(binFiles(fs)).toEqual([]);
    expect(events.filter((e) => e.t === "ingested").map((e: any) => e.result.turns[0].text)).toEqual(["w0", "w1", "w2"]);
  });

  it("keeps a window when the Mac drops mid-send, without counting it as a failure", async () => {
    const s = setup();
    s.deps.ingest = vi.fn(async () => { s.setReady(false); throw new Error("Lost the connection to your Mac."); });
    s.box.begin(1);
    await s.box.enqueue(1, 0, audio("w0"), meta(0));
    await s.box.drain();
    expect(binFiles(s.fs)).toEqual(["sutra-queue/1/0.bin"]);
    expect(JSON.parse(fromUtf8(s.fs.files.get("sutra-queue/1/0.json")!))).toMatchObject({ attempts: 0, failed: false });
  });

  it("gives up on a window the Mac can't read after a few tries, without blocking the rest", async () => {
    const s = setup();
    const ok = s.deps.ingest;
    s.deps.ingest = vi.fn(async (sid: number, blob: Blob, index: number, f: string, t: number) => {
      if (index === 0) throw new Error("Couldn't decode this audio.");
      return ok(sid, blob, index, f, t);
    });
    s.box.begin(1);
    await s.box.enqueue(1, 0, audio("bad"), meta(0));
    await s.box.enqueue(1, 1, audio("good"), meta(1));
    await s.box.drain();
    expect(s.ingested.map((x) => x.index)).toEqual([1]);
    expect((s.deps.ingest as any).mock.calls.filter((c: any[]) => c[2] === 0)).toHaveLength(MAX_ATTEMPTS);
    expect(s.events.find((e) => e.t === "failed")).toMatchObject({ sessionId: 1, windowIndex: 0, error: "Couldn't decode this audio." });
    expect(await s.box.stats()).toMatchObject({ windows: 0, failed: 1 });

    // Retry: it works this time and the audio is deleted.
    s.deps.ingest = ok;
    await s.box.retryFailed();
    await s.box.drain();
    expect(s.ingested.map((x) => x.index)).toEqual([1, 0]);
    expect(binFiles(s.fs)).toEqual([]);
  });

  it("can discard windows that failed", async () => {
    const s = setup({ ingest: vi.fn(async () => { throw new Error("bad audio"); }) });
    s.box.begin(1);
    await s.box.enqueue(1, 0, audio("bad"), meta(0));
    await s.box.drain();
    expect((await s.box.stats()).failed).toBe(1);
    await s.box.discardFailed();
    expect(binFiles(s.fs)).toEqual([]);
  });

  it("writes the notes after the last window, copies the meeting to the Mac, then forgets the recording", async () => {
    const s = setup();
    s.box.begin(7);
    await s.box.enqueue(7, 0, audio("a"), meta(0));
    await s.box.drain();
    expect(s.deps.process).not.toHaveBeenCalled(); // still recording
    await s.box.enqueue(7, 1, audio("b"), meta(1));
    await s.box.closeSession(7);
    await s.box.drain();
    expect(s.deps.process).toHaveBeenCalledTimes(1);
    expect(s.deps.process).toHaveBeenCalledWith(7);
    expect(s.deps.sync).toHaveBeenCalledWith(70);
    expect(s.events.some((e) => e.t === "processed" && e.sessionId === 7)).toBe(true);
    expect([...s.fs.files.keys()]).toEqual([]);
    expect(await s.box.isWaiting(7)).toBe(false);
  });

  it("waits for the Mac to write notes, and re-sends a meeting the Mac didn't take", async () => {
    const s = setup();
    s.setReady(false);
    s.box.begin(3);
    await s.box.enqueue(3, 0, audio("a"), meta(0));
    await s.box.closeSession(3);
    await s.box.drain();
    expect(await s.box.isWaiting(3)).toBe(true);
    expect(s.deps.process).not.toHaveBeenCalled();

    let fail = true;
    s.deps.sync = vi.fn(async () => { if (fail) throw new Error("Mac said no"); });
    s.setReady(true);
    await s.box.drain();
    expect(s.deps.process).toHaveBeenCalledTimes(1);
    expect(await s.box.isWaiting(3)).toBe(false); // notes are written…
    expect(s.fs.files.has("sutra-queue/3/session.json")).toBe(true); // …but the copy to the Mac is still owed
    fail = false;
    await s.box.drain();
    expect(s.deps.process).toHaveBeenCalledTimes(1);
    expect(s.deps.sync).toHaveBeenCalledTimes(2);
    expect([...s.fs.files.keys()]).toEqual([]);
  });

  it("only copies conversations that got their notes, and keeps the entry for the rest", async () => {
    const s = setup({ conversations: vi.fn(async () => [{ id: 1, finished: true }, { id: 2, finished: false }]) });
    s.box.begin(5);
    await s.box.enqueue(5, 0, audio("a"), meta(0));
    await s.box.closeSession(5);
    await s.box.drain();
    expect(s.deps.sync).toHaveBeenCalledTimes(1);
    expect(s.deps.sync).toHaveBeenCalledWith(1);
    expect([...s.fs.files.keys()]).toEqual(["sutra-queue/5/session.json"]); // no audio left
  });

  it("closes recordings cut short by the app being killed, but not the live one", async () => {
    const s = setup();
    s.setReady(false);
    await s.box.enqueue(1, 0, audio("orphan"), meta(0));
    s.box.begin(2);
    await s.box.enqueue(2, 0, audio("live"), meta(0));
    expect(await s.box.recover()).toEqual([1]);
    s.setReady(true);
    await s.box.drain();
    expect(s.deps.process).toHaveBeenCalledTimes(1);
    expect(s.deps.process).toHaveBeenCalledWith(1);
  });

  it("forgets everything on unpair", async () => {
    const s = setup();
    s.setReady(false);
    await s.box.enqueue(1, 0, audio("a"), meta(0));
    await s.box.clear();
    expect([...s.fs.files.keys()]).toEqual([]);
    expect(await s.box.stats()).toEqual({ recordings: 0, windows: 0, failed: 0 });
  });

  it("refuses to queue without a pairing key (audio is never kept unencrypted)", async () => {
    const s = setup({ storageKey: async () => null });
    await expect(s.box.enqueue(1, 0, audio("a"), meta(0))).rejects.toThrow(/isn't paired/);
    expect(s.fs.files.size).toBe(0);
  });
});
