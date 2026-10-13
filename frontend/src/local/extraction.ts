import type { Provider } from "../providers/provider";
import { EXTRACTION_JSON_SCHEMA, EXTRACT_SYSTEM } from "./aiPrompts";
import * as graph from "./graph";
import * as people from "./people";
import * as repo from "./repo";
import { segmentSession } from "./segmentation";
import { clusterAndIdentify } from "./speakerId";
import { buildSpeakerDisplay, detectLang, normName } from "./util";
import { captureExtraction } from "./training";
import { generateMinutes } from "./minutes";
import { deriveSessionPriors } from "./priors";
import { buildAttributionHints, scoreProjects, type AttributionHint } from "./projectContext";

const clamp = (x: any) => Math.max(0, Math.min(1, Number(x) || 0.5));

export async function extractConversation(convId: number, provider: Provider) {
  // Redaction-safe source: redacted turns must not be absorbed into memory summaries/facts, which the
  // MCP read layer exposes via search_memory / list_conversations / get_conversation.memory.
  const detail = await repo.conversationDetailSafe(convId);
  const turns = (detail?.turns ?? []) as any[];
  if (!turns.length) return null;
  // turns are read-time coalesced; record EVERY underlying turn id as graph-edge evidence (not just leads).
  const turnIds = turns.flatMap((t: any) => t.member_ids ?? [t.id]);
  // Show the model clean "Speaker N" (not raw cluster ids "c1") for unnamed speakers, preferring the
  // enrolled person_name. We invert this map below to translate the model's returned label back to cN.
  // The meeting-capture owner channel ("me") is always "Me".
  const display = buildSpeakerDisplay(turns);
  const transcript = turns.map((t) => `${t.person_name || (t.session_speaker_label === "me" ? "Me" : display.get(t.session_speaker_label)) || "Speaker"}: ${t.text}`).join("\n");

  // Give the model the conversation's date so it can resolve relative times ("kal 11 baje" -> ISO datetime).
  const convDate = String((detail as any)?.conversation?.started_at ?? "").slice(0, 10);
  const userContent = (convDate ? `Today's date: ${convDate}.\n\n` : "") + transcript;
  const data = await provider.extract(EXTRACTION_JSON_SCHEMA, EXTRACT_SYSTEM, userContent);
  const entities = (data.entities ?? []) as any[];
  const entTexts = entities.map((e) => `${e.name} (${e.type}): ${e.description ?? ""}`.trim());
  const summary = data.summary ?? "";
  // Never embed the literal "(empty)" (it pollutes semantic search) — fall back to title/first fact.
  const seed = summary.trim() || String(data.title ?? "").trim() || String(data.facts?.[0] ?? "").trim() || "conversation";
  // Embeddings power semantic search; engines that can't embed (local agents) fall back to keywords.
  let vecs: number[][] = [];
  if (provider.canEmbed !== false) {
    try { vecs = await provider.embed([seed, ...entTexts]); } catch (e) { console.warn("embeddings skipped", e); }
  }
  const memVec = vecs[0], entVecs = vecs.slice(1);

  const memId = await repo.upsertMemory({
    conversation_id: convId, title: data.title ?? "Untitled", subtitle: data.subtitle ?? null, summary,
    facts: data.facts ?? [], action_items: data.action_items ?? [], decisions: data.decisions ?? [],
    open_questions: data.open_questions ?? [],
    importance: clamp(data.importance_score), type_tags: data.type_tags ?? [], embed_model: provider.id,
  }, memVec);
  await repo.setConversationTitle(convId, data.title ?? "Untitled conversation");
  // Scheduled / time-bound events (meetings, deadlines) — replace any prior set for this conversation.
  try {
    await repo.clearEvents(convId);
    for (const ev of (data.events ?? []) as any[]) {
      if (ev && ev.title) await repo.insertEvent({ conversation_id: convId, title: ev.title, when_text: ev.when ?? null, start_ts: ev.datetime ?? null, kind: ev.kind ?? null });
    }
  } catch (e) { console.warn("events insert skipped", convId, e); }
  try {
    await captureExtraction({ conversation_id: convId, lang: detectLang(transcript), model_id: provider.id, transcript, extraction_raw: data });
  } catch (e) { console.warn("training capture skipped", convId, e); }

  // Auto speaker-name attribution: apply high-confidence names (self-introductions) the extractor
  // inferred, mapping the per-call diarization label -> a person. Low-confidence address cues ("Hey
  // Mark") are intentionally NOT auto-applied — they need user confirmation to avoid mislabeling.
  // Project roster (when this conversation is mapped to a project with local context ON): a voice-linked
  // member is preferred and an extractor-returned name is canonicalized to the roster's exact spelling
  // ("salendra" -> "Salendra"). The HIGH=auto / LOW=suggested rule is unchanged — a LOW-confidence cue is
  // still NOT applied here (its confirm UI is P3).
  let roster: AttributionHint[] = [];
  try {
    const project: any = await repo.projectForConversation(convId);
    if (project && project.context_enabled !== false) roster = buildAttributionHints(project);
  } catch (e) { console.warn("project roster lookup skipped", convId, e); }
  const rosterByName = new Map<string, AttributionHint>();
  for (const h of roster) rosterByName.set(h.name.toLowerCase(), h);

  const sessionId = turns[0]?.session_id;
  if (sessionId != null) {
    // The model sees display labels ("Speaker 1") — translate its returned speaker back to the RAW cN
    // cluster label (the DB key relabelSpeaker is keyed on) via the inverse of the display map. Accept
    // both "Speaker 1" and the bare "1" form; fall through to the raw label if it already is one.
    const rawByDisplay = new Map<string, string>();
    for (const [raw, disp] of display) {
      rawByDisplay.set(disp.toLowerCase(), raw);                       // "speaker 1" -> "c1"
      rawByDisplay.set(disp.replace(/^speaker\s+/i, "").trim(), raw);  // "1" -> "c1"
    }
    for (const sn of (data.speaker_names ?? []) as any[]) {
      let name = String(sn?.name ?? "").trim();
      if (!name || sn?.confidence !== "high") continue;
      // Canonicalize a HIGH-confidence name to the project roster's exact spelling when it matches, and
      // map a roster "Me" member straight to the device owner. (Voice-linked members are preferred upstream
      // by speaker-ID clustering; here the roster only fixes the NAME, never lowers the confidence bar.)
      const hit = rosterByName.get(name.toLowerCase());
      if (hit) name = hit.name;
      const returned = String(sn?.speaker ?? "").trim();
      const stripped = returned.replace(/^speaker\s+/i, "").trim();
      const label = rawByDisplay.get(returned.toLowerCase()) ?? rawByDisplay.get(stripped) ?? stripped;
      if (!label) continue;
      const isMe = /^(me|myself)$/i.test(name) || !!hit?.isMe;
      try { await people.relabelSpeaker(sessionId, label, isMe ? { name: "Me", is_me: true } : { name }); }
      catch (e) { console.warn("auto speaker-name skipped", label, e); }
    }
  }

  const nameToId: Record<string, number> = {};
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    const id = await graph.upsertEntity(e.type, e.name, e.description ?? null, entVecs[i] ?? null);
    if (id) nameToId[normName(e.name)] = id;
  }
  for (const rel of (data.relations ?? []) as any[]) {
    const s = nameToId[normName(rel.src ?? "")], d = nameToId[normName(rel.dst ?? "")];
    if (s && d) await graph.upsertEdge(s, d, rel.relation ?? "related_to", convId, turnIds);
  }
  // Clear this conversation's prior action items before (re-)inserting, so re-extraction (recovery
  // path) doesn't duplicate them. No-op on first-time extraction (no existing rows to delete).
  await repo.clearActions(convId);
  for (const a of (data.action_items ?? []) as any[]) {
    await repo.insertAction({ text: a.text, owner: a.owner, due: a.due, source_conversation: convId });
  }
  // Meeting detection: flag drives the "Meeting" chip + (optional) auto Minutes-of-Meeting generation.
  // A recording made with meeting capture is always a meeting, whatever the model says.
  const isMeeting = !!data.is_meeting || !!(detail as any)?.conversation?.is_meeting;
  try { await repo.setConversationMeeting(convId, isMeeting); } catch (e) { console.warn("meeting flag skipped", convId, e); }
  // Notes derived from the old extraction (e.g. a cached Detailed style) are stale now.
  await repo.clearNotes(convId);
  await repo.setConversationStatus(convId, "done");
  return { conversation_id: convId, memory_id: memId, title: data.title, entities: Object.keys(nameToId).length,
           action_items: (data.action_items ?? []).length, importance: clamp(data.importance_score), is_meeting: isMeeting };
}

