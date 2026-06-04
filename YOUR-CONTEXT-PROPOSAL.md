# YOUR-CONTEXT-PROPOSAL.md

> Status: **RESEARCH-ONLY DESIGN PROPOSAL.** Nothing here is implemented. This document proposes the "Your Context" user-profile-grounding feature for Sutra, grounded in cited external research and verified against the actual codebase (`frontend/src/local/*`, `evals/*`). It ends with an explicit **STOP — awaiting greenlight** gate.

---

## 1. Executive summary

Sutra already has the **knowledge tier** (graph + entity resolution + hybrid/graph-RAG chat). Every production memory system studied (ChatGPT Memory, Claude Memory, LangMem, Mem0, Letta/MemGPT, Zep/Graphiti) converges on a **two-tier split**: a large searchable store *plus* a small, always-in-context **profile tier**. "Your Context" is exactly Sutra's missing profile tier.

The single highest-leverage use of the profile is to **ground EXTRACT and seed entity resolution** — directly attacking Sutra's weak metric, **entity F1 0.709 (hi-en)** — while protecting the strong metric, **action-item F1 0.971**. The proposal models the profile as a **typed, in-place, versioned card set** (LangMem/Letta "human block" pattern) whose people/projects are **canonical graph entities with aliases**, not duplicated free text. At extraction/chat time, only a **retrieved, transcript-relevant subset of cards (~300–400 tokens)** is injected — never the whole profile (Memoria; arXiv 2406.17803; EDC; on-device limits).

Three hard design rules carry the proposal:

1. **PRIORS, NOT TRUTH.** Profile facts are defeasible defaults injected with a low base confidence and a "this MAY be stale — prefer in-conversation evidence and FLAG the conflict" instruction. They never enter the reinforcement amplifier and never appear in extraction output unless the conversation actually references them.
2. **CANONICALIZE, DON'T OVERSHADOW.** The profile supplies a known-entity roster + aliases so "Raj/Raju/राज" collapse to one node — but discovery of NEW entities is explicitly preserved via a `links_to_profile: known|new|unsure` flag and a precision-first merge bar.
3. **MEASURE BEFORE SHIPPING.** The feature ships only if a paired A/B on the gold set lifts hi-en entity F1 with **no regression** to action-item F1/precision. External evidence is unanimous that adding context can *lower* accuracy ("When Better Prompts Hurt": a generic wrapper cut extraction pass rate 100%→90%).

Storage uses the existing `settings` JSON K/V (zero migration). Per-field privacy tiers gate cloud egress; sensitive fields default **on-device-only**. The SQLCipher-key-in-`localStorage` gap (`db.ts:10-20`) is called out as a **blocker** because the profile concentrates PII.

---

## 2. Cited findings per research axis

### Axis A — How production systems structure/store/update/retrieve persistent context

The field has converged on a small set of primitives, with one axis of disagreement (full-injection vs retrieval).

- **ChatGPT Memory = full-injection, NOT RAG.** Two buckets: Saved Memories (explicit, user-editable) + Reference Chat History. A 4-component block is injected into *every* message: interaction metadata; ~40 recent conversations; **Model Set Context** (editable saved facts); **User Knowledge Memories** (AI-generated summaries regenerated from hundreds of conversations). Explicitly "no vector DB, no knowledge graph, no per-memory retrieval" — relies on the model to ignore irrelevant context ("the bitter lesson"). Token-heavy; viable only because summaries are compressed.
  - https://openai.com/index/memory-and-new-controls-for-chatgpt/
  - https://help.openai.com/en/articles/8983136-what-is-memory
  - https://www.shloked.com/writing/chatgpt-memory-bitter-lesson
  - https://llmrefs.com/blog/reverse-engineering-chatgpt-memory
  - https://manthanguptaa.in/posts/chatgpt_memory/
- **Claude Memory = per-project editable summary.** Memory is scoped per Project (no context bleed), surfaced as a single human-readable **summary** the user edits by chatting; Claude **announces when it uses a memory** ("Based on your React project last week…"); incognito mode writes nothing; Claude Code has auto-memory.
  - https://claude.com/blog/memory
  - https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
  - https://docs.anthropic.com/en/docs/claude-code/memory
- **LangGraph/LangMem = the clean taxonomy + Profile-vs-Collection decision.** Semantic (facts about the user — *this is Your Context*) / episodic / procedural. **Profile** = one in-place JSON doc, fixed schema, best for stable bounded info; in-place merge gets error-prone as it grows. **Collection** = many narrow items searched at runtime, needs reconciliation. `BaseStore` namespace+key model. LangMem profiles use a Pydantic schema with `enable_inserts=False` to force a single in-place instance. Hot-path vs **background reflection** (`ReflectionExecutor`, debounced) — background preferred to avoid latency.
  - https://docs.langchain.com/oss/python/langgraph/memory
  - https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
  - https://langchain-ai.github.io/langmem/guides/manage_user_profile/
  - https://langchain-ai.github.io/langmem/guides/extract_semantic_memories/
- **Mem0 = two-phase extract→update with typed memories.** Extract atomic facts; per candidate emit **ADD/UPDATE/DELETE/NOOP** (newer pipeline favors ADD-only + timestamp-aware resolution over deletion). Memories typed (`preference|profile|task_state|log|summary`); facts and entities kept as parallel collections; multi-signal retrieval (vector + BM25 + entity-match, score-fused, recency-reranked); KV fast path for stable profile lookups. ~26% edge over OpenAI built-in memory on their benchmark.
  - https://mem0.ai/blog/ai-memory-management-for-llms-and-agents
  - https://mem0.ai/blog/state-of-ai-agent-memory-2026
  - https://deepwiki.com/mem0ai/mem0/1-overview
- **Letta/MemGPT = self-edited in-context memory blocks.** A **memory block** = labeled persistent string always prepended (`label`, `description`[critical], `value`, `limit`, `read_only`, `shareable`); default `human` + `persona` blocks; agent edits via tools; recall + archival tiers (OS RAM-vs-disk analogy).
  - https://docs.letta.com/guides/agents/memory-blocks/
  - https://www.letta.com/blog/memory-blocks
  - https://www.letta.com/blog/agent-memory
  - https://arxiv.org/abs/2310.08560
