# Sutra — Phase 1 + Phase 2 Build

**On-device-first Android app · hybrid-cloud intelligence by default.**

Sutra is an ambient-memory app: it captures a spoken conversation, transcribes +
diarizes it, extracts structured memory (summary, facts, action items, decisions,
entities), builds a personal **knowledge graph**, and lets you **search** and **chat**
over your own memory with cited answers — with all derived data living **on-device in
an encrypted SQLite database**. The only thing that leaves the phone is text (and, in
the default Hybrid mode, audio in-flight to a transcription endpoint that never stores it).

This document describes exactly what Phases 1 and 2 built. Phases 3 and 4 (on-device
ASR/LLM/voiceprints) are a hard STOP and are described only as deferred scope.

---

## 0. The two privacy promises (never blur these)

The product makes exactly two audio promises, defined verbatim in
`frontend/src/providers/index.ts` (`MODE_COPY`). They must never be conflated:

| Mode | Label | Audio promise (verbatim) |
|------|-------|--------------------------|
| **Hybrid** (default) | "Hybrid (best accuracy)" | **"Audio is processed in the cloud and never stored."** |
| **On-device** (stub) | "On-device (max privacy)" | **"Audio never leaves your device."** |

- **Hybrid** is the shipping default. Audio is sent in-flight to the proxy's
  `/transcribe` endpoint and is never persisted anywhere (client or server).
- **On-device** is user-selectable but is currently a **stub** (`OnDeviceProvider`
  throws "not installed yet"). When real on-device models land in Phase 3/4, the
  "audio never leaves your device" promise becomes literally true for that mode.

Mixing these two strings (e.g. claiming "never leaves your device" while in Hybrid)
would be a privacy misrepresentation. Keep them distinct.

---

## 1. Architecture as built

```
 Android device (Capacitor WebView, React 19 + Vite PWA)
   ┌─────────────────────────────────────────────────────────────────┐
   │  CaptureController (frontend/src/lib/capture.ts)                  │
   │    getUserMedia → MediaRecorder (webm/opus) + AnalyserNode RMS VAD│
   │    → silence/maxlen-bounded windows (in-memory Blob only)         │
   │    ForegroundMic.start()  ── JS bridge ──┐                        │
   └──────────────────────────────────────────┼────────────────────────┘
                                               ▼
   MicForegroundService (type=microphone) keeps the mic alive screen-off
                                               │  window Blob
                                               ▼
   provider (default = CloudProvider) ── multipart POST ──▶ Sutra Proxy :8787
                                               │                 │ /transcribe ONLY (audio in-flight)
                                               │                 │ holds OUR OpenAI key server-side
                                               ▼                 ▼
   ingest.ts: persist diarized turns      OpenAI /v1/audio/transcriptions
   (audio Blob discarded, never stored)   (gpt-4o-transcribe-diarize, diarized_json)
                                               │
                                               ▼
   ┌─────────────────── On-device SQLite + SQLCipher (the system of record) ──────┐
   │  segmentation → conversations                                                │
   │  extraction (proxy /extract, text-only) → memories + action_items           │
   │  graph upsert (entities + bi-temporal edges + evidence) → knowledge graph   │
   │  embeddings (proxy /embed, text-only) → BLOB Float32 on memories/entities   │
   │                                                                             │
   │  Search : brute-force cosine KNN ∪ FTS5 BM25 → RRF(k=60) → recency × imp.   │
   │  Chat   : hybrid seed → recursive-CTE graph expand → grounded cited answer  │
   │  Recap  : per-day rollup (local notification; email optional)               │
   └─────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 App shell — React 19 + Vite + Capacitor

- The UI is a **React 19 + Vite + TypeScript PWA**, packaged for Android via
  **Capacitor** (`frontend/capacitor.config.ts`: `appId: app.sutra.memory`,
  `appName: Sutra`, `webDir: dist`). The CapacitorSQLite plugin is configured with
  `androidIsEncryption: true` (SQLCipher on device).
- The app's data surface is a local-first facade `frontend/src/local/sutra.ts`
  (`api.*`) that mirrors what used to be a REST client; pages call it and everything
  runs on-device except provider (cloud) calls. The active mode is read from settings
  (`mode`, default `hybrid`).

### 1.2 Microphone foreground service (screen-off capture)

A custom native Capacitor plugin keeps the mic alive while the screen is off — the
PWA limitation (Android Chrome mutes background tab capture) is solved by running the
real capture inside a native foreground service.

- `frontend/android/app/src/main/java/app/sutra/memory/MicForegroundService.java` —
  a `Service` started with `foregroundServiceType=microphone`. It posts an **ongoing
  low-priority notification** ("Sutra is listening", text "Recording this conversation
  · audio is never stored") and returns `START_STICKY`.
- `ForegroundMicPlugin.java` — `@CapacitorPlugin(name="ForegroundMic")` exposing
  `start()`/`stop()` that `startForegroundService` / `stopService` the service.
- `MainActivity.java` registers the plugin in `onCreate`.
- `frontend/src/lib/foregroundMic.ts` — JS wrapper; **no-op on web/iOS**, only calls
  the native plugin when `Capacitor.getPlatform() === "android"`.
- `CaptureController` (`frontend/src/lib/capture.ts`) calls `ForegroundMic.start()`
  on `start()` and `ForegroundMic.stop()` on `stop()`. One `getUserMedia` stream feeds
  both the `MediaRecorder` (the bytes uploaded) and an `AnalyserNode` RMS VAD (hysteresis
  thresholds hi=0.022 / lo=0.012) that bounds windows by trailing silence (`silenceMs`
  default 1200), a min-speech floor (700ms), and a hard cap (`maxSeconds` 150). Each
  window is a complete webm/opus Blob; long silent windows roll over without uploading.
  **Audio lives only in memory** and is handed to `onWindow`; nothing is stored client-side.
- `AndroidManifest.xml` declares: `RECORD_AUDIO`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`, `INTERNET`, and the
  `MicForegroundService` (`android:foregroundServiceType="microphone"`).

