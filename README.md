# Sutra — Ambient Memory (MVP)

Privacy-first ambient memory you can test **today from your phone's browser**. Sutra captures a
conversation, transcribes + diarizes it, extracts structured memory (summary, action items, decisions,
entities), builds a personal **knowledge graph**, lets you **search** and **chat** over your own memory
with **cited** answers, and emails you a **daily recap**.

> **Privacy invariant (non-negotiable):** Sutra stores transcripts and derived data only.
> **Raw audio is never persisted.** Audio is processed in-flight and discarded.

---

## Desktop app (macOS / Windows / Linux)
A minimal meeting-notes app in the spirit of Aside:
- **It notices your calls.** When Google Meet, Zoom, Teams, Slack huddles and similar are in progress, a small pill appears at the top of the screen: *"Google Chrome in call · ● Record ×"*.
- **No bot joins.** Sutra records your mic and the call's audio as two channels and transcribes each separately, so "you" and "everyone else" are always attributed correctly.
- **Notes when you stop.** You get Summary, Decisions, Action items (with checkboxes) and Open questions. There's also a *Detailed* style, the transcript with speakers you can rename, and **Ask about this meeting…**.

```bash
cd frontend && npm install
npm run dev            # desktop app (electron-vite)
npm run dev:web        # same UI in the browser (Chrome/Edge for meeting capture)
npm test && npm run typecheck
npm run build:desktop  # packaged app (dmg / nsis / AppImage)
```
See [`docs/AUDIT-2026-09.md`](docs/AUDIT-2026-09.md) for the audit, what changed, and the macOS permissions to allow.

## Stack
- **Backend:** Python + FastAPI (async), Postgres + `pgvector`.
- **AI (OpenAI):** `gpt-4o-transcribe-diarize` (diarized STT) · `gpt-5.4-mini` (extraction, Structured Outputs)
  · `gpt-5.4-nano` (LLM rerank) · `text-embedding-3-large`@1536 · SpeechBrain **ECAPA-TDNN** voiceprints.
- **Frontend:** React + Vite + TypeScript **PWA**, hand-crafted calm-dark design, `react-force-graph` graph.
- See [`docs/M0-research-and-plan.md`](docs/M0-research-and-plan.md) for the verified API research and every decision.

## Quickstart (Docker)
```bash
cp .env.example .env          # fill OPENAI_API_KEY (and SMTP for recap email, optional)
docker compose up --build     # Postgres+pgvector + backend (serves the built PWA) on :8000
# open http://localhost:8000
python_seed() { docker compose exec backend python -m app.seed; }   # optional demo data
docker compose exec backend python -m app.seed                      # seed retrieval/graph/chat
```

### Test it on your phone (mic needs HTTPS)
`getUserMedia` requires a secure context, so a plain `http://<lan-ip>` URL will **not** grant the mic.
Use a one-command tunnel:
```bash
cloudflared tunnel --url http://localhost:8000
# open the printed https://*.trycloudflare.com URL on your Android phone, grant the mic, record.
```

## Weekend run order
- **Saturday:** `docker compose up --build` → open the tunnel URL on your phone → **Settings → enroll
  yourself** ("This is me", optionally a 5-10s voice sample) → **Capture** → hold a ~10-min mixed
  Hindi/English conversation → watch diarized turns land → open **Memory** to see the summary, action
  items, and entities; open **Graph**.
- **Sunday:** Use **Ask Sutra** to query your memory ("what did Amartya say about his college shortlist?")
  and get a cited answer → check the **daily recap** (Settings → "Send today's recap now", or wait for the
  scheduled time). Try **Upload audio** on Capture with your `.m4a` recordings.

## Dev mode (fast iteration)
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up   # backend reload, no PWA build
cd frontend && npm install && npm run dev                            # PWA on :5173, proxies /api -> :8000
```

## Ranking formula (hybrid retrieval)
```
candidates = semantic_topK(pgvector cosine) ∪ lexical_topK(Postgres ts_rank)
rrf(d)     = Σ 1 / (RRF_K + rank_in_list(d))            # Reciprocal Rank Fusion, RRF_K=60
recency(d) = 0.5 ^ (age_days / HALF_LIFE_DAYS)          # HALF_LIFE_DAYS=30 (configurable)
final(d)   = RANK_W_RRF · norm(rrf) · recency · (1 + RANK_W_IMPORTANCE · importance_score)
# optional rerank of the top-N: local cross-encoder (bge-reranker-base) or LLM (gpt-5.4-nano). Default OFF.
```
All weights are in `.env` and editable live in **Settings**.

## Architecture
```
PWA (foreground, HTTPS, mic + wake lock)
  getUserMedia → MediaRecorder + RMS VAD → ~2-5 min webm windows
        │  multipart POST /api/sessions/{id}/windows
        ▼
  FastAPI ── OpenAI gpt-4o-transcribe-diarize (diarized_json, chunking=auto)
        │    ECAPA voiceprint (in-memory ffmpeg decode → embed → DISCARD audio) → person identity
        │    persist turns (no audio)
        ▼
  Postgres+pgvector ── segmentation (gap + topic-shift) → conversations
                       extraction (gpt-5.4-mini, Structured Outputs) → memories + action_items
                       graph upsert (entities + edges + evidence) → knowledge graph
        │
        ├─ Search  : semantic + lexical → RRF → recency × importance → [rerank?]
        ├─ Chat    : hybrid seed → expand graph 1-2 hops → grounded answer with citations
        └─ Recap   : APScheduler daily job → rollup → SMTP email
```

## API (under `/api`)
`health` · `settings` · `sessions` (+`/windows`, `/close`, `/process`, `/turns`) · `people` (+`/enroll`,
relabel) · `conversations` · `graph` · `entities` · `search` · `chat` · `action_items` (+`/draft`) ·
`recap/run` · `rollups`.

## Tests
```bash
docker compose exec backend pytest          # integration suite (mock provider; offline, deterministic)
```
Includes a privacy assertion that **no audio column exists** in any table, plus a full
capture→extract→search→chat→recap pipeline test.

## Known limitations (honest)
- **No background / screen-off capture** in a PWA — Android Chrome mutes the mic when the tab isn't visible
  and Wake Lock only keeps the *screen* on. Foreground-only; always-on requires a future native Android app.
- **No live *diarized* streaming** (diarize isn't in the Realtime API) — diarized turns appear per window.
- **VAD** uses a Web Audio energy gate (reliable, dependency-free); Silero (`@ricky0123/vad-web`) is a
  documented drop-in upgrade.
- Single user, no auth beyond local. Gmail/Calendar actions are **draft-only** (generated text, not sent).