- **Zep/Graphiti = bi-temporal KG (closest to Sutra's graph).** Episode/semantic-entity/community subgraphs; entities resolved against existing nodes (1024-d cosine + full-text + LLM dedupe — analogous to Sutra's 0.86 threshold). Every edge carries `t_valid`/`t_invalid` (world time) + `created_at`/`expired_at` (system time); contradictions **invalidate**, never delete. On LongMemEval: +18.5% accuracy, ~90% latency reduction (1.6k vs 115k tokens), biggest gains in **temporal reasoning (+48%)** and **preferences (+77%)** — exactly what a long-lived profile cares about.
  - https://arxiv.org/html/2501.13956v1
  - https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/
  - https://github.com/getzep/graphiti

**Recurring patterns:** (1) two tiers universal; (2) facts/entities/summaries kept distinct; (3) profile=in-place doc, knowledge=append-only collection/graph; (4) updates trend append-only + temporal invalidation; (5) writes in the background; (6) transparency/citation of memory is table-stakes; (7) per-scope isolation prevents bleed.

### Axis B — Entity canonicalization with a gazetteer + feeding known entities into EXTRACT

The canonical ER pipeline: **normalize → block → pairwise compare (fuzzy+embedding) → classify/cluster → canonicalize to a golden record with a persistent canonical ID.** Aliases point to the canonical ID rather than spawning records. Recommended layers above fuzzy matching: a **nickname dictionary** (Bill→William), legal-suffix normalization for orgs, and **phonetic/transliteration** handling — critical for **Hinglish** (Devanagari transliteration produces phonetic-but-fuzzy-matchable variants: Farha/Farhah, Aditya/Adi). **Blocking** bounds comparisons; **two-threshold review band** (auto-merge above HIGH, queue gray band, new below LOW) is best practice — Sutra's single hard 0.86 cutoff silently forks anything 0.78–0.86.
  - https://www.peopledatalabs.com/data-lab/datafication/entity-resolution-guide
  - https://dataladder.com/a-guide-to-entity-resolution-tools-for-enterprise-data-projects/
  - https://dataladder.com/fuzzy-matching-101/
  - https://arxiv.org/pdf/1905.06167
  - https://arxiv.org/pdf/cs/0609051
  - https://rosette.com/name-matching-algorithms
  - https://www.netowl.com/name-matching-software

Feeding the known-entity list into the prompt is the higher-leverage change:
- **Entity definitions + few-shot (PromptNER/GPT4NER):** explicit per-type definitions + examples + per-entity justification → ~11% F1 gain, SOTA few-shot NER. Sutra has 7 types but no definitions. https://arxiv.org/abs/2305.15444
- **RAG/dynamic prompting:** retrieve the most relevant known entities per input (TF-IDF/SBERT). Static structured prompting +11–12% F1; dynamic retrieval +5.6–7.3% more. Explicit **token-budget warning**: you cannot fit everything — inject a retrieved subset. https://www.nature.com/articles/s44387-025-00062-2 ; https://arxiv.org/html/2508.06504
- **Candidate generation + ranking (entity linking):** k-NN retrieve top-k canonical candidates (name + short description), LLM picks/scores (k≈10 shown of k≈64 retrieved). Dominant failure = **bounded recall** (right entity not in candidate set). Resolve a mention by showing top-k candidates and emitting a `canonical_id` or "NEW". https://academic.oup.com/database/article/doi/10.1093/database/baae067/7721591 ; https://arxiv.org/pdf/2202.13404
- **Graphiti production analog:** hybrid search (embedding + full-text over names *and summaries*) → LLM resolution prompt → canonical name/summary; edge dedupe constrained to same entity pair. Caveat: LLM name-matching "degrades as entity vocabularies grow more ambiguous" — the LLM is the adjudicator, not a substitute for good aliases/blocking. https://arxiv.org/html/2501.13956v1 ; https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/
- **Output-format notes (llmNER):** emitting a candidate `canonical_id` beats re-typing a name; in-line tagging can beat pure JSON for span fidelity; one-type-per-turn reduces cross-type confusion. Keep JSON, add the candidate-id field + crisp definitions. https://arxiv.org/html/2406.04528v1

### Axis C — Injecting the profile without token bloat

- **Do NOT inject the whole profile.** OpenAI's personalization cookbook renders only **top-k notes** (e.g. 6 global + 8 session), each a 3-field card `{text(1-2 sentences), last_update_date, keywords}`, in explicit `<user_profile>`/`<memories>` blocks with a precedence policy (current message > session > global). https://developers.openai.com/cookbook/examples/agents_sdk/context_personalization
- **Memoria (closest analog):** KG triplets in SQL + embeddings; retrieve top-K≈20 by similarity with **exponential recency decay**; **<400 prompt tokens vs ~115,000**, up to 38.7% lower latency, 87.1% accuracy (beats full-context). https://arxiv.org/html/2512.12686v1
- **arXiv 2406.17803 (most important methodological finding):** **personalization signal > semantic similarity** — a random profile subset *from the same user* beats a semantically-similar subset from *other* users; **trimming each item to essentials fits 2–5× more items per budget with better results**; profile placed **earlier** in the prompt has a larger effect. → Store many short structured facts; always use THIS user's profile; place it near the top. https://arxiv.org/html/2406.17803v1
- **EDC (Extract-Define-Canonicalize):** extract freely, then canonicalize against a **target schema** via a trained Schema Retriever that pulls only contextually-relevant relations (full schema "exceeds the context window"). Near-perfect blueprint: Your Context people/projects/topics = the canonical schema; inject a retrieved subset as "align to these known entities." https://arxiv.org/html/2404.03868v1
- **On-device limits make this mandatory:** edge devices have 30–50× lower memory bandwidth; "concatenating user-specific memories with the input prompt quickly exhausts the limited context," quality degrades by ~turn 5. Lost-in-the-middle is real past ~32k tokens regardless of window size. https://v-chandra.github.io/on-device-llms/ ; https://arxiv.org/pdf/2311.12275 ; https://arxiv.org/pdf/2407.04418 ; https://www.flowhunt.io/blog/context-engineering/ ; https://www.instinctools.com/blog/context-engineering/ ; https://docs.langchain.com/oss/python/deepagents/context-engineering

