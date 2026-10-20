import { describe, it, expect, vi } from "vitest";

const run = vi.fn(async (id: string) => {
  if (id === "claude") throw new Error("Claude AI usage limit reached|1792430000");
  if (id === "codex") return { text: "{}", json: { ok: "codex" } };
  throw new Error("should not get here");
});
(globalThis as any).sutraDesktop = {
  isDesktop: true, platform: "darwin", db: () => null,
  ai: {
    run,
    detect: async () => [
      { id: "claude", installed: true, signedIn: true },
      { id: "cursor", installed: true, signedIn: false },
      { id: "codex", installed: true, signedIn: true },
    ],
  },
};

describe("engine out of quota", () => {
  it("runs the same job on the next signed-in engine", async () => {
    const { AgentProvider } = await import("../agentProvider");
    const p = new AgentProvider("claude", () => null);
    expect(await p.extract({}, "sys", "user")).toEqual({ ok: "codex" });
    expect(run.mock.calls.map((c) => c[0])).toEqual(["claude", "codex"]);
    expect(p.lastEngine).toBe("codex");
  });

  it("doesn't fall back on other errors", async () => {
    const { AgentProvider } = await import("../agentProvider");
    run.mockImplementationOnce(async () => { throw new Error("returned notes in the wrong shape"); });
    await expect(new AgentProvider("claude", () => null).extract({}, "s", "u")).rejects.toThrow(/wrong shape/);
  });
});
