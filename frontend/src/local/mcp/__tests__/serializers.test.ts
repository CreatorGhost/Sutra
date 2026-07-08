// Unit tests for the PURE MCP serializers + clamp helpers (no DB, no network, no jsdom). These enforce
// the LOCKED whitelists and the hard privacy invariants from mcp-plan.md §5/§9: no voiceprint/embedding
// bytes, no generated_draft body, no redacted turns or the redacted flag, no token/SQLCipher material,
// no graph turn_ids, no whole attrs blob — for EVERY serializer, asserted by recursively scanning keys.
import { describe, it, expect } from "vitest";
import {
  clampInt, clampTopN, clampHops, clampGraphLimit, clampListLimit, clampEventsLimit, clampContextTopN,
  serializeSearch, serializeConversation, serializeConversationList, serializePeople, serializeGraph,
  serializeActionItems, serializeEvents, serializeMinutes, serializeYourContext, serializeAsk,
  serializePrivacy, serializeRollup, YOUR_CONTEXT_NOTE,
} from "../serializers";

// Recursively collect every object key (and string scalar) of a serialized output, so we can assert that
// forbidden field names / marker substrings never appear anywhere in the structure.
function allKeys(v: any, out: string[] = []): string[] {
  if (v == null) return out;
  if (Array.isArray(v)) { for (const x of v) allKeys(x, out); return out; }
  if (typeof v === "object") { for (const k of Object.keys(v)) { out.push(k); allKeys(v[k], out); } return out; }
  return out;
}
const FORBIDDEN_KEYS = [
  "voiceprint", "voiceprint_dim", "has_voiceprint", "embedding", "embed_model", "embed_dim",
  "generated_draft", "redacted", "text_clean", "session_id", "window_index", "member_ids",
  "lang", "start_ts_turn", "attrs", "source_turn_ids", "entity_id", "norm_subject", "share_cloud",
  "turn_ids", "mcp_token", "token", "created_at", "norm_name",
];
function assertNoForbiddenKeys(v: any) {
  const keys = allKeys(v);
  for (const f of FORBIDDEN_KEYS) expect(keys, `forbidden key "${f}" leaked`).not.toContain(f);
}
// Deep-stringify and assert no leak markers / vendor names slipped through as VALUES.
const FORBIDDEN_SUBSTR = ["REDACTED_SECRET_TURN", "PRIVATE_PRIOR_MARKER", "DRAFT_BODY_MARKER"];
function assertNoMarkers(v: any) {
  const s = JSON.stringify(v);
  for (const m of FORBIDDEN_SUBSTR) expect(s, `marker "${m}" leaked`).not.toContain(m);
}

describe("clamp helpers", () => {
  it("clampInt enforces lo/hi/default and truncates", () => {
    expect(clampInt(5, 1, 10, 3)).toBe(5);
    expect(clampInt(0, 1, 10, 3)).toBe(1);       // below lo -> lo
    expect(clampInt(99, 1, 10, 3)).toBe(10);     // above hi -> hi
    expect(clampInt("x", 1, 10, 3)).toBe(3);     // non-numeric -> default
    expect(clampInt(undefined, 1, 10, 3)).toBe(3);
    expect(clampInt(4.9, 1, 10, 3)).toBe(4);     // truncates toward zero
  });
  it("topN clamps 1..50 default 10", () => {
    expect(clampTopN(undefined)).toBe(10);
    expect(clampTopN(0)).toBe(1);
    expect(clampTopN(1)).toBe(1);
    expect(clampTopN(50)).toBe(50);
    expect(clampTopN(51)).toBe(50);
    expect(clampTopN(1000)).toBe(50);
  });
  it("hops clamps 0..3 default 2", () => {
    expect(clampHops(undefined)).toBe(2);
    expect(clampHops(-5)).toBe(0);
    expect(clampHops(0)).toBe(0);
    expect(clampHops(3)).toBe(3);
    expect(clampHops(9)).toBe(3);
  });
  it("graph limit clamps 1..240 default 120", () => {
    expect(clampGraphLimit(undefined)).toBe(120);
    expect(clampGraphLimit(0)).toBe(1);
    expect(clampGraphLimit(240)).toBe(240);
    expect(clampGraphLimit(241)).toBe(240);
  });
  it("list limit clamps 1..200 default 50", () => {
    expect(clampListLimit(undefined)).toBe(50);
    expect(clampListLimit(0)).toBe(1);
    expect(clampListLimit(200)).toBe(200);
    expect(clampListLimit(500)).toBe(200);
  });
  it("events limit clamps 1..50 default 50", () => {
    expect(clampEventsLimit(undefined)).toBe(50);
    expect(clampEventsLimit(0)).toBe(1);
    expect(clampEventsLimit(50)).toBe(50);
    expect(clampEventsLimit(99)).toBe(50);
  });
  it("context topN clamps 1..20 default 8", () => {
    expect(clampContextTopN(undefined)).toBe(8);
    expect(clampContextTopN(0)).toBe(1);
    expect(clampContextTopN(20)).toBe(20);
    expect(clampContextTopN(99)).toBe(20);
  });
});

