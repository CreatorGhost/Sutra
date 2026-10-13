// Transcript refinement service. Non-destructive: raw turns.text stays the source of truth; cleaned
// text lands in turns.text_clean and conversations.refined decides which is used. Cloud or agent engine — the
// on-device provider's refine() is a no-op, so we bail before touching anything. Idempotent: re-running
// just re-cleans the same rows. A per-batch failure leaves that batch's raw text untouched.
import * as repo from "./repo";
import { extractConversation } from "./extraction";
import { assembleProjectContext } from "./projectContext";
import { clampBrief, BRIEF_CAP } from "./repo";
import type { Provider, RefineOpts } from "../providers/provider";
import { isFullTextEngine } from "../providers";

const BATCH = 30; // 30 turns is ample local context for a conservative cleanup pass; no cross-batch state.

/** Clean a conversation's transcript in place (raw preserved), flag it refined, then rebuild
 *  memory/graph/embeddings from the now-cleaned text. */
export async function cleanConversation(
  convId: number,
  provider: Provider,
): Promise<{ ok: boolean; refinedTurns?: number; reason?: string }> {
  if (!isFullTextEngine(provider)) return { ok: false, reason: "cloud-only" };
  try {
    const lang = String((await repo.getSettings()).transcript_lang ?? "english");
    const mode = lang === "english" ? "english" : "other";

    const rows = (await repo.rawConversationTurns(convId)) as any[];
    if (!rows.length) return { ok: false, reason: "empty" };

    // Project grounding for cleanup: inject the canonical-spelling glossary + delimited brief (with the
    // untrusted-transcript role constraint) when this conversation is mapped to a project with local
    // context ON. Empty/absent/disabled => undefined fields, so refine() behaves exactly as today.
    const ctxOpts: Pick<RefineOpts, "glossary" | "brief" | "roleConstraint"> = {};
    try {
      const project: any = await repo.projectForConversation(convId);
      if (project && project.context_enabled !== false) {
        const ctx = assembleProjectContext(project);
        if (ctx.cleanupGlossary) ctxOpts.glossary = ctx.cleanupGlossary;
        const brief = clampBrief(project.brief ?? "", BRIEF_CAP).trim();
        if (brief) ctxOpts.brief = brief;
        if (ctx.cleanupGlossary || brief) ctxOpts.roleConstraint = ctx.roleConstraint;
      }
    } catch (e) { console.warn("project context lookup skipped", convId, e); }

    let refinedTurns = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const texts = batch.map((t) => String(t.text ?? ""));
      try {
        // English mode: translate() is the reliable Hindi→English path (refine() leaks Devanagari and
        // gets rejected by the guard below). Translate first, then conservatively de-noise the English
        // via refine in 'other' mode (no second translation, so no Devanagari risk). Each step is a
        // strict 1:1 array; if either returns a bad length we fall back to the prior text per index.
        let out: string[];
        if (mode === "english") {
          const en = await provider.translate(texts);
          const safe = Array.isArray(en) && en.length === texts.length ? en : texts;
          const cleaned = await provider.refine(safe, { mode: "other", ...ctxOpts });
          out =
            Array.isArray(cleaned) && cleaned.length === texts.length
              ? cleaned.map((c, k) => (typeof c === "string" && c.trim() ? c : safe[k]))
              : safe;
        } else {
          out = await provider.refine(texts, { mode: "other", ...ctxOpts });
        }
        if (Array.isArray(out) && out.length === texts.length) {
          // STRICT 1:1 gate passed — apply per-line, keeping raw for any suspect line.
          for (let j = 0; j < batch.length; j++) {
            const c = out[j];
            if (!c || !c.trim()) continue; // empty -> keep raw
            if (mode === "english" && /[ऀ-ॿ]/.test(c)) continue; // Devanagari leak -> keep raw
            const wRaw = (texts[j].match(/\S+/g) || []).length;
            const wNew = (c.match(/\S+/g) || []).length;
            if (wRaw > 0 && (wNew > wRaw * 2.5 + 4 || wNew < wRaw * 0.4 - 4)) continue; // abnormal length -> keep raw
            await repo.setTurnClean(batch[j].id, c);
            refinedTurns++;
          }
        } // else: count mismatch -> skip whole batch (raw kept)
      } catch (e) {
        // keep raw for this batch
        console.warn("refine batch skipped", e);
      }
    }

    await repo.setConversationRefined(convId, true);
    await extractConversation(convId, provider); // rebuild memory/graph/embeddings from cleaned text
    return { ok: true, refinedTurns };
  } catch (e) {
    // Top-level failure: raw text is intact and refined defaults to 0, so no revert needed.
    console.warn("cleanConversation failed", convId, e);
    return { ok: false, reason: "error" };
  }
}

/** Toggle a conversation between raw and cleaned text without re-running the model refine pass, then
 *  re-derive memory/graph from whichever text is now active. */
export async function setRefined(
  convId: number,
  on: boolean,
  provider: Provider,
): Promise<{ ok: boolean }> {
  await repo.setConversationRefined(convId, on);
  await extractConversation(convId, provider); // re-derive from the chosen text (no model refine call)
  return { ok: true };
}