/** Map a freshly-extracted conversation to a project. Runs the PURE scorer over the conversation's
 *  signals (enrolled people present + transcript text) vs every context-enabled project, then:
 *    HIGH + lone clear winner -> set project_id SILENTLY (project_auto=1, so the UI shows an undo).
 *    MEDIUM (or a tie that can't earn HIGH) -> leave UNMAPPED, record a one-tap suggestion.
 *    LOW / none -> leave fully unmapped (today's behavior).
 *  NEVER overwrites a user choice (project_id already set, or project_auto=0 with a project). Best-effort:
 *  swallows every error so it can never fail session processing. */
export async function autoMapConversation(convId: number): Promise<void> {
  try {
    const mapping = await repo.conversationMapping(convId);
    // A user-set mapping (mapped & NOT a prior auto-map) is sacred — never touch it. A prior silent
    // auto-map MAY be refreshed (re-extraction), but a real user choice is left alone.
    if (mapping.project_id != null && !mapping.project_auto) return;
    const projects = await repo.scorableProjects();
    if (!projects.length) return;
    const detail = await repo.conversationDetailSafe(convId);
    const turns = (detail?.turns ?? []) as any[];
    const transcript = turns.map((t) => String(t.text ?? "")).join("\n");
    const presentPersonIds = await repo.conversationPersonIds(convId);
    const scores = scoreProjects({ presentPersonIds, transcript }, projects);
    const top = scores[0];
    if (!top) return;
    if (top.confidence === "high") {
      await repo.setConversationProject(convId, top.projectId, true); // silent; project_auto=1 -> undo
    } else if (top.confidence === "medium") {
      // Don't clobber an existing silent auto-map with a weaker suggestion; only suggest when unmapped.
      if (mapping.project_id == null) await repo.setConversationProjectSuggestion(convId, top.projectId);
    } else if (mapping.project_id != null && mapping.project_auto) {
      // A prior auto-map no longer scores high (e.g. project edited) — retract it rather than keep a
      // possibly-wrong silent map. Conservative: prefer UNMAPPED over a confident-wrong map.
      await repo.setConversationProject(convId, null, true);
    }
  } catch (e) { console.warn("auto-map skipped", convId, e); }
}

