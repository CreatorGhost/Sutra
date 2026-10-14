// The recording store: encrypted at rest, audio survives a crash mid-chunk, kept screenshots outlive
// the recording, and unconfirmed recordings are swept after a week.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaStore, loadKey, KEEP_UNCONFIRMED_MS } from "../recordingMedia";

const root = () => mkdtempSync(join(tmpdir(), "sutra-media-"));
const plainBox = { available: false, seal: () => "", open: () => Buffer.alloc(0) };
const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, n, 1, 2, 3, 0xff, 0xd9]);

describe("recording media store", () => {
  it("encrypts screenshots and reads them back in order", () => {
    const r = root();
    let t = 1_760_000_000_000;
    const s = new MediaStore(r, loadKey(r, plainBox), () => t);
    const a = s.saveFrame(7, t, jpeg(1), 0.4);
    const b = s.saveFrame(7, t, jpeg(2), 2); // same ms: a distinct name; score clamped
    expect(a.name).toBe(`shot-${t}.jpg`);
    expect(b).toEqual({ name: `shot-${t + 1}.jpg`, at: t, score: 1 });
    expect(Buffer.from(readFileSync(join(r, "7", `${a.name}.enc`))).includes(Buffer.from([0xff, 0xd8, 0xff, 1]))).toBe(false);
    expect([...s.readFrame(7, a.name)]).toEqual([...jpeg(1)]);
    expect(s.frames(7).map((f) => f.name)).toEqual([a.name, b.name]);
    expect(() => s.readFrame(7, "../key.json")).toThrow(/bad screenshot name/);
    expect(() => s.saveFrame("x", t, jpeg(1), 0)).toThrow(/bad recording id/);
  });

  it("keeps audio as encrypted chunks and survives a chunk cut short", () => {
    const r = root();
    const s = new MediaStore(r, loadKey(r, plainBox));
    s.appendAudio(3, new Uint8Array([1, 2, 3]), "audio/webm;codecs=opus");
    s.appendAudio(3, new Uint8Array([4, 5]), "audio/ogg");
    appendFileSync(join(r, "3", "audio.enc"), Buffer.from([0, 0, 0, 99, 1, 2])); // a crash mid-write
    const a = s.readAudio(3)!;
    expect([...a.bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(a.mime).toBe("audio/webm;codecs=opus");
    expect(s.status(3)).toMatchObject({ frames: 0, audioMime: "audio/webm;codecs=opus" });
  });

  it("a kept screenshot outlives its recording; a different install's key can't read it", () => {
    const r = root();
    const s = new MediaStore(r, loadKey(r, plainBox));
    const f = s.saveFrame(9, 1_760_000_000_000, jpeg(5), 0.5);
    s.keep(9, f.name, 42);
    s.deleteSession(9);
    expect(s.status(9)).toBeNull();
    expect([...s.readKept(42, f.name)]).toEqual([...jpeg(5)]);
    const other = root();
    expect(() => new MediaStore(r, loadKey(other, plainBox)).readKept(42, f.name)).toThrow();
    s.deleteKept(42);
    expect(() => s.readKept(42, f.name)).toThrow();
  });

  it("decrypts chosen screenshots into an agent's temp dir under safe names", () => {
    const r = root(), out = root();
    const s = new MediaStore(r, loadKey(r, plainBox));
    const f = s.saveFrame(4, 1_760_000_000_000, jpeg(9), 0.5);
    expect(s.exportFrames(4, [{ name: f.name, label: "S01" }, { name: f.name, label: "../evil" }], out)).toEqual([join(out, "S01.jpg")]);
    expect(readdirSync(out)).toEqual(["S01.jpg"]);
  });

  it("sweeps recordings nobody confirmed within a week", () => {
    const r = root();
    let t = 1_760_000_000_000;
    const s = new MediaStore(r, loadKey(r, plainBox), () => t);
    s.saveFrame(1, t, jpeg(1), 0);
    t += KEEP_UNCONFIRMED_MS - 1000;
    s.saveFrame(2, t, jpeg(1), 0);
    t += 2000;
    expect(s.sweep()).toEqual([1]);
    expect(s.status(1)).toBeNull();
    expect(s.status(2)).not.toBeNull();
  });
});
