import { describe, it, expect } from "vitest";
import {
  AGENTS, AGENT_IDS, acpInvocation, agentBinaries, agentInvocation, buildAgentPrompt, extractJson, installCommand, isAgentId,
  looksSignedOut, parseAgentOutput, safeModel,
} from "../agentProtocol";
import { WHISPER_MODELS, parseWhisperJson, whisperArgs, whisperLanguageArgs } from "../localModels";

const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

describe("engine registry", () => {
  it("has exactly the seven supported engines", () => {
    expect(AGENT_IDS).toEqual(["claude", "codex", "cursor", "gemini", "grok", "droid", "commandcode"]);
    for (const id of AGENT_IDS) {
      expect(AGENTS[id].id).toBe(id);
      expect(AGENTS[id].initials).toHaveLength(2);
      expect(AGENTS[id].signIn).toBeTruthy();
    }
    expect(isAgentId("gemini")).toBe(true);
    expect(isAgentId("cloud")).toBe(false);
  });
  it("never looks for Command Code as `cmd` on Windows (that's cmd.exe)", () => {
    expect(agentBinaries("commandcode", "win32")).toEqual(["command-code"]);
    expect(agentBinaries("commandcode", "darwin")).toContain("cmd");
  });
  it("uses the platform's install command", () => {
    expect(installCommand("cursor", "win32")).toMatch(/^irm /);
    expect(installCommand("cursor", "darwin")).toMatch(/^curl /);
    expect(installCommand("gemini", "win32")).toBe("npm install -g @google/gemini-cli");
  });
});

