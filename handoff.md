# Sutra — Engineering Handoff

> A self-contained brief so any agent (or person) can pick up a task and start. Sutra is a **privacy-first, local-first ambient-memory Android app**: capture a conversation → diarize → transcribe (Hinglish) → extract structured memory → knowledge graph → search + cited chat → daily recap. **Hard invariant: raw audio is NEVER persisted** — processed in-flight and discarded; only derived text is stored on-device.

---

## 0. How to use this doc
- **Pick a task** from §6 (features) or §7 (UI/UX audit). Each item has files + a concrete fix + effort (S/M/L).
- **Before editing**, read §8 (parallel-safety) so two agents don't collide on shared files, and §4 (constraints) — especially the `SCHEMA_VERSION` rule and the GateGuard hook workflow.
- **Verify** with §3 (build/test/deploy on the device).

---

## 1. What Sutra is — architecture
- **Frontend (the app):** React 19 + Vite + TypeScript, hand-crafted CSS design system (**no Tailwind**), wrapped by **Capacitor 6** into a native Android app. Runs in-browser too.
- **Local-first data:** everything persists **on-device** in SQLite via `@capacitor-community/sqlite` (SQLCipher-encrypted). The on-device API surface is the facade `frontend/src/local/sutra.ts` (`api` object) over services in `frontend/src/local/*.ts`.
- **AI calls** go through `frontend/src/providers/cloudProvider.ts` → a **thin hosted proxy** `backend/app/proxy.py` (holds the OpenAI key) exposing: `/transcribe` (audio in-flight, never stored), `/extract`, `/embed`, `/rerank`, `/chat` (text-only). Provider abstraction: `CloudProvider` (default, "hybrid" mode) vs `OnDeviceProvider` (stub, Phase 3/4).
- **Models:** `gpt-4o-transcribe-diarize` (diarized transcription), `gpt-5.4-mini` (extraction, Structured Outputs), `gpt-5.4-nano` (rerank), `text-embedding-3-large`@1536.
- **Modes:** **Hybrid** (default; cloud for quality) and **On-device** ("max privacy"; stub until Phase 3/4 greenlight). UI copy must keep the two modes' audio promises distinct.

## 2. Repo layout (key files)
```
frontend/
  src/
    App.tsx                      # shell + bottom nav + routes: / /memory /conversation/:id /graph /chat /settings
    index.css                    # ~200-line design system (tokens + component classes)  <- UI audit centers here
    components/  Waveform.tsx (canvas mic visualizer), HomeView.tsx (polished home, NOT wired), Header.tsx, Nav.tsx, ui.tsx, Preview.tsx
    pages/       Capture.tsx, Memory.tsx, ConversationDetail.tsx, GraphPage.tsx, Chat.tsx, Settings.tsx
    local/       sutra.ts (facade), schema.ts (SCHEMA_VERSION + migrations), db.ts, repo.ts, ingest.ts,
                 extraction.ts, aiPrompts.ts, chat.ts, search.ts, graph.ts, recap.ts, people.ts, training.ts, segmentation.ts, util.ts
    providers/   provider.ts, cloudProvider.ts, ondeviceProvider.ts (stub), index.ts (Mode + MODE_COPY)
    lib/         capture.ts (VAD/window capture controller), foregroundMic.ts (native plugin bridge)
  android/app/src/main/
    java/app/sutra/memory/  MainActivity.java, ForegroundMicPlugin.java, MicForegroundService.java
    AndroidManifest.xml
  capacitor.config.ts
backend/app/                     # proxy.py (:8787) + the original full backend (:8000); config.py, providers/openai_provider.py, services/*
docker-compose.yml, docker-compose.dev.yml
```

