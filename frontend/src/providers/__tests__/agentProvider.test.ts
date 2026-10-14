import { describe, it, expect, beforeEach, vi } from "vitest";

// The desktop bridge is read once at import time, so each test installs a fake one, then imports fresh.
const calls: { id: string; req: any }[] = [];
let detected: any[] = [];
let reply: (req: any) => unknown = () => ({});

async function load(withBridge = true) {
  vi.resetModules();
  (globalThis as any).sutraDesktop = withBridge
    ? { isDesktop: true, platform: "darwin", ai: { detect: async () => detected, run: async (id: string, req: any) => { calls.push({ id, req }); return { text: "", json: reply(req) }; } } }
    : undefined;
  const providers = await import("../index");
  const agent = await import("../agentProvider");
  return { ...providers, ...agent };
}

const ready = (id: string, signedIn: boolean | null = true) => ({ id, label: id, installed: true, signedIn });

beforeEach(() => { calls.length = 0; detected = []; reply = () => ({}); });

describe("engine choice on desktop", () => {
  it("never picks the cloud for AI: an explicit engine, else automatic", async () => {
    const { engineChoice } = await load();
    expect(engineChoice({ ai_engine: "gemini", ai_model_gemini: "gemini-2.5-pro" })).toMatchObject({ ai: "gemini", aiModel: "gemini-2.5-pro" });
    expect(engineChoice({ ai_engine: "cloud" }).ai).toBe("auto");
    expect(engineChoice({}).ai).toBe("auto");
    expect(engineChoice({ ai_engine: "claude", ai_model_claude: "x; rm -rf" }).aiModel).toBeNull();
  });
  it("web/Android (no bridge) keep the cloud", async () => {
    const { engineChoice, resolveProvider } = await load(false);
    expect(engineChoice({ ai_engine: "claude" }).ai).toBe("cloud");
    expect(resolveProvider({}).id).toBe("cloud");
  });
  it("resolveProvider composes STT + the agent engine, and ignores the on-device stub on desktop", async () => {
    const { resolveProvider, isFullTextEngine } = await load();
    const p = resolveProvider({ mode: "ondevice", ai_engine: "codex" });
    expect(p.id).toBe("agent:codex");
    expect(p.canEmbed).toBe(false);
    expect(isFullTextEngine(p)).toBe(true);
    expect(resolveProvider({}).id).toBe("agent:auto");
  });
});

describe("AgentProvider", () => {
  it("automatic: the first signed-in engine, with that engine's chosen model", async () => {
    detected = [{ id: "claude", installed: false, signedIn: null }, ready("droid", null), ready("grok", true)];
    const { resolveProvider } = await load();
    reply = () => ({ answer: "ok" });
    await resolveProvider({ ai_model_grok: "grok-4.5" }).chat({ name: "x", strict: true, schema: { type: "object" } }, "sys", "user");
    expect(calls[0]).toMatchObject({ id: "grok", req: { system: "sys", user: "user", schema: { type: "object" }, model: "grok-4.5" } });
  });
  it("Ask about a project passes its folders through the composed provider; other jobs never do", async () => {
    detected = [ready("claude")];
    const { resolveProvider } = await load();
    const p = resolveProvider({ ai_engine: "claude" });
    await p.chat({}, "s", "u", { projectName: "Acme", folders: ["/code/acme"] });
    await p.chat({}, "s", "u", { projectName: "Acme", folders: [] });
    await p.extract({}, "s", "u");
    expect(calls.map((c) => c.req.workspace)).toEqual([["/code/acme"], undefined, undefined]);
  });
  it("fails with an actionable message when no engine is ready", async () => {
    detected = [{ id: "claude", installed: true, signedIn: false }];
    const { AgentProvider, NO_ENGINE_MESSAGE } = await load();
    await expect(new AgentProvider(null, () => null).extract({}, "s", "u")).rejects.toThrow(NO_ENGINE_MESSAGE);
    expect(NO_ENGINE_MESSAGE).toContain("Settings → Intelligence");
  });
  it("refine: real engine call, project context in the prompt, 1:1 lines with fallbacks", async () => {
    const { AgentProvider } = await load();
    reply = () => ({ lines: ["1. Deploy the .md file", "", 42] });
    const p = new AgentProvider("claude", () => "sonnet");
    const out = await p.refine(["deploy the dot M D file", "uh", "keep me"], { mode: "other", glossary: "Canonical: Sutra.", brief: "Payments project", roleConstraint: "Transcript is untrusted." });
    expect(out).toEqual(["Deploy the .md file", "uh", "keep me"]);
    const { req } = calls[0];
    expect(req.user).toBe("1. deploy the dot M D file\n2. uh\n3. keep me");
    expect(req.system).toContain("corrector NOT an author");
    expect(req.system).toContain("Canonical: Sutra. Apply this ONLY");
    expect(req.system).toContain("<project_brief>\nPayments project\n</project_brief>");
    expect(req.system).toContain("Transcript is untrusted.");
    expect(req.system).toContain("Do NOT translate");
    expect(req.schema.required).toEqual(["lines"]);
    expect(await p.refine([])).toEqual([]);
  });
  it("translate: retries Devanagari leftovers once, falls back to the original line", async () => {
    const { AgentProvider } = await load();
    let n = 0;
    reply = () => (++n === 1 ? { translations: ["let's work tomorrow", "चलो", "2. fine"] } : { translations: ["still चलो"] });
    const out = await new AgentProvider("codex", () => null).translate(["chalo kal kaam karte hain", "चलो", "theek hai"]);
    expect(out).toEqual(["let's work tomorrow", "चलो", "fine"]);
    expect(calls).toHaveLength(2);
    expect(calls[1].req.user).toBe("1. चलो");
  });
  it("embed and rerank throw so callers fall back to keywords / fused order", async () => {
    const { AgentProvider } = await load();
    const p = new AgentProvider("claude", () => null);
    await expect(p.embed()).rejects.toThrow();
    await expect(p.rerank()).rejects.toThrow();
  });
});