### Axis D — Priors vs ground truth: belief revision & contradiction detection

- **Belief revision / TMS / AGM:** record **justifications** (X believed *because of* Y) so retracting an assumption auto-retracts dependents; ATMS holds inconsistent assumption sets simultaneously; AGM = expansion/revision/contraction with **minimal change + primacy of new information**. Profile facts = low-entrenchment assumptions; conversation evidence = higher entrenchment; on conflict revise toward evidence. https://cse.buffalo.edu/~shapiro/Papers/br-overview.pdf ; https://www.csc2.ncsu.edu/faculty/jdoyle2/publications/cf92.pdf ; https://en.wikipedia.org/wiki/Belief_revision
- **Zep bi-temporal contradiction handling:** scoped to **same entity pair**, LLM-judged, **invalidate (set `t_invalid`) not delete**, prioritize new info. https://arxiv.org/html/2501.13956v1 ; https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/
- **Mem0 ADD/UPDATE/DELETE/NOOP + documented failure modes:** systems **refuse to overwrite stale facts** ("Dan likes pizza" persists) OR **destroy coexisting facts** (treat "works at A" + "advises B" as a contradiction). Graph stores collapse on coexisting-fact retrieval; ADD-only accumulates without correction. → Distinguish *real contradiction* (role changed) from *coexistence* (two projects); never auto-delete. https://arxiv.org/html/2504.19413v1 ; https://arxiv.org/html/2605.26667v1 ; https://arxiv.org/html/2604.04853v1 ; https://xtrace.ai/blog/every-tool-is-solving-a-different-memory-problem
- **Contradiction detection mechanics:** similarity to find candidate pairs → **NLI (entailment/neutral/contradiction)** or LLM judge, temporally + entity scoped. Represent priors as **confidence∈[0,1] + provenance**; KBT jointly infers fact-correctness and source-accuracy; **Deliberation on Priors** treats KG priors as "foundational guidance not hard constraints… subject to verification," backtracking with explicit feedback on constraint violation. https://www.sciencedirect.com/science/article/pii/S0950705122006323 ; https://www.emergentmind.com/topics/natural-language-inference-nli ; https://www.shadecoder.com/topics/contradiction-detection-a-comprehensive-guide-for-2025 ; https://arxiv.org/abs/1502.03519 ; https://arxiv.org/pdf/2104.12622 ; https://arxiv.org/html/2405.16929v2 ; https://arxiv.org/html/2505.15210v2 ; https://arxiv.org/abs/2502.13247

### Axis E — Pitfalls of profile-grounded extraction + mitigations

- **Context poisoning / error amplification:** corrupted context "propagates into answers"; once a model commits to a wrong assumption it contaminates subsequent reasoning. SSGM proposes a write-time Truth Maintenance check (reject update if it entails contradiction with the trusted core). **Acute for Sutra:** a bad profile fact is injected into EXTRACT for *every* conversation, and `graph.ts` has a **reinforcement amplifier** (`importance+0.05`, `weight+1.0`, `graphOverview` orders by `mention_count DESC`) — error amplification is literally wired into the scoring. https://www.elastic.co/search-labs/blog/context-poisoning-llm ; https://neuraltrust.ai/blog/echo-chamber-context-poisoning-jailbreak ; https://arxiv.org/html/2603.11768v1 ; https://arxiv.org/pdf/2311.01740 ; https://arxiv.org/html/2511.12236
- **Over-fitting / discovery suppression:** EL models are biased to pick an existing candidate over predicting **NIL** ("Learn to Not Link") — must separate the NIL/"new entity" decision from candidate selection; **entity overshadowing** = prior-probability bias over-predicts frequent/known entities at the expense of rare correct ones. Heavy grounding makes models echo context ("ungrounded even when correct"). **Acute for Sutra:** profile says people=[Farha,Mark] → biases extractor to map a NEW "Farhan"/different "Mark" onto known nodes; then `upsertEntity` over-merges at the embedding level (Mark/Marc sit above 0.86). Code-switched proper nouns are *precisely* the rare-entity case. Forcing new entities into known ones likely **raises precision while lowering recall** — watch recall. https://arxiv.org/abs/2305.15725 ; https://arxiv.org/pdf/2108.10949 ; https://arxiv.org/html/2404.07060v1 ; https://www.minimalistinnovation.com/post/benchmarking-datasets-metrics-entity-resolution
- **Staleness:** STALE benchmark — even the best models hit only **55.2%** at recognizing a stored memory is no longer valid; **Implicit Conflict** (a later observation invalidates an earlier memory with no explicit negation) is hardest — exactly how role/job/relationship changes surface in ambient audio (nobody says "I quit"). Semantic retrieval has **no correlation with recency**. Fix = structured state consolidation + freshness decay + re-confirmation. https://arxiv.org/abs/2605.06527 ; https://tacnode.io/post/llm-model-staleness-what-it-is-why-it-happens-and-why-it-breaks-ai-systems
- **"When Better Prompts Hurt":** a more-informative prompt cut extraction pass rate 100%→90%; a 50–200-case versioned golden set with paired comparison is the regression gate. https://arxiv.org/html/2601.22025v1 ; PersonaMem-v2: frontier models 37–48% on implicit personalization https://arxiv.org/pdf/2512.06688

### Axis F — Privacy for an on-device structured profile

