import { describe, it, expect } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { probeAcpSession, runAcpPrompt, type AcpOptions } from "../acp";

const AGENT = join(__dirname, "fixtures", "fakeAcpAgent.cjs");
const killed: ChildProcessWithoutNullStreams[] = [];
const kill = (c: ChildProcessWithoutNullStreams) => { killed.push(c); c.kill(); };

function opts(mode: string, extra: Partial<AcpOptions & { extMethod: string }> = {}): AcpOptions & { prompt: string; extMethod?: string } {
  return {
    start: async () => spawn(process.execPath, [AGENT], { env: { ...process.env, FAKE_ACP_MODE: mode } }),
    cwd: "/tmp/sutra-empty", label: "Fake", timeoutMs: 5000, prompt: "Summarise this meeting", ...extra,
  };
}
const echo = (text: string) => JSON.parse(text).echo;

describe("ACP one-shot runner", () => {
  it("initialize → authenticate → session/new → mode/model → prompt, collecting only message chunks", async () => {
    const r = await runAcpPrompt(opts("ok", { authMethodId: "cached_token", mode: "ask", model: "m2" }), kill);
    expect(r.stopReason).toBe("end_turn");
    const e = echo(r.text);
    expect(e.prompt).toBe("Summarise this meeting");
    expect(e.state.calls).toEqual(["initialize", "authenticate", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt"]);
    expect(e.state.client).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    expect(e.state).toMatchObject({ auth: "cached_token", cwd: "/tmp/sutra-empty", mcp: [], mode: "ask", model: "m2" });
    expect(r.text).not.toContain("(thinking)");
    expect(killed.at(-1)?.killed).toBe(true);
  });

  it("skips authenticate unless asked, and skips a mode the agent doesn't offer", async () => {
    const e = echo((await runAcpPrompt(opts("ok", { mode: "plan" }), kill)).text);
    expect(e.state.calls).toEqual(["initialize", "session/new", "session/prompt"]);
  });

  it("refuses tool permissions with the agent's reject option and fails fs requests", async () => {
    const e = echo((await runAcpPrompt(opts("permission"), kill)).text);
    expect(e.state.answers.permission).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(e.state.answers.fs).toBe(-32601);
  });

  it("accepts Grok's prompt_complete notification as the end of the turn", async () => {
    const r = await runAcpPrompt(opts("notify-complete"), kill);
    expect(echo(r.text).prompt).toBe("Summarise this meeting");
  });

  it("surfaces authentication and model errors with the agent's name", async () => {
    await expect(runAcpPrompt(opts("authfail", { authMethodId: "cached_token" }), kill)).rejects.toThrow(/^Fake: Not authenticated/);
    await expect(runAcpPrompt(opts("ok", { model: "nope" }), kill)).rejects.toThrow(/no longer offers the model “nope”/);
    await expect(runAcpPrompt(opts("refuse-model", { model: "m2" }), kill)).rejects.toThrow(/couldn't switch to the model “m2”: Invalid value m2/);
  });

  it("upgrades a saved bare model id to the exact form the session accepts", async () => {
    const e = echo((await runAcpPrompt(opts("suffixed", { model: "opus" }), kill)).text);
    expect(e.state.model).toBe("opus[context=300k]");
  });

  it("reports the agent's stderr when it dies, and times out a hung agent", async () => {
    await expect(runAcpPrompt(opts("crash"), kill)).rejects.toThrow("boom: not logged in");
    const t0 = Date.now();
    await expect(runAcpPrompt(opts("hang", { timeoutMs: 400 }), kill)).rejects.toThrow("Fake took too long to answer.");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(killed.at(-1)?.killed).toBe(true);
  });

  it("probes a session for its models without prompting", async () => {
    const { session } = await probeAcpSession(opts("ok", { extMethod: "cursor/list_available_models" }), kill);
    expect(session.sessionId).toBe("s1");
    expect(session.configOptions.find((o: any) => o.id === "model").options).toHaveLength(2);
  });
});
