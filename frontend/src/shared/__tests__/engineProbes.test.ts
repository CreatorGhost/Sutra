import { describe, it, expect } from "vitest";
import {
  parseAcpModels, resolveAcpModelId, upgradeModelId, parseClaudeAuthStatus, parseCodexAuthFile, parseCodexLoginStatus, parseCommandCodeModelList, parseCommandCodeStatus,
  parseCursorAbout, parseDroidModelList, parseGeminiAuth, parseGrokModels, parseVersion,
  parseCursorModels, pickContext, splitModelParams, withContext,
} from "../engineProbes";
import { validateJson } from "../jsonSchemaLite";

describe("engine probes", () => {
  it("version: first non-empty line", () => {
    expect(parseVersion("\n2.1.296 (Claude Code)\n")).toBe("2.1.296 (Claude Code)");
    expect(parseVersion("")).toBeNull();
  });

  it("claude auth status", () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.co","subscriptionType":"max"}')).toEqual({ signedIn: true, account: "a@b.co · max" });
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}')).toEqual({ signedIn: true, account: null });
    expect(parseClaudeAuthStatus('{"loggedIn":false}')).toEqual({ signedIn: false, account: null });
    expect(parseClaudeAuthStatus("error: unknown command 'auth'")).toEqual({ signedIn: null, account: null });
  });

  it("codex login status + auth.json id_token", () => {
    expect(parseCodexLoginStatus("Not logged in")).toEqual({ signedIn: false, account: null });
    expect(parseCodexLoginStatus("Logged in using ChatGPT")).toEqual({ signedIn: true, account: "ChatGPT" });
    expect(parseCodexLoginStatus("Logged in using an API key - sk-proj-***")).toEqual({ signedIn: true, account: "API key" });
    const payload = Buffer.from(JSON.stringify({ email: "dev@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString("base64url");
    expect(parseCodexAuthFile(JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }))).toEqual({ email: "dev@example.com", plan: "plus" });
    expect(parseCodexAuthFile("{}")).toEqual({ email: null, plan: null });
  });

  it("cursor about (JSON and text)", () => {
    expect(parseCursorAbout('{"cliVersion":"2026.05.09-abc","userEmail":"me@x.io","subscriptionTier":"Pro"}')).toEqual({ version: "2026.05.09-abc", signedIn: true, account: "me@x.io · Pro" });
    expect(parseCursorAbout('{"cliVersion":"2026.05.09-abc","userEmail":null}')).toMatchObject({ signedIn: false });
    expect(parseCursorAbout("About Cursor CLI\n\nCLI Version         2026.03.20-44cb435\nUser Email          Not logged in\n")).toEqual({ version: "2026.03.20-44cb435", signedIn: false, account: null });
    expect(parseCursorAbout("About Cursor CLI\n\nCLI Version         2026.03.20-44cb435\nUser Email          user@example.com\n")).toMatchObject({ signedIn: true, account: "user@example.com" });
    expect(parseCursorAbout("unknown command: about")).toEqual({ version: null, signedIn: null, account: null });
  });

  it("gemini sign-in from ~/.gemini", () => {
    const env = {};
    expect(parseGeminiAuth({ settings: null, accounts: null, hasOauthCreds: false, env })).toEqual({ signedIn: false, account: null });
    expect(parseGeminiAuth({ settings: '{"security":{"auth":{"selectedType":"oauth-personal"}}}', accounts: '{"active":"g@gmail.com","old":[]}', hasOauthCreds: true, env }))
      .toEqual({ signedIn: true, account: "g@gmail.com" });
    expect(parseGeminiAuth({ settings: null, accounts: null, hasOauthCreds: false, env: { GEMINI_API_KEY: "k" } })).toEqual({ signedIn: true, account: "API key" });
    expect(parseGeminiAuth({ settings: '{"security":{"auth":{"selectedType":"oauth-personal"}}}', accounts: null, hasOauthCreds: false, env }).signedIn).toBeNull();
  });

  it("grok models (exit 0 either way)", () => {
    const out = "You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n";
    expect(parseGrokModels(out)).toEqual({ authenticated: true, models: ["grok-4.6", "grok-4.5"], defaultModel: "grok-4.6" });
    expect(parseGrokModels("You are not authenticated.\n\nDefault model: grok-4.6\n").authenticated).toBe(false);
  });

  it("droid `exec -m ?` model list", () => {
    const out = "Invalid model: ?\n\nAvailable built-in models:\n  auto, claude-opus-5-5, gpt-6-sol\n\nAvailable custom models:\n  custom:My-Llama-0 (My Llama)\n";
    expect(parseDroidModelList(out)).toEqual(["auto", "claude-opus-5-5", "gpt-6-sol", "custom:My-Llama-0"]);
    expect(parseDroidModelList(out + out)).toHaveLength(4);
  });

  it("command code status + model list", () => {
    expect(parseCommandCodeStatus('{"authenticated":false,"version":"1.82.1"}')).toEqual({ authenticated: false, version: "1.82.1" });
    expect(parseCommandCodeStatus("garbage")).toBeNull();
    const list = "Available models  ·  89 models\n\nOpen Source\n\ndeepseek/deepseek-v4-pro               hybrid reasoning\ndeepseek/deepseek-v4-flash             fast reasoning (default)\n\nPass the full id to --model\nDecision models\nx/y  z\n";
    expect(parseCommandCodeModelList(list)).toEqual({ models: ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"], defaultModel: "deepseek/deepseek-v4-flash" });
  });

  it("ACP model discovery", () => {
    expect(parseAcpModels({ models: [{ value: "gpt-5", name: "GPT-5" }, { value: "sonnet-4.5", name: "Sonnet" }] }, null).models).toEqual(["gpt-5", "sonnet-4.5"]);
    // Cursor: the session's suffixed ids win over list_available_models' bare (and over-promising) ones.
    const cursor = { models: { currentModelId: "opus-5[context=300k]", availableModels: [{ modelId: "opus-5[context=300k]" }, { modelId: "gpt-5[]" }] } };
    expect(parseAcpModels({ models: [{ value: "opus-5" }, { value: "gpt-5" }, { value: "only-listed" }] }, cursor))
      .toEqual({ models: ["opus-5[context=300k]", "gpt-5[]"], defaultModel: "opus-5[context=300k]" });
    expect(parseAcpModels(null, { models: { currentModelId: "b", availableModels: [{ modelId: "a" }, { modelId: "b" }] } })).toEqual({ models: ["a", "b"], defaultModel: "b" });
    expect(parseAcpModels(null, { configOptions: [{ id: "model", category: "model", currentValue: "x", options: [{ value: "x" }, { group: "g", options: [{ value: "y" }] }] }] }))
      .toEqual({ models: ["x", "y"], defaultModel: "x" });
    expect(parseAcpModels(null, {})).toEqual({ models: [], defaultModel: null });
  });

  it("resolves a saved model id to the form the ACP session accepts", () => {
    const session = { models: { currentModelId: "opus-5[context=1m]", availableModels: [{ modelId: "opus-5[context=300k]" }, { modelId: "opus-5[context=1m]" }, { modelId: "gpt-5[]" }] } };
    expect(resolveAcpModelId("gpt-5[]", session)).toBe("gpt-5[]");                    // exact
    expect(resolveAcpModelId("opus-5", session)).toBe("opus-5[context=1m]");          // bare → the session's current pick
    expect(resolveAcpModelId("GPT-5", session)).toBe("gpt-5[]");                      // base match ignores case
    expect(resolveAcpModelId("retired-model", session)).toBeNull();                   // gone
    expect(resolveAcpModelId("anything", {})).toBe("anything");                       // session doesn't list models
    const opt = { configOptions: [{ id: "model", category: "model", currentValue: "x[a]", options: [{ value: "x[a]" }, { group: "g", options: [{ value: "y[b]" }] }] }] };
    expect(resolveAcpModelId("y", opt)).toBe("y[b]");
  });

  it("upgrades a saved model id to the form the engine lists now", () => {
    const offered = ["opus-5[context=300k]", "gpt-5[]"];
    expect(upgradeModelId("opus-5", offered)).toBe("opus-5[context=300k]");
    expect(upgradeModelId("gpt-5[]", offered)).toBe("gpt-5[]");
    expect(upgradeModelId("retired", offered)).toBe("retired");      // left for the call to report
    expect(upgradeModelId("", offered)).toBe("");
  });
});

describe("JSON schema validation (the subset Sutra's AI schemas use)", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      score: { type: "number" },
      ids: { type: "array", items: { type: "integer" } },
      owner: { type: ["string", "null"] },
      kind: { type: "string", enum: ["meeting", "call"] },
      items: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      either: { anyOf: [{ type: "string" }, { type: "boolean" }] },
    },
    required: ["title", "score", "owner", "kind"],
    additionalProperties: false,
  };
  it("accepts a valid object (extra keys tolerated)", () => {
    expect(validateJson(schema, { title: "t", score: 1, ids: [1, 2], owner: null, kind: "call", items: [{ text: "x" }], either: true, extra: 1 })).toEqual([]);
    expect(validateJson(schema, { title: "t", score: 0.5, owner: "me", kind: "meeting" })).toEqual([]);
  });
  it("reports missing keys, wrong types, enums and nested paths", () => {
    const errs = validateJson(schema, { title: 3, score: "1", ids: [1.5], kind: "chat", items: [{}], either: 4 });
    expect(errs).toEqual(expect.arrayContaining([
      "owner: required", "title: expected string, got integer", "score: expected number, got string",
      "ids[0]: expected integer, got number", 'kind: must be one of "meeting", "call"', "items[0].text: required",
    ]));
    expect(errs.length).toBeLessThanOrEqual(8);
    expect(validateJson(schema, [])).toEqual(["(root): expected object, got array"]);
  });
});