## 3. Build / test / deploy (device = Samsung Z Fold 7, `adb`)
```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"; export PATH="$PATH:$ANDROID_HOME/platform-tools"

# --- Frontend build + deploy to device ---
cd frontend
npm run build                               # tsc + vite (catches type errors)
npx cap sync android
cd android && ./gradlew assembleDebug        # add `clean` only when Java/native changed
APK=app/build/outputs/apk/debug/app-debug.apk
adb install -r "$APK"
adb shell pm grant app.sutra.memory android.permission.RECORD_AUDIO
adb shell pm grant app.sutra.memory android.permission.POST_NOTIFICATIONS
adb reverse tcp:8787 tcp:8787                # phone reaches the Mac's proxy over USB
adb shell am force-stop app.sutra.memory && adb shell am start -n app.sutra.memory/.MainActivity

# --- Proxy (transcription/extraction) is a BAKED docker image, NOT volume-mounted, NO --reload ---
docker compose build proxy && docker compose up -d proxy     # REQUIRED after editing backend/app
curl -s localhost:8787/usage                                  # health
```
**Device gotchas (learned the hard way):**
- `adb` shows **"no devices/emulators found"** intermittently -> it's a stale ADB server, not the cable: `adb kill-server && adb start-server`.
- Foldable `screencap` to stdout is corrupted by a multi-display warning -> write on-device then pull: `adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png`.
- Debug build shows a benign **"16 KB libsqlcipher.so not aligned"** dialog (tap "Don't show again"); real fix = a 16 KB-aligned SQLCipher for Play release.
- Live WebView console/JS debug: `adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof app.sutra.memory)` -> `chrome://inspect`.

## 4. Constraints every agent MUST respect
1. **Privacy invariant:** never write raw audio to durable storage. Export/share = derived text only.
2. **Hinglish is the quality bar:** transcription/extraction must handle Hindi-English code-switching; Hindi renders in **Devanagari** (the live `/transcribe` is primed via `settings.transcribe_prompt`). Don't regress this.
3. **Phase-3/4 is GATED:** do NOT build on-device models (sherpa-onnx ASR, Gemma LLM, ECAPA voiceprint) without explicit owner greenlight. `OnDeviceProvider` stays a stub.
4. **`SCHEMA_VERSION` serialization (critical for parallel work):** `frontend/src/local/schema.ts` is at **`SCHEMA_VERSION = 2`**; `db.ts` runs a forward-only `cur+1..SCHEMA_VERSION` migrate loop. Two features both writing `MIGRATIONS[3]` will **silently clobber** each other. Rule: **each schema-bumping feature claims the next integer in build order and rebases** (next bumper -> v3, then v4, ...). Coordinate via this doc.
5. **GateGuard hooks** fire on `Edit`/`Write` of files and the first `Bash` of a turn, demanding facts. Workflow: present the requested facts (importers, affected functions, no-data-files, the verbatim instruction) in prose, then **retry the same call** — it passes on retry. (Or set env `ECC_GATEGUARD=off`.)
6. **Read-only audits/planning parallelize safely** via the `Workflow` tool; **file edits should be done in the main loop** (subagent writes hit the GateGuard gate). When fanning out workflow agents, omit `agentType` (or use the exact `ecc:`-prefixed name) and keep StructuredOutput schemas **flat** (markdown strings + simple arrays) to avoid generation loops.

## 5. Current state (shipped this session)
- **Whole base app works** (M1–M4): capture · diarization · Hinglish transcription · extraction (summary/actions/decisions/entities/relations) · knowledge graph · hybrid search · cited graph-RAG chat (+ refusal) · recap engine · people (manual relabel) · training-capture · settings · modes.
- **On-device pipeline CONFIRMED on the Z Fold 7:** capture -> diarize -> transcribe -> extract -> store.
- **Device fixes shipped** (see also memory `sutra-build-state.md`):
  - WebView mic **dual-gate**: OS `RECORD_AUDIO` runtime request (MainActivity) **+** WebView `onPermissionRequest` grant.
  - **Bluetooth SCO route fix** (the big one): `ForegroundMicPlugin.routeToBuiltinMic()` pins `TYPE_BUILTIN_MIC` before `getUserMedia` so Chromium doesn't fail on a paired-watch/carkit comms mic; `+MODIFY_AUDIO_SETTINGS`; AEC/NS/AGC disabled in the Android getUserMedia constraints.
  - Dev **mixed-content**: `capacitor.config` `androidScheme:"http"` so `http://localhost` -> `http://localhost:8787` proxy fetch isn't blocked.
  - **Hinglish transcription** prompt (`settings.transcribe_prompt`, Devanagari priming) in `openai_provider.transcribe_diarize`, with a 400-retry that drops `prompt`/`chunking`.