### 1.3 On-device SQLite + SQLCipher schema

`frontend/src/local/db.ts` opens the DB via `@capacitor-community/sqlite`. On device
the connection is **encrypted (SQLCipher)**; on web it falls back to an unencrypted
dev-only store (`initWebStore`). The SQLCipher passphrase is currently sourced from a
locally-persisted random key (`getSecret`), with a `TODO(prod)` to move it to the
Android Keystore via a secure-storage plugin. Migrations are versioned via
`PRAGMA user_version`; `SCHEMA_VERSION = 2`.

Schema is in `frontend/src/local/schema.ts` (a faithful port of the Postgres schema).

| Table | Purpose |
|-------|---------|
| `people` | identities; `is_me`, `provisional`, reserved `voiceprint` BLOB + `voiceprint_dim` (Phase 3) |
| `sessions` | a recording session (status active/closed) |
| `turns` | diarized utterances (`session_speaker_label`, `person_id`, `text`, `lang`, timestamps, `conversation_id`, `redacted`) |
| `conversations` | segmented conversations (participants as JSON array) |
| `memories` | per-conversation extraction: `summary`, `facts`, `action_items`, `decisions`, `importance`, `type_tags`, embedding |
| `entities` | resolved graph nodes (`type`, `canonical_name`, `norm_name`, `attrs`, embedding, `mention_count`) |
| `edges` | typed relations between entities (bi-temporal) |
| `action_items` | extracted tasks (`owner`, `status`, `due`, `generated_draft`) |
| `daily_rollups` | per-day recap (summary, highlights, open actions) |
| `settings` | single-row JSON settings blob |

Key representation decisions (driven by the SQLite port of pgvector/jsonb):

- **Embeddings as BLOB.** `pgvector vector(N)` → `embedding BLOB` storing a **Float32**
  array, plus `embed_model` and `embed_dim` columns. Conversion helpers `vecToBlob` /
  `blobToVec` in `frontend/src/local/util.ts` round-trip `Float32Array ↔ Uint8Array`.