- **Sensitivity classification is load-bearing:** tiered sensitivity drives controls; **combination/aggregation risk** (name+employer+projects+relationships is re-identifying even if each field is benign) → treat the **profile-as-whole** as high tier; sensitivity is context-dependent (storage vs cloud-send differ). OWASP MASVS-STORAGE classes the people/relationship graph as sensitive. https://www.forcepoint.com/blog/insights/pii-data-classification ; https://www.protecto.ai/blog/pii-data-classification-best-practices/ ; https://mas.owasp.org/MASVS/05-MASVS-STORAGE/
- **Encryption gap (real, in code):** `db.ts:10-20` stores the SQLCipher passphrase in `localStorage` (WebView, not hardware-isolated) with an explicit `TODO(prod)` Keystore note. AES-256 is moot if the key is trivially recoverable. Fix = AndroidKeyStore AES key wraps a random passphrase, store only the wrapped blob; prefer StrongBox for the small wrap; optionally gate T2 reads with `setUserAuthenticationParameters` + `setUnlockedDeviceRequired`; disable auto-backup. https://discuss.zetetic.net/t/sqlcipher-how-to-protect-the-key/522 ; https://developer.android.com/privacy-and-security/keystore ; https://source.android.com/docs/security/best-practices/hardware ; https://mas.owasp.org/MASTG/knowledge/android/MASVS-STORAGE/MASTG-KNOW-0043/ ; https://www.guardsquare.com/blog/android-keystore ; https://www.besthub.dev/articles/how-to-secure-your-android-room-database-with-sqlcipher-and-keystore-f8aae7e98123
- **Cloud egress discipline:** data minimization (inject only relevant fields); **pseudonymize, don't just redact** (PERSON_1/PROJECT_A, de-pseudonymize locally) — ideal for a relational graph; a small local model (Llama3-8B) matches GPT-4o for PII scrubbing (Rescriber). Canonicalizing means the cloud can receive pseudonymized canonical IDs instead of raw spoken names — privacy and entity-F1 point the same way. https://www.kiteworks.com/cybersecurity-risk-management/prevent-llm-data-leakage-controls/ ; https://medium.com/@ThinkingLoop/privacy-by-prompt-how-to-strip-pii-before-the-model-ever-sees-it-12047ee86fa0 ; https://radicalbit.ai/resources/blog/llm-data-privacy/ ; https://www.tonic.ai/guides/llm-data-privacy ; https://arxiv.org/abs/2410.11876 ; https://privacyinternational.org/long-read/5555/your-future-ai-assistant-still-needs-earn-your-trust ; https://github.com/OWASP/mastg/blob/master/Document/0x05d-Testing-Data-Storage.md

### Axis G — Integration/schema-version/conflict analysis (codebase-fit, verified)

Verified against the actual files:
- `settings` is a single-row JSON K/V (`schema.ts:72`, `repo.getSettings`/`putSettings` at `repo.ts:132-138`) read on every provider call — a `your_context` key fits with **zero migration**.
- **SCHEMA_VERSION ladder is forward-only/append-only/integer-keyed** (`db.ts:50-60`, `SCHEMA_VERSION=2` at `schema.ts:4`); a new table would be `MIGRATIONS[3]` + bump to 3 in the *same* change, and `createConnection(...,SCHEMA_VERSION,...)` at `db.ts:35` must move together.
- **PROMPT_VERSION=`extract-v2`** (`aiPrompts.ts:3`) is stamped on every training sample (`extraction.ts:33` → `schema.ts:92`) and recorded in eval results (`run.py:101`) — any prompt/schema change MUST bump it (→v3) or training corpus + eval results become silently incomparable.
- **Dual source-of-truth / already drifted:** evals import the **backend Python** prompt (`run.py:20` `from app.services.extraction import SYSTEM`, `run.py:19` `from app.schemas import EXTRACTION_JSON_SCHEMA`) — NOT `frontend/src/local/aiPrompts.ts`. To A/B on the gate metrics, the context block must land in the backend strategy/prompt; `evals/strategies.py` `STRATEGIES` is an extensible dict (already holds `combined`/`entity_pass`/`combined_v2`).
- **Chat citation contract:** `CHAT_SYSTEM` (`aiPrompts.ts:52-56`) = "Answer ONLY from the provided context… set supported=false… Cite the conversation ids"; `ANSWER_SCHEMA` requires `citation_conversation_ids: integer[]` (`aiPrompts.ts:58-65`); `chat.ts:31-39` keys citations off it. Profile facts have no `conversation_id` → must be labeled non-citable.
- **Graph perf:** `upsertEntity` embedding tier and `nearestEntities` are brute-force O(n) scans (`graph.ts:18-20, 76-78`) → do **lazy** seeding, not bulk pre-insert; keep 0.86.
- **Gold set is 6 samples** with known entity rosters per conversation (`evals/gold/seed.jsonl`); `entity_f1` = normalized-name fuzz≥85 (`metrics.py:51-52`); gate = hi-en action-F1 ≥ 0.90× baseline AND CER ≤ 1.2× (`run.py:5-7`).
  - https://www.decodingai.com/p/keep-knowledge-graph-clean ; https://arxiv.org/html/2601.22025v1 ; https://www.mdpi.com/2073-431X/15/3/178 ; https://arxiv.org/pdf/2604.04853 ; https://aclanthology.org/2025.acl-long.397.pdf ; https://arxiv.org/pdf/2512.06688 ; https://taurusystems.com/build-an-ontology-for-llm-grounding/ ; https://datawalk.com/grounding-large-language-models-with-knowledge-graphs/

---

## 3. Profile SCHEMA

Stored as a versioned JSON blob under the `settings` key `your_context` (zero migration). Modeled as a **typed, in-place card set** (LangMem profile + Letta human-block + OpenAI-cookbook note shape). People/projects/orgs are **references to canonical graph entities by id** (Zep-style), not duplicated text. Each card and each field carries privacy, provenance, confidence, and temporal metadata.

### 3.1 Entity cards (people / projects / topics / orgs / places)

