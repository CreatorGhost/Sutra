# Sutra — Definition of "Perfect" (Evaluator Rubric)

The evaluator agent tests the **running** app (real OpenAI provider, real recordings) against this rubric.
A category passes only if **every** check passes. The build is "perfect" only when **all categories pass**
with zero Critical or Major issues open. Score each check ✅/❌ with evidence (request/response, screenshot, log).

## C1 — Capture → diarized transcript (M1) · CRITICAL
- [ ] `docker compose up` boots db + backend; `/api/health` returns `{status:ok, db:true}`.
- [ ] Uploading a real `.m4a` recording returns diarized turns with ≥2 distinct speakers when present.
- [ ] Bilingual (Hindi-English) speech is transcribed faithfully (not dropped/garbled), `lang` tagged.
- [ ] Live mic capture in the PWA produces turns; record/pause/stop states are correct and visible.
- [ ] Speaker voiceprints resolve identities; "me" is reliably tagged after enrollment; relabel merges work.

## C2 — Privacy invariant · CRITICAL (non-negotiable)
- [ ] No table has any audio/waveform/blob column (automated test `test_no_audio_columns_anywhere` passes).
- [ ] No audio file is ever written to disk (verify: container fs + code review of ingest path).
- [ ] Consent mode `drop`/`redact` gates unenrolled speakers before persistence.

## C3 — Intelligence + graph (M2)
- [ ] Each conversation yields a coherent summary, action items (owner/due when stated), decisions, facts.
- [ ] Entities (person/project/topic/org/place/event/commitment) extracted and de-duplicated.
- [ ] Graph edges have evidence (conversation + turn ids); graph browser renders and expands on tap.
- [ ] importance_score in [0,1] assigned; type_tags present.

## C4 — Retrieval + chat + recap (M3)
- [ ] Hybrid search returns relevant memories; ranking blends RRF + recency + importance (formula documented).
- [ ] Chat answers are grounded and **cite source conversations + dates**; unsupported questions are refused
      (supported=false), never hallucinated.
- [ ] Daily recap rollup builds (summary + highlights + open actions); email sends when SMTP configured
      (or cleanly skips with a clear log when not).

## C5 — UI/UX quality · (design is a deliverable)
- [ ] Minimal, professional, cohesive calm-dark design; consistent spacing/type/components across all pages.
- [ ] Fully responsive; looks right on a phone (375px) — no overflow, 44px+ touch targets, safe-area respected.
- [ ] Clear loading/empty/error states everywhere; no dead ends; navigation is obvious and consistent.
- [ ] Motion is purposeful and respects prefers-reduced-motion. Mic has a live recording indicator.

## C6 — Robustness & correctness
- [ ] No unhandled 500s on the documented flows; bad input returns sane 4xx with messages.
- [ ] Backend integration tests pass (mock provider); a real-OpenAI smoke test passes when key present.
- [ ] Frontend builds with zero TypeScript errors; no console errors on each page in the browser.
- [ ] Schema is idempotent; app recovers if DB starts slowly.

## C7 — Deliverables & docs
- [ ] `docker compose up` works from a clean checkout; `.env.example` lists every key.
- [ ] Seed script populates demo data so retrieval/chat/graph are testable without recording.
- [ ] README: setup, Sat/Sun run order, research findings (M0), architecture diagram, ranking formula,
      cloudflared phone instructions, and honest known limitations (background capture).

## Acceptance (end-to-end, from the brief)
- [ ] Real recording → diarized bilingual transcript → summary + action items + entities → entities linked
      in the graph → a natural question in chat returns a **cited, correct** answer → recap email renders.
- [ ] Audio is never written to disk at any point.

---
**Severity:** Critical = privacy breach, data loss, core flow broken, or crash on a documented path.
Major = feature wrong/missing or notable UX failure. Minor = polish. Ship only at **0 Critical, 0 Major**.
