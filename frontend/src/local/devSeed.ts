// DEV-only deterministic seed for exercising the MCP read path end-to-end (mcp-plan.md §8). Exposed
// as window.__sutraDev = { seed } from sutra.ts's DEV block. Imports repo/db/graph/minutes-level
// modules ONLY — never sutra.ts (avoids an import cycle). Uses the SAME insert helpers the real
// extraction pipeline uses, so FTS stays in sync (repo.upsertMemory), turns go through repo.insertTurn,
// the graph through graph.upsertEntity/upsertEdge, minutes through repo.setMinutes, priors through
// repo.insertPrior, and the daily rollup through repo.upsertRollup.
//
// The fixture embeds three marker strings that must NEVER surface in any MCP response (except
// has_draft:true): REDACTED_SECRET_TURN (a redacted=1 turn), PRIVATE_PRIOR_MARKER (a share_cloud=0
// prior), DRAFT_BODY_MARKER (a generated_draft body). Verifiers grep every tool output for them.
import { q, run, persist } from "./db";
import * as graph from "./graph";
import * as repo from "./repo";

const SEED_TITLE_C1 = "Sprint planning with Farha";
const SEED_TITLE_C2 = "Coffee catchup";
// Deterministic prior subjects (exact strings, so the wipe matches what we inserted — normName
// leaves punctuation/markers in place, so a norm_subject IN(bare-name) match would not).
const SEED_PRIOR_P1 = "Farha — designer on Redesign";
const SEED_PRIOR_P2 = "Acme — PRIVATE_PRIOR_MARKER client account";
const SEED_PRIOR_P3 = "Redesign";

/** Has this DB already been seeded? Marker = the C1 conversation by its deterministic title. */
async function seedConversationId(): Promise<number | null> {
  const row = (await q("SELECT id FROM conversations WHERE title=? LIMIT 1", [SEED_TITLE_C1]))[0] as any;
  return row ? Number(row.id) : null;
}

/** Idempotent: wipe any prior seed rows (by marker/title) then re-insert a deterministic fixture. */
async function wipePriorSeed(): Promise<void> {
  // Conversations (and their cascade-linked turns/memories/events/minutes) by title.
  const convs = (await q("SELECT id FROM conversations WHERE title IN (?,?)", [SEED_TITLE_C1, SEED_TITLE_C2])) as any[];
  for (const c of convs) {
    const cid = Number(c.id);
    await run("DELETE FROM turns WHERE conversation_id=?", [cid]);
    const m = (await q("SELECT id FROM memories WHERE conversation_id=?", [cid]))[0] as any;
    if (m) await run("DELETE FROM memories_fts WHERE rowid=?", [Number(m.id)]);
    await run("DELETE FROM memories WHERE conversation_id=?", [cid]);
    await run("DELETE FROM events WHERE conversation_id=?", [cid]);
    await run("DELETE FROM minutes WHERE conversation_id=?", [cid]);
    await run("DELETE FROM action_items WHERE source_conversation=?", [cid]);
    await run("DELETE FROM conversations WHERE id=?", [cid]);
  }
  // Sessions tagged as seed-owned (device label), plus their orphan turns.
  const sess = (await q("SELECT id FROM sessions WHERE device=?", ["devseed"])) as any[];
  for (const s of sess) {
    await run("DELETE FROM turns WHERE session_id=?", [Number(s.id)]);
    await run("DELETE FROM sessions WHERE id=?", [Number(s.id)]);
  }
  // Entities + edges by deterministic norm_name.
  const ents = (await q("SELECT id FROM entities WHERE norm_name IN (?,?,?)", ["farha", "redesign", "acme"])) as any[];
  for (const e of ents) {
    const eid = Number(e.id);
    await run("DELETE FROM edges WHERE src_entity=? OR dst_entity=?", [eid, eid]);
    await run("DELETE FROM entities WHERE id=?", [eid]);
  }
  // Priors by exact deterministic subject (normName keeps punctuation/markers, so a norm_subject
  // IN(...) match on bare names would miss P1/P2 and accumulate dupes on re-seed).
  await run("DELETE FROM priors WHERE subject IN (?,?,?)", [SEED_PRIOR_P1, SEED_PRIOR_P2, SEED_PRIOR_P3]);
  // Daily rollup for today.
  await run("DELETE FROM daily_rollups WHERE day=?", [new Date().toISOString().slice(0, 10)]);
  // People by canonical_name.
  await run("DELETE FROM people WHERE canonical_name IN (?,?,?)", ["Aditya", "Farha", "Rohan"]);
  await persist();
}