- **Feature #1 shipped — auto speaker-naming:** `aiPrompts.ts` (PROMPT_VERSION `extract-v2`, new `speaker_names` schema field + system instruction) + `extraction.ts` applies **high-confidence self-introductions** via `people.relabelSpeaker`. **No schema bump used.** Low-confidence address cues are NOT applied (needs the confirm-UI follow-up, §6 item F1).
  - *Test:* record "Hi, main Farha hoon" -> Stop & process -> the speaker turns into "Farha".

## 6. Remaining feature roadmap (buildable)
Sequenced into parallel-safe waves; **schema bumpers serialized** (see §4.4). `[shared files]` shown for collision avoidance.

**Wave 1 — no schema bump, disjoint files (safe in parallel):**
- **W1.A Keystore SQLCipher key** (security, M) — move the DB passphrase out of plaintext into Android Keystore / secure storage (TODO in `local/db.ts`). `[db.ts, capacitor.config.ts]`
- **W1.B Capture / BT-route hardening** (reliability, M) — re-pin built-in mic on mid-session route flips; long-session robustness; adaptive VAD now that AEC/NS are off. `[lib/capture.ts, lib/foregroundMic.ts, ForegroundMicPlugin.java, MicForegroundService.java]`

**Wave 2 — serialize the schema (reminders -> v3, recap -> v4):**
- **W2.A Rerank + ranking tuning** (S, no schema) — enable LLM rerank via proxy `/rerank` + tune `rank_*`/score-scale in `search.ts`. `[backend/app/config.py, local/search.ts, Settings.tsx]`
- **W2.B Proactive reminders / nudges** (M, **schema v3**) — local notifications for action items w/ due dates + a `/reminders` view. `[schema.ts(v3), repo.ts, sutra.ts, App.tsx, local/extraction.ts]`
- **W2.C Recap screen + daily notification** (M, **schema v4**) — surface `recap.buildRollup` in a `/recap` screen + deliver via local notification. Lands LAST in the wave (rebases B's repo/sutra/App + A's Settings). `[schema.ts(v4), repo.ts, sutra.ts, recap.ts, App.tsx, Settings.tsx, Nav.tsx]`

**Wave 3 — UI-heavy, after Wave 2 settles:**
- **W3.A Native export / share** (M, no schema) — Capacitor Filesystem+Share for a conversation/memory; fix the silently-swallowed Android training export. **Derived text only.** `[sutra.ts, ConversationDetail.tsx, Settings.tsx, AndroidManifest.xml, package.json]`
- **W3.B Onboarding + DPDP consent** (M, no schema) — first-run consent + permission priming + capture-mode choice gate. `[App.tsx, sutra.ts, repo.ts, Capture.tsx, Settings.tsx, providers/index.ts, AndroidManifest.xml]`
- **W3.C Streaming / live transcription** (L) — lower latency / incremental turns without breaking diarization. `[lib/capture.ts, local/ingest.ts, Capture.tsx]`

**Follow-up:**
- **F1 Speaker-naming confirm UI** (S–M, schema bump) — one-tap "Is Speaker B = Mark?" for low-confidence address cues; add a `speaker_suggestions` table (claims the next schema version) + surface in `ConversationDetail.tsx`. Completes Feature #1.

**GATED — do not build without greenlight:** on-device voiceprint (ECAPA, Phase 3) · on-device max-privacy ASR/LLM (sherpa-onnx + Gemma, Phase 4) · calendar/contacts integration (plan-only).

## 7. UI/UX audit — fix-ready tasks (39 issues: 10 Critical / 14 Major / 15 Minor)
All line numbers verified against `frontend/src`. The two user-reported bugs are **C1/C2/C3** below.