- **jsonb → TEXT (JSON1).** All JSON columns are `TEXT` and queried with SQLite's JSON1
  functions (`json_each`, `json_insert`, `json_array_length`). Arrays (facts, action_items,
  type_tags, participant ids, evidence) are JSON text.
- **Bi-temporal edges.** `edges` carries `valid_from`, `valid_to`, **and**
  `ingested_at` (default `datetime('now')`), baked in from day one so a fact's validity
  window is independent of when it was recorded. `upsertEdge` updates `valid_to` and
  appends evidence on conflict; an index on `valid_to` supports temporal queries.
- **FTS mirror.** `memories_fts` is a contentless **FTS5** virtual table
  (`content=''`, `tokenize='unicode61 remove_diacritics 2'`) whose `rowid` = `memories.id`,
  maintained by the repo (`upsertMemory` deletes + re-inserts the FTS row).

### 1.4 Retrieval (hybrid)

`frontend/src/local/search.ts` ports the documented ranking formula exactly:

1. **Semantic** — embed the query (`provider.embed`), then **brute-force cosine KNN**
   over all memory embeddings loaded from SQLite (`memoriesForSearch` → `cosine` per row),
   keep top `search_prefetch` (default 30).
2. **Lexical** — **FTS5 BM25**: `SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?
   ORDER BY bm25(memories_fts)`. Query is tokenized to word/Devanagari tokens.
3. **Fuse** — **Reciprocal Rank Fusion, k=60** (`rrf += 1/(k + rank + 1)`) across the
   two lists (fuse on rank, never blend raw cosine and BM25 scales).
4. **Recency decay** — `0.5 ^ (age_days / half_life)`, `rank_half_life_days` default 30.
5. **Importance** — `score = w_rrf · norm(rrf) · recency · (1 + w_imp · importance)`,
   `rank_w_rrf` 1.0, `rank_w_importance` 0.5.
6. Optional **rerank** (`rerank: "llm"`) re-scores the head via `provider.rerank`;
   default OFF, falls back to fused order on error.

> **Note on the vector index.** The current implementation is **brute-force cosine in
> TypeScript** (load all embeddings, score each). This is correct and fine at single-user
> scale. The documented later optimization is **sqlite-vec** (an ANN index extension);
> swapping it in changes only the candidate-fetch step, not the formula.

### 1.5 Knowledge graph

`frontend/src/local/graph.ts` runs the full graph engine in on-device SQLite:

- **Entity resolution** — `upsertEntity` first tries an exact `(type, norm_name)` match
  (bumping `mention_count` + `importance`), then falls back to **embedding cosine
  similarity** against same-type entities, accepting a merge at `entity_sim_threshold`
  (default 0.86); otherwise inserts a new node.
- **Bi-temporal typed edges** — `upsertEdge` inserts `(src, dst, relation)` with
  `valid_from`/`valid_to` and JSON evidence (conversation + turn ids), incrementing
  weight and appending evidence on conflict.
- **Bidirectional recursive-CTE traversal** — `expand()` runs a `WITH RECURSIVE`
  query that walks edges in **both directions** (`src→dst` or `dst→src`) up to `hops`
  (capped at 3), then returns the induced subgraph (nodes + edges). `graphOverview()`
  seeds from the most-mentioned entities; `nearestEntities()` does cosine KNN over
  entity embeddings to seed graph-RAG chat (`frontend/src/local/chat.ts`).

### 1.6 The thin stateless proxy

`backend/app/proxy.py` (FastAPI, **port 8787**) is the only server component on the
product path. It is **stateless: no database, no user data persisted.**

- **`/transcribe` is the ONLY audio endpoint.** It reads the upload into memory
  (`await file.read()` — "in-flight ONLY, never persisted"), forwards to OpenAI, and
  `del audio` in a `finally`. The other four endpoints are **text-only**:
  `/extract`, `/embed`, `/rerank`, `/chat`.
- It **holds OUR OpenAI key server-side** (via `OpenAIProvider`, `backend/app/config.py`)
  so the app works out-of-the-box with zero key friction.
