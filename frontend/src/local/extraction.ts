import type { Provider } from "../providers/provider";
import { EXTRACTION_JSON_SCHEMA, EXTRACT_SYSTEM } from "./aiPrompts";
import * as graph from "./graph";
import * as people from "./people";
import * as repo from "./repo";
import { segmentSession } from "./segmentation";
import { clusterAndIdentify } from "./speakerId";
import { detectLang, normName } from "./util";
import { captureExtraction } from "./training";

const clamp = (x: any) => Math.max(0, Math.min(1, Number(x) || 0.5));

export async function extractConversation(convId: number, provider: Provider) {
  const detail = await repo.conversationDetail(convId);
  const turns = (detail?.turns ?? []) as any[];
  if (!turns.length) return null;
  const turnIds = turns.map((t) => t.id);
  const transcript = turns.map((t) => `${t.person_name || (t.session_speaker_label === "me" ? "Me" : "Speaker " + t.session_speaker_label)}: ${t.text}`).join("\n");

  // Give the model the conversation's date so it can resolve relative times ("kal 11 baje" -> ISO datetime).
  const convDate = String((detail as any)?.conversation?.started_at ?? "").slice(0, 10);
  const userContent = (convDate ? `Today's date: ${convDate}.\n\n` : "") + transcript;
  const data = await provider.extract(EXTRACTION_JSON_SCHEMA, EXTRACT_SYSTEM, userContent);
  const entities = (data.entities ?? []) as any[];
  const entTexts = entities.map((e) => `${e.name} (${e.type}): ${e.description ?? ""}`.trim());
  const summary = data.summary ?? "";
  // Never embed the literal "(empty)" (it pollutes semantic search) — fall back to title/first fact.
  const seed = summary.trim() || String(data.title ?? "").trim() || String(data.facts?.[0] ?? "").trim() || "conversation";
  const vecs = await provider.embed([seed, ...entTexts]);
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
  const sessionId = turns[0]?.session_id;
  if (sessionId != null) {
    for (const sn of (data.speaker_names ?? []) as any[]) {
      const name = String(sn?.name ?? "").trim();
      if (!name || sn?.confidence !== "high") continue;
      const label = String(sn?.speaker ?? "").replace(/^speaker\s+/i, "").trim();
      if (!label) continue;
      const isMe = /^(me|myself)$/i.test(name);
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
  // Replace (not append): re-extraction (recovery pass, "Regenerate") used to duplicate every action item.
  await repo.clearActions(convId);
  for (const a of (data.action_items ?? []) as any[]) {
    await repo.insertAction({ text: a.text, owner: a.owner, due: a.due, source_conversation: convId });
  }
  // Notes derived from the old extraction (e.g. a cached Detailed style) are stale now.
  await repo.clearNotes(convId);
  await repo.setConversationStatus(convId, "done");
  return { conversation_id: convId, memory_id: memId, title: data.title, entities: Object.keys(nameToId).length,
           action_items: (data.action_items ?? []).length, importance: clamp(data.importance_score) };
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