describe("serializeSearch", () => {
  it("whitelists result fields and ignores extra columns", () => {
    const out = serializeSearch("hi", [{
      conversation_id: 7, title: "T", summary: "S", facts: ["f1"], importance: 0.8,
      started_at: "2026-06-10", score: 1.23,
      embedding: [1, 2, 3], created_at: "x", rrf: 9, id: 5,
    }]);
    expect(out.query).toBe("hi");
    expect(out.results[0]).toEqual({
      conversation_id: 7, title: "T", summary: "S", facts: ["f1"], importance: 0.8,
      started_at: "2026-06-10", score: 1.23,
    });
    assertNoForbiddenKeys(out);
  });
  it("parses facts from a JSON string and tolerates null input", () => {
    const out = serializeSearch("q", [{ conversation_id: 1, facts: '["a","b"]' }]);
    expect(out.results[0].facts).toEqual(["a", "b"]);
    expect(serializeSearch(undefined as any, null as any)).toEqual({ query: "", results: [] });
  });
});

describe("serializeConversation (redaction + transcript gate)", () => {
  const detail = {
    conversation: { id: 1, title: "C1", started_at: "a", ended_at: "b", is_meeting: 1, refined: 1, participant_person_ids: [2, 3, "x"] },
    memory: { title: "M", summary: "s", facts: ["f"], action_items: ["ai"], decisions: ["d"], importance_score: 0.5, type_tags: ["work"] },
    turns: [
      { session_speaker_label: "S1", person_id: 2, person_name: "Farha", is_me: 0, text: "hello", abs_start: "t0",
        // fields that must be dropped:
        text_clean: "HELLO", session_id: 99, window_index: 4, lang: "en", start_ts: 1, end_ts: 2, redacted: 0, voiceprint: "AAAA" },
      { session_speaker_label: "S2", person_id: 3, is_me: 1, text: "REDACTED_SECRET_TURN content", abs_start: "t1", redacted: 1 },
    ],
    participants: [{ id: 2, canonical_name: "Farha", is_me: 0, voiceprint: "x", created_at: "y" }],
    events: [{ id: 5, title: "E", when_text: "w", start_ts: "s", kind: "k", conversation_id: 1 }],
    minutes: { title: "Min", summary: "ms", attendees: ["A"], generated_at: "g" },
  };
  it("drops redacted=1 turns even when transcripts are allowed (defensive guard)", () => {
    const out = serializeConversation(detail, true)!;
    expect(out.turns).toHaveLength(1);
    expect(out.turns[0].speaker).toBe("S1");   // speaker = session_speaker_label
    expect(out.turns[0].text).toBe("hello");
    expect(out.transcripts_shared).toBe(true);
    assertNoMarkers(out);                       // the REDACTED turn's text must be gone
    assertNoForbiddenKeys(out);
  });
  it("turn serializer emits only whitelisted fields", () => {
    const out = serializeConversation(detail, true)!;
    expect(Object.keys(out.turns[0]).sort()).toEqual(
      ["abs_start", "is_me", "person_id", "person_name", "speaker", "text"].sort());
  });
  it("transcripts disabled -> turns [] and transcripts_shared false, memory still present", () => {
    const out = serializeConversation(detail, false)!;
    expect(out.turns).toEqual([]);
    expect(out.transcripts_shared).toBe(false);
    expect(out.memory?.title).toBe("M");
    assertNoMarkers(out);
  });
  it("participant_person_ids keeps only integers; null detail -> null", () => {
    const out = serializeConversation(detail, true)!;
    expect(out.conversation!.participant_person_ids).toEqual([2, 3]);
    expect(serializeConversation(null, true)).toBeNull();
  });
});