- **Usage-metering hook** — `_meter(user, kind)` increments an in-memory per-user
  counter (a placeholder for a future buy-once / fair-use credit model); `/usage`
  exposes it. Not durable yet.
- **BYO-key is scaffolded but OFF by default** — `_provider(byo_key)` uses a client-
  supplied `X-OpenAI-Key` header for that single request if present, otherwise the
  server key. It is an optional power-user/enterprise path, not in the default flow.

`backend/app/providers/openai_provider.py` calls OpenAI's REST API via `httpx`:
`gpt-4o-transcribe-diarize` (`response_format=diarized_json`, `chunking_strategy=auto`
with a retry-without-chunking fallback for short clips), `gpt-5.4-mini` extraction
(Structured Outputs / `json_schema`), `text-embedding-3-large` @1536 dims, and a
`gpt-5.4-nano` LLM rerank.

### 1.7 Provider abstraction

`frontend/src/providers/provider.ts` is a **TS mirror of `backend/app/providers/base.py`** —
the seam between cloud and on-device. The `Provider` interface has five methods;
`transcribeDiarize` is documented as **the only method that ever receives audio**
(in-flight only); `extract`/`embed`/`rerank`/`chat` are text-only.

- `CloudProvider` (`cloudProvider.ts`) — the **default (= Hybrid)**. Posts audio to
  `/transcribe` (multipart) and JSON to the four text endpoints on the proxy
  (`VITE_PROXY_URL`, default `http://localhost:8787`).
- `OnDeviceProvider` (`ondeviceProvider.ts`) — a **STUB**. Every method throws
  "On-device intelligence is not installed yet (max-privacy mode is Phase 3/4)."
- `frontend/src/providers/index.ts` `getProvider(mode)` returns the cloud provider for
  `hybrid` (default) and the stub for `ondevice`.

---

## 2. Data-capture / training schema

Schema v2 (`frontend/src/local/schema.ts`) adds an **opt-in, on-device, encrypted
fine-tuning corpus**, separate from app data and **never auto-uploaded**. Logic is in
`frontend/src/local/training.ts`.

### 2.1 Tables

| Table | Contents |
|-------|----------|
| `training_samples` | one row per captured sample: `source`, `lang`, `consent_version`, `redacted`, `has_audio`, **`model_id`**, **`prompt_version`**, `conversation_id`, `transcript` |
| `training_extraction` | `extraction_raw` (model output) + `extraction_corrected` (user-edited gold) |
| `training_asr` | `asr_raw`, `asr_corrected`, `diarization` (audio tier) |
| `training_audio` | `audio` BLOB + `mime` (audio tier; encrypted on-device via SQLCipher) |
| `training_edits` | append-only edit log: `field`, `before`, `after`, `ts` |

### 2.2 Two consent tiers

- **Text tier (default opt-in)** — `training_optin`. Captures extraction transcripts +
  raw model outputs + user corrections (`captureExtraction`).
- **Audio tier (stronger, separate opt-in)** — `training_audio_optin`. Additionally
  stores the **audio bytes + transcript** for ASR fine-tuning (`captureAudio`). The
  audio sits encrypted on-device (SQLCipher); it is never uploaded automatically.

### 2.3 Corpus versioning, language tag, edit-logging

- Every sample is stamped with **`model_id`** (the model that produced it) and
  **`prompt_version`** (`PROMPT_VERSION = "extract-v1"`) plus a **`lang`** tag — so the
  corpus is reproducible and filterable by model/prompt/language.
- **Edits become gold labels.** `logEdit` appends to `training_edits` and writes the
  corrected value into `extraction_corrected` / `asr_corrected`. Export prefers the
  corrected value over the raw output.

### 2.4 JSONL export (two formats)

`exportJSONL(kind)`:

- **extraction** → SFT messages format: `{messages:[{role:system,content:EXTRACT_SYSTEM},
  {role:user,content:transcript},{role:assistant,content:corrected||raw}]}`.
- **asr** → audio/text format: `{audio_base64, mime, text:(corrected||raw), lang}`.

