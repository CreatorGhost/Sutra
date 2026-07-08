# Your Context (priors) — schema, rules & backlog

> Compressed from `feature.md` (the engineering spec — its MCP / Tier B / Your-Context-Phase-1
> portions are shipped) and `YOUR-CONTEXT-PROPOSAL.md` (the upstream research/design).
> **Status:** v1 foundation BUILT (priors table v7 + repo + derivation + chat-grounding +
> Settings UI). The application layer (roster speaker-naming, context-grounded cleanup,
> Ambient+Discuss UX) is DESIGNED, not built.

---

## §0 — HARD product rules (apply to EVERY feature, still binding)

1. **Audio never persisted** — only `Provider.transcribeDiarize` (`provider.ts:15`) touches
   audio, in-flight only; `training_audio` (`schema.ts:96-101`) is the only audio-capable
   table, OPT-IN / UNWIRED / empty by default.
2. **AI model/vendor names NEVER in user-facing copy** (enforced even in proxy `/health`,
   `proxy.py:59`).
3. **Local-first** — memory on device, encrypted at rest, proxy stays stateless.
4. **Priors are non-citable, may-be-stale beliefs** — never authoritative.
5. **Never expose** raw voiceprints/biometric blobs, embeddings, the SQLCipher passphrase, or
   redacted turns (`turns.redacted=1`, `schema.ts:24`).

## Data flow (where priors fit)

capture (`capture.ts`, windowed webm/opus) → `ingestWindow` (`sutra.ts:39`) →
`transcribeDiarize` (only audio seam) → proxy returns diarized turns + (hybrid, opt-in)
192-d ECAPA voiceprints; proxy decodes to PCM in /dev/shm RAM then unlinks
(`voiceprint.py:31-156`) → `processSession` (`extraction.ts:92-136`): cluster speakers →
segment → extract memory/entities/edges/action_items/events → auto-minutes →
**deriveSessionPriors** → SQLite. Retrieval = hybrid (semantic cosine + FTS5 BM25 → RRF) +
graph-RAG chat fusing memories + graph + priors.

## Priors — schema v7 (BUILT, the live contract)

`SCHEMA_VERSION=7`; `priors` table = `MIGRATIONS[7]` (`schema.ts:148-184`).

Columns: `id, kind, entity_id, subject, norm_subject, value, attrs(JSON), confidence(REAL=0.5),
supported(INT=1), contradicted(INT=0), provenance, status('suggested'), source_conversation,
source_turn_ids(JSON), is_prior(=1), share_cloud(INT=0), valid_from, valid_to,
last_confirmed_at, superseded_by, created_at`. Indexes on norm_subject/kind/entity_id/status.

- `kind` user set = `person|project|org|role|topic|goal|pref`; **derivation auto-produces only
  person|project|org**.
- Privacy = ONE flag `share_cloud` (default 0).
- **Three locked invariants** (`priors.ts:4-12`): additive/non-destructive; idempotent (re-run
  reinforces `supported++`, never dup); **ZERO extra LLM calls** (pure SQL + arithmetic).
- `topPriors(query, k=8, cloud=false)` selects
  `(status='confirmed' OR provenance='user') AND superseded_by IS NULL AND valid_to IS NULL`;
  cloud adds `AND share_cloud=1`; ranks by
  `effective_confidence = confidence * recency * clamp(1 + 0.1*(supported-contradicted), 0.5, 1.5)`.
- **Known gap:** the `query` arg is unused (`repo.ts:372`).
- `supersedePrior` is **never automatic**.

> The built code chose a dedicated `priors` table over a settings-JSON blob, and a single
> `share_cloud` flag over the proposal's three-tier `field_privacy` — so the schema below from
> the original proposal is **superseded by the table above**, kept only for design rationale.

## Backlog — designed, NOT built (durable design intent)

**Your Context Phase 2 (LOCKED, not built):** user-authored context pack + **TEAM ROSTER**
`{name, role, aliases[], person_id?}` stored as `kind='person'` / `provenance='user'` priors
via `attrs` JSON (no migration); roster-grounded speaker-naming with HIGH→auto-apply /
LOW→suggested-marked confidence rule (never silently rename from role/topic inference; confirm
learns the voiceprint); context-grounded cleanup glossary injected into the corrector
normalization **post-transcription only** (ASR rejects biasing prompts; keep 1:1 / Devanagari /
length guards); Ambient + Discuss UX. Phase 2 does **not** touch the extraction prompt.

**Your Context Phase 3+:** extraction-grounding behind an A/B eval gate (bumps PROMPT_VERSION
v5→v6, must land in BOTH the TS and backend Python prompt/schema; ship only on a paired
hi-en entity_f1 win with no action-F1/CER regression, expanding the gold set 6→≥50); per-project
context overlays; full T0/T1/T2 privacy tiers + pseudonymized cloud egress + egress audit
(SQLCipher key-wrap is a launch blocker); onboarding gazetteer; edit-by-chat; conflict-card
reflector loop.