```jsonc
{
  "schema_version": 1,
  "profile_version": 7,                 // bumped in-place on every edit (enable_inserts=False semantics)
  "owner": { "display_name": "Aditya", "aliases": ["Adi","ADP","अदिति?"], "entity_id": 12 },
  "role": { "value": "PM", "field_privacy": "cloud-OK", "provenance": "user", "confidence": 0.9,
            "is_prior": true, "valid_from": "2025-01-01", "valid_to": null },
  "company": { "value": "Acme", "field_privacy": "cloud-OK-optin", "provenance": "user", "confidence": 0.9,
               "is_prior": true, "valid_from": "2025-01-01", "valid_to": null },
  "people": [
    { "entity_id": 41, "canonical_name": "Farha", "aliases": ["Farhah","फरहा"],
      "relationship_to_user": "teammate", "keywords": ["payments","design"],
      "field_privacy": "on-device-only",          // other people's names default on-device-only (T2)
      "provenance": "user",                         // user | auto-suggested
      "confidence": 0.8, "is_prior": true,
      "last_update_date": "2026-05-20", "valid_from": "2025-06-01", "valid_to": null }
  ],
  "projects": [
    { "entity_id": 88, "canonical_name": "refund flow", "aliases": ["refunds","refund pipeline"],
      "relationship_to_user": "owner", "keywords": ["payments","Q3"],
      "field_privacy": "cloud-OK-optin", "provenance": "user", "confidence": 0.85, "is_prior": true,
      "last_update_date": "2026-05-18", "valid_from": "2026-03-01", "valid_to": null }
  ],
  "orgs":   [ { "entity_id": 5, "canonical_name": "Stripe", "aliases": [], "relationship_to_user": "vendor",
               "field_privacy": "cloud-OK", "provenance": "user", "confidence": 0.7, "is_prior": true } ],
  "topics": [ { "canonical_name": "checkout redesign", "aliases": ["checkout v2"], "keywords": ["frontend"],
               "field_privacy": "cloud-OK-optin", "provenance": "auto-suggested", "confidence": 0.6, "is_prior": true } ],
  "goals":  [ { "text": "ship refund flow by Q3", "field_privacy": "on-device-only", "provenance": "user",
               "confidence": 0.9, "is_prior": true, "valid_from": "2026-04-01", "valid_to": null } ],
  "response_prefs": { "style": "concise, English summaries", "field_privacy": "cloud-OK", "provenance": "user" },
  "project_overlays": [                  // Claude per-Project isolation: confidential context scoped, not global
    { "scope": "client-X", "people": [/* ids */], "projects": [/* ids */], "field_privacy": "on-device-only" }
  ]
}
```

### 3.2 Field/entity attributes (every card carries all of these)