describe("serializeConversationList", () => {
  it("whitelists row fields and parses type_tags string", () => {
    const out = serializeConversationList([{ id: 1, title: "T", started_at: "a", ended_at: "b",
      is_meeting: 1, summary: "s", importance_score: 0.4, type_tags: '["work"]', action_count: 2,
      session_id: 9, refined: 1, embedding: [1] }]);
    expect(out[0]).toEqual({ id: 1, title: "T", started_at: "a", ended_at: "b", is_meeting: true,
      summary: "s", importance_score: 0.4, type_tags: ["work"], action_count: 2 });
    assertNoForbiddenKeys(out);
  });
});

describe("serializePeople (voiceprint never leaks)", () => {
  it("emits only safe profile fields", () => {
    const out = serializePeople([{ id: 1, canonical_name: "Aditya", is_me: 1, provisional: 0,
      enroll_count: 3, notes: "me", has_voiceprint: 1, voiceprint: "AAAA", voiceprint_dim: 192, created_at: "x" }]);
    expect(out[0]).toEqual({ id: 1, canonical_name: "Aditya", is_me: true, provisional: false,
      enroll_count: 3, notes: "me" });
    assertNoForbiddenKeys(out);
  });
});

describe("serializeGraph (evidence turn_ids stripped + deduped)", () => {
  it("emits deduped {conversation_id} only — turn_ids never leave", () => {
    const out = serializeGraph({
      nodes: [{ id: 1, type: "person", canonical_name: "Farha", importance: 0.6, mention_count: 4, embedding: [1], norm_name: "farha" }],
      edges: [{ id: 9, src: 1, dst: 2, relation: "works_on", weight: 2,
        evidence: [
          { conversation_id: 1, turn_ids: [10, 11] },
          { conversation_id: 1, turn_ids: [12] },   // duplicate conversation_id -> deduped
          { conversation_id: 2, turn_ids: [99] },
        ] }],
    });
    expect(out.nodes[0]).toEqual({ id: 1, type: "person", canonical_name: "Farha", importance: 0.6, mention_count: 4 });
    expect(out.edges[0].evidence).toEqual([{ conversation_id: 1 }, { conversation_id: 2 }]);
    // turn_ids absent everywhere
    expect(JSON.stringify(out)).not.toContain("turn_ids");
    assertNoForbiddenKeys(out);
  });
  it("parses evidence supplied as a JSON string", () => {
    const out = serializeGraph({ nodes: [], edges: [{ src: 1, dst: 2, relation: "r", weight: 1,
      evidence: '[{"conversation_id":3,"turn_ids":[7]}]' }] });
    expect(out.edges[0].evidence).toEqual([{ conversation_id: 3 }]);
  });
  it("tolerates null/garbage graph", () => {
    expect(serializeGraph(null)).toEqual({ nodes: [], edges: [] });
    expect(serializeGraph({})).toEqual({ nodes: [], edges: [] });
  });
});

describe("serializeActionItems (has_draft derived, draft body never leaves)", () => {
  it("derives has_draft from generated_draft presence, never emits the body", () => {
    const out = serializeActionItems([
      { id: 1, text: "Do X", owner: "me", status: "open", due: "d", source_conversation: 5, generated_draft: "DRAFT_BODY_MARKER ..." },
      { id: 2, text: "Done Y", owner: null, status: "done", due: null, source_conversation: 6, generated_draft: null },
    ]);
    expect(out[0].has_draft).toBe(true);
    expect(out[1].has_draft).toBe(false);
    assertNoMarkers(out);                 // DRAFT_BODY_MARKER must be gone
    assertNoForbiddenKeys(out);
  });
});

describe("serializeEvents", () => {
  it("whitelists fields", () => {
    const out = serializeEvents([{ id: 1, title: "Demo", when_text: "Fri", start_ts: "s", kind: "k",
      conversation_id: 3, conv_title: "C", created_at: "x" }]);
    expect(out[0]).toEqual({ id: 1, title: "Demo", when_text: "Fri", start_ts: "s", kind: "k",
      conversation_id: 3, conv_title: "C" });
    assertNoForbiddenKeys(out);
  });
});

