import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() }, ipcMain: { handle: () => {} }, safeStorage: {} }));

const locked = { available: true, seal: (k: string) => Buffer.from(k), open: () => { throw new Error("denied"); } };

describe("data keys are never replaced", () => {
  it("database: a key that can't be opened stops with a fix, and the key file is left as it was", async () => {
    const { provisionKey } = await import("../storage");
    const dir = mkdtempSync(join(tmpdir(), "sutra-key-"));
    writeFileSync(join(dir, "sutra.key"), "sealed-old");
    expect(() => provisionKey(dir, locked)).toThrow(/Always Allow/);
    expect(readFileSync(join(dir, "sutra.key"), "utf8")).toBe("sealed-old");
    expect(() => provisionKey(dir, { ...locked, available: false })).toThrow(/Always Allow/);
  });

  it("database: a database without its key is not given a new one", async () => {
    const { provisionKey } = await import("../storage");
    const dir = mkdtempSync(join(tmpdir(), "sutra-key-"));
    writeFileSync(join(dir, "sutra.db"), "x");
    expect(() => provisionKey(dir, locked)).toThrow(/missing/);
    expect(existsSync(join(dir, "sutra.key"))).toBe(false);
  });

  it("recordings: an unreadable key is set aside, not overwritten", async () => {
    const { loadKey } = await import("../recordingMedia");
    const dir = mkdtempSync(join(tmpdir(), "sutra-rec-"));
    writeFileSync(join(dir, "key.json"), JSON.stringify({ sealed: true, key: "old" }));
    const key = loadKey(dir, { available: true, seal: (b) => b.toString("base64"), open: () => { throw new Error("denied"); } });
    expect(key).toHaveLength(32);
    const aside = readdirSync(dir).find((f) => f.startsWith("key.unreadable-"))!;
    expect(JSON.parse(readFileSync(join(dir, aside), "utf8")).key).toBe("old");
  });
});