| Attribute | Type | Purpose | Default |
|---|---|---|---|
| `entity_id` | int? | Reference to a canonical `entities.id` (people/projects/orgs). Null for free topics/goals. | null |
| `canonical_name` / `value` / `text` | string | The canonical form. | — |
| `aliases[]` | string[] | Nicknames, initials, Hinglish/Devanagari/transliteration variants (user-editable). | [] |
| `relationship_to_user` | string | "teammate", "manager", "owner", "vendor"… (drives chat disambiguation: "my manager"). | — |
| `keywords[]` | string[] | 1–3 retrieval tags (OpenAI-cookbook note shape). | [] |
| **`field_privacy`** | enum | **`cloud-OK` \| `cloud-OK-optin` \| `on-device-only`.** Sensitive fields (other people's names, goals, family/health/contact, project code-names) **default `on-device-only`**. | most-restrictive |
| **`provenance`** | enum | **`user` \| `auto-suggested`.** Auto-suggested facts require confirmation before becoming `user`. | user |
| **`confidence`** | float [0,1] | Base trust for prior-weighting (priors start low so fresh evidence outweighs them; KBT/AGM-entrenchment). | 0.6 |
| **`is_prior`** | bool | True for all profile facts — marks them defeasible (PRIORS-NOT-TRUTH). | true |
| `valid_from`/`valid_to` | date? | Event-time window (mirrors `edges.valid_from/valid_to`). On role/project change, set `valid_to` + open a new interval — never overwrite. | null |
| `last_update_date` | date | Recency for decay + precedence (Memoria exponential decay; cookbook precedence). | now |

**Privacy-tier mapping** (Forcepoint/Protecto/MASVS): `cloud-OK` ≈ T0 (own first name, role title, broad topics, public org); `cloud-OK-optin` ≈ T1 (employer specifics, project code-names, colleague first-names+relationship — sent only as a minimized/pseudonymized slice); `on-device-only` ≈ T2 (other people's full names, contact handles, family/health/relationship details, goals). **The profile-as-whole is high-sensitivity** (aggregation risk) and is never serialized verbatim into a cloud prompt.

---

## 4. The compact profile-card builder (relevance-selection + token budget)

Two builders, both reusing the existing cosine/RRF machinery in `search.ts` and `nearestEntities` in `graph.ts`. **Never inject the whole profile** (Memoria; 2406.17803; EDC; on-device limits).

**`buildContextCards(queryOrTranscript, mode)`** algorithm:
1. **Embed** the query (chat) or transcript (extract) with the existing provider `embed`.
2. **Candidate cards** = all profile cards (always THIS user's — personalization signal > similarity, 2406.17803).
3. **Score** each card = `α·cosine(embedding) + β·keyword/FTS-overlap + γ·recency_decay(last_update_date) + δ·importance` — relevance+recency+importance, **not similarity alone** (2406.17803; Memoria decay). Recency decay is explicit because semantic retrieval has no recency signal (Tacnode/STALE).
4. **Tier-gate (cloud mode only):** drop `on-device-only` cards; for `cloud-OK-optin` cards, **pseudonymize** names to consistent placeholders (PERSON_1/PROJECT_A) and record the mapping for local de-pseudonymization. In **on-device mode**, use full cards (privacy → quality differentiator).
5. **Select top-k** (k tied to a new setting `profile_topn`, default ~6–8, mirroring `search_topn`) under a **hard token budget ~300–400 tokens** (Memoria's <400-token result).
6. **Render** as compact cards (trimmed to essentials — 2–5× more items per budget, 2406.17803), with a clear `description` per card (Letta: the description field measurably helps models use blocks correctly).

```
# Your Context (PRIORS — may be outdated; prefer in-conversation evidence and flag conflicts)
People:   Farha [teammate, payments] ; Mark [manager]
Projects: refund flow [you own, Q3] ; checkout redesign [frontend]
Role/Org: PM at Acme | Goals: ship refund flow by Q3
```

Token-budget guard: if rendered cards exceed the budget, drop lowest-scored first; log the realized token count so the eval harness can measure prompt-token delta.

---

## 5. Injection design (extraction + chat + graph-seed/canonicalize)

### 5.1 Extraction grounding — `extraction.ts:19` + `aiPrompts.ts`

Build a per-call system string `EXTRACT_SYSTEM + renderContextBlock(cards)` (terse, char-limited — verbosity risks the 100%→90% regression). Inject a `<known_entities>` block as **PRIORS with explicit override + flag instructions** (EDC target-alignment + PromptNER definitions + PRIORS-NOT-TRUTH):

**Exact extraction-prompt addition (appended to EXTRACT_SYSTEM):**
```
KNOWN CONTEXT (priors — the user's known people/projects/orgs; these MAY be outdated).
Use these CANONICAL names/types to disambiguate and canonicalize entities you find
(e.g. resolve 'Raju'/'राज' to 'Raj' if Raj is listed). Prefer linking a mention to a
listed entity over inventing a new node, BUT:
 - Only output an entity if THIS conversation actually mentions it. Do NOT add a prior
   entity that was not discussed.
 - If the conversation contradicts a prior (role/company/relationship changed), TRUST the
   conversation, keep the spoken form, and record it in contradicts_profile.
 - If a mention does NOT match any listed entity, mark it links_to_profile="new" — do not
   force it onto a listed entity, and never invent a candidate_id not in the list.
Entity types: person (named humans incl. role-people like Landlord/Doctor/Mummy);
project (named products/tools/initiatives); org; place; event (named); topic; commitment.
[<known_entities>:  41|person|Farha (teammate) ; 88|project|refund flow (you own) ; ...]
```

**Schema additions to `EXTRACTION_JSON_SCHEMA.entities[]` (bumps PROMPT_VERSION → `extract-v3`):**
- `candidate_id: ["integer","null"]` — the listed entity id the mention links to, else null (turns extraction into linking; removes post-hoc fuzzy-merge guesswork — EL papers, Graphiti).
- `links_to_profile: enum ["known","new","unsure"]` — explicit NIL/new-entity head, separated from candidate selection ("Learn to Not Link"), to preserve discovery.
- New top-level `contradicts_profile: [{ profile_fact, observed_fact, entity, confidence }]` — makes contradictions a first-class output (DP feedback loop), not silently lost.

### 5.2 Chat grounding — `chat.ts:14-28` + `aiPrompts.ts`

Prepend a `# Your Context` block to `ctx` **before** `# Memories` and the graph block (earlier placement → larger effect, 2406.17803; avoids lost-in-the-middle). Resolve "my manager"/"the redesign" to canonical entities. **Preserve the citation contract:** label the block `user profile — NOT a citable source; use only to disambiguate; answers must still cite a conversation_id`. Keep `CHAT_SYSTEM`'s "answer ONLY from context" rule (profile = grounding, not new facts), and tag each context line with provenance + recency (`[profile]` vs `[C123, 2026-05]`). Instruct CHAT_SYSTEM to **prefer recent conversation evidence over priors on conflict** and to tell the user when the profile looks stale. Optionally extend `ANSWER_SCHEMA` with `flagged_contradictions` (kept in sync across TS+Python if added).

### 5.3 Graph seed / canonicalize — `graph.ts upsertEntity`

- **Alias map at the exact-match tier (highest-leverage structural change):** before the embedding tier, normalize an extracted name against profile aliases so the **exact `(type,norm_name)` tier hits**. Store aliases in `entities.attrs` (`attrs.aliases[]`, JSON, no migration). This is O(1) canonical resolution for known nicknames/Hinglish spellings.
- **Lazy seeding only:** a profile person/project becomes a high-importance canonical entity **on first real mention**, never bulk pre-inserted (the embedding/nearest scans are brute-force O(n) — `graph.ts:18-20,76-78`).
- **Keep 0.86; add a two-threshold band** for *profile-driven* merges: auto-merge above HIGH (e.g. 0.90, stricter than generic — profile grounding is the overshadowing case), create-new below LOW (e.g. 0.80), queue the gray band for the existing people-confirmation UX. Log every merge decision (entity_id, alias, score, source) for audit.
- **Reinforcement firewall:** profile-injected entities must NOT accrue `importance`/`mention_count` from the profile itself; only real conversation mentions raise rank, so `graphOverview` / graph-RAG are not dominated by an unverified prior.

### 5.4 The PRIORS-NOT-TRUTH rule + contradiction flagging (cross-cutting)

- Profile facts are stored in a separate weaker layer with `is_prior=true`, low base `confidence`, and `provenance` (KBT/AGM/DP).
- **Gate profile-derived edges behind "mentioned in this conversation"** — a prior must not fabricate an extraction output unless the conversation references it (prevents injecting unsupported facts and regressing baselines).
- **Write-time contradiction check (Zep-scoped + SSGM-TMS):** before reinforcing a profile-derived edge, pull existing edges for the **same entity pair** and run a cheap NLI/LLM contradiction classifier on that small set. Functionally-conflicting relations (`works_at A` vs `works_at B`) → **invalidate the older edge** (set `valid_to`/a new `t_invalid`), keep for history; genuinely coexisting (`advises B`) → keep both (avoids the MemFail "destroys coexisting facts" mode). Today `upsertEdge` only increments `weight` and can never represent "role changed."
- Confidence × recency weighting so a stale prior cannot dominate fresh evidence.

---

## 6. The self-enriching loop (frequent-entity → one-tap add, WITH the "this is NEW" escape path)

**Background reflection, never the hot path** (LangMem ReflectionExecutor; ChatGPT periodic regen; Mem0 post-hoc). After a capture session settles (debounced so an in-progress session isn't reconciled mid-stream):
1. **Detect frequent/high-importance entities** not yet in the profile (e.g. a person/project appearing across ≥N conversations or above an importance threshold — surfaced from existing `mention_count`/`importance`).
2. **Propose, don't auto-apply:** present a **one-tap "Add to Your Context"** suggestion card (`provenance: auto-suggested`, low confidence) — the user confirms before it becomes a canonical prior. Reuse the existing high-confidence-only gate pattern (`extraction.ts:41-49`: auto-apply only `confidence:"high"`, defer the rest).
3. **Update step = Mem0 ADD/UPDATE/DELETE/NOOP, but DELETE-as-invalidate** (Graphiti). Each proposed edit is logged (`training_edits`-style) so it is auditable and reversible.
4. **The "this is NEW" escape path:** every suggestion offers three actions — **Add as new** (creates a NEW canonical entity, explicitly NOT merged into any existing prior — counters overshadowing/NIL-avoidance), **Link to existing** (merge into a listed entity), or **Dismiss**. The reflection pass must never silently fold a frequent novel entity ("Farhan") into a similar prior ("Farha") — the NEW path is always available and is the default when `links_to_profile="new"`.
5. **Staleness re-confirmation:** apply freshness decay (SSGM Weibull-style) so aging priors lose grounding influence; on a schedule, prompt the user to re-confirm aging job/role/active-project facts (STALE). On an Implicit-Conflict signal (extraction implies a different role/company with no explicit negation), surface a **Conflict-detected card** — confirm/override, never silent auto-edit (MemFail anti-pattern; AGM minimal change under user authority).

---

## 7. Editing UX

**Your Context screen** (transparency + control — Claude/ChatGPT editable-summary pattern; Privacy International user agency):
- View/edit the profile as an editable card set; edit by form OR by chatting (Claude pattern).
- Per-card **privacy toggle** (`cloud-OK` / `cloud-OK-optin` / `on-device-only`) with sensitive defaults pre-set to on-device-only; a per-card **alias editor** (add Hinglish/transliteration variants).
- **Provenance + confidence badges**: `auto-suggested` facts visibly pending confirmation.
- **"What Sutra has shared about me"** local egress audit log — which profile fields were sent in each cloud prompt (transparency feature; LLM-gateway audit pattern).
- **Conflict-detected** and **Add-to-Context** cards (from §6) surface here.
- Full **view / edit / export / wipe** reusing the `training_*` opt-in + `consent_version` + `wipe()`/`export()` posture (`training.ts`).
- Citation: when a profile fact influenced an answer, chat says "Based on your Sutra project…" (Claude announce-memory pattern) — and flags staleness.
- Scope: a global profile plus per-project overlays so confidential project context stays isolated (Claude per-Project).

**Onboarding:** a short, optional first-run flow seeds role/company + a handful of people/projects with their common aliases (the gazetteer seed). Skippable; the self-enriching loop fills the rest over time. MASVS leak-channel hygiene: profile inputs use no-suggestions keyboard fields, field values are never logged, DB + Keystore alias excluded from auto-backup.

---

## 8. EVAL PLAN (A/B vs no-profile baseline on the gold set)

**Mandatory gate, not optional** — "When Better Prompts Hurt" shows a more-informative prompt can *lower* accuracy. Reuse the existing harness; the eval grades **backend Python** prompts, so the context block must land in a backend strategy (dual-source-of-truth fix).

- **Arms (`evals/strategies.py`, additive to the `STRATEGIES` dict):**
  - `combined` — current baseline, no profile (already measured: action-F1 0.971, entity-F1 0.709 hi-en).
  - `combined_with_context` — inject a fixed per-sample profile via a `<known_entities>` block.
  - `combined_with_context_linking` — also use `candidate_id`/`links_to_profile` linking.
- **Gold data:** add an optional `profile` field to each `evals/gold/seed.jsonl` sample (the 3 hi-en samples college/standup/trek have trivially authorable rosters). **Expand the gold set from 6 → 50–200 stratified cases (~20% edge cases)** before trusting the delta ("When Better Prompts Hurt").
- **Primary metric:** **hi-en `entity_f1`** (`metrics.py:51`, normalized-name fuzz≥85) — target: **close the 0.709 gap toward the 0.971 action level.** Paired per-sample comparison (`run.py:105` `per_sample`).
- **Guardrails (gate — ship only if ALL hold):**
  - **NO regression** to action-item F1 0.971 / precision (gate: hi-en action-F1 ≥ 0.90× baseline AND CER ≤ 1.2×, `run.py:5-7`).
  - **Discovery-rate / recall guard** (counter overshadowing): a held-out set of **NOVEL entities NOT in the profile**; report pairwise + cluster precision/recall separately (beyond-F1) and new-entities-per-conversation profile-on vs profile-off. Entity-F1 must not rise on precision while NEW-entity recall falls.
  - **Canonicalization metric:** canonical-id accuracy / cluster purity (not just F1).
- **New probe splits (acceptance gates for the prior-handling design):**
  - **Staleness/Implicit-Conflict (STALE-style):** profile says X, conversation implies Y → measure State-Resolution + premise-resistance.
  - **Contradiction handling:** contradiction-detection precision/recall; correct invalidation vs wrong deletion of coexisting facts (the two MemFail modes).
  - **Poisoning blast radius:** inject one deliberately-wrong profile fact; measure how many downstream extractions it corrupts.
  - **Preferences/temporal slice** inspired by LongMemEval (largest gains for persistent-context systems).
- **Token-cost check:** measure prompt-token delta (must stay within the ~300–400-token profile budget).
- Guard the whole feature behind a setting so it can be A/B'd and shipped only on a paired win.

---

## 9. Constraints alignment

- **SQLCipher / key gap:** profile inherits AES-256 at rest, but the passphrase lives in `localStorage` (`db.ts:10-20`). Because the profile concentrates PII (aggregation risk), the Keystore-wrap fix is a **prerequisite/blocker** for shipping (recommended default below).
- **Hybrid default:** in cloud (default) mode, only `cloud-OK` + opt-in `cloud-OK-optin` fields serialize, pseudonymized; `on-device-only` never leaves the device. Canonicalization lets the cloud receive pseudonymized canonical IDs — reduces cloud PII vs today's raw-transcript extraction.
- **On-device models Phase 3/4 STOPPED:** the token-frugal retrieved-card scheme (<400 tokens) is exactly what on-device limits require, and it cuts cloud cost/latency now. It does not depend on on-device extraction; it is a prerequisite for any future on-device path.
- **Schema/provider fit:** storage = `your_context` JSON key in `settings` (zero migration); aliases in `entities.attrs` (zero migration). The proxy stays a thin OpenAI wrapper; the **client owns the prompt** (matches the `aiPrompts.ts:1` design note) — `buildContextCards`/`profileForCloud` run client-side.
- **Conflicts (explicitly flagged):**
  1. **Dual source-of-truth/drift** — evals grade backend Python (`extract-v1`, no speaker_names); app runs TS (`extract-v2`). Context grounding must land in `app.services.extraction`/`strategies.py` to be measurable.
  2. **PROMPT_VERSION must bump** v2→v3 in the same change (else corpus/eval comparability breaks). Persist the profile snapshot used on each training sample.
  3. **SCHEMA_VERSION ladder** forward-only — prefer the `settings` JSON to avoid touching it; if history is needed, `MIGRATIONS[3]` + bump `SCHEMA_VERSION=3` + the `createConnection` arg together.
  4. **Chat citation contract** — profile has no `conversation_id`; label non-citable and/or extend the schema in sync TS+Python.
  5. **Graph perf + false-merge** — keep 0.86, use the alias map, lazy seeding, brute-force O(n) scans are fine at on-device scale.

---

## 10. Open questions (with recommended defaults)

1. **Storage: `settings` JSON vs dedicated table?** → Default **`settings` JSON** (zero migration; profile is a single current snapshot). Use a table only if product wants editable profile history.
2. **PROMPT_VERSION bump on runtime injection?** → Default **bump to `extract-v3`** and persist the profile snapshot per sample (full reproducibility).
3. **Chat: label profile non-citable vs add `used_profile`/`flagged_contradictions`?** → Default **label non-citable** first (no schema change); add the schema fields only if eval shows the model hallucinating citations.
4. **Merge thresholds for profile-driven canonicalization?** → Default **HIGH 0.90 / LOW 0.80** with gray-band confirmation; keep generic `entity_sim_threshold=0.86` unchanged.
5. **Self-enrich auto-add threshold?** → Default **never auto-add**; one-tap confirm only (privacy-first; MemFail-safe). Suggest when an entity appears in ≥3 conversations or importance ≥ a tunable bar.
6. **Key fix scope before launch?** → Default **block launch on the Keystore-wrap fix** (`db.ts`) given the profile's PII density.
7. **Gold-set expansion owner/size?** → Default **expand to ≥50 stratified cases** before trusting the A/B delta.
8. **`profile_topn` / token budget?** → Default **k≈6–8, ~300–400 tokens** (mirrors `search_topn`, Memoria result).
9. **Per-project overlays in v1?** → Default **defer**; ship a global profile first, overlays in a follow-up (Claude per-Project is the target).

---

## 11. Risks + exact mitigations

| Risk | Exact mitigation |
|---|---|
| **Context poisoning / error amplification** (one bad prior re-asserted every conversation; amplified by `importance+0.05`/`weight+1.0`/`graphOverview` ordering) | Inject as **defeasible PRIORS** with override+flag instruction; **reinforcement firewall** (priors don't accrue importance/mention_count); **write-time contradiction check** before reinforcing; gate edges behind "mentioned in this conversation." |
| **Over-fitting / discovery suppression** (forcing "Farhan"→"Farha"; ER over-merge above 0.86) | Explicit **`links_to_profile: known\|new\|unsure`** NIL head; **stricter profile-merge bar (0.90)**; reversible merges (retain surface form + evidence); **discovery-rate + recall guard** in evals. |
| **Staleness / Implicit Conflict** (profile encodes a past state; nobody announces "I quit") | **`valid_from`/`valid_to`** per fact + invalidate-not-overwrite; **freshness decay** + scheduled re-confirmation; **Implicit-Conflict flag** at extraction → Conflict-detected card. |
| **Adding context lowers accuracy** ("Better Prompts Hurt" 100%→90%) | Ship **only on a paired A/B win** with no action-F1 regression; terse char-limited block; feature behind a setting. |
| **Token bloat / on-device exhaustion** | **Retrieved top-k cards, ~300–400-token hard budget**, never the whole profile; early placement; trim to essentials. |
| **PII concentration / cloud leak** | **Tiered `field_privacy`** (sensitive→on-device-only); `profileForCloud` minimized+pseudonymized projection; egress audit log; **Keystore-wrap the SQLCipher key** before launch. |
| **Corpus/eval incomparability** | **Bump PROMPT_VERSION v2→v3**; persist profile snapshot per sample; land grounding in the backend strategy graded by the gate. |
| **Graph perf regression from seeding** | **Lazy seeding** (canonicalize on first mention), not bulk pre-insert; alias map at the exact-match tier; keep 0.86. |
| **Silent destructive auto-edit** (MemFail) | **Never auto-edit the profile**; one-tap confirm + the NEW escape path; DELETE-as-invalidate, logged + reversible. |

---

## STOP — awaiting greenlight

This is a research-first design proposal. **No code is to be written and no files changed** until the user reviews and greenlights. Recommended pre-implementation gates before any build begins: (1) confirm storage = `settings` JSON; (2) commit to the PROMPT_VERSION v3 bump + backend-strategy A/B; (3) approve the Keystore-key fix as a launch blocker; (4) approve expanding the gold set to ≥50 cases. **Awaiting greenlight.**
