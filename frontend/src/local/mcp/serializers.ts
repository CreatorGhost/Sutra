// Pure whitelist serializers for the MCP read layer (no DB, no network). Every output object is
// constructed FIELD-BY-FIELD — DB rows are NEVER spread — so a new column can never silently leak.
// Inputs are treated as untrusted shapes (null/undefined, missing nested objects, JSON strings not yet
// parsed, etc.), mirroring repo.ts's P() defensive-parse idiom. Hard invariants enforced here AND in
// the unit tests: no voiceprint/embedding bytes, no generated_draft body, no redacted turns or the
// redacted flag, no token/SQLCipher material, no graph turn_ids, no whole attrs blob.

// Defensive JSON parse (mirrors repo.ts P()): pass through already-parsed values; parse strings; else default.
const P = <T>(v: any, d: T): T => {
  if (v == null) return d;
  if (typeof v !== "string") return v as T;
  try { return JSON.parse(v) as T; } catch { return d; }
};
const arr = <T = unknown>(v: any): T[] => (Array.isArray(v) ? v : Array.isArray(P(v, [])) ? (P(v, []) as T[]) : []);
const num = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round3 = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null; };

// Error whose message is a CURATED, human-safe string (no SQL/stack/vendor/token) and may therefore be
// forwarded verbatim onto the wire. Anything NOT a SafeError (e.g. a raw SQLite/provider exception) is
// replaced with a generic message by the bridge — plan §3: error strings must carry no SQL/stack/vendor.
export class SafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeError";
  }
}

// ---- clamp helpers (exported so handlers AND tests share one definition of the bounds) ----
export const clampInt = (v: any, lo: number, hi: number, dflt: number): number => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};
export const clampTopN = (v: any) => clampInt(v, 1, 50, 10);
export const clampHops = (v: any) => clampInt(v, 0, 3, 2);
export const clampGraphLimit = (v: any) => clampInt(v, 1, 240, 120);
export const clampListLimit = (v: any) => clampInt(v, 1, 200, 50);
export const clampEventsLimit = (v: any) => clampInt(v, 1, 50, 50);
export const clampContextTopN = (v: any) => clampInt(v, 1, 20, 8);

// ---- search_memory ----
export function serializeSearch(query: string, results: any[]): {
  query: string;
  results: { conversation_id: number | null; title: string | null; summary: string | null; facts: unknown[]; importance: number | null; started_at: string | null; score: number | null }[];
} {
  return {
    query: String(query ?? ""),
    results: arr<any>(results).map((r) => ({
      conversation_id: num(r?.conversation_id),
      title: r?.title ?? null,
      summary: r?.summary ?? null,
      facts: arr(r?.facts),
      importance: num(r?.importance),
      started_at: r?.started_at ?? null,
      score: num(r?.score),
    })),
  };
}

// ---- get_conversation ----
function serializeMemory(m: any) {
  if (m == null) return null;
  return {
    title: m.title ?? null,
    summary: m.summary ?? null,
    facts: arr(m.facts),
    action_items: arr(m.action_items),
    decisions: arr(m.decisions),
    importance: num(m.importance_score),
    type_tags: arr(m.type_tags),
  };
}
// Turn serializer: speaker = session_speaker_label; emit only the whitelisted fields; DEFENSIVELY drop
// any row flagged redacted===1 (belt-and-suspenders even though conversationDetailSafe already filters).
function serializeTurn(t: any) {
  return {
    speaker: t?.session_speaker_label ?? null,
    person_id: num(t?.person_id),
    person_name: t?.person_name ?? null,
    is_me: !!t?.is_me,
    text: t?.text ?? null,
    abs_start: t?.abs_start ?? null,
  };
}
export function serializeConversation(detail: any, allowTranscripts: boolean): {
  conversation: { id: number | null; title: string | null; started_at: string | null; ended_at: string | null; is_meeting: boolean; refined: boolean; participant_person_ids: number[] } | null;
  memory: ReturnType<typeof serializeMemory>;
  turns: ReturnType<typeof serializeTurn>[];
  transcripts_shared: boolean;
  participants: { id: number | null; canonical_name: string | null; is_me: boolean }[];
  events: { id: number | null; title: string | null; when_text: string | null; start_ts: string | null; kind: string | null }[];
  minutes: ReturnType<typeof serializeMinutes>;
} | null {
  if (detail == null) return null;
  const c = detail.conversation ?? null;
  const rawTurns = arr<any>(detail.turns).filter((t) => Number(t?.redacted) !== 1);
  const turns = allowTranscripts ? rawTurns.map(serializeTurn) : [];
  return {
    conversation: c == null ? null : {
      id: num(c.id),
      title: c.title ?? null,
      started_at: c.started_at ?? null,
      ended_at: c.ended_at ?? null,
      is_meeting: !!c.is_meeting,
      refined: !!c.refined,
      participant_person_ids: arr<number>(c.participant_person_ids).map((x) => Number(x)).filter((x) => Number.isInteger(x)),
    },
    memory: serializeMemory(detail.memory),
    turns,
    transcripts_shared: !!allowTranscripts,
    participants: arr<any>(detail.participants).map((p) => ({ id: num(p?.id), canonical_name: p?.canonical_name ?? null, is_me: !!p?.is_me })),
    events: arr<any>(detail.events).map((e) => ({ id: num(e?.id), title: e?.title ?? null, when_text: e?.when_text ?? null, start_ts: e?.start_ts ?? null, kind: e?.kind ?? null })),
    minutes: serializeMinutes(detail.minutes),
  };
}