describe("serializeMinutes", () => {
  it("whitelists minute sections; null -> null", () => {
    expect(serializeMinutes(null)).toBeNull();
    const out = serializeMinutes({ title: "T", summary: "s", attendees: ["A"], agenda: ["g"],
      discussion: ["d"], decisions: ["dec"], action_items: [{ task: "t" }], next_steps: ["n"],
      generated_at: "g", extra_secret: "leak" })!;
    expect(Object.keys(out).sort()).toEqual(
      ["action_items", "agenda", "attendees", "decisions", "discussion", "generated_at", "next_steps", "summary", "title"].sort());
    assertNoForbiddenKeys(out);
  });
});

describe("serializeYourContext (priors whitelist + attrs lift)", () => {
  it("lifts relationship_to_user from attrs, rounds confidence to 3dp, drops attrs/share_cloud/turn_ids", () => {
    const out = serializeYourContext([{
      kind: "person", subject: "Farha", value: "designer on Redesign", status: "confirmed",
      effective_confidence: 0.8765432, attrs: { relationship_to_user: "colleague", secret: "hidden" },
      share_cloud: 1, source_turn_ids: [1, 2, 3], entity_id: 5, norm_subject: "farha",
    }]);
    expect(out.note).toBe(YOUR_CONTEXT_NOTE);
    expect(out.priors[0]).toEqual({
      kind: "person", subject: "Farha", value: "designer on Redesign",
      relationship_to_user: "colleague", effective_confidence: 0.877, status: "confirmed",
    });
    assertNoForbiddenKeys(out);
  });
  it("parses attrs supplied as a JSON string and tolerates missing attrs", () => {
    const a = serializeYourContext([{ kind: "k", subject: "s", attrs: '{"relationship_to_user":"friend"}', effective_confidence: 0.5 }]);
    expect(a.priors[0].relationship_to_user).toBe("friend");
    const b = serializeYourContext([{ kind: "k", subject: "s" }]);
    expect(b.priors[0].relationship_to_user).toBeNull();
    expect(b.priors[0].effective_confidence).toBeNull();
  });
  it("note must NOT name any AI vendor/model", () => {
    expect(YOUR_CONTEXT_NOTE.toLowerCase()).not.toMatch(/openai|gpt|claude|anthropic|gemini|llama|sutra/);
  });
});

describe("serializeAsk", () => {
  it("whitelists answer/supported/citations/retrieved", () => {
    const out = serializeAsk({ answer: "A", supported: true,
      citations: [{ conversation_id: 1, title: "T", date: "d", extra: "x" }],
      retrieved: [{ conversation_id: 2, title: "U", score: 0.9, embedding: [1] }], internal: "leak" });
    expect(out.answer).toBe("A");
    expect(out.supported).toBe(true);
    expect(out.citations[0]).toEqual({ conversation_id: 1, title: "T", date: "d" });
    expect(out.retrieved[0]).toEqual({ conversation_id: 2, title: "U", score: 0.9 });
    assertNoForbiddenKeys(out);
  });
  it("defaults safely on garbage input", () => {
    expect(serializeAsk(null)).toEqual({ answer: "", supported: false, citations: [], retrieved: [] });
  });
});

describe("serializePrivacy", () => {
  it("passes through only status/mode/privacy strings", () => {
    const out = serializePrivacy({ status: "ok", mode: "hybrid", privacy: "Audio is never stored.", secret: "x" });
    expect(out).toEqual({ status: "ok", mode: "hybrid", privacy: "Audio is never stored." });
  });
});

describe("serializeRollup", () => {
  it("whitelists day/summary/highlights/open_actions (parsed), drops id/emailed_at/created_at", () => {
    const out = serializeRollup({ id: 1, day: "2026-06-10", summary: "s",
      highlights: '["h1","h2"]', open_actions: '[{"text":"t","owner":"o","due":"d","secret":"x"}]',
      emailed_at: "e", created_at: "c" })!;
    expect(out.day).toBe("2026-06-10");
    expect(out.highlights).toEqual(["h1", "h2"]);
    expect(out.open_actions).toEqual([{ text: "t", owner: "o", due: "d" }]);
    assertNoForbiddenKeys(out);
  });
  it("null row -> null", () => {
    expect(serializeRollup(null)).toBeNull();
  });
});
