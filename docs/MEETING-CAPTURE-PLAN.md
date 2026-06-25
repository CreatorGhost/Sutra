# Sutra — Online-Meeting Capture — FINAL Implementation Plan

Companion to `docs/MEETING-CAPTURE-SPEC.md`. This is the consolidated, decided plan, structured as discrete **build → verify** milestones so it can be run in a loop.

## Decisions locked
| Topic | Decision |
|---|---|
| Surface | **Electron desktop app** (primary) + **PWA** — one shared React UI, swappable shell |
| Why desktop | Meetings run as **software (Zoom/Teams apps, Meet)** → need **system-audio loopback**, which is app-agnostic and reliable; pure-web can't do it cleanly |
| STT | **Deepgram** default; **Sarvam** also supported (the pluggable `STT_PROVIDER` backend already built) |
| Backend | **Reuse as-is** — same proxy (transcription, chunking, streaming) + the same `frontend/local` pipeline (memory, graph, extraction, chat, search). Only NEW backend work: **multichannel** support |
| Audio source | **Whole-system loopback** v1 (captures any meeting app) + **mic picker** + mic/system on-off toggles. **Per-app audio capture deferred** (needs native per-process taps = real complexity) |
| Capture scope | System-wide; default-output device, following device-change events |

## Stack
| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron 39+** | Win/Mac/Linux; **built-in system-audio loopback** (Core Audio tap / WASAPI / PipeWire) → **no native module for v1** |
| Build | **electron-vite** | Reuses the existing Vite + React + TS config; main + preload + renderer |
| Renderer (UI) | **existing `frontend/src`** | Same React app as the PWA: UI + `local/` pipeline + providers, shared verbatim |
| Packaging | **electron-builder** | One config → Win `.exe`/NSIS, macOS `.dmg` (notarized), Linux AppImage/deb + auto-update |
| Desktop DB | **better-sqlite3 (FTS5)** | Full-text search the PWA's `sql.js` lacks; behind the existing storage interface so `local/` is unchanged |

## Repo structure (minimal disruption — one UI source)
```
frontend/src              ← ONE codebase (~90%+ shared across PWA + desktop + phone logic)
   ├─ UI, local/, providers           → unchanged, runs in PWA AND Electron renderer
   ├─ capture/CaptureProvider.ts       → interface
   │    ├─ BrowserCapture.ts           → getUserMedia + getDisplayMedia (PWA)
   │    └─ ElectronCapture.ts          → IPC → main-process loopback (desktop)
   └─ storage/                          → adapter: sql.js (web) | better-sqlite3 (desktop)
electron/                 ← thin desktop shell (NEW, small)
   ├─ main.ts    window + setDisplayMediaRequestHandler({audio:'loopback'}) + mic
   └─ preload.ts contextIsolation IPC bridge
Outputs:  vite build → PWA   ·   electron-vite build && electron-builder → Win/Mac/Linux
```

## Milestones (each = one build→verify loop unit · 🤖 = I verify directly · 🖥️ = you run on your Mac)

> **Status — all milestones complete.** M0–M6 (tickets **F1–F7**) are built and machine-verified:
> `npx vitest run` green (149 tests), `npx tsc -b` 0, `npx electron-vite build` 0 (out/main, out/preload,
> out/renderer), the renderer bundle carries **no** static `better-sqlite3` import, and the backend STT
> tests pass under a clean Python-3.11 venv (`requirements.txt`). The remaining on-device steps
> (signed/notarized installers, a real 9-speaker call, 1-hour continuous-capture stability) are the
> Mac morning checklist in **`docs/MEETING-CAPTURE-VERIFY.md`**.

### M0 — Electron scaffold + abstractions + capability gate ✅ (F1)
- electron-vite scaffold; renderer = `frontend/src`; electron-builder targets (win/mac/linux). `CaptureProvider` interface + `StorageProvider` interface (stubs). `/meeting` route + "use the desktop app / Chrome-Edge" gate for unsupported web contexts.
- **Verify 🤖:** `npm run dev` opens the desktop app loading the existing UI; PWA build still green; `vitest`/`tsc` pass; app launches on macOS.

