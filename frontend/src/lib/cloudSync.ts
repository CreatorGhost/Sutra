// Tier B cloud sync client (opt-in, one-way phone -> server). Builds the SAME share_cloud-respecting,
// whitelisted projection the device's MCP read layer exposes, then POSTs it to /sync with the bearer
// JWT. The server treats the body as an idempotent REPLACE under the signed-in user's id.
//
// Privacy invariants mirrored client-side (the server re-enforces them as defense-in-depth, but we
// never send what shouldn't leave the device in the first place — same rules as the MCP serializers):
//   - redacted turns are dropped (we read via the redaction-safe conversation detail)
//   - voiceprints are never read into the projection (no voiceprint column bound)
//   - edge evidence is stripped to { conversation_id } only (turn_ids dropped)
//   - action_items.generated_draft body is never sent
//   - ONLY priors with share_cloud=1 are included
// Audio is never persisted anywhere, so it can't be in scope here.

import * as repo from "../local/repo";
import { topPriors } from "../local/repo";
import { graphOverview } from "../local/graph";
import { q } from "../local/db";
import { API_BASE, authHeader } from "./auth";

// Defensive JSON parse (mirrors repo.ts P()): pass parsed values through; parse strings; else default.
const P = <T>(v: any, d: T): T => {
  if (v == null) return d;
  if (typeof v !== "string") return v as T;
  try { return JSON.parse(v) as T; } catch { return d; }
};
const arr = <T = unknown>(v: any): T[] => (Array.isArray(v) ? v : (Array.isArray(P(v, [])) ? (P(v, []) as T[]) : []));
const intIds = (v: any): number[] => arr<number>(v).map((x) => Number(x)).filter((x) => Number.isInteger(x));

export type SyncCounts = Record<string, number>;
export type SyncResult = { ok: boolean; synced_at: string; counts: SyncCounts };

