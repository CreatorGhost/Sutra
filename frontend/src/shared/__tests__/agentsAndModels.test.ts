import { describe, it, expect } from "vitest";
import { agentInvocation, buildAgentPrompt, extractJson, parseAgentOutput, safeModel } from "../agentProtocol";
import { WHISPER_MODELS, parseWhisperJson, whisperArgs, whisperLanguageArgs } from "../localModels";

const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

describe("agent invocations", () => {
  it("claude: print mode, JSON envelope, tools off, schema enforced by the CLI", () => {
    const inv = agentInvocation("claude", { system: "s", user: "u", schema, model: "sonnet" }, "/tmp/x");
    expect(inv.stdin).toBe(true);
    expect(inv.args).toEqual(["-p", "--output-format", "json", "--tools", "", "--no-session-persistence", "--model", "sonnet", "--json-schema", JSON.stringify(schema)]);
  });
  it("codex: exec, read-only sandbox, schema + last-message files, prompt on stdin", () => {
    const inv = agentInvocation("codex", { system: "s", user: "u", schema }, "/tmp/x");
    expect(inv.args.slice(0, 5)).toEqual(["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only"]);
    expect(inv.args).toContain("--output-schema");
    expect(inv.args.at(-1)).toBe("-");
    expect(inv.outFile).toBe("/tmp/x/last-message.txt");
  });
  it("cursor: print mode with the prompt as an argument", () => {
    const inv = agentInvocation("cursor", { system: "s", user: "u", model: "auto" }, "/tmp/x");
    expect(inv).toMatchObject({ stdin: false, args: ["-p", "--output-format", "json"] });
  });
  it("rejects unsafe model names", () => {
    expect(safeModel("gpt-5-codex")).toBe("gpt-5-codex");
    expect(safeModel("x; rm -rf /")).toBeNull();
  });
  it("spells out the schema only when the CLI can't enforce it", () => {
    expect(buildAgentPrompt({ system: "S", user: "U", schema }, true)).toContain("JSON Schema");
    expect(buildAgentPrompt({ system: "S", user: "U", schema }, false)).not.toContain("JSON Schema");
  });
});

describe("agent output parsing", () => {
  it("claude structured_output", () => {
    const out = JSON.stringify({ is_error: false, result: '{"answer":"x"}', structured_output: { answer: "Ship Friday" } });
    expect(parseAgentOutput("claude", out, null, true).json).toEqual({ answer: "Ship Friday" });
  });
  it("cursor result text with fenced JSON", () => {
    const out = JSON.stringify({ type: "result", is_error: false, result: 'Sure!\n```json\n{"answer":"yes"}\n```' });
    expect(parseAgentOutput("cursor", out, null, true).json).toEqual({ answer: "yes" });
  });
  it("codex last-message file", () => {
    expect(parseAgentOutput("codex", "noise", '{"answer":"from file"}', true).json).toEqual({ answer: "from file" });
  });
  it("surfaces agent errors", () => {
    expect(() => parseAgentOutput("claude", JSON.stringify({ is_error: true, result: "Not logged in" }), null, false)).toThrow("Not logged in");
  });
  it("extracts balanced JSON with braces inside strings", () => {
    expect(extractJson('ok: {"a":"}{","b":[1,{"c":2}]} trailing')).toEqual({ a: "}{", b: [1, { c: 2 }] });
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