export async function processSession(sessionId: number, provider: Provider) {
  // Speaker-ID first (hybrid only; no-ops on-device): cluster turns by voiceprint into stable per-session
  // speakers and auto-tag enrolled people, so segmentation/extraction/display see corrected speakers.
  const speakers = await clusterAndIdentify(sessionId);
  // Idempotent: segmentSession only touches turns with conversation_id IS NULL, so re-running just
  // segments NEW orphan turns (never duplicating assigned ones). We then extract any conversation in
  // this session that still has no memory — covering both fresh and previously-failed conversations.
  const newConvIds = await segmentSession(sessionId);
  const memoryless = await repo.sessionConversationsWithoutMemory(sessionId);
  const toExtract = Array.from(new Set<number>([...newConvIds, ...memoryless]));
  const extracted: any[] = [];
  let lastError: string | null = null;
  for (const cid of toExtract) {
    try { const r = await extractConversation(cid, provider); if (r) extracted.push(r); }
    catch (e: any) {
      lastError = String(e?.message ?? e);
      try { await repo.setConversationStatus(cid, "failed"); } catch { /* status best-effort */ }
      console.error("extraction failed", cid, e);
    }
  }
  // Project auto-mapping: score each freshly-extracted conversation against the user's projects and
  // SILENTLY map a lone clear winner (HIGH), suggest a MEDIUM, leave the rest unmapped. Runs BEFORE
  // auto-minutes so a high-confidence map grounds the minutes (right glossary + roster). Best-effort.
  for (const r of extracted) {
    if (r?.conversation_id == null) continue;
    await autoMapConversation(r.conversation_id);
  }
  // Auto Minutes-of-Meeting: for conversations the extractor flagged as meetings, generate minutes
  // unless the user turned auto-generation off (default ON). Cloud-only (on-device extract isn't tuned
  // for the minutes schema; manual generation stays available everywhere). Best-effort — never fails processing.
  try {
    const autoMinutes = (await repo.getSettings()).auto_minutes !== false;
    if (autoMinutes && provider.id === "cloud") {
      for (const r of extracted) {
        if (!r?.is_meeting) continue;
        try { await generateMinutes(r.conversation_id, provider); }
        catch (e) { console.warn("auto minutes skipped", r.conversation_id, e); }
      }
    }
  } catch (e) { console.warn("auto minutes pass skipped", e); }
  // "Your Context" derivation: distill this session's freshly-written graph into the user's standing
  // priors. Rule-based, ZERO extra LLM calls, idempotent, non-destructive. Cloud-only (mirrors the
  // auto-minutes gate — on-device extraction doesn't populate the graph the same way) and gated on the
  // context_enabled master toggle (default ON). Best-effort — must NEVER fail session processing.
  try {
    const contextEnabled = (await repo.getSettings()).context_enabled !== false;
    if (contextEnabled && provider.id === "cloud") {
      try { await deriveSessionPriors(sessionId, provider); }
      catch (e) { console.warn("derive priors skipped", sessionId, e); }
    }
  } catch (e) { console.warn("derive priors pass skipped", e); }
  return { session_id: sessionId, conversations: toExtract, extracted, failed: toExtract.length - extracted.length, lastError, speakers };
}

/** Recovery pass: reprocess recordings transcribed but never fully turned into memories (app killed
 *  mid-process, proxy unreachable, or a prior build crashed in extraction). Safe on every launch —
 *  only touches incomplete data; idempotent. */
export async function reprocessIncomplete(provider: Provider) {
  let recovered = 0;
  const sessions = await repo.sessionsWithUnsegmentedTurns();
  for (const sid of sessions) {
    try { const r = await processSession(sid, provider); recovered += r.extracted.length; }
    catch (e) { console.warn("reprocess session failed", sid, e); }
  }
  for (const cid of await repo.conversationsWithoutMemory()) {
    try { const r = await extractConversation(cid, provider); if (r) recovered++; }
    catch (e) { try { await repo.setConversationStatus(cid, "failed"); } catch { /* best-effort */ } console.warn("reprocess conv failed", cid, e); }
  }
  return { sessionsScanned: sessions.length, recovered };
}