### M1 — Two-channel capture engine (both shells, behind the abstraction) ⭐ core ✅ (F2)
- **M1a BrowserCapture (PWA):** `getUserMedia(mic)` + `getDisplayMedia(tab/system)` → single `AudioContext(48k)` → `ChannelMerger(2)` (mic→ch0, system→ch1) → `AudioWorklet` interleaved linear16 2-ch; ~90s windows → in-RAM ring buffer (**never persisted**); no-audio-track guard; echo policy.
- **M1b ElectronCapture (desktop):** main-process `setDisplayMediaRequestHandler({ audio:'loopback' })` (system) + `getUserMedia` (mic) → two tracks → same 2-ch encode; mic device picker + mic/system toggles; follow default-output device changes; **BT-SCO mic warning** (AirPods double-duty → 8 kHz).
- **Verify 🤖** windowing/merge/guard unit tests · **🖥️** real: play a Zoom/Teams/Meet meeting on your Mac → desktop app captures 2-channel windows; headphones produce clean separation; missed-checkbox guarded; audio freed each window.

### M2 — Multichannel transcription (backend) ✅ (F3)
- Deepgram: `multichannel=true & diarize=true & channels=2`; extend `DeepgramStt._normalize` for the `channels[]` response → ch0=Me, ch1=remotes(diarized); tag segments `channel`/`is_me`. Sarvam: split stereo → 2 mono 16k requests.
- **Verify 🤖:** feed a 2-channel file (your voice / meeting audio) → Me-tagged segments + diarized remote segments; backend tests green.

### M3 — Attribution (Me + remotes) ✅ (F4)
- Channel 0 → **"Me"** deterministically (skip voiceprint for owner); channel 1 remote labels → existing **ECAPA voiceprint clustering** → stable cross-window remote identities → Sutra people/graph.
- **Verify 🤖** logic · **🖥️** real 2–3-person call: "Me" always correct; remotes get stable names.

### M4 — Desktop DB (better-sqlite3 + FTS5) ✅ (F5)
- Implement `StorageProvider` for desktop with better-sqlite3 (FTS5 full-text); web keeps sql.js. Same `local/repo` code, two adapters.
- **Verify 🤖:** desktop search returns FTS5 results; web path unchanged; existing local tests green.

### M5 — Capture UI (shared, PWA-ready) ✅ (F6)
- `/meeting` page: start/stop, mic picker + source toggles, live status (windows/duration), headphone hint, error/recovery UX, Sutra design system; PWA manifest + install.
- **Verify 🤖** component/a11y · **🖥️** one-tap record → conversation in Memory; "stop sharing"/window-close recovers.

### M6 — Hardening + cross-platform packaging ✅ (F7)
- Stream-ended + network-blip recovery; AEC warm-up handling; long-meeting stability (reuse the **auto-chunker**); privacy copy ("audio never stored"); **electron-builder** signed installers for Win/Mac/Linux + auto-update.
- **Verify 🖥️:** a continuous **1-hour** meeting captured end-to-end on your Mac, audio never written to disk; installers build for all three OSes.

### Phase 2 (DEFERRED — only if usage demands)
Per-app audio capture (native Core Audio per-process tap / WASAPI process-loopback module); Windows/Linux field polish. Reference (MIT) for native taps if needed: `fastrepl/anarlog`, `thewh1teagle/vibe`. Avoid for code reuse: screenpipe (commercial), OBS/BlackHole (GPL).

## Build order
M0 → M1 (gates everything) → M2 → M3; M4 and M5 can run in parallel with M2/M3; M6 last. Phase 2 independent.

## Testing model
- **I verify directly (🤖):** all backend/multichannel/attribution logic, unit tests, the 2-channel transcription path (I can bootstrap a 2-channel file from your Hinglish Blip recordings, or better, a real meeting clip).
- **You run on your Mac (🖥️):** anything that captures *live* system audio (Electron loopback) — I build it, you run it, we heal. I can't drive a desktop GUI + audio device from here.

## Still needed to start
1. **A real multi-speaker Hinglish meeting recording** (video `.mp4` or audio) — for the multichannel/diarization validation and for you to play during the live loopback test. (Not a hard blocker for M0/M1-code; needed by M2/M3 verify.)
2. **The loop contents** — what you want each loop iteration to do (build steps, verify steps, heal criteria, checkpoints).

## Reused from Sutra today (not rebuilt)
Provider abstraction + `multichannel`/`diarize` (Deepgram integrated), auto-chunking, the 90s-window + audio-never-stored model, ECAPA voiceprint clustering, the `local/` memory/graph/extraction/chat/search pipeline, the `/transcribe` proxy. This is a **new capture surface + an Electron shell**, not a pipeline rewrite.