### 2.5 User controls + DPDP consent versioning

- **View / export / clear** — `stats()` (sample/audio/edit counts), `exportJSONL`, and
  `wipe()` (removes all rows from every `training_*` table; user-initiated only).
- **DPDP consent versioning** — `CONSENT_VERSION = "dpdp-v1"` is stored on every sample
  and in settings (`training_consent_version`) when a tier is toggled, so consent is
  auditable and re-promptable when the version changes.

### 2.6 Recommendation — held-out split

Keep a strict **held-out split between the training corpus and the eval gold set** so a
model is never evaluated on data it was trained on. The eval gold lives in `evals/gold/`
(curated, hand-labeled); training samples live in the on-device `training_*` tables.
Before fine-tuning, partition by sample id (or by conversation) and never let an eval
gold conversation enter the training export — otherwise the Hinglish gate (§3) would be
measuring memorization, not generalization.

---

## 3. Eval harness

`evals/` is the quality guardrail. It runs gold conversations through the **same provider
+ extraction prompt + JSON schema the app uses** and reports metrics **OVERALL** and for
the **Hinglish (`hi-en`) subset** separately.

### 3.1 How to run it

```bash
docker compose up -d proxy   # or the full stack; the harness needs the OpenAI key in .env

docker compose -f docker-compose.yml -f docker-compose.dev.yml exec backend \
  pip install -q -r evals/requirements.txt
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec -w /app backend \
  python -m evals.run
```

Results (with `model_id` + `prompt_version` for corpus versioning) are written to
`evals/results/<provider>-<model>-<timestamp>.json`.

### 3.2 Gold schema

One JSON object per line in `gold/*.jsonl` (`evals/gold/seed.jsonl` ships 6 samples,
5 hi-en + 1 en):

```json
{"id":"college-hien","lang":"hi-en","audio":null,
 "transcript":[{"speaker":"Me","text":"..."}],
 "expected":{"entities":[{"name":"Ashoka University","type":"org"}],
             "action_items":[{"text":"...","owner":"Me"}],
             "decisions":["..."],"summary_points":["..."]}}
```

- `lang` (`hi`|`en`|`hi-en`) drives the subset split.
- `audio` is optional; when present it enables WER/CER (ASR) via `jiwer`.
- Metrics (`evals/metrics.py`): greedy fuzzy-matched precision/recall/F1 for entities
  (`token_set_ratio ≥ 85`) and action items (`≥ 70`), Hinglish-aware normalization
  (keeps word chars + Devanagari, drops punctuation), and `wer_cer`.

### 3.3 Cloud baseline numbers

From `evals/results/openai-gpt-5.4-mini-20260602-054150.json` (extract `gpt-5.4-mini`,
prompt `extract-v1`, 6 samples):

| Subset | n | action-item F1 | action P / R | entity F1 |
|--------|---|----------------|--------------|-----------|
| **OVERALL** | 6 | **0.976** | 0.958 / 1.0 | 0.691 |
| **Hinglish (hi-en)** | 5 | **0.971** | 0.95 / 1.0 | **0.709** |
| English (en) | 1 | 1.0 | 1.0 / 1.0 | 0.600 |

(CER/WER are `null` here because the seed gold is extraction-only — no `audio`.)

### 3.4 The on-device gate (HARD RULE)

An on-device model becomes a **default only if, on the `hi-en` subset specifically**:

- **action-item F1 ≥ 0.874** ( = **0.90 × 0.971**, 90% of the cloud Hinglish baseline ),
  **AND**
- **CER ≤ 1.2 ×** the cloud CER baseline.

This is enforced as a documented rule in `evals/run.py` and `evals/README.md`. Re-run
the harness for every candidate model and compare against the stored cloud baseline.

---

## 4. Phase 3 / 4 — hard STOP (deferred)

Phases 3 and 4 are **not built**. They are intentionally out of scope for this milestone:

- **On-device ASR + diarization** via **sherpa-onnx**.
- **On-device LLM** (**Gemma 3n**) for extraction/chat.
- **On-device embeddings** (**EmbeddingGemma**).
- **Automatic speaker voiceprints** (**ECAPA-TDNN**). Today speaker identity is the
  per-call diarization label plus **manual "this is me" labeling** (`people.ts`,
  `ingest.ts`); the `people.voiceprint` BLOB column is reserved but unused.

Until then:

- **`OnDeviceProvider` stays a stub** — selecting On-device mode reports unavailability.
- **The "Audio never leaves your device" promise** only becomes literally true for
  On-device mode when these models ship.
- **Every future model must clear the Hinglish gate (§3.4)** before it can become a
  default. No on-device model is promoted on vibes — only on `hi-en` action-item F1 ≥
  0.874 and CER ≤ 1.2× cloud.

---

## 5. Exact run steps

### 5.1 Start the proxy (intelligence backend)

```bash
# from repo root; needs OPENAI_API_KEY in .env
docker compose up -d proxy        # Sutra proxy on :8787 (stateless; /transcribe + 4 text endpoints)
curl -s http://localhost:8787/health
```

### 5.2 Build and sync the PWA into the Android project

```bash
cd frontend
npm install                       # first time
npm run build                     # produces dist/
npx cap sync android              # copies dist/ + native plugins into android/
```

> If running on a physical device, point the app at a reachable proxy via
> `VITE_PROXY_URL` (e.g. a LAN IP or tunnel) before `npm run build` — `localhost`
> resolves to the device itself.

### 5.3 Run on a device

```bash
cd frontend
npx cap run android               # build + install + launch on a connected device/emulator
```

Or install the prebuilt debug APK directly:

```bash
adb install -r frontend/android/app/build/outputs/apk/debug/app-debug.apk
```

(That APK path already exists in the tree from a prior debug build.)

---

## 6. Known — not yet validated

These are honest gaps where the code is written but has not been confirmed on real
hardware. None of them are on the failure path for the product (native uses real SQLite):

1. **Native SQLite runtime on a physical device.** The SQLCipher-encrypted DB open
   path (`db.ts`) is implemented but has not been exercised end-to-end on a physical
   Android phone (key provisioning, migrations, encrypted reads/writes under load).
2. **Background mic capture on a physical phone.** The `MicForegroundService` +
   `CaptureController` screen-off path is implemented but unverified on real hardware
   (OEM background restrictions, doze, notification permission behavior vary by device).
3. **Web SQLite fallback (dev only).** The browser store relies on
   **jeep-sqlite ↔ sql.js wasm** version pairing, which is **currently mismatched**, so
   the web dev fallback may not open. This does **not** affect the product path: native
   Android uses real SQLite via `@capacitor-community/sqlite`, so the web store is a
   dev convenience only.

---

## Appendix — key file map

| Area | Files |
|------|-------|
| App shell / Capacitor | `frontend/capacitor.config.ts`, `frontend/src/local/sutra.ts` |
| Foreground mic | `frontend/android/.../MicForegroundService.java`, `ForegroundMicPlugin.java`, `MainActivity.java`, `frontend/android/.../AndroidManifest.xml`, `frontend/src/lib/foregroundMic.ts`, `frontend/src/lib/capture.ts` |
| Local DB / schema | `frontend/src/local/schema.ts`, `db.ts`, `repo.ts`, `util.ts` |
| Retrieval / graph / chat | `frontend/src/local/search.ts`, `graph.ts`, `chat.ts`, `ingest.ts`, `segmentation.ts`, `extraction.ts`, `recap.ts`, `people.ts` |
| Training corpus | `frontend/src/local/training.ts` |
| Providers | `frontend/src/providers/provider.ts`, `cloudProvider.ts`, `ondeviceProvider.ts`, `index.ts` |
| Proxy / cloud | `backend/app/proxy.py`, `backend/app/providers/openai_provider.py`, `backend/app/config.py` |
| Evals | `evals/run.py`, `metrics.py`, `README.md`, `gold/seed.jsonl`, `results/` |
| Research / rubric | `docs/M0-research-and-plan.md`, `docs/PERFECTION-RUBRIC.md`, `README.md` |
