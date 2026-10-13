import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../../shared/agentProtocol";
import { engineOptions, optionKey, prettyModel, toggleFavorite, visibleOptions } from "../modelPicker";

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