// ---- list_conversations ----
export function serializeConversationList(rows: any[]): {
  id: number | null; title: string | null; started_at: string | null; ended_at: string | null; is_meeting: boolean; summary: string | null; importance_score: number | null; type_tags: unknown[]; action_count: number | null;
}[] {
  return arr<any>(rows).map((r) => ({
    id: num(r?.id),
    title: r?.title ?? null,
    started_at: r?.started_at ?? null,
    ended_at: r?.ended_at ?? null,
    is_meeting: !!r?.is_meeting,
    summary: r?.summary ?? null,
    importance_score: num(r?.importance_score),
    type_tags: arr(r?.type_tags),
    action_count: num(r?.action_count),
  }));
}

// ---- list_people (NEVER voiceprint / voiceprint_dim / has_voiceprint / created_at) ----
export function serializePeople(rows: any[]): {
  id: number | null; canonical_name: string | null; is_me: boolean; provisional: boolean; enroll_count: number | null; notes: string | null;
}[] {
  return arr<any>(rows).map((p) => ({
    id: num(p?.id),
    canonical_name: p?.canonical_name ?? null,
    is_me: !!p?.is_me,
    provisional: !!p?.provisional,
    enroll_count: num(p?.enroll_count),
    notes: p?.notes ?? null,
  }));
}

// ---- get_graph_neighborhood ----
// Evidence transform: parse the stored [{conversation_id, turn_ids}] and emit a DEDUPED list of
// {conversation_id} ONLY — turn_ids never leave (kills the redacted-turn-id leak class entirely).
function serializeEvidence(ev: any): { conversation_id: number }[] {
  const items = arr<any>(ev);
  const seen = new Set<number>();
  const out: { conversation_id: number }[] = [];
  for (const it of items) {
    const cid = num(it?.conversation_id);
    if (cid == null || seen.has(cid)) continue;
    seen.add(cid);
    out.push({ conversation_id: cid });
  }
  return out;
}
export function serializeGraph(g: any): {
  nodes: { id: number | null; type: string | null; canonical_name: string | null; importance: number | null; mention_count: number | null }[];
  edges: { src: number | null; dst: number | null; relation: string | null; weight: number | null; evidence: { conversation_id: number }[] }[];
} {
  const src = g ?? {};
  return {
    nodes: arr<any>(src.nodes).map((n) => ({
      id: num(n?.id),
      type: n?.type ?? null,
      canonical_name: n?.canonical_name ?? null,
      importance: num(n?.importance),
      mention_count: num(n?.mention_count),
    })),
    edges: arr<any>(src.edges).map((e) => ({
      src: num(e?.src),
      dst: num(e?.dst),
      relation: e?.relation ?? null,
      weight: num(e?.weight),
      evidence: serializeEvidence(e?.evidence),
    })),
  };
}

// ---- list_action_items (has_draft derived; the generated_draft BODY never leaves) ----
export function serializeActionItems(rows: any[]): {
  id: number | null; text: string | null; owner: string | null; status: string | null; due: string | null; source_conversation: number | null; has_draft: boolean;
}[] {
  return arr<any>(rows).map((a) => ({
    id: num(a?.id),
    text: a?.text ?? null,
    owner: a?.owner ?? null,
    status: a?.status ?? null,
    due: a?.due ?? null,
    source_conversation: num(a?.source_conversation),
    has_draft: a?.generated_draft != null,
  }));
}

