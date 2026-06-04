# Sutra — M0: Research Findings, Decisions & Build Plan

**Date:** 2026-06-01 · **Status:** M0 (research + plan, no code yet) · **Audience:** you, before I touch any code.

All `[VERIFY]` items from the brief were checked against **primary docs this session** (OpenAI's docs now live at `developers.openai.com`; `platform.openai.com` 301-redirects there). The two claims the whole stack depends on — the diarization model and the reasoning/embedding models — went through a second adversarial fact-checker that tried to refute each concrete id/param/limit and **could not**. Confidence is labelled per finding: `verified` (confirmed from a primary doc this session), `likely` (strong secondary), `uncertain` (memory only).

---

## 0. TL;DR — what changed vs. the brief

1. **🔴 Model lineup moved on.** GPT-4o / o-series are now **legacy**. Current frontier is **GPT-5.5 / GPT-5.4** (1.05M context). For Sutra I recommend **`gpt-5.4-mini`** for extraction, **`gpt-5.4-nano`** for rerank (it's literally documented "for… ranking"), and **`text-embedding-3-large`** for embeddings. All swappable in `.env`.
2. **🟢 `gpt-4o-transcribe-diarize` is real & GA**, exactly as the brief hoped — `response_format: "diarized_json"`, `chunking_strategy: "auto"` required >30s, segment schema confirmed. It accepts **webm/opus directly → no server-side transcode needed**. It is **not** in the Realtime API → batch-per-window is the only path (no live diarized streaming).
3. **🟡 pgvector can't HNSW-index 3072 dims** (vector type caps at 2000). Two fixes: reduce embeddings to **1536** (default) or store **`halfvec(3072)`** (indexable to 4000, half the storage). I'll default to 1536-reduced.
4. **🔴 Background mic capture is impossible in a PWA.** Confirmed from the W3C spec: Android Chrome mutes capture tracks when the tab isn't visible; Screen Wake Lock keeps only the *screen* on, not the CPU/audio. Foreground-only is the honest MVP boundary; true always-on needs the future native app.
5. **🟡 Phone testing needs HTTPS.** `getUserMedia` requires a secure context — a plain `http://<lan-ip>` URL will **not** grant mic on your phone. Plan a tunnel (cloudflared) or real TLS.
6. **Speaker identity:** manual one-tap labeling is the right MVP call. Bonus: OpenAI's own `known_speaker_references` (≤4, 2–10s clips) can pin **"me"** stably across windows without any voiceprint library.

---

## 1. Verified findings per `[VERIFY]`

### 1.1 OpenAI STT + diarization — `verified` (adversarially re-confirmed)

- **Model id:** `gpt-4o-transcribe-diarize`, **GA**, served by **`POST /v1/audio/transcriptions`** only. Context 16k, max output 2k, cutoff 2024-06-01. **Pricing $2.50/1M audio-input, $10.00/1M output tokens.**
- **Request:** `response_format="diarized_json"`; **`chunking_strategy="auto"` is *required* when audio >30s** (omitting it errors, or silently truncates to ~32s — a known footgun). `chunking_strategy` may instead be a VAD config object (`server_vad`, `prefix_padding_ms`, `silence_duration_ms`, `threshold`).
- **Unsupported:** `prompt`, `logprobs`/`include`, `timestamp_granularities[]`. Don't send them.
- **Response shape (confirmed against API reference):**
  ```jsonc
  { "task": "transcribe", "duration": 123.4, "text": "full transcript…",
    "segments": [
      { "type": "transcript.text.segment", "id": "…", "speaker": "A",
        "start": 0.0, "end": 4.2, "text": "…" }
    ],
    "usage": { … } }
  ```
  Speaker labels are `A`, `B`, `C…` **and are only consistent within one API call.** Speaker info exists *only* in `diarized_json`.
- **Formats:** endpoint accepts `flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm` → **browser webm/opus uploads as-is.** Max upload **25 MB**.
- **Known-speaker pinning:** up to **4** paired `known_speaker_names[]` + `known_speaker_references[]` (2–10s reference clips, as data URLs) make the `speaker` field use your names instead of A/B/C.
- **No streaming / not in Realtime API** for diarize → buffer a window, then POST it.
- **Fallback `whisper-1`:** supports word/segment `timestamp_granularities[]` but **no diarization** (and no streaming).
- *Open:* exact max **duration** per call isn't in primary docs (community: ~1400s/~23min `likely`); the binding limit is 25 MB, which a 5-min opus clip is comfortably under.

### 1.2 Reasoning/extraction + embeddings — `verified` (adversarially re-confirmed)

| Role | Model | Price /1M (in / out) | Context | Notes |
|---|---|---|---|---|
| **Extraction** (default) | `gpt-5.4-mini` | $0.75 / $4.50 | 400k | Structured Outputs (json_schema strict) + function calling ✓ |
| Extraction (upgrade) | `gpt-5.4` / `gpt-5.5` | $2.50/$15 · $5/$30 | 1.05M | for hard transcripts only |
| **Rerank** (cheap) | `gpt-5.4-nano` | $0.20 / $1.25 | 400k | docs: "classification, data extraction, **ranking**, sub-agents" |
| **Embeddings** | `text-embedding-3-large` | ~$0.13 /1M | — | native **3072**, `dimensions` param reduces to 1536/1024/256 |

- Structured Outputs (`response_format: json_schema`, `strict:true`) is **Supported on all GPT-5.x tiers** and composes with tool calling — confirmed on each model page. This is how extraction will be made reliable.
- Embeddings: a 3-large vector shortened to 256 still beats `ada-002`@1536 on MTEB, so **1536 retains near-full quality** while halving index size. No `text-embedding-4` exists yet.
- *Minor:* GPT-5.x context is exactly **1,050,000**; `gpt-5.5-pro` ($30/$180) exists for the hardest cases (not needed here).

### 1.3 Browser → server audio path — `verified`/`likely`

- **MediaRecorder on Android Chrome → `audio/webm;codecs=opus`.** Feature-detect with `MediaRecorder.isTypeSupported(...)`, set as `mimeType`, read back `recorder.mimeType`, and wrap `.start()` in try/catch (a `true` from isTypeSupported isn't a guarantee) with fallback to `'audio/webm'`.
- **No ffmpeg transcode required** — webm is natively accepted. Keep ffmpeg only as an optional shrink/normalize step or for a future iOS (mp4/aac) client.
- **Transport:** one **multipart HTTPS POST per VAD-bounded window** (retryable, survives backgrounding/network drops) rather than a long-lived socket — because diarize is request/response. *(A WebSocket is only justified if we add the provisional-live captions stretch, which uses a separate non-diarized stream.)*
- **Windowing:** ~2–5 min, silence-bounded windows; one diarize call each; let `chunking_strategy:"auto"` sub-segment within. **Never** slice into many <30s chunks and concatenate speaker numbers — labels would scramble.

### 1.4 Browser VAD — `verified` → **`@ricky0123/vad-web`**

- Actively maintained (v0.0.30, ~147k weekly downloads, repo pushed 2026-01-30). Runs **Silero VAD** ONNX via onnxruntime-web in an AudioWorklet; emits `onSpeechStart` / `onSpeechEnd(audio)` / `onVADMisfire`.
- Cost: ~69 KB JS + **~1.8 MB** `silero_vad_legacy.onnx` (default) + onnxruntime-web WASM — all loaded separately. **Lazy-load + cache in the service worker** so it's a one-time cost; call `release()` on teardown (a Nov-2025 leak fix).
- Tunable silence gap via **`redemptionMs`** (default 1400; drop to ~600–900 for snappier window cuts), `minSpeechMs` (400) to reject blips.
- Alternatives rejected: a Web Audio **RMS energy gate** is near-free but noise-naive/unreliable (keep only as a flagged fallback); the **Web Speech API** is a cloud-ish recognizer, not a clean VAD primitive.

### 1.5 Speaker identity — `verified` → **manual labeling for MVP**

- OpenAI diarization already separates speakers *within* a call; the only gap is *cross-session* identity. Auto voiceprint adds PyTorch (hundreds of MB), enrollment UX, threshold tuning, and false-match modes — **not worth it for a single-user weekend MVP.**
- **MVP:** one-tap UI to map each session's `A/B/C…` to names ("this is me", "Amartya"). Reliably tagging **"me"** is the priority everything downstream depends on.
- **Cheap cross-window stability (recommended add):** pass `known_speaker_references` for "me" so the owner stays labelled consistently across windows — no extra library.
- **Stretch (documented, not built):** SpeechBrain **ECAPA-TDNN** (`speechbrain/spkrec-ecapa-voxceleb`, 0.80% EER, Apache-2.0, not HF-gated, 192-dim, CPU-feasible). Embed in-flight from the audio buffer, store only the 192-float vector (pgvector `vector(192)`), match by cosine; start threshold **≥0.75 similarity** to accept same-speaker, **<0.65** → new/unknown, calibrate on your own voice. (Avoid Resemblyzer — lightly maintained; avoid pyannote here — HF-gated.)

### 1.6 pgvector + hybrid ranking — `verified`/`likely`

- **HNSW:** `WITH (m=16, ef_construction=64)` (defaults are well-tuned at thousands-of-vectors scale); raise query-time `SET hnsw.ef_search = 100` for recall.
- **Dim limit:** `vector` HNSW caps at **2000 dims** → 3072 can't be indexed as a plain vector. **Default: reduce to `vector(1536)`** + `vector_cosine_ops`. **Upgrade path:** keep 3072 as `halfvec` — `CREATE INDEX … USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)` (indexable to 4000, half storage).
- **Operators:** cosine via `<=>` + `vector_cosine_ops`.
- **Hybrid fusion:** two prefetch CTEs — semantic (`ORDER BY embedding <=> q`) and lexical (`ts_rank` over a GIN-indexed `tsvector`, `websearch_to_tsquery`) — each with `ROW_NUMBER()` rank, `LIMIT ~20–50`, fused by **RRF, k=60**: `score = Σ 1/(60 + rank)`. **Fuse on rank, never blend raw `ts_rank` and cosine** (incompatible scales).
- **Rerank:** make it a toggle, **default OFF** (RRF is strong). ON → local cross-encoder **`BAAI/bge-reranker-base`** re-scoring top-~20 (self-hosted, no per-call cost, predictable on a VPS). Optional `llm` mode via `gpt-5.4-nano` for hard/ambiguous queries.

### 1.7 Frontend — `verified` (constraints) / `likely` (stack picks)

- **Stack:** **React 19 + Vite + TypeScript**, installable via **`vite-plugin-pwa`** (Workbox). Simplest fit for a client-heavy app whose only server is FastAPI; serves onnxruntime-web WASM cleanly. (Next.js SSR adds friction for no payoff here.)
- **UI:** **Tailwind + shadcn/ui**, "calm dark" design language — near-black surfaces, one restrained accent, Inter/Geist + a mono for transcript timestamps; ~720px reading column; bottom tab nav with 44px targets + safe-area insets; 150–250ms ease-out motion, a live mic pulse, `prefers-reduced-motion` respected.
- **Graph viz:** **Sigma.js** (graphology + WebGL, ForceAtlas2 in a WebWorker) for scale/mobile; `react-force-graph` as the faster-to-wire small-graph alternative.
- **🔴 Capture reality (verified from W3C/MDN/Chrome docs):** foreground capture works fine under HTTPS; **backgrounding the tab or turning the screen off mutes the mic** (UA-controlled), and Wake Lock only keeps the screen lit and auto-releases on backgrounding. → **Foreground-only MVP**, with an explicit "recording / paused" state and an honest note that always-on needs a native foreground-service app.

---

## 2. Decisions (LOCKED 2026-06-01)

> **Confirmed by user:** model tier = **GPT-5.4 mini/nano** (D2/D3); live UX = **batch-per-window only** (D6, no provisional-live stretch); speaker identity = **full auto voiceprint / ECAPA** (D7, upgraded from manual); phone access = **cloudflared quick tunnel** (D11).

| # | Decision | Choice |
|---|---|---|
| D1 | STT/diarize | `gpt-4o-transcribe-diarize`, `diarized_json`, `chunking_strategy:"auto"`, webm uploaded as-is, batch-per-window |
| D2 | Extraction model | `gpt-5.4-mini` + Structured Outputs (json_schema strict) |
| D3 | Rerank model (when on) | `gpt-5.4-nano` (or local `bge-reranker-base`) |
| D4 | Embeddings | `text-embedding-3-large`, `dimensions=1536`, pgvector `vector(1536)` HNSW cosine |
| D5 | VAD | `@ricky0123/vad-web` (Silero, legacy model), lazy-loaded + SW-cached |
| D6 | Transport / live UX | multipart HTTPS POST per window; **batch-per-window** diarized turns (no provisional-live WebSocket path) |
| D7 | **Speaker identity (auto)** | **SpeechBrain ECAPA-TDNN** (`spkrec-ecapa-voxceleb`, 192-dim) — embed each speaker in-flight, cosine-match to enrolled `people` (accept ≥0.75, new <0.65); one-tap manual override + enrollment UI. **Requires server-side audio decode (ffmpeg/torchaudio) → embed → discard.** Optionally also pass `known_speaker_references` for "me". |
| D8 | Frontend | React+Vite+TS PWA, Tailwind+shadcn, Sigma.js graph |
| D9 | Graph store | labeled property graph in Postgres (`entities`+`edges`), recursive CTE traversal — no separate graph DB |
| D10 | Rerank default | OFF (toggle: `off`/`crossencoder`/`llm`) |
| D11 | Deploy | `docker-compose` (pgvector + FastAPI + built PWA); phone access via **cloudflared quick tunnel** (HTTPS) |

**Consequence of D7:** ffmpeg becomes a **required** backend dependency (decode webm→PCM for embedding, in-memory only), and the image carries PyTorch + SpeechBrain. Voiceprint enrollment + auto-matching move into **M1's ingest path** (person resolution at ingest), with manual override when match confidence is low.

## 3. Proposed architecture

```
 Android Chrome PWA  (foreground, HTTPS, mic granted, wake-lock held)
   getUserMedia → AudioWorklet → @ricky0123/vad-web (Silero)
     │  onSpeechStart → "recording" ;  onSpeechEnd / 2–5min cap → close window
     ▼
   window Blob (webm/opus)  ──multipart POST──▶  FastAPI
                                                  │ forward bytes → OpenAI /v1/audio/transcriptions
                                                  │   (gpt-4o-transcribe-diarize, diarized_json, chunking=auto)
                                                  │ ◀ segments[] → persist turns (audio discarded immediately)
                                                  ▼
   Postgres + pgvector ── conversations ◀ segmentation (gap + topic-shift)
                          memories      ◀ extraction (gpt-5.4-mini, json_schema): summary, facts,
                                            action_items, decisions, entities, importance_score
                          entities/edges ◀ graph upsert + entity resolution (name-norm + embedding sim)
                          embeddings     ◀ text-embedding-3-large@1536
     │
     ├─ Search: semantic(<=>) + lexical(ts_rank) → RRF(k=60) → recency×importance → [rerank?]
     ├─ Chat (graph-RAG): hybrid seed → expand 1–2 hops along edges → answer w/ citations (conv + date)
     └─ Daily recap: scheduled job → per-day rollup → SMTP email
```

**Privacy invariant (enforced & tested):** no audio column anywhere; the window Blob lives only in memory during the OpenAI call and is freed immediately. Consent Mode drops/redacts turns from unknown speakers before persistence.

## 4. Ranking formula (documented per brief §7)

```
candidates = semantic_topK(cosine) ∪ lexical_topK(ts_rank)         # K ≈ 20–50 each
rrf(d)     = Σ_lists 1 / (60 + rank_list(d))                       # Reciprocal Rank Fusion
recency(d) = 0.5 ^ (age_days / HALF_LIFE_DAYS)                     # HALF_LIFE_DAYS default 30
final(d)   = w_rrf · norm(rrf(d)) · recency(d) · (1 + w_imp · importance_score(d))
# optional: rerank top-N by bge-reranker-base (or gpt-5.4-nano) and reorder
```
Configurable: `w_rrf` (1.0), `w_imp` (0.5), `HALF_LIFE_DAYS` (30), `RRF_K` (60), `RERANK` (`off`). Importance_score ∈ [0,1] is assigned by the LLM at ingest with type tags (decision/commitment/factual/social).

## 5. Build plan

- **M1 — Capture → transcript.** PWA scaffold (Vite+PWA, Tailwind/shadcn, dark shell, bottom nav) · mic permission + wake lock + record/pause state · `@ricky0123/vad-web` windowing · FastAPI `/ingest/window` (UploadFile → OpenAI diarize → persist `turns`, discard audio) · pgvector schema + migrations · live transcript view. *Check: a real bilingual conversation from your phone lands as a correctly diarized transcript.*
- **M2 — Intelligence + graph.** Conversation segmentation (gap + topic-shift) · extraction (gpt-5.4-mini, json_schema): summary/facts/action_items/decisions/entities/importance · graph upsert + entity resolution · entity & conversation browse UI. *Check: a conversation yields summary + action items + linked entities.*
- **M3 — Retrieval + chat + recap + full UI.** Hybrid search (RRF+recency+importance, optional rerank) · graph-RAG chat with citations + refusal-when-unsupported · daily rollup job + SMTP recap · polish all screens. *Check: "what did Amartya say about his college shortlist?" → cited correct answer; recap email arrives.*
- **M4 — Polish + README.** Consent Mode · Settings (keys, model ids, retention, recap time, enrolled speakers) · error handling · seed/demo script · docker-compose + cloudflared run docs · README (this research, architecture, ranking formula, limitations).

## 6. Open decisions for you → see the questions I'm asking alongside this doc

D-A provisional-live captions (stretch) yes/no · D-B speaker-identity depth · D-C phone HTTPS transport · D-D model tier confirmation. Defaults above let me proceed immediately if you're happy with them.

## 7. Known limitations (honest)

- **No background / screen-off capture** in a PWA (W3C-mandated mic muting). Foreground-only; always-on is a future native Android foreground-service app.
- **No live *diarized* streaming** (diarize isn't in the Realtime API) — diarized turns appear as each window closes, not word-by-word.
- **Cross-window speaker identity** is best-effort (known-speaker pinning / manual labels); perfect auto re-ID is a stretch.
- **Phone access needs HTTPS** (tunnel or TLS); plain LAN HTTP won't grant the mic.
- Single-user, no auth beyond local; Gmail/Calendar *write* actions are draft-only (generated text, not sent).