describe("agent invocations", () => {
  it("claude: print mode, JSON envelope, tools/slash commands/hooks off, schema enforced by the CLI", () => {
    const inv = agentInvocation("claude", { system: "s", user: "u", schema, model: "sonnet" }, "/tmp/x");
    expect(inv.args).toEqual(["-p", "--output-format", "json", "--tools", "", "--disable-slash-commands", "--permission-mode", "dontAsk",
      "--settings", '{"disableAllHooks":true}', "--no-session-persistence", "--model", "sonnet", "--json-schema", JSON.stringify(schema)]);
  });
  it("codex: exec, read-only sandbox, schema + last-message files, prompt on stdin", () => {
    const inv = agentInvocation("codex", { system: "s", user: "u", schema }, "/tmp/x");
    expect(inv.args.slice(0, 5)).toEqual(["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only"]);
    expect(inv.args).toContain("--output-schema");
    expect(inv.args.at(-1)).toBe("-");
    expect(inv.outFile).toBe("/tmp/x/last-message.txt");
    expect(inv.schemaFile).toBe("/tmp/x/schema.json");
  });
  it("gemini: headless JSON, read-only plan mode, prompt on stdin, `auto` = no -m", () => {
    expect(agentInvocation("gemini", { system: "s", user: "u", model: "auto" }, "/t").args).toEqual(["-p", "", "--output-format", "json", "--approval-mode", "plan", "--skip-trust"]);
    expect(agentInvocation("gemini", { system: "s", user: "u", model: "gemini-2.5-pro" }, "/t").args.slice(-2)).toEqual(["-m", "gemini-2.5-pro"]);
  });
  it("command code: print mode without --yolo, no session file", () => {
    const inv = agentInvocation("commandcode", { system: "s", user: "u", model: "deepseek/deepseek-v4-pro" }, "/t");
    expect(inv.args).toEqual(["-p", "--output-format", "json", "--skip-onboarding", "--no-auto-update", "--no-session", "--model", "deepseek/deepseek-v4-pro"]);
    expect(inv.args).not.toContain("--yolo");
  });
  it("ACP agents: cursor in ask mode with its cached login; grok's model as a flag; droid's API key only when set", () => {
    expect(acpInvocation("cursor", "auto")).toEqual({ args: ["acp"], authMethodId: "cursor_login", mode: "ask", model: null });
    expect(acpInvocation("cursor", "gpt-5").model).toBe("gpt-5");
    expect(acpInvocation("grok", "grok-4.6")).toEqual({ args: ["agent", "--no-leader", "-m", "grok-4.6", "stdio"], authMethodId: "cached_token" });
    expect(acpInvocation("grok", null, { XAI_API_KEY: "k" }).authMethodId).toBe("xai.api_key");
    expect(acpInvocation("droid", "auto")).toEqual({ args: ["exec", "--output-format", "acp"], authMethodId: undefined, model: null });
    expect(acpInvocation("droid", "claude-opus-5-5", { FACTORY_API_KEY: "k" })).toMatchObject({ authMethodId: "factory-api-key", model: "claude-opus-5-5" });
    expect(() => agentInvocation("grok", { system: "", user: "" }, "/t")).toThrow();
  });
  it("rejects unsafe model names (they go on a command line)", () => {
    expect(safeModel("gpt-5-codex")).toBe("gpt-5-codex");
    expect(safeModel("deepseek/deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
    expect(safeModel("x; rm -rf /")).toBeNull();
    expect(safeModel("--yolo")).toBeNull();
    expect(safeModel("")).toBeNull();
  });
  it("spells out the schema only when the CLI can't enforce it, and appends retry errors", () => {
    expect(buildAgentPrompt({ system: "S", user: "U", schema }, true)).toContain("JSON Schema");
    expect(buildAgentPrompt({ system: "S", user: "U", schema }, false)).not.toContain("JSON Schema");
    const retry = buildAgentPrompt({ system: "S", user: "U", schema }, true, ["answer: required"]);
    expect(retry).toContain("- answer: required");
    expect(retry.indexOf("answer: required")).toBeGreaterThan(retry.indexOf("U"));
  });
});

describe("agent output parsing", () => {
  it("claude structured_output", () => {
    const out = JSON.stringify({ is_error: false, result: '{"answer":"x"}', structured_output: { answer: "Ship Friday" } });
    expect(parseAgentOutput("claude", out, null).structured).toEqual({ answer: "Ship Friday" });
  });
  it("claude verbose envelope: the last result message wins", () => {
    const out = JSON.stringify([{ type: "system" }, { type: "assistant" }, { type: "result", is_error: false, result: "hi", structured_output: { answer: "a" } }]);
    expect(parseAgentOutput("claude", out, null)).toEqual({ text: "hi", structured: { answer: "a" } });
  });
  it("codex last-message file", () => {
    expect(parseAgentOutput("codex", "noise", '{"answer":"from file"}').text).toBe('{"answer":"from file"}');
  });
  it("gemini response / error", () => {
    expect(parseAgentOutput("gemini", JSON.stringify({ session_id: "s", response: "Hello", stats: {} }), null).text).toBe("Hello");
    expect(() => parseAgentOutput("gemini", JSON.stringify({ error: { type: "Error", message: "Please set an Auth method", code: 41 } }), null)).toThrow("Auth method");
  });
  it("command code: the final result line", () => {
    const ok = ['{"type":"event","event":{"type":"run_start","sessionId":"x"}}', '{"type":"result","subtype":"success","finalText":"{\\"answer\\":\\"y\\"}"}'].join("\n");
    expect(parseAgentOutput("commandcode", ok, null).text).toBe('{"answer":"y"}');
    const bad = '{"type":"result","subtype":"error","finalText":"","error":"Error: Not authenticated. Please run \\"cmd login\\" first."}';
    expect(() => parseAgentOutput("commandcode", bad, null)).toThrow(/^Not authenticated/);
  });
  it("surfaces agent errors", () => {
    expect(() => parseAgentOutput("claude", JSON.stringify({ is_error: true, result: "Not logged in" }), null)).toThrow("Not logged in");
  });
  it("extracts balanced JSON with braces inside strings, and fenced JSON", () => {
    expect(extractJson('ok: {"a":"}{","b":[1,{"c":2}]} trailing')).toEqual({ a: "}{", b: [1, { c: 2 }] });
    expect(extractJson('Sure!\n```json\n{"answer":"yes"}\n```')).toEqual({ answer: "yes" });
    expect(() => extractJson("no json here")).toThrow();
  });
  it("recognises sign-in errors", () => {
    expect(looksSignedOut('Not authenticated. Please run "cmd login" first.')).toBe(true);
    expect(looksSignedOut("Invalid API key · Please run /login")).toBe(true);
    expect(looksSignedOut("Please set an Auth method in your settings.json")).toBe(true);
    expect(looksSignedOut("rate limited")).toBe(false);
  });
});

describe("local whisper", () => {
  it("catalog uses official whisper.cpp ggml file names", () => {
    for (const m of WHISPER_MODELS) expect(m.file).toMatch(/^ggml-[\w.-]+\.bin$/);
    expect(WHISPER_MODELS.filter((m) => m.recommended)).toHaveLength(1);
  });
  it("maps transcript languages to whisper flags", () => {
    expect(whisperLanguageArgs("english")).toMatchObject({ language: "auto", translate: true });
    expect(whisperLanguageArgs("devanagari")).toMatchObject({ language: "hi", translate: false });
    const args = whisperArgs({ modelPath: "/m.bin", wavPath: "/a.wav", outPrefix: "/a", threads: 4, ...whisperLanguageArgs("english") });
    expect(args).toEqual(["-m", "/m.bin", "-f", "/a.wav", "-oj", "-of", "/a", "-np", "-t", "4", "-l", "auto", "-tr"]);
  });
  it("parses whisper-cli -oj output, drops noise, joins broken sentences", () => {
    const json = {
      result: { language: "en" },
      transcription: [
        { timestamps: { from: "00:00:00,000", to: "00:00:02,000" }, offsets: { from: 0, to: 2000 }, text: " Monitoring is basically" },
        { offsets: { from: 2100, to: 4000 }, text: " done." },
        { offsets: { from: 4000, to: 9000 }, text: " [BLANK_AUDIO]" },
        { offsets: { from: 9000, to: 12000 }, text: " Let's deploy Friday." },
      ],
    };
    const r = parseWhisperJson(JSON.stringify(json));
    expect(r.segments).toEqual([
      { start: 0, end: 4, text: "Monitoring is basically done." },
      { start: 9, end: 12, text: "Let's deploy Friday." },
    ]);
    expect(r.duration).toBe(12);
  });
});