// ---- upcoming_events ----
export function serializeEvents(rows: any[]): {
  id: number | null; title: string | null; when_text: string | null; start_ts: string | null; kind: string | null; conversation_id: number | null; conv_title: string | null;
}[] {
  return arr<any>(rows).map((e) => ({
    id: num(e?.id),
    title: e?.title ?? null,
    when_text: e?.when_text ?? null,
    start_ts: e?.start_ts ?? null,
    kind: e?.kind ?? null,
    conversation_id: num(e?.conversation_id),
    conv_title: e?.conv_title ?? null,
  }));
}

// ---- get_minutes ----
export function serializeMinutes(m: any): {
  title: string | null; summary: string | null; attendees: unknown[]; agenda: unknown[]; discussion: unknown[]; decisions: unknown[]; action_items: unknown[]; next_steps: unknown[]; generated_at: string | null;
} | null {
  if (m == null) return null;
  return {
    title: m.title ?? null,
    summary: m.summary ?? null,
    attendees: arr(m.attendees),
    agenda: arr(m.agenda),
    discussion: arr(m.discussion),
    decisions: arr(m.decisions),
    action_items: arr(m.action_items),
    next_steps: arr(m.next_steps),
    generated_at: m.generated_at ?? null,
  };
}

// ---- get_your_context (priors) ----
// relationship_to_user is LIFTED from attrs.relationship_to_user; effective_confidence rounded to 3dp.
// NEVER emit attrs whole, source_turn_ids, entity_id, norm_subject, or share_cloud.
export const YOUR_CONTEXT_NOTE = "Beliefs the user chose to share — may be outdated; not ground truth.";
function serializePrior(p: any) {
  const attrs = P(p?.attrs, {} as Record<string, unknown>);
  return {
    kind: p?.kind ?? null,
    subject: p?.subject ?? null,
    value: p?.value ?? null,
    relationship_to_user: (attrs && typeof attrs === "object" ? (attrs as any).relationship_to_user : null) ?? null,
    effective_confidence: round3(p?.effective_confidence),
    status: p?.status ?? null,
  };
}
export function serializeYourContext(priors: any[]): {
  note: string;
  priors: { kind: string | null; subject: string | null; value: string | null; relationship_to_user: unknown; effective_confidence: number | null; status: string | null }[];
} {
  return { note: YOUR_CONTEXT_NOTE, priors: arr<any>(priors).map(serializePrior) };
}

// ---- ask_memory ----
export function serializeAsk(r: any): {
  answer: string; supported: boolean; citations: { conversation_id: number | null; title: string | null; date: string | null }[]; retrieved: { conversation_id: number | null; title: string | null; score: number | null }[];
} {
  const src = r ?? {};
  return {
    answer: typeof src.answer === "string" ? src.answer : "",
    supported: !!src.supported,
    citations: arr<any>(src.citations).map((c) => ({ conversation_id: num(c?.conversation_id), title: c?.title ?? null, date: c?.date ?? null })),
    retrieved: arr<any>(src.retrieved).map((m) => ({ conversation_id: num(m?.conversation_id), title: m?.title ?? null, score: num(m?.score) })),
  };
}

// ---- get_privacy (strings already vendor-clean — from MODE_COPY via api.health) ----
export function serializePrivacy(h: any): { status: string | null; mode: string | null; privacy: string | null } {
  const src = h ?? {};
  return { status: src.status ?? null, mode: src.mode ?? null, privacy: src.privacy ?? null };
}

// ---- get_daily_rollup ----
// daily_rollups columns (schema.ts:67-70): day, summary, highlights(JSON), open_actions(JSON). The row
// also carries id/emailed_at/created_at — explicitly NOT emitted. open_actions are whitelisted per item.
export function serializeRollup(row: any): {
  day: string | null; summary: string | null; highlights: unknown[]; open_actions: { text: string | null; owner: string | null; due: string | null }[];
} | null {
  if (row == null) return null;
  return {
    day: row.day ?? null,
    summary: row.summary ?? null,
    highlights: arr(row.highlights),
    open_actions: arr<any>(P(row.open_actions, [])).map((a) => ({ text: a?.text ?? null, owner: a?.owner ?? null, due: a?.due ?? null })),
  };
}