// ---- projection ----
// Built field-by-field from repo reads (DB rows are never spread) so a new column can't silently leak.
// Entity ids / conversation ids / person ids are CLIENT-LOCAL integers; the server maps them to its own
// per-user ids, so two users' "conversation 7" never collide.
export async function buildProjection(): Promise<Record<string, any>> {
  const [convRows, peopleRows, actionRows, eventRows, rollupRows, graph, priors] = await Promise.all([
    repo.listConversations(),
    repo.listPeople(),
    repo.listActions(),                 // all statuses
    repo.upcomingEvents(new Date(0).toISOString()), // all events with a start_ts, not just future
    repo.listRollups(),
    graphOverview(),
    topPriors("", 500, true),           // cloud=true => only share_cloud=1 priors
  ]);

  // People — no voiceprint / has_voiceprint / created_at.
  const people = arr<any>(peopleRows).map((p) => ({
    id: Number(p.id),
    canonical_name: p.canonical_name ?? null,
    is_me: !!p.is_me,
    provisional: !!p.provisional,
    enroll_count: Number(p.enroll_count) || 0,
    notes: p.notes ?? null,
  }));

  // Conversations + their memory + non-redacted turns + events + minutes. We pull full per-conversation
  // detail via the redaction-safe reader so redacted turns are excluded at the source.
  const conversations: any[] = [];
  const memories: any[] = [];
  const turns: any[] = [];
  const events: any[] = [];
  const minutes: any[] = [];
  for (const c of arr<any>(convRows)) {
    const cid = Number(c.id);
    if (!Number.isInteger(cid)) continue;
    const detail = await repo.conversationDetailSafe(cid);
    if (!detail) continue;
    const conv = (detail as any).conversation ?? {};
    conversations.push({
      id: cid,
      title: conv.title ?? null,
      started_at: conv.started_at ?? null,
      ended_at: conv.ended_at ?? null,
      participant_person_ids: intIds(conv.participant_person_ids),
      is_meeting: !!conv.is_meeting,
      refined: !!conv.refined,
    });
    const m = (detail as any).memory;
    if (m) {
      memories.push({
        conversation_id: cid,
        title: m.title ?? null,
        summary: m.summary ?? "",
        facts: arr(m.facts),
        action_items: arr(m.action_items),
        decisions: arr(m.decisions),
        importance: Number(m.importance_score) || 0.5,
        type_tags: arr(m.type_tags),
      });
    }
    // Turns are already redaction-filtered + coalesced by conversationDetailSafe. Emit only whitelisted
    // fields (no voiceprint, no redacted flag). The server fabricates a session row, so no session_id.
    for (const t of arr<any>((detail as any).turns)) {
      turns.push({
        conversation_id: cid,
        session_speaker_label: t.session_speaker_label ?? null,
        person_id: t.person_id != null ? Number(t.person_id) : null,
        text: t.text ?? "",
        abs_start: t.abs_start ?? null,
        window_index: Number(t.window_index) || 0,
        start_ts: t.start_ts ?? null,
        lang: t.lang ?? null,
      });
    }
    for (const e of arr<any>((detail as any).events)) {
      events.push({
        conversation_id: cid,
        title: e.title ?? null,
        when_text: e.when_text ?? null,
        start_ts: e.start_ts ?? null,
        kind: e.kind ?? null,
      });
    }
    const min = (detail as any).minutes;
    if (min) {
      const { generated_at, ...data } = min as any;
      minutes.push({ conversation_id: cid, data, generated_at: generated_at ?? null });
    }
  }

  // Entities — the full set so edge src/dst resolve. No embedding bound.
  const entityRows = (await q(
    "SELECT id,type,canonical_name,norm_name,importance,mention_count,attrs FROM entities ORDER BY mention_count DESC LIMIT 1000"
  )) as any[];
  const entities = arr<any>(entityRows).map((e) => ({
    id: Number(e.id),
    type: e.type ?? null,
    canonical_name: e.canonical_name ?? null,
    norm_name: e.norm_name ?? null,
    importance: Number(e.importance) || 0.5,
    mention_count: Number(e.mention_count) || 0,
    attrs: P(e.attrs, {} as Record<string, unknown>),
  }));

  // Edges — evidence stripped to { conversation_id } only (turn_ids dropped, deduped).
  const edges = arr<any>((graph as any)?.edges).map((e) => {
    const seen = new Set<number>();
    const evidence: { conversation_id: number }[] = [];
    for (const it of arr<any>(e.evidence)) {
      const cid = Number(it?.conversation_id);
      if (!Number.isInteger(cid) || seen.has(cid)) continue;
      seen.add(cid);
      evidence.push({ conversation_id: cid });
    }
    return {
      src: Number(e.src),
      dst: Number(e.dst),
      relation: e.relation ?? null,
      weight: Number(e.weight) || 1,
      evidence,
    };
  }).filter((e) => Number.isInteger(e.src) && Number.isInteger(e.dst));

  // Action items — no generated_draft body.
  const action_items = arr<any>(actionRows).map((a) => ({
    text: a.text ?? "",
    owner: a.owner ?? null,
    status: a.status ?? "open",
    due: a.due ?? null,
    source_conversation: a.source_conversation != null ? Number(a.source_conversation) : null,
  }));

  // Rollups.
  const rollups = arr<any>(rollupRows).map((r) => ({
    day: r.day ?? null,
    summary: r.summary ?? null,
    highlights: arr(P(r.highlights, [])),
    open_actions: arr(P(r.open_actions, [])),
  }));

  // Priors — already restricted to share_cloud=1 by topPriors(cloud=true). Tag share_cloud:1 so the
  // server's "only share_cloud truthy" gate accepts them; never send attrs internals it strips anyway.
  const projectedPriors = arr<any>(priors).map((p) => ({
    kind: p.kind ?? null,
    subject: p.subject ?? null,
    value: p.value ?? null,
    attrs: P(p.attrs, {} as Record<string, unknown>),
    confidence: Number(p.confidence) || 0.5,
    status: p.status ?? null,
    provenance: p.provenance ?? null,
    source_conversation: p.source_conversation != null ? Number(p.source_conversation) : null,
    share_cloud: 1,
  }));

  return {
    client_synced_at: new Date().toISOString(),
    people,
    conversations,
    memories,
    turns,
    entities,
    edges,
    action_items,
    events,
    minutes,
    priors: projectedPriors,
    rollups,
  };
}

// ---- "last synced" persistence (local) ----
const LAST_SYNC_KEY = "sutra_tier_b_last_sync";
export function lastSyncedAt(): string | null {
  try { return localStorage.getItem(LAST_SYNC_KEY); } catch { return null; }
}
function setLastSyncedAt(iso: string): void {
  try { localStorage.setItem(LAST_SYNC_KEY, iso); } catch { /* ignore */ }
}

// ---- push ----
/** Build the projection and POST it to /sync with the bearer JWT. Records "last synced at" on success.
 *  Throws a human, non-leaky error on failure (signed out, server unreachable, Tier B disabled). */
export async function syncNow(): Promise<SyncResult> {
  const body = await buildProjection();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  let r: Response;
  try {
    r = await fetch(API_BASE + "/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("Sync timed out — check your connection and try again.");
    throw new Error("Couldn't reach the server. Check the address and your connection.");
  } finally {
    clearTimeout(t);
  }
  if (r.status === 401) throw new Error("Your session expired — sign in again.");
  if (r.status === 503) throw new Error("Cloud sync isn't enabled on this server yet.");
  if (!r.ok) {
    let detail = "";
    try { const j: any = await r.json(); detail = typeof j?.detail === "string" ? j.detail : ""; } catch { /* */ }
    throw new Error(detail || `Sync failed (${r.status}).`);
  }
  const result = (await r.json()) as SyncResult;
  const when = result?.synced_at || new Date().toISOString();
  setLastSyncedAt(when);
  return result;
}
