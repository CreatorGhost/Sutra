// "Your Context" derivation — a RULE-BASED, ZERO-extra-LLM pass that distills a just-processed
// session's graph into the user's standing PRIORS (beliefs about their world, not ground truth).
//
// Invariants (locked v1):
//  - Additive & non-destructive: reads the session's already-written entities/edges; never deletes or
//    overwrites raw data. The transcript + memories + graph remain the source of truth.
//  - Idempotent: re-running on the same session reinforces (supported++) via repo.upsertPrior rather
//    than duplicating. Safe on the recovery path.
//  - ZERO extra LLM calls: everything here is SQL + arithmetic over data extraction already produced.
//  - Derived priors are status='suggested', provenance='derived', confidence 0.5 — NEVER auto-confirmed.
//  - Conflicts are only FLAGGED (contradicted++) and a fresh 'suggested' prior is added — NEVER
//    auto-superseded; the user supersedes explicitly.
import type { Provider } from "../providers/provider";
import { persist, q, run } from "./db";
import * as repo from "./repo";
import { normName } from "./util";

// Entity types we promote into priors, mapped to prior `kind`. (entities.type uses the extractor's
// ENTITY_TYPES; prior kinds are person|project|org|role|topic|goal|pref — we derive the structural three.)
const KIND_BY_ENTITY_TYPE: Record<string, "person" | "project" | "org"> = {
  person: "person",
  project: "project",
  org: "org",
};

const CANDIDATE_TYPES = Object.keys(KIND_BY_ENTITY_TYPE);

/** Derive/refresh the user's priors from one session's freshly-written graph.
 *  Best-effort, idempotent, non-destructive, zero extra LLM calls. */
export async function deriveSessionPriors(sessionId: number, _provider: Provider) {
  // Resolve the owner ("is_me"). Without an owner there is no "your" context to derive.
  const me = (await q("SELECT id, canonical_name FROM people WHERE is_me=1 LIMIT 1"))[0] as any;
  const meName = me ? normName(String(me.canonical_name ?? "")) : "";

  // The session's just-written graph: only entities/edges whose evidence references THIS session's
  // conversations (entities carry no session column, so we scope through edge evidence). This keeps the
  // pass local to the data we just produced and avoids re-deriving the whole graph every session.
  const convIds = await repo.sessionConversationIds(sessionId);
  if (!convIds.length) return { derived: 0, reinforced: 0, conflicts: 0, conversations: 0 };

  const cph = convIds.map(() => "?").join(",");
  // Edges touched by this session: any edge with evidence pointing at one of the session's conversations.
  const edges = (await q(
    `SELECT id, src_entity, dst_entity, relation, evidence FROM edges
     WHERE EXISTS (SELECT 1 FROM json_each(edges.evidence) je
                   WHERE json_extract(je.value,'$.conversation_id') IN (${cph}))`,
    convIds)) as any[];

  // The entities involved in this session: the endpoints of the edges evidenced above.
  const entityIds = new Set<number>();
  for (const e of edges) { entityIds.add(e.src_entity); entityIds.add(e.dst_entity); }
  if (!entityIds.size) return { derived: 0, reinforced: 0, conflicts: 0, conversations: convIds.length };

  const eph = [...entityIds].map(() => "?").join(",");
  const ents = (await q(
    `SELECT id, type, canonical_name, norm_name, importance, mention_count FROM entities
     WHERE id IN (${eph}) AND type IN (${CANDIDATE_TYPES.map(() => "?").join(",")})`,
    [...entityIds, ...CANDIDATE_TYPES])) as any[];

  // Resolve the owner ENTITY (a person-type entity matching the is_me name) so we can read off the
  // user's first-person relationships from edges whose src is the owner.
  const ownerEntity = meName
    ? (ents.find((e) => e.type === "person" && normName(String(e.canonical_name ?? "")) === meName)
       ?? (await q("SELECT id, norm_name FROM entities WHERE type='person' AND norm_name=? LIMIT 1", [meName]))[0])
    : null;
  const ownerEntityId = ownerEntity ? Number((ownerEntity as any).id) : null;

  // relationship_to_user: for each session edge whose src is the owner, attach the (normalized) relation
  // to the dst entity. e.g. owner --works_on--> "Sutra" => relationship_to_user "works_on".
  const relByEntity = new Map<number, string>();
  if (ownerEntityId != null) {
    for (const e of edges) {
      if (Number(e.src_entity) === ownerEntityId) {
        const rel = String(e.relation ?? "").trim();
        if (rel && !relByEntity.has(Number(e.dst_entity))) relByEntity.set(Number(e.dst_entity), rel);
      }
    }
  }

  let derived = 0, reinforced = 0, conflicts = 0;
  for (const ent of ents) {
    const id = Number(ent.id);
    // Never derive a prior FOR the owner themselves — "Your Context" is about the user's world.
    if (ownerEntityId != null && id === ownerEntityId) continue;
    const kind = KIND_BY_ENTITY_TYPE[String(ent.type)];
    if (!kind) continue;
    // Candidate threshold: a salient, repeated entity (locked v1 rule).
    const mention = Number(ent.mention_count) || 0;
    const importance = Number(ent.importance) || 0;
    if (!(mention >= 3 || importance >= 0.7)) continue;

    const subject = String(ent.canonical_name ?? "").trim();
    if (!subject) continue;
    const relationship_to_user = relByEntity.get(id) ?? null;
    const attrs = relationship_to_user ? { relationship_to_user } : {};

    // Conflict check: a confirmed/user prior for the SAME (kind, entity_id) carrying a DIFFERENT value.
    // We only FLAG it (contradicted++) and still add the new suggested prior — never auto-supersede.
    // (Derived priors are subject-only with value=null, so a value conflict is rare but handled.)
    const newValue: string | null = null; // v1 derived priors are subject-level beliefs (no asserted value)
    const existing = (await q(
      `SELECT id, value FROM priors WHERE kind=? AND entity_id=? AND superseded_by IS NULL
         AND (status='confirmed' OR provenance='user') ORDER BY id`,
      [kind, id])) as any[];
    let flagged = false;
    for (const ex of existing) {
      const exVal = ex.value == null ? null : String(ex.value);
      if (newValue != null && exVal != null && exVal !== newValue) {
        // FLAG ONLY — bump contradicted on the conflicting confirmed/user prior. Never auto-supersede.
        try { await run("UPDATE priors SET contradicted=contradicted+1 WHERE id=?", [Number(ex.id)]); await persist(); flagged = true; }
        catch { /* best-effort */ }
      }
    }
    if (flagged) conflicts++;

    // upsertPrior canonicalizes on (kind, norm_subject)/entity_id and reinforces on match (supported++,
    // refresh last_confirmed_at) or inserts a fresh suggested/derived prior otherwise.
    const before = (await q(
      "SELECT id FROM priors WHERE kind=? AND (norm_subject=? OR (entity_id IS NOT NULL AND entity_id=?)) LIMIT 1",
      [kind, normName(subject), id]))[0] as any;
    await repo.upsertPrior({
      kind,
      entity_id: id,
      subject,
      norm_subject: subject,
      value: newValue,
      attrs,
      confidence: 0.5,
      provenance: "derived",
      status: "suggested",
      source_conversation: convIds[0] ?? null,
      source_turn_ids: [],
    });
    if (before) reinforced++; else derived++;
  }

  return { derived, reinforced, conflicts, conversations: convIds.length };
}
