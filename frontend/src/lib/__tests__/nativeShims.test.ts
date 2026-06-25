// Native-shim web/no-op branches (ticket F7 — "NATIVE SHIMS DON'T THROW").
// In a non-native (desktop/web) runtime — Capacitor.isNativePlatform() === false — the native-only
// integrations must take their web branch WITHOUT throwing an unhandled error. This exercises the two
// the acceptance calls out:
//   • exportBackup() (lib/backup.ts) → the web "download a file" branch (no Filesystem/Share).
//   • shareMinutes() (local/sutra.ts) → the web "navigator.clipboard.writeText" branch (no Share sheet).
// The Capacitor native modules are mocked so importing them never pulls in a real plugin, and
// isNativePlatform() is forced false to select the web branch.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Shared Capacitor mocks: web platform, native plugins inert ───────────────────────────────────
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE" },
  Encoding: { UTF8: "utf8" },
  Filesystem: { writeFile: vi.fn(), getUri: vi.fn() },
}));
vi.mock("@capacitor/share", () => ({ Share: { share: vi.fn() } }));

describe("exportBackup web branch (!isNativePlatform)", () => {
  const click = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    click.mockClear();
    // Tests run in the node environment (no jsdom — matching the repo convention). The web download
    // branch only needs document.createElement("a") + URL.createObjectURL/revokeObjectURL + Blob;
    // inject minimal fakes so the branch runs and we can observe the anchor click.
    (URL as any).createObjectURL = vi.fn(() => "blob:fake");
    (URL as any).revokeObjectURL = vi.fn();
    Object.defineProperty(globalThis, "document", {
      value: { createElement: () => ({ href: "", download: "", click }) },
      configurable: true, writable: true,
    });
  });

  it("downloads a JSON file and does NOT throw / does NOT call native Share", async () => {
    // The DB connection backup.ts dumps from — only exportToJson is reached on this path.
    vi.doMock("../../local/db", () => ({
      DB_NAME: "sutra",
      getConnection: async () => ({
        exportToJson: async () => ({ export: { database: "sutra", version: 1, tables: [] } }),
      }),
      getSqlite: async () => ({}),
      openDb: async () => ({ query: async () => ({ values: [{ user_version: 1 }] }) }),
      persist: async () => undefined,
      resetConnectionCache: () => undefined,
    }));

    const { exportBackup } = await import("../backup");
    const { Share } = await import("@capacitor/share");

    const res = await exportBackup();

    expect(res.filename).toMatch(/^sutra-backup-\d{8}\.json$/);
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.uri).toBeUndefined();          // web branch returns no native file uri
    expect(click).toHaveBeenCalledTimes(1);   // the download anchor was clicked
    expect((Share.share as any)).not.toHaveBeenCalled(); // native Share sheet NOT used on web
  });
});

describe("shareMinutes web branch (!isNativePlatform)", () => {
  beforeEach(() => vi.resetModules());

  it("copies markdown to the clipboard and does NOT throw / does NOT open the Share sheet", async () => {
    // Mock sutra.ts's collaborators so only the shareMinutes web path runs (no provider/db graph).
    vi.doMock("../../local/repo", () => ({
      getSettings: async () => ({ mode: "local" }),
      conversationDetail: async () => ({ conversation: { title: "Weekly sync" }, minutes: { summary: "x" } }),
      PROJECT_LABEL: "Projects",
    }));
    vi.doMock("../../local/minutes", () => ({
      minutesToMarkdown: (_t: string, _m: any) => "# Weekly sync\n- decided",
    }));
    // Inert stubs for the rest of sutra.ts's import graph (never reached by shareMinutes).
    const noop = {};
    vi.doMock("../../providers", () => ({ getProvider: async () => noop, MODE_COPY: {}, }));
    vi.doMock("../../local/db", () => ({ q: async () => [] }));
    vi.doMock("../../local/chat", () => ({}));
    vi.doMock("../../local/extraction", () => ({}));
    vi.doMock("../../local/graph", () => ({ expand: () => {}, graphOverview: () => {} }));
    vi.doMock("../../local/ingest", () => ({}));
    vi.doMock("../../local/people", () => ({}));
    vi.doMock("../../local/recap", () => ({}));
    vi.doMock("../../local/refinement", () => ({}));
    vi.doMock("../../local/search", () => ({ searchMemories: async () => [] }));
    vi.doMock("../../local/training", () => ({}));

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText } }, configurable: true, writable: true,
    });

    const { api } = await import("../../local/sutra");
    const { Share } = await import("@capacitor/share");

    const res = await api.shareMinutes(1);

    expect(res).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith("# Weekly sync\n- decided"); // clipboard branch taken
    expect((Share.share as any)).not.toHaveBeenCalled();                // native Share NOT used on web
  });
});
