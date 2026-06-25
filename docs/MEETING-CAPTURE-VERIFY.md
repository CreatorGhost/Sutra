# Sutra — Online-Meeting Capture — On-Device VERIFY (Mac morning checklist)

Companion to `MEETING-CAPTURE-PLAN.md` / `MEETING-CAPTURE-SPEC.md`. Everything machine-checkable is
already green (vitest 149, `tsc -b` 0, `electron-vite build` 0, renderer bundle has no static
`better-sqlite3`, backend STT tests pass on a clean Python-3.11 venv). This file is the short list of
things that need **your Mac, real audio devices, and signing keys** — run top to bottom.

Run from `frontend/` unless noted.

## 0. One-time prep
- [ ] `npm install` (pulls `electron`, `electron-builder`, `electron-updater`, `better-sqlite3-multiple-ciphers`).
- [ ] Native rebuild for Electron's ABI: `npx electron-builder install-app-deps`
      (rebuilds `better-sqlite3-multiple-ciphers` against the bundled Electron — required for the
      desktop DB + FTS5 to load in the packaged app).

## 1. Run the desktop app (dev)
- [ ] `npm run dev` → Electron window opens, loading the existing Sutra UI (same `index.html`/`#root`).
- [ ] The bottom nav shows a **Meeting** tab (capability gate = supported in the Electron renderer).
- [ ] Open **Meeting** → the two-channel capture UI renders (mic picker, Headphones/Speakers toggle,
      Start), with the line **"Audio is processed live and never stored."** visible.

## 2. Capture a real Meet/Zoom call
- [ ] Join a Google Meet (Mode A — tab audio) or the Zoom/Teams desktop app (Mode B — system audio).
- [ ] Wear headphones (cleanest two-channel separation, no echo).
- [ ] Hit **Start**. Confirm live status advances ("Capturing… transcribing windows", windows emitted,
      turns counting up).
- [ ] Speak yourself + have a remote speak → after a window, a conversation appears in **Memory** with
      **your** turns tagged "Me" (channel 0) and remote turns diarized (channel 1).
- [ ] **Stop & process** → uploads drain, the conversation finalizes.
- [ ] Stop the screen-share from Chrome's banner mid-capture → page shows **Capture ended** and offers
      **Restart capture** (stream-ended recovery, no crash).

## 3. 9-speaker diarization on the test clip
- [ ] Play `/Users/adityapratapsingh/Downloads/FDM/sutra-meeting-test/meeting_clip.mp4` through the
      meeting app (or share its tab) and capture it.
- [ ] Verify the remote channel resolves to ~9 stable speakers across windows (ECAPA clustering →
      Sutra people/graph), and "Me" never gets mislabeled as a remote.

## 4. Native better-sqlite3 + FTS5 on desktop
- [ ] In the running desktop app, add/capture some memories, then use **Ask / search**.
- [ ] Confirm lexical search returns rows (FTS5 `MATCH … bm25`) — this is the leg the web `sql.js`
      build silently lacks. The desktop adapter unit test (`src/storage/__tests__/desktopAdapter.test.ts`)
      already proves an FTS5 `MATCH` returns rows; this confirms it end-to-end against the real file DB
      under Electron.
- [ ] The DB file lives under `app.getPath('userData')/sutra.db`, SQLCipher-keyed via the
      safeStorage-sealed `sutra.key` (Keychain). The key never reaches the renderer.

## 5. Build signed installers (win / mac / linux)
- [ ] `npm run build:desktop` → `electron-vite build` then `electron-builder` per
      `electron-builder.json` (win = nsis, mac = dmg, linux = AppImage; output in `release/`).
- [ ] macOS signing + notarization (the part that needs your Apple Developer creds, NOT gated in CI):
      - Add `build/entitlements.mac.plist` (mic + screen-capture) and an `icon.icns` in `build/`.
      - Export `CSC_LINK` / `CSC_KEY_PASSWORD` (Developer ID Application cert) and
        `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` for notarization, then re-run
        `npm run build:desktop`.
      - `spctl -a -vvv "release/mac/Sutra.app"` → "accepted / Notarized Developer ID".
- [ ] Auto-update: `electron-builder.json` `publish` (github: CreatorGhost/Sutra) emits
      `latest*.yml`. Confirm `app.isPackaged` makes `checkForUpdatesAndNotify` active in the packaged
      build and inert in `npm run dev`.

## 6. 1-hour continuous-capture stability + audio-never-stored
- [ ] Capture a continuous **1-hour** meeting end-to-end. Memory stays flat (each ~90s window's PCM is
      freed after its in-flight WAV upload; auto-chunker handles long windows).
- [ ] While capturing, confirm **no audio is written to disk**:
      `sudo fs_usage -w -f filesys | grep -iE '\.(wav|pcm|raw|m4a|opus)'` produces nothing for the
      Sutra process. The only audio that ever materializes is the in-flight WAV `Blob` (RAM), uploaded
      then discarded.

---
**Caveat (not a regression):** the global Anaconda Python has an incompatible `fastmcp`/`pydantic`
combo (`default` + `default_factory`), so `pytest` collection that imports `app.main` fails there. Run
backend tests under a clean venv built from `backend/requirements.txt` (Python 3.11):
`python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pytest tests/test_stt_providers.py`.
