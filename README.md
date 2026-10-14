# Sutra — Ambient Memory

Privacy-first, **local-first** ambient memory for your phone. Sutra captures a conversation,
transcribes it and separates who said what, distills it into structured memory (title, summary, key
facts, decisions, action items with steps, scheduled events), builds a personal **knowledge graph**,
and lets you **search** and **chat** over your own memory with **cited** answers — plus a daily recap.
It's built for how people actually talk, treating **Hindi–English (Hinglish) code-switching** as
first-class.

It is a **phone app today** (Android, plus a web/PWA build) — not a hardware wearable.

> **Privacy invariant (non-negotiable):** raw audio is **in-flight only and never persisted by
> default** — it's processed in the moment and discarded. Derived memory is stored **encrypted
> on-device**; you can export or wipe it anytime; nothing is auto-uploaded. (The single narrow
> exception is an explicit, currently-disabled on-device audio-training opt-in, which would store
> samples encrypted on the device and never upload them.)

---

## Architecture (how it actually works today)

Sutra is **local-first**: all the real logic — capture, storage, search, graph, recap, people —
runs **on-device** in the app. The only thing that leaves the device is, in the default mode, audio
sent in-flight to a thin proxy for transcription/extraction; the proxy keeps nothing.

- **The app:** Capacitor + React 19 + TypeScript, wrapped into a native Android app (also runs as a
  web/PWA build). All on-device logic lives in `frontend/src/local/*` (facade: `frontend/src/local/sutra.ts`).
- **On-device storage:** encrypted SQLite (**SQLCipher**) via `@capacitor-community/sqlite`. The
  encryption key is held in **hardware-backed secure storage**. Schema + migrations are in
  `frontend/src/local/schema.ts`.
- **Networking:** a thin, **stateless** proxy at `backend/app/proxy.py` is the **only** holder of the
  cloud API key. The phone talks **only** to this proxy (audio in-flight for transcription, plus
  text-only extraction/embedding/rerank/chat calls). The proxy stores nothing.
- **Intelligence:** advanced speech-to-text with speaker separation, on-device voiceprint matching to
  keep speakers consistent and recognize enrolled people, and language AI for extraction and grounded
  chat. (Specific model/vendor names are deliberately omitted — that's a competitive detail.)

### Two backends — don't confuse them

| Path | Status | Used by |
|---|---|---|
| `backend/app/proxy.py` | **Current / real.** Thin, stateless key-holder the phone talks to. | The phone app (default "hybrid" mode). |
| `backend/app/main.py` (+ Postgres) | **Legacy.** The OLD full server that used to serve a PWA and persist data. | **Only** `backend/tests/` and `evals/`. **Not** used by the phone. |

If you're reasoning about what the app does, look at `frontend/src/local/*` and `backend/app/proxy.py`.
The `main.py` + Postgres stack is retained solely so the existing test/eval suites keep running; it is
**not** the production data path and the phone never touches it.

---

## Build the app

## Desktop app (macOS / Windows / Linux)
A minimal meeting-notes app in the spirit of Aside:
- **It notices your calls.** When Google Meet, Zoom, Teams, Slack huddles and similar are in progress, a small pill appears at the top of the screen: *"Google Chrome in call · ● Record ×"*.
- **No bot joins.** Sutra records your mic and the call's audio as two channels and transcribes each separately, so "you" and "everyone else" are always attributed correctly.
- **Notes when you stop.** You get Summary, Decisions, Action items (with checkboxes) and Open questions. There's also a *Detailed* style, the transcript with speakers you can rename, and **Ask about this meeting…**.

```bash
cd frontend && npm install   # postinstall rebuilds the SQLite engine for Electron
npm run dev            # desktop app (electron-vite)
# If Electron reports NODE_MODULE_VERSION mismatch: npm run rebuild:electron
npm run dev:web        # same UI in the browser (Chrome/Edge for meeting capture)
npm test && npm run typecheck
npm run build:desktop  # packaged app (dmg / nsis / AppImage)
```
See [`docs/AUDIT-2026-09.md`](docs/AUDIT-2026-09.md) for the audit and macOS permissions, and [`docs/LOCAL-AI.md`](docs/LOCAL-AI.md) for local transcription models (whisper.cpp) and running notes/Q&A through Claude Code, Codex or Cursor Agent.

## Stack
- **Backend:** Python + FastAPI (async), Postgres + `pgvector`.
- **AI (OpenAI):** `gpt-4o-transcribe-diarize` (diarized STT) · `gpt-5.4-mini` (extraction, Structured Outputs)
  · `gpt-5.4-nano` (LLM rerank) · `text-embedding-3-large`@1536 · SpeechBrain **ECAPA-TDNN** voiceprints.
- **Frontend:** React + Vite + TypeScript **PWA**, hand-crafted calm-dark design, `react-force-graph` graph.
- See [`docs/M0-research-and-plan.md`](docs/M0-research-and-plan.md) for the verified API research and every decision.

```bash
npm --prefix frontend run build     # tsc + vite; catches type errors and produces the web build
```

For the native Android sync/build and installing on a device, see **`RUN-ON-DEVICE.md`** (end-to-end:
start the proxy, connect the device, build, install, first run). Deeper as-built internals, the build
commands, and dev/debug notes live in **`docs/archive/BUILD-HISTORY.md`**. This README intentionally
points to those rather than duplicating them.

The proxy (which holds the cloud key) runs as a baked image:

```bash
docker compose up -d proxy          # proxy on :8787 (reads the API key from .env)
curl -s localhost:8787/health       # health check
```

---

## Deploy to a device

Follow **`RUN-ON-DEVICE.md`** for the validated flow on a physical Android phone — including making the
on-device app reach your local proxy (`adb reverse tcp:8787 tcp:8787`, or baking a LAN proxy URL at
build time), first-run permissions, and on-device verification that all data stays in encrypted SQLite.

---

## Privacy invariants (the non-negotiables)

- **Raw audio is never persisted by default** — in-flight only, then discarded. The lone exception is an
  explicit, **currently-disabled** on-device audio-training opt-in (encrypted on-device, never uploaded).
- **Local-first & you own your data** — derived memory is encrypted on-device; export or wipe anytime;
  nothing is auto-uploaded.
- **The proxy is stateless** — it holds only the cloud key and persists nothing.

---

## Tests & evals

`backend/tests/` and `evals/` exercise the **legacy** `main.py` + Postgres server, not the phone's
local-first path. Run them against that stack as documented in `docs/archive/BUILD-HISTORY.md`. (The
opt-in hosted variant — accounts, sync, hosted MCP — is covered in `docs/archive/TIER-B.md`.)

## Known limitations (honest)

- **No background / screen-off capture in the web/PWA build** — browsers mute the mic when the tab isn't
  visible. Screen-off capture is an Android-native capability (foreground service); validate long
  screen-off sessions on the device.
- **On-device AI compute is roadmap.** Today's intelligence uses a privacy-preserving cloud-assisted path
  (audio in-flight only); what's local today is storage, search, graph, recaps, and the privacy
  guarantee. The "on-device max-privacy" capture mode is a disabled stub.
- **No live word-by-word diarization** — diarized turns appear per processed chunk.
- **Single-user, local-trust model** — a free account is required (email + password, for the hosted
  cloud-assist and optional sync), but there are no teams or shared memory. Email/calendar actions are
  draft-only (generated text, never auto-sent).

See `docs/OVERVIEW.md`, `docs/FEATURES.md`, and `docs/ROADMAP.md` for the vision, the full
built-feature list, and what's next.