### Priority 1 — Mic button "square overlay" + jerky animation (C1, S)
Two compounding bugs: (1a) `.mic-btn` (`index.css:202-208`, button at `Capture.tsx:127-134`) is the only control missing platform resets -> the rectangular **tap-highlight + focus ring** paint on the border-box, not the radius; (1b) the recording pulse animates a **positive-spread `box-shadow`** (`@keyframes pulsering`, `index.css:206-208`) -> squares off at the corners **and** janks (paint-bound, not GPU). **Fix — replace `index.css:200-208`:**
```css
.mic-wrap { display:flex; flex-direction:column; align-items:center; gap:18px; padding:18px 0 8px; }
.mic-btn {
  position:relative; isolation:isolate; width:104px; height:104px; border-radius:50%;
  border:none; padding:0; cursor:pointer; display:grid; place-items:center; color:var(--on-accent);
  background:radial-gradient(circle at 50% 35%, var(--accent-2), var(--accent));
  box-shadow:0 10px 36px -10px var(--accent-glow);
  transition:transform .18s var(--spring), background .25s var(--ease);
  -webkit-tap-highlight-color:transparent; -webkit-touch-callout:none;
  appearance:none; -webkit-appearance:none; user-select:none; -webkit-user-select:none;
  touch-action:manipulation; outline:none; will-change:transform;
}
.mic-btn > svg { position:relative; z-index:2; }
.mic-btn:active { transform:scale(.94); }
.mic-btn:focus { outline:none; }
.mic-btn:focus-visible { box-shadow:0 0 0 3px var(--bg), 0 0 0 6px var(--accent-line), 0 10px 36px -10px var(--accent-glow); }
.mic-btn::before, .mic-btn::after { content:""; position:absolute; inset:0; border-radius:50%; border:2px solid var(--accent-line); pointer-events:none; opacity:0; z-index:0; }
.mic-btn.recording::before { animation:mic-ripple 2.4s var(--ease) infinite; }
.mic-btn.recording::after  { animation:mic-ripple 2.4s var(--ease) 1.2s infinite; }
@keyframes mic-ripple { 0%{transform:scale(1);opacity:.55} 70%{opacity:0} 100%{transform:scale(2.2);opacity:0} }
.mic-btn.recording { animation:mic-breathe 2.6s var(--ease) infinite; }
.mic-btn.speaking  { animation:mic-breathe 1.1s var(--ease) infinite; }
@keyframes mic-breathe { 0%,100%{transform:scale(1)} 50%{transform:scale(1.05)} }
.mic-btn.paused { background:var(--surface-3); color:var(--muted); box-shadow:0 8px 24px -14px rgba(0,0,0,.6); }
.mic-btn.paused::before, .mic-btn.paused::after { animation:none; opacity:0; }
```
Delete `@keyframes pulsering`. Apply the same resets to `.icon-btn` (`index.css:83`). **TSX `Capture.tsx:128`:** set `className` to include `recording`/`speaking`/`paused` from `state` (`state==="speaking"` is set via `onState` at `Capture.tsx:57`).

### Priority 2 — Scrolling + sticky headers (C2 S–M, C3 M)
There's **no app scroll container** — the body scrolls and only `.app-header` sticks, so every `.page-title` scrolls away. **Full fix (best on the Fold):**
- **Step A** make `.app` the single scroller: `html,body,#root{height:100%}` · `body{overflow:hidden;overscroll-behavior-y:none;overflow-x:hidden}` · `.app{height:100dvh;display:flex;flex-direction:column;overflow:hidden}` · `.page{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-y:contain}` (keep `.page` bottom padding for the fixed nav).
- **Step B** sticky sub-header: add `.page-head{position:sticky;top:0;z-index:20;margin:-18px -18px 16px;padding:14px 18px 12px;background:linear-gradient(180deg,color-mix(in srgb,var(--bg) 94%,transparent),color-mix(in srgb,var(--bg) 70%,transparent));backdrop-filter:blur(14px);border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent)}` and wrap each page title (+ Memory tab row) in `<div className="page-head">` (`Capture.tsx:121`, `Memory.tsx:46+50`, `Settings.tsx:69`, `ConversationDetail.tsx:34`, `GraphPage.tsx:50`).
- **Step C** Chat: drop `minHeight:calc(100vh-120px)` (`Chat.tsx:32`); composer -> `position:sticky;bottom:0` (`Chat.tsx:64`).
- *Minimal alt:* keep body-scroll, do Step B only with `top:calc(var(--sat)+56px)`.