/** Seed a deterministic memory fixture for MCP e2e. Idempotent (re-seeds cleanly). DEV-only. */
export async function seed(): Promise<{ seeded: boolean; conversation_id: number }> {
  await wipePriorSeed();

  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const startedAt = new Date(now).toISOString();
  const future = new Date(now + 3 * 86400000).toISOString(); // event: now + 3d

  // ---- People ----
  const aditya = await repo.insertPerson("Aditya", true);
  const farha = await repo.insertPerson("Farha", false, undefined, "designer");
  const rohan = await repo.insertPerson("Rohan", false);

  // ---- Session (owns the raw turns) ----
  const session = (await repo.createSession("devseed")) as any;
  const sid = Number(session.id);

  // ---- C1: meeting, refined=0 ----
  const c1 = await repo.insertConversation({
    session_id: sid, title: SEED_TITLE_C1, started_at: startedAt, ended_at: startedAt,
    participant_person_ids: [aditya, farha], status: "done",
  });
  // C1 is a meeting (§8). insertConversation doesn't take is_meeting; the extractor flips it via
  // setConversationMeeting (extraction.ts:86 / minutes.ts:41), so mirror that path here.
  await repo.setConversationMeeting(c1, true);
  // 4 turns — one redacted=1 carrying the REDACTED_SECRET_TURN marker; others are clean real content.
  const t1 = await repo.insertTurn({ session_id: sid, window_index: 0, session_speaker_label: "A", person_id: aditya, text: "Let's lock the sprint. Farha owns the redesign.", abs_start: startedAt, conversation_id: c1 });
  const t2 = await repo.insertTurn({ session_id: sid, window_index: 0, session_speaker_label: "B", person_id: farha, text: "On it. We ship the Acme demo Friday.", abs_start: startedAt, conversation_id: c1 });
  const tRedacted = await repo.insertTurn({ session_id: sid, window_index: 0, session_speaker_label: "A", person_id: aditya, text: "REDACTED_SECRET_TURN — internal number not for sharing.", abs_start: startedAt, conversation_id: c1, redacted: 1 });
  await repo.insertTurn({ session_id: sid, window_index: 0, session_speaker_label: "B", person_id: farha, text: "Great, I'll prep the deck.", abs_start: startedAt, conversation_id: c1 });
  // Some seeded inserters set conversation_id via setTurnsConversation; here we set it at insert time
  // via the conversation_id field, but insertTurn doesn't bind it — link explicitly.
  await repo.setTurnsConversation([t1, t2, tRedacted], c1);
  // (4th turn linked below alongside re-linking; ensure all four are attached.)
  await run("UPDATE turns SET conversation_id=? WHERE session_id=? AND conversation_id IS NULL", [c1, sid]);
  await persist();

  // C1 memory (FTS-synced via repo.upsertMemory). Facts are marker-free real content.
  await repo.upsertMemory({
    conversation_id: c1,
    title: SEED_TITLE_C1,
    summary: "Sprint planning: Farha owns the redesign; team ships the Acme demo Friday.",
    facts: ["Farha owns the redesign", "Acme demo ships Friday", "Sprint scope locked"],
    action_items: [{ text: "Prep the Acme demo deck", owner: "Farha", due: future.slice(0, 10) }],
    decisions: ["Farha leads the redesign track"],
    importance: 0.8, type_tags: ["work"], embed_model: null,
  });

  // ---- C2: not a meeting ----
  const c2 = await repo.insertConversation({
    session_id: sid, title: SEED_TITLE_C2, started_at: startedAt, ended_at: startedAt,
    participant_person_ids: [aditya, rohan], status: "done",
  });
  await repo.insertTurn({ session_id: sid, window_index: 1, session_speaker_label: "A", person_id: aditya, text: "How was your weekend, Rohan?", abs_start: startedAt, conversation_id: c2 });
  await repo.insertTurn({ session_id: sid, window_index: 1, session_speaker_label: "C", person_id: rohan, text: "Relaxing, thanks. Coffee's good here.", abs_start: startedAt, conversation_id: c2 });
  await run("UPDATE turns SET conversation_id=? WHERE session_id=? AND window_index=1 AND conversation_id IS NULL", [c2, sid]);
  await persist();
  await repo.upsertMemory({
    conversation_id: c2, title: SEED_TITLE_C2, summary: "Casual coffee catchup with Rohan over the weekend.",
    facts: ["Caught up with Rohan", "Discussed the weekend"], action_items: [], decisions: [],
    importance: 0.3, type_tags: ["personal"], embed_model: null,
  });

  // ---- Entities + edges (evidence references the REDACTED turn to prove evidence stripping) ----
  const eFarha = await graph.upsertEntity("person", "Farha", "designer on the Redesign", null);
  const eRedesign = await graph.upsertEntity("project", "Redesign", "the product redesign track", null);
  const eAcme = await graph.upsertEntity("org", "Acme", "client for the Friday demo", null);
  // Edge evidence intentionally includes the redacted turn id (tRedacted) — the serializer must drop turn_ids.
  await graph.upsertEdge(eFarha, eRedesign, "owns", c1, [t1, tRedacted]);
  await graph.upsertEdge(eRedesign, eAcme, "demoed_to", c1, [t2, tRedacted]);

  // ---- Action items: one open with a generated_draft body (DRAFT_BODY_MARKER), one done ----
  await repo.insertAction({ text: "Send Acme the demo agenda", owner: "Aditya", due: future.slice(0, 10), source_conversation: c1 });
  await run("UPDATE action_items SET generated_draft=? WHERE text=? AND source_conversation=?",
    ["DRAFT_BODY_MARKER — Hi Acme, here is the agenda for Friday's demo …", "Send Acme the demo agenda", c1]);
  await repo.insertAction({ text: "Book the demo room", owner: "Aditya", source_conversation: c1 });
  await run("UPDATE action_items SET status='done' WHERE text=? AND source_conversation=?", ["Book the demo room", c1]);
  await persist();

  // ---- Event: future (now + 3d) ----
  await repo.insertEvent({ conversation_id: c1, title: "Demo with Acme", when_text: "Friday", start_ts: future, kind: "meeting" });
  await persist();

  // ---- Minutes for C1 (realistic Minutes shape) ----
  await repo.setMinutes(c1, {
    title: SEED_TITLE_C1,
    summary: "Sprint planning meeting; redesign ownership and the Acme demo were locked.",
    attendees: ["Aditya", "Farha"],
    agenda: ["Sprint scope", "Acme demo readiness"],
    discussion: ["Reviewed the redesign track", "Confirmed Friday demo timeline"],
    decisions: ["Farha owns the redesign", "Ship the Acme demo Friday"],
    action_items: [{ task: "Prep the Acme demo deck", owner: "Farha", due: future.slice(0, 10) }],
    next_steps: ["Circulate the agenda to Acme"],
  });

  // ---- Daily rollup for today ----
  await repo.upsertRollup(
    today,
    "Two conversations today: sprint planning with Farha and a coffee catchup with Rohan.",
    [`${SEED_TITLE_C1}: Farha owns the redesign; Acme demo ships Friday.`, `${SEED_TITLE_C2}: caught up with Rohan.`],
    [{ text: "Send Acme the demo agenda", owner: "Aditya", due: future.slice(0, 10) }],
  );

  // ---- Priors (P1/P2/P3 mix) ----
  // P1: user/confirmed/share_cloud=1 — surfaces in get_your_context(cloud=true).
  await repo.insertPrior({
    kind: "person", entity_id: eFarha, subject: SEED_PRIOR_P1, value: "designer",
    attrs: { relationship_to_user: "colleague" }, confidence: 0.8, provenance: "user", status: "confirmed",
    source_conversation: c1, share_cloud: 1,
  });
  // P2: confirmed/derived but share_cloud=0 — must NOT leak (carries PRIVATE_PRIOR_MARKER).
  await repo.insertPrior({
    kind: "org", subject: SEED_PRIOR_P2, value: "client",
    attrs: { relationship_to_user: "client" }, confidence: 0.7, provenance: "derived", status: "confirmed",
    source_conversation: c1, share_cloud: 0,
  });
  // P3: suggested/derived/share_cloud=1 — must NOT surface (fails the confirmed-or-user gate).
  await repo.insertPrior({
    kind: "project", subject: SEED_PRIOR_P3, value: null,
    attrs: { relationship_to_user: "works_on" }, confidence: 0.5, provenance: "derived", status: "suggested",
    source_conversation: c1, share_cloud: 1,
  });
  await persist();

  return { seeded: true, conversation_id: c1 };
}

/** Returns the seeded C1 conversation id if the fixture is present, else null (handy for verifiers). */
export async function seededConversationId(): Promise<number | null> {
  return seedConversationId();
}
