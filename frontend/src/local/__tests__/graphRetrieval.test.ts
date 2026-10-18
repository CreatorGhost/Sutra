// The graph page's data and Ask's graph-found meetings, through the REAL repo on an in-memory SQLite.
import { describe, it, expect, vi, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { adapt } from "../../storage/desktopAdapter";
import { runMigrations } from "../../storage/migrate";
import { buildGraph } from "../../app/graph/model";

const raw = new Database(":memory:");
runMigrations({
  exec: (sql) => raw.exec(sql),
  getUserVersion: () => Number(raw.pragma("user_version", { simple: true })),
  setUserVersion: (v) => raw.exec(`PRAGMA user_version=${v};`),
  columns: (t) => (raw.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => String(r.name)),
});
const store = adapt(raw as any);
vi.mock("../db", () => ({ q: (s: string, p?: any[]) => store.q(s, p), run: (s: string, p?: any[]) => store.run(s, p), exec: (s: string) => store.exec(s), persist: async () => {} }));

let repo: typeof import("../repo");
let graph: typeof import("../graph");
beforeAll(async () => { repo = await import("../repo"); graph = await import("../graph"); });

async function meeting(title: string, summary: string) {
  const s = await repo.createSession("electron", "meeting", "Zoom");
  await repo.insertTurn({ session_id: s.id, session_speaker_label: "me", text: summary, start_ts: 0, end_ts: 2, abs_start: "2026-10-01T10:00:00.000Z" });
  const { segmentSession } = await import("../segmentation");
  const [cid] = await segmentSession(s.id);
  await repo.upsertMemory({ conversation_id: cid, title, summary, facts: [], action_items: [], decisions: [], open_questions: [], importance: 0.5, type_tags: [] });
  return cid;
}

describe("graph page data", () => {
  it("one link per pair listing every relation; size by connections; hubs get the labels", () => {
    const g = buildGraph({
      nodes: [1, 2, 3, 4, 5, 6].map((id) => ({ id, type: "topic", canonical_name: `n${id}`, mention_count: 1 })),
      edges: [{ src: 1, dst: 2, relation: "uses" }, { src: 2, dst: 1, relation: "related_to" }, { src: 1, dst: 3, relation: "uses" }, { src: 1, dst: 4, relation: "uses" }],
    }, new Set());
    expect(g.links).toHaveLength(3);
    expect(g.links[0].relations).toEqual(["uses", "related_to"]);
    const n1 = g.nodes.find((n) => n.id === 1)!, n6 = g.nodes.find((n) => n.id === 6)!;
    expect(n1.degree).toBe(3);
    expect(n1.val).toBeGreaterThan(n6.val);
    expect(n1.hub).toBe(true);
  });

  it("the overview drops the owner and entities left without a link", async () => {
    const cid = await meeting("Sync", "x");
    const me = await graph.upsertEntity("person", "Me", null, null);
    const a = await graph.upsertEntity("project", "Mantis", null, null);
    const b = await graph.upsertEntity("topic", "Slack alerts", null, null);
    await graph.upsertEntity("topic", "Lonely", null, null);
    await graph.upsertEdge(a, b, "uses", cid, []);
    await graph.upsertEdge(me, a, "works on", cid, []);
    const o = await graph.graphOverview();
    expect((o.nodes as any[]).map((n) => n.canonical_name).sort()).toEqual(["Mantis", "Slack alerts"]);
    expect(o.edges).toHaveLength(1);
  });
});

describe("Ask finds related work through the graph", () => {
  it("ranks meetings by the edges that link them, skipping ones search already found", () => {
    const edges = [
      { src: 1, dst: 2, weight: 1, evidence: [{ conversation_id: 10 }, { conversation_id: 11 }] },
      { src: 2, dst: 3, weight: 3, evidence: [{ conversation_id: 12 }] },
      { src: 3, dst: 4, weight: 1, evidence: [{ conversation_id: 13 }, { conversation_id: 13 }] },
    ];
    expect(graph.relatedConversations(edges, [1], new Set([11]))).toEqual([12, 10, 13]);
  });

  it("brings a meeting from another project into a project-scoped answer, citable", async () => {
    const pA = await repo.createProject(), pB = await repo.createProject();
    await repo.updateProject(pB, { name: "MCS" });
    const here = await meeting("Mantis alerts", "Planning Slack alerts for Mantis");
    const there = await meeting("Webhook retry queue", "Built a retry queue for outgoing webhooks");
    await repo.setConversationProject(here, pA);
    await repo.setConversationProject(there, pB);
    const q = await graph.upsertEntity("topic", "Slack alerts", null, [1, 0]);
    const w = await graph.upsertEntity("topic", "webhook retries", null, [0.9, 0.1]);
    await graph.upsertEdge(q, w, "depends on", there, []);
    const { chat } = await import("../chat");
    const provider: any = {
      id: "agent:claude", canEmbed: true, embed: async () => [[1, 0]],
      chat: vi.fn(async () => ({ answer: "You built a retry queue in MCS [C" + there + "].", supported: true, citation_conversation_ids: [there] })),
    };
    const r = await chat("How should Slack alerts retry?", provider, [], pA);
    const user = provider.chat.mock.calls[0][2] as string;
    expect(user).toContain("# Related meetings (linked through the knowledge graph; may be from other projects)");
    expect(user).toContain(`[C${there}] (2026-10-01) [project: MCS] Webhook retry queue`);
    expect(r.citations.map((c: any) => c.conversation_id)).toEqual([there]);
  });
});
