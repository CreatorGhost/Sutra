import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../../shared/agentProtocol";
import { agentsFromHost, carryContext, engineOptions, listedModel, modelContext, modelName, optionKey, prettyModel, toggleFavorite, visibleOptions } from "../modelPicker";

const st = (id: AgentStatus["id"], over: Partial<AgentStatus> = {}): AgentStatus => ({
  id, label: id, installed: true, path: "/bin/x", version: "1", signedIn: true, account: null, models: [], defaultModel: null,
  install: "", signIn: "", hint: null, ...over,
} as AgentStatus);

describe("prettyModel", () => {
  it("formats common slugs", () => {
    expect(prettyModel("sonnet")).toBe("Sonnet");
    expect(prettyModel("gpt-5-codex")).toBe("GPT-5 Codex");
    expect(prettyModel("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(prettyModel("auto")).toBe("Auto");
    expect(prettyModel("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(prettyModel("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
  });
});

describe("engineOptions", () => {
  it("lists Default first, then reported models, and keeps a custom current model", () => {
    const o = engineOptions(st("claude", { models: ["sonnet", "opus"], defaultModel: "sonnet" }), "claude-x");
    expect(o.map((x) => x.model)).toEqual([null, "sonnet", "opus", "claude-x"]);
    expect(o[0]).toMatchObject({ name: "Default", hint: "Sonnet", key: "claude:" });
  });
  it("drops model names that aren't safe on a command line", () => {
    expect(engineOptions(st("codex", { models: ["ok-1", "bad; rm -rf"] }), null).map((x) => x.model)).toEqual([null, "ok-1"]);
  });
});

describe("visibleOptions", () => {
  const agents = [st("claude", { models: ["sonnet", "opus"] }), st("codex", { models: ["gpt-5-codex"] }), st("cursor", { signedIn: false, models: ["auto"] })];
  it("shows one engine's models on its tab", () => {
    expect(visibleOptions({ agents, settings: {}, tab: "codex", query: "" }).map((o) => o.key)).toEqual(["codex:", "codex:gpt-5-codex"]);
  });
  it("searches every ready engine, never a signed-out one", () => {
    expect(visibleOptions({ agents, settings: {}, tab: "claude", query: "codex" }).map((o) => o.key)).toEqual(["codex:", "codex:gpt-5-codex"]);
    expect(visibleOptions({ agents, settings: {}, tab: "claude", query: "auto" })).toEqual([]);
  });
  it("lists favorites in the order they were starred, skipping ones no longer available", () => {
    const favs = toggleFavorite(toggleFavorite(["cursor:auto"], optionKey("codex", "gpt-5-codex")), "claude:opus");
    expect(visibleOptions({ agents, settings: { ai_model_favorites: favs }, tab: "favorites", query: "" }).map((o) => o.key))
      .toEqual(["codex:gpt-5-codex", "claude:opus"]);
    expect(toggleFavorite(favs, "claude:opus")).not.toContain("claude:opus");
  });
});

describe("engines on a paired Mac", () => {
  it("lists the Mac's engines in the picker; only ready ones offer models", () => {
    const agents = agentsFromHost([
      { id: "claude", label: "Claude Code", ready: true, account: "a@b.c", models: ["sonnet", "opus"], defaultModel: "sonnet" },
      { id: "codex", label: "Codex", ready: false, account: null, models: ["gpt-5"], defaultModel: null },
    ]);
    expect(agents.map((a) => [a.id, a.installed, a.signedIn])).toEqual([["claude", true, true], ["codex", false, null]]);
    expect(visibleOptions({ agents, settings: {}, tab: "claude", query: "" }).map((o) => o.key)).toEqual(["claude:", "claude:sonnet", "claude:opus"]);
    expect(visibleOptions({ agents, settings: {}, tab: "codex", query: "" })).toEqual([]);
  });
});

describe("Cursor context windows in the picker", () => {
  const two = [{ value: "300k", label: "300K" }, { value: "1m", label: "1M" }];
  const cursor = st("cursor", { models: ["claude-opus-5", "gpt-5", "composer-2"], modelNames: { "claude-opus-5": "Opus 5" },
    contexts: { "claude-opus-5": two, "gpt-5": [{ value: "272k", label: "272K" }, { value: "1m", label: "1M" }] } });

  it("treats a saved context suffix as the listed model", () => {
    expect(listedModel(cursor, "claude-opus-5[context=1m]")).toBe("claude-opus-5");
    expect(engineOptions(cursor, "claude-opus-5[context=1m]").map((o) => o.model)).toEqual([null, "claude-opus-5", "gpt-5", "composer-2"]);
    expect(modelName(cursor, "claude-opus-5[context=1m]")).toBe("Opus 5");
    // An engine whose own ids carry the suffix keeps them as they are.
    expect(listedModel(st("grok", { models: ["opus[context=300k]"] }), "opus[context=300k]")).toBe("opus[context=300k]");
  });

  it("folds Cursor's own 'default' (Auto) into the Default row", () => {
    const opts = engineOptions({ ...cursor, models: ["default", ...cursor.models], modelNames: { ...cursor.modelNames, default: "Auto" } }, null);
    expect(opts[0]).toMatchObject({ model: null, name: "Default", hint: "Auto" });
    expect(opts.map((o) => o.model)).not.toContain("default");
  });

  it("shows the window in use: 300K by default, 1M when chosen, none without a choice", () => {
    expect(modelContext(cursor, "claude-opus-5")).toEqual({ choices: two, value: "300k" });
    expect(modelContext(cursor, "claude-opus-5[context=1m]").value).toBe("1m");
    expect(modelContext(cursor, "composer-2")).toEqual({ choices: [], value: null });
  });

  it("carries a 1M pick to the next model only when it offers 1M", () => {
    expect(carryContext(cursor, "claude-opus-5[context=1m]", "gpt-5")).toBe("gpt-5[context=1m]");
    expect(carryContext(cursor, "claude-opus-5[context=1m]", "composer-2")).toBe("composer-2");
    expect(carryContext(cursor, "claude-opus-5", "gpt-5")).toBe("gpt-5");
  });
});