describe("Cursor parameterized models", () => {
  const ctx = (...v: string[]) => v.map((x) => ({ value: x, label: x.toUpperCase() }));

  it("splits and rebuilds a model id's inline params", () => {
    expect(splitModelParams("opus-5[context=1m, fast=true]")).toEqual({ base: "opus-5", params: { context: "1m", fast: "true" } });
    expect(splitModelParams("opus-5")).toEqual({ base: "opus-5", params: {} });
    expect(withContext("opus-5[context=300k]", "1m")).toBe("opus-5[context=1m]");
    expect(withContext("opus-5[context=1m]", null)).toBe("opus-5");
  });

  it("defaults to 300K, else the nearest window under it; honours an explicit pick", () => {
    expect(pickContext(ctx("300k", "1m"), null)).toBe("300k");
    expect(pickContext(ctx("272k", "1m"), null)).toBe("272k");
    expect(pickContext(ctx("1m", "2m"), null)).toBe("1m");      // nothing smaller: the smallest
    expect(pickContext(ctx("300k", "1m"), "1M")).toBe("1m");    // by label, any case
    expect(pickContext(ctx("272k", "1m"), "300k")).toBe("272k");
    expect(pickContext([], "1m")).toBeNull();
  });

  it("lists every model as a bare id, with names and context windows", () => {
    const r = parseCursorModels({ models: [
      { value: "claude-opus-5", name: "Opus 5", configOptions: [
        { id: "context", category: "model_config", name: "Context", type: "select", currentValue: "300k", options: [{ value: "300k", name: "300K" }, { value: "1m", name: "1M" }] },
        { id: "fast", category: "model_config", name: "Fast", type: "select", currentValue: "false", options: [{ value: "false" }, { value: "true" }] },
      ] },
      { value: "composer-2", name: "Composer 2", configOptions: [] },
      { value: "claude-opus-5[context=1m]", name: "dupe" },
    ] });
    expect(r.models).toEqual(["claude-opus-5", "composer-2"]);
    expect(r.modelNames).toEqual({ "claude-opus-5": "Opus 5", "composer-2": "Composer 2" });
    expect(r.contexts).toEqual({ "claude-opus-5": [{ value: "300k", label: "300K" }, { value: "1m", label: "1M" }] });
  });

  it("keeps a saved context choice when the engine lists bare ids", () => {
    expect(upgradeModelId("claude-opus-5[context=1m]", ["claude-opus-5", "gpt-5"])).toBe("claude-opus-5[context=1m]");
    expect(upgradeModelId("claude-opus-5", ["claude-opus-5[context=300k]"])).toBe("claude-opus-5[context=300k]");
  });
});