### CRITICAL (remaining)
- **C4 (S)** `.btn.primary` used 6x but **undefined** -> every primary CTA renders grey, active tab indistinguishable. Add `.btn.primary{background:var(--accent);border-color:transparent;color:var(--on-accent);box-shadow:0 6px 20px -8px var(--accent-glow)} .btn.primary:active{transform:scale(.96)} .btn.primary:disabled{opacity:.5;box-shadow:none}`. (`Memory.tsx:53,64; Chat.tsx:66; Settings.tsx:81,116; ConversationDetail.tsx:101`)
- **C5 (S)** `.chip.warn` used 6x but **undefined** -> amber chips render grey. Add `.chip.warn{background:var(--amber-soft);color:var(--amber-2);border-color:transparent}`.
- **C6 (S)** No `:focus-visible` anywhere (WCAG 2.4.7). Add a global ring + circular ring for `.mic-btn`/`.icon-btn`.
- **C7 (S)** `--faint` (#5e5a72) body text fails contrast (~2.7:1). Bump to ~`#7d7790` in `:root`.
- **C8 (L)** Polished `HomeView` is dead code; `/` uses legacy Capture. Wire HomeView into `/` (feed it `level` from `Capture.tsx:58`) **or** delete it. Large swaths of `index.css` (.hero/.coming-card/.greet/.privacy-badge) are otherwise unused.
- **C9 (M)** Title shown twice (`Header.tsx:15` chip + each page `.page-title`). Pick one source of truth (pairs with C2).
- **C10 (M–L)** Foldable two-pane (`.page.wide`/`.two-pane`, `index.css:193-197`) is **dead CSS** — never used. Add `className="page wide"` to Memory/Graph/ConversationDetail; build real master/detail for the Fold.

### MAJOR (14, condensed — file · fix · effort)
- **M1 (S)** `.score-bar>i` animates `width` (reflow ~10x/s while recording) -> drive `transform:scaleX(level)` (`Capture.tsx:141`, `index.css:188`).
- **M2 (S)** Search/chat inputs + icon-only Send/Search buttons unlabeled -> add `aria-label` (`Chat.tsx:65-66`, `Memory.tsx:63-64`).
- **M3 (S)** Tap targets <44px: `.icon-btn` 42px (`index.css:83`), Memory toggle ~26px (`Memory.tsx:113`), relabel ~20px (`ConversationDetail.tsx:89`) -> 44x44 (WCAG 2.5.8).
- **M4 (M)** Reduced-motion ignored by canvas rAF (`Waveform.tsx:51-55`) + inline spinners -> read `matchMedia('(prefers-reduced-motion:reduce)')`, pause on `visibilitychange`, replace inline spin with `.spin`.
- **M5 (M)** No staggered reveal; turns replay `fade-in` on every ingest (`Capture.tsx:166`) -> add `.reveal` w/ `--i` delay; remove per-turn `fade-in`.
- **M6 (S)** Vague/duplicate ARIA labels (`Settings.tsx:104`, `Memory.tsx:113`, `ConversationDetail.tsx:89`) -> contextualize + `aria-pressed`/`aria-expanded`.
- **M7 (S)** Live recording status not announced -> `role="status" aria-live="polite"` on the status line; `aria-pressed` on mic (`Capture.tsx:135-139`).
- **M8 (S)** No landscape/short-viewport handling -> `@media (max-height:560px){.wave-wrap{height:72px}.mic-btn{width:76px;height:76px}.page-title{font-size:21px}}`.
- **M9 (S)** Safe-area top has no floor -> `--sat:max(env(safe-area-inset-top),8px)` (`index.css:41`) + enable native cutout mode.
- **M10 (S–M)** Two patterns for one mutually-exclusive choice -> use `.pill-toggle` for Settings capture-mode + Memory tabs.
- **M11 (S)** Bare `<h3>` off the token system (`Capture.tsx:159`, `ConversationDetail.tsx:83`) -> `.section-h`.
- **M12 (M)** Off-token graph colors (`GraphPage.tsx:67,81`, `ui.tsx:28-31`) -> read tokens via `getComputedStyle`; map `TYPE_COLOR` to tokens.
- **M13 (S)** Detail back is a hardcoded `<Link to="/memory">` (`ConversationDetail.tsx:33`) -> `useNavigate(); nav(-1)`.
- **M14 (S)** Nav labels != titles != routes -> align (`Nav.tsx:7-8`, `Header.tsx:4-5`).

### MINOR (15, condensed)
m1 `.trunc` undefined (`Settings.tsx:99`) · m2 `.tag-type` undefined (`GraphPage.tsx:90`) · m3 `.spin` class missing (`Capture.tsx:138`) · m4 GraphPage double bottom padding (`GraphPage.tsx:49`) · m5 `.nav a` active scale has no transition · m6 CountRing progress snaps (HomeView) · m7 no route-transition/sheet-exit anim · m8 hero radius off-token (`index.css:138`) · m9 magic font-size/spacing literals -> `--fs-*` tokens + 4px grid · m10 dead `.topbar`/one-off eyebrow · m11 `.lang-tag` chips ~4.0:1 contrast · m12 ConversationDetail "still processing" shows nothing (`:44`) · m13 Memory tab not deep-linkable -> `useSearchParams` · m14 `.score-bar` missing `role="meter"` · m15 Recap/Actions have no top-level home (consider a `Today` surface).

### Quick wins (highest impact, all S, all in `index.css` unless noted)
1. Mic resets (C1) — kills the square. 2. Ripple via transform/opacity (C1) — smooth recording. 3. Define `.btn.primary`, `.chip.warn`, `.trunc`, `.spin` (C4/C5/m1/m3) — restores CTA hierarchy + amber + truncation across 5/6 screens. 4. `.page-head` sticky wrappers (C2). 5. global `:focus-visible` ring (C6). 6. bump `--faint` (C7). 7. `.score-bar` -> `scaleX` (M1). 8. aria-labels on inputs/icon buttons (M2). 9. remove GraphPage inline padding (m4). 10. `.icon-btn` 44x44 (M3).

## 8. Parallel-safety matrix (avoid collisions)
Hot shared files: **`index.css`** (almost all UI audit items), **`schema.ts`** (serialize: reminders v3 -> recap v4 -> F1 next), **`sutra.ts` / `repo.ts` / `App.tsx`** (reminders + recap + onboarding), **`Settings.tsx`** (rerank + recap + onboarding + export), **`Capture.tsx`** (mic fix + capture-hardening + streaming), **`ConversationDetail.tsx`** (export + F1 + audit).
- The **UI/UX audit is mostly one big `index.css` pass** — best done by ONE agent as a single sweep (quick wins + C1–C7) to avoid self-collision, with per-page TSX wrappers (`.page-head`, classNames) as follow-on edits.
- Features that **bump schema** (reminders, recap, F1) must be **serialized**; everything else groups by the `[shared files]` lists in §6.
- Do file edits in the main loop (GateGuard); use workflows for read-only audit/design fan-out.

## 9. Suggested execution order for a fresh agent team
1. **UI/UX `index.css` sweep** (quick wins + C1–C7) — single agent, immediate visible payoff, unblocks the reported bugs. Then per-page TSX wrappers (C2 Step B, M-series aria/tap-targets).
2. **W1.A Keystore** + **W1.B Capture-hardening** in parallel (disjoint files).
3. **W2.A Rerank** then **W2.B Reminders (v3)**, then **W2.C Recap (v4)** last.
4. **C8 HomeView wiring** + **C10 foldable two-pane** (larger UI), then **W3** (export, onboarding, streaming).
5. **F1 speaker-naming confirm-UI** (closes Feature #1).
6. Gated items only after greenlight.

---
*Generated 2026-06-02 after on-device validation + a 9-agent UI/UX audit. Memory refs: `sutra-build-state.md`, `sutra-m0-decisions.md`, `feedback-verify-hardware-claims.md`. Full audit JSON archived in the session task output `w3dy6mh2p`.*