**8 recommended features** (NOW=1,2 · NEXT=3,4,6,7,8 · LATER=5):
1. proactive reminders from events + action items via a per-item LocalNotifications scheduler [add `dueActions()`];
2. calendar `.ics` export (client-side VEVENT string, reuse Share plumbing, export-only no write-back);
3. person timeline `/person/:id` (add `conversationsForPerson`/`actionsForPerson`; keep a VIEW not a CRM);
4. weekly digest (generalize `buildRollup`, synthetic `daily_rollups` key, no schema change, ONE provider call);
5. cross-conversation project/people threading (reuse edge evidence `json_each`, `conversationsForEntity`, no new table);
6. voice query (reuse the capture stack → transcribeDiarize → chat; audio invariant preserved);
7. saved/suggested questions (settings JSON or a tiny table);
8. search filters person/date/type (post-fusion filter param on `searchMemories`).

**REJECTED (do NOT build):** live two-way calendar/email/Slack auto-sync/auto-send; real
on-device AI compute (WASM-in-WebView found impossible; `ondeviceProvider.ts` is a hard-fail
stub); full sales CRM; analytics dashboards/charts; auto-redact unenrolled speakers
(a consent-policy feature, not a memory capability).

## Cross-cutting data-loss / correctness flags (still relevant)

- `action_items.steps[]` is **extracted then dropped** — `insertAction` (`repo.ts:228`) persists
  only text/owner/due/status/source_conversation, no steps column (any UI/MCP can't expose
  per-action steps until wired).
- Re-extracting the same conversation re-inflates entity mention_count/importance + edge weight
  (`graph.ts:7-11,37-40`), guarded by "memory exists → skip."

## Design rationale (from the research proposal)

**Core thesis:** every production memory system (ChatGPT, Claude, LangMem, Mem0, Letta,
Zep/Graphiti) is two-tier — a large searchable store + a small always-in-context PROFILE tier.
"Your Context" is Sutra's profile tier. Highest-leverage use = ground EXTRACT + seed entity
resolution to attack weak hi-en entity F1 (0.709) WITHOUT regressing action-item F1 (0.971).

**Three hard design rules:** (1) **PRIORS NOT TRUTH** — defeasible defaults, low base confidence,
"MAY be stale — prefer in-conversation evidence and FLAG conflict"; never enter the reinforcement
amplifier; never appear in extraction output unless the conversation references them.
(2) **CANONICALIZE, DON'T OVERSHADOW** — supply a known-entity roster + aliases so Raj/Raju/राज
collapse to one node, but preserve NEW-entity discovery via `links_to_profile: known|new|unsure`
+ a precision-first merge bar. (3) **MEASURE BEFORE SHIPPING** — ship only if a paired A/B lifts
hi-en entity F1 with NO regression to action-F1/precision (generic context can cut extraction
pass rate 100%→90%).

**Injection points (design):** extraction prompt gets a `<known_entities>` PRIORS block with
override+flag instructions (bump PROMPT_VERSION; schema adds `candidate_id`, `links_to_profile`,
top-level `contradicts_profile[]`); chat prepends `# Your Context` BEFORE memories/graph, labelled
NON-CITABLE (no conversation_id); graph alias map at the exact-match tier with LAZY seeding and a
reinforcement firewall (priors don't accrue importance/mention_count).

**Codebase-fit gotchas (verified):**
- `settings` = single-row JSON K/V — a new key = zero migration.
- The `SCHEMA_VERSION` ladder is forward-only / append-only (`db.ts`, `schema.ts`); a new
  table = next `MIGRATIONS[i]` + bump SCHEMA_VERSION + `createConnection` arg, together.
- `PROMPT_VERSION` is stamped on every training sample + eval result — **any prompt/schema change
  MUST bump it** or the corpus/evals become silently incomparable.
- **DUAL SOURCE-OF-TRUTH / DRIFT:** evals grade the BACKEND Python prompt
  (`run.py` imports `app.services.extraction.SYSTEM` + `app.schemas.EXTRACTION_JSON_SCHEMA`),
  NOT `frontend/src/local/aiPrompts.ts`. To A/B on gate metrics, the context block must land in
  the backend strategy (`evals/strategies.py STRATEGIES` is an extensible dict).
- Chat citation contract requires `citation_conversation_ids:int[]` → profile facts have no
  conversation_id → must be non-citable.
- Gold set = 6 samples; `entity_f1` = normalized fuzz ≥85 (`metrics.py:51`); gate = hi-en
  action-F1 ≥ 0.90×baseline AND CER ≤ 1.2× (`run.py:5-7`).
