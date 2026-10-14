import { describe, it, expect } from "vitest";
import { addTerm, chipState, meetingCounts, peopleLine, projectColor, PROJECT_COLORS, removeHeardAs, removeTerm, splitVariants } from "../projects/model";
import { actionMeta, minutesView } from "../meeting/minutesModel";
import { buildGraph, mergeGraph, searchNodes, typeCounts, typeKey } from "../graph/model";

describe("project chip state", () => {
  const projects = [{ id: 1, name: "Nectar" }, { id: 2, name: "Atlas" }];
  it("shows the mapping, with auto for silent maps", () => {
    expect(chipState({ project_id: 1, project_auto: 1 }, projects)).toEqual({ kind: "mapped", project: projects[0], auto: true });
    expect(chipState({ project_id: 2, project_auto: false, suggested_project_id: 1 }, projects)).toMatchObject({ kind: "mapped", auto: false, project: { id: 2 } });
  });
  it("keeps a mapping to a project not loaded yet", () => {
    expect(chipState({ project_id: 9 }, projects)).toEqual({ kind: "mapped", project: { id: 9 }, auto: false });
  });
  it("offers a suggestion only when unmapped and the project still exists", () => {
    expect(chipState({ project_id: null, suggested_project_id: 2 }, projects)).toEqual({ kind: "suggested", project: projects[1] });
    expect(chipState({ project_id: null, suggested_project_id: 7 }, projects)).toEqual({ kind: "none" });
    expect(chipState({}, projects)).toEqual({ kind: "none" });
  });
});

describe("project helpers", () => {
  it("uses the chosen colour, else a stable one", () => {
    expect(projectColor({ id: 3, color: "#123456" })).toBe("#123456");
    expect(projectColor({ id: 3 })).toBe(PROJECT_COLORS[3]);
    expect(projectColor({ id: 3 + PROJECT_COLORS.length })).toBe(PROJECT_COLORS[3]);
  });
  it("counts meetings per project", () => {
    const m = meetingCounts([{ project_id: 1 }, { project_id: 1 }, { project_id: null }, { project_id: 2 }, {}]);
    expect([...m]).toEqual([[1, 2], [2, 1]]);
  });
  it("summarises people", () => {
    expect(peopleLine([], 0)).toBe("No people yet");
    expect(peopleLine(["Aditya", "Ravi"], 2)).toBe("Aditya, Ravi");
    expect(peopleLine(["Aditya", "Ravi", "Mei", "Jo"], 5)).toBe("Aditya, Ravi +3");
  });
  it("edits the glossary", () => {
    expect(splitVariants(" AI sensor, AI Sensi ;; ")).toEqual(["AI sensor", "AI Sensi"]);
    let t = addTerm([], " AiSensy ", ["AI sensor", "aisensy", "AI sensor"]);
    expect(t).toEqual([{ canonical: "AiSensy", heardAs: ["AI sensor"] }]);
    t = addTerm(t, "aisensy", ["AI Sensi", "ai SENSOR"]);
    expect(t).toEqual([{ canonical: "AiSensy", heardAs: ["AI sensor", "AI Sensi"] }]);
    expect(addTerm(t, "  ")).toBe(t);
    expect(removeHeardAs(t, "AISENSY", "ai sensor")).toEqual([{ canonical: "AiSensy", heardAs: ["AI Sensi"] }]);
    expect(removeTerm(addTerm(t, "Nectar"), "aisensy")).toEqual([{ canonical: "Nectar", heardAs: [] }]);
  });
});

describe("minutes view", () => {
  it("returns null without minutes", () => {
    expect(minutesView(null)).toBeNull();
    expect(minutesView(undefined)).toBeNull();
  });
  it("drops empty sections and blank rows", () => {
    const v = minutesView({
      title: "Weekly sync", summary: " Shipped. ", attendees: ["Aditya", " "], agenda: [], discussion: ["Infra"], decisions: ["Ship Friday"],
      action_items: [{ task: "Deploy", owner: "Aditya", due: "Fri" }, { task: "  " }, { task: "Review", owner: null }], next_steps: [],
      generated_at: "2026-09-22 11:30:00",
    }, "Monitoring sync")!;
    expect(v.title).toBe("Weekly sync");
    expect(v.summary).toBe("Shipped.");
    expect(v.attendees).toEqual(["Aditya"]);
    expect(v.sections.map((s) => s.key)).toEqual(["discussion", "decisions"]);
    expect(v.actions).toEqual([{ task: "Deploy", owner: "Aditya", due: "Fri" }, { task: "Review", owner: null, due: null }]);
    expect(v.empty).toBe(false);
    expect(v.generatedAt).toBe("2026-09-22 11:30:00");
  });
  it("hides a title that repeats the meeting's, and flags empty minutes", () => {
    expect(minutesView({ title: "Weekly Sync" }, "weekly sync")!.title).toBeNull();
    expect(minutesView({ title: "x" })!.empty).toBe(true);
  });
  it("formats action meta", () => {
    expect(actionMeta({ owner: "Ravi", due: "Fri" })).toBe("Ravi · due Fri");
    expect(actionMeta({ owner: null, due: null })).toBe("");
  });
});

describe("graph model", () => {
  const raw = {
    nodes: [
      { id: 1, type: "person", canonical_name: "Aditya", mention_count: 4 },
      { id: 2, type: "Organization", canonical_name: "Acme", mention_count: 1 },
      { id: 3, type: "topic", canonical_name: "Monitoring", mention_count: 2 },
      { id: 4, type: "weird", canonical_name: "Admin panel" },
    ],
    edges: [{ id: 1, src: 1, dst: 2, relation: "works_at" }, { id: 2, src: 1, dst: 3, relation: "owns" }],
  };
  it("normalises types", () => {
    expect(typeKey("Organization")).toBe("org");
    expect(typeKey("people")).toBe("person");
    expect(typeKey("location")).toBe("place");
    expect(typeKey(null)).toBe("other");
  });
  it("hides types and their links", () => {
    const g = buildGraph(raw, new Set(["org"]));
    expect(g.nodes.map((n) => n.id)).toEqual([1, 3, 4]);
    expect(g.links).toEqual([{ source: 1, target: 3, relation: "owns" }]);
    expect(g.nodes[0].val).toBe(5);
    expect(buildGraph(null, new Set())).toEqual({ nodes: [], links: [] });
  });
  it("counts types in legend order", () => {
    expect(typeCounts(raw)).toEqual([{ type: "person", count: 1 }, { type: "topic", count: 1 }, { type: "org", count: 1 }, { type: "other", count: 1 }]);
  });
  it("searches prefix-first", () => {
    const nodes = buildGraph(raw, new Set()).nodes;
    expect(searchNodes(nodes, "ad").map((n) => n.name)).toEqual(["Aditya", "Admin panel"]);
    expect(searchNodes(nodes, "it").map((n) => n.name)).toEqual(["Aditya", "Monitoring"]);
    expect(searchNodes(nodes, " ")).toEqual([]);
  });
  it("merges an expansion without duplicates", () => {
    const m = mergeGraph(raw, { nodes: [raw.nodes[0], { id: 5, type: "event", canonical_name: "Launch" }], edges: [raw.edges[0], { src: 1, dst: 5, relation: "attends" }] });
    expect(m.nodes.map((n) => n.id)).toEqual([1, 2, 3, 4, 5]);
    expect(m.edges).toHaveLength(3);
  });
});
