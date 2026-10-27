# Build history — as-built internals, redesign, UX audit, bug hunt

> Compressed from `handoff.md`, `PHASE-1-2.md`, `redesign-plan.md`, `UX-AUDIT.md`,
> `UX-FIXES.md`, `gaps.md`, and `issues.md`. These describe **shipped / superseded** work.
> Current truth lives in [`../OVERVIEW.md`](../OVERVIEW.md), [`../FEATURES.md`](../FEATURES.md),
> [`../ROADMAP.md`](../ROADMAP.md), and [`../../RUN-ON-DEVICE.md`](../../RUN-ON-DEVICE.md).

---

## 1. As-built internals (from PHASE-1-2)

### Two privacy promises (verbatim — never conflate) — `providers/index.ts` MODE_COPY
- **Hybrid** (default, "Hybrid (best accuracy)"): *"Audio is processed in the cloud and never
  stored."* Audio sent in-flight to proxy `/transcribe`, never persisted client or server.
- **On-device** ("On-device (max privacy)"): *"Audio never leaves your device."* Currently a
  **STUB** — `OnDeviceProvider` throws "not installed yet"; the promise becomes literally true
  only when the Phase 3/4 models ship.

### Proxy contract (`backend/app/proxy.py`, FastAPI :8787, stateless, no DB)
- `/transcribe` is the ONLY audio endpoint: reads upload into memory, forwards, `del audio` in
  `finally`. Other four are text-only: `/extract`, `/embed`, `/rerank`, `/chat`. Holds the
  cloud key server-side.
- `_meter(user, kind)` = in-memory per-user usage counter (placeholder, not durable); `/usage`
  exposes it. BYO-key scaffolded but OFF (`X-OpenAI-Key` header per-request).

### On-device SQLite + SQLCipher (`frontend/src/local/`) — `PRAGMA user_version` migrations
Tables: people (is_me, provisional, reserved voiceprint BLOB + voiceprint_dim), sessions, turns
(session_speaker_label, person_id, text, lang, conversation_id, redacted), conversations
(participants JSON), memories (summary, facts, action_items, decisions, importance, type_tags,
embedding), entities (type, canonical_name, norm_name, attrs, embedding, mention_count), edges
(bi-temporal), action_items (owner, status, due, generated_draft), daily_rollups, settings
(single-row JSON). *(The schema has since advanced to v7 — see [`YOUR-CONTEXT.md`](./YOUR-CONTEXT.md).)*
- Embeddings stored as BLOB Float32 + embed_model/embed_dim (`vecToBlob`/`blobToVec` in util.ts);
  jsonb→TEXT via JSON1; edges carry valid_from/valid_to + ingested_at (bi-temporal) — `upsertEdge`
  updates valid_to + appends evidence on conflict; `memories_fts` contentless FTS5
  (content='', tokenize='unicode61 remove_diacritics 2', rowid=memories.id).

### Retrieval (`search.ts`) — exact formula
1. Semantic: brute-force cosine KNN over all embeddings, keep top `search_prefetch` (30).
2. Lexical: FTS5 BM25. 3. Fuse: RRF k=60 (`rrf += 1/(k+rank+1)`, **fuse on rank, never raw scores**).
4. Recency: `0.5^(age_days/half_life)`, `rank_half_life_days=30`.
5. `score = w_rrf·norm(rrf)·recency·(1 + w_imp·importance)`, `w_rrf=1.0`, `w_imp=0.5`.
6. Optional LLM rerank (default OFF, falls back to fused order). Later optimization = sqlite-vec
   ANN (changes only candidate-fetch, not the formula).

### Knowledge graph (`graph.ts`)
- `upsertEntity`: exact (type, norm_name) match → else embedding cosine vs same-type at
  `entity_sim_threshold` 0.86 → else insert.
- `expand()`: WITH RECURSIVE bidirectional traversal up to hops (capped 3); `graphOverview()`
  seeds from most-mentioned; `nearestEntities()` cosine-KNN seeds graph-RAG chat.

### Training corpus (`training.ts`) — opt-in, on-device encrypted, never auto-uploaded
Tables: training_samples (source, lang, consent_version, redacted, has_audio, model_id,
prompt_version, conversation_id, transcript), training_extraction (raw + corrected gold),
training_asr, training_audio (BLOB+mime), training_edits (append-only). Two tiers: text
(`training_optin`) vs audio (`training_audio_optin`). `PROMPT_VERSION='extract-v1'`,
`CONSENT_VERSION='dpdp-v1'`. `exportJSONL(kind)`: extraction→SFT messages,
asr→{audio_base64,mime,text,lang}. Keep a strict held-out split between the training corpus and
`evals/gold/`.

### Eval harness (`evals/`) + the ON-DEVICE GATE (hard rule, enforced in run.py + README)
Gold = one JSON/line in `gold/*.jsonl` (lang hi|en|hi-en drives the subset split; audio optional
→ WER/CER via jiwer). Cloud baseline (6 samples): overall action-item F1 0.976, Hinglish F1
0.971, entity F1 0.691. **GATE:** an on-device model becomes default ONLY IF, on the hi-en subset,
action-item F1 ≥ 0.874 (=0.90×0.971) AND CER ≤ 1.2× the cloud CER baseline.

### Known-unvalidated (web only)
jeep-sqlite ↔ sql.js wasm version mismatch means the web dev fallback may not open and lacks
FTS5; native Android uses real SQLite (product path unaffected).

## 2. Build / deploy + dev notes (from handoff)

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"; export PATH="$PATH:$ANDROID_HOME/platform-tools"
cd frontend && npm run build && npx cap sync android
cd android && ./gradlew assembleDebug        # add `clean` only when Java/native changed
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell pm grant app.sutra.memory android.permission.RECORD_AUDIO
adb shell pm grant app.sutra.memory android.permission.POST_NOTIFICATIONS
adb reverse tcp:8787 tcp:8787                 # phone reaches Mac proxy over USB
# Proxy is a BAKED docker image (no volume mount, no --reload): rebuild after editing backend/app
docker compose build proxy && docker compose up -d proxy
```

**Device gotchas:**
- `adb` "no devices found" intermittently = stale ADB server: `adb kill-server && adb start-server`.
- Foldable `screencap` to stdout is corrupted by a multi-display warning; write on-device then pull.
- Benign "16 KB libsqlcipher.so not aligned" dialog on debug; real fix = 16KB-aligned SQLCipher
  for a Play release.
- `window.__sutra` console handle + inspectable WebView are DEV-build ONLY; on-device CDP /
  `chrome://inspect` needs a dev build, not the production APK. WebView debug:
  `adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof app.sutra.memory)`.

**Hard constraints:**
1. Privacy invariant: never write raw audio to durable storage; export/share = derived text only.
2. Hinglish quality bar: Hindi renders in Devanagari, primed via `settings.transcribe_prompt`.
3. On-device sherpa-onnx ASR, Gemma LLM, ECAPA voiceprint (Phase 3/4) are GATED; `OnDeviceProvider`
   stays a stub until owner greenlight.
4. **`SCHEMA_VERSION` serialization rule** (`frontend/src/local/schema.ts`): `db.ts` runs a
   forward-only `cur+1..SCHEMA_VERSION` migrate loop. Each schema-bumping feature claims the NEXT
   integer in build order and rebases — **two features writing the same `MIGRATIONS` index silently
   clobber.**

**Proxy hardening env (OFF by default; USB/LAN unchanged):**
- `PROXY_SHARED_SECRET` → every request must send a matching `X-Sutra-Secret` (constant-time,
  else 401); frontend sends it when `VITE_PROXY_SECRET` is set at build.
- `PROXY_ALLOWED_ORIGINS` (comma-separated CORS allowlist; defaults `*`).
- `MAX_UPLOAD_MB` (cap on `/transcribe`, default 30, 413 if exceeded).

## 3. UI/UX redesign decisions (from redesign-plan — BUILT across 5 phases)

Ground rule: zero feature loss; reuse the existing `index.css` token system; no
framework/rebrand/capture-logic change.

- **Move 1 — IA:** nav = 4 tabs `Home(mic) · Memory · Ask · Settings`; Graph moves inside Memory
  as a 3rd segment (Conversations · Actions · Graph), `/graph` kept as a deep link. Capture becomes
  Home with a "Today" snapshot (open action items, upcoming events, Continue card) from existing
  api calls.
- **Move 2 — Memory:** persistent search field in `.page-head` (Search segment removed, search
  ambient); date-group rows (Today/Yesterday/This week/Earlier); humanized importance chip (no chip
  <0.5, "Notable" 0.5–0.75, "Important" >0.75 — raw float only on Detail); Actions grouped
  Overdue/Today/Later/Done.
- **Move 3 — ConversationDetail:** two segments `Overview · Transcript` (pill-toggle);
  speaker-rename signifier = Pencil icon + one-time hint chip; section anchor chips scroll-to-section.
- **Move 4 — Settings:** hub-and-spoke routes (Appearance, Capture & language, Your Context,
  People & voices, Connections [MCP + Cloud sync as 2 sections of ONE page], Daily recap, Advanced
  [models/ranking, training, sessions debug]); each subpage fetches only its own data (fixes the
  Settings over-fetch).
- **Move 5 — visual:** type-scale tokens `--fs-xs/-s/-body/-l/-xl/-title` (12/13/15/17/20/26),
  kill sub-12px; spacing snap to 4/8/12/16; card-hierarchy rule (heavy card only for the one
  featured object, flat rows for lists); contextual header actions; record-start/stop haptics;
  wire-or-delete `.two-pane`/`.page.wide`.

**Defects fixed by the redesign (verify in a build):**
- Sev4: onboarding leaked raw SQL errors ("no such module: fts5") and `finish()` refused to
  complete → trapped first-run. Fix: route through `isBenignError` sanitize; complete onboarding +
  queue settings write on benign failure.
- Sev3: switching tabs mid-recording silently killed the recording (Capture unmount `ctrl.stop()`
  never closed/processed the session); no Android hardware backButton listener. Fix: guard nav while
  recording or auto-run full `stop()` on unmount + add a backButton listener (`@capacitor/app`).
- Sev3: Ask thread lost on every tab switch (`msgs` was component state). Fix: lift to module scope /
  sessionStorage.
- Sev2: Settings pill-toggles lacked `role=radiogroup`/`aria-checked`.

## 4. UI/UX audit (from UX-AUDIT) — Nielsen + WCAG 2.2 + CWV

- **Section A (DONE/shipped):** error-resilience refactor (`Promise.allSettled` + sectioned inline
  retry, dismissible banner), contrast token bump, nav aria-label + aria-current, Capture/Onboarding
  dead-zone tightening, stable list keys, ConversationDetail header title, reduced-motion gating,
  tablist roles, chat auto-scroll fix, conversation `status` → real "Processing" vs "Couldn't process
  — open to retry."
- **Section B (deferred, largely subsumed by the shipped redesign):** large-viewport/desktop
  adaptation (constrain max-width or a side rail ≥1024px), light-theme toggle (`[data-theme=light]`
  tokens exist), full font-size-token refactor, Settings over-fetch → targeted refreshes. Open polish:
  search-results loading skeleton.
- **Known render limitation:** the local web build can't open populated data (sql.js lacks FTS5;
  device build has it) — populated Memory/Conversation visuals are `needs-verification` on device.

## 5. UX fix worklist hard-constraints (from UX-FIXES) — durable cross-cutting guidance

1. Never expose AI model/vendor names in user-facing copy/docs/shipped comments (competitive rule).
2. Never persist raw audio; don't wire any audio-capture/training path. Audio in-flight only.
3. Don't break the USB/no-env dev path — proxy auth is optional (only when an env secret is set);
   no env var required.
4. Dark-first; light theme is additive.
5. The "COST CRITICAL $…" / "SCOPE WARNING" hook lines are a known-spurious plugin bug — ignore.
6. Web build runs without FTS5 (sql.js); "no such module: fts5" warnings are expected on web —
   verify populated-data screens on device.

Selected durable fix decisions: header matches nav frosted treatment
(`color-mix(in srgb, var(--bg) 72%, transparent)` + backdrop-blur), `theme-color` aligned to `--bg`
`#0a0912`; raw ranking knobs hidden behind an Advanced `<details>` with min/max/step and friendlier
labels ("Standard" / "Smarter (slower)"); `.btn.sm` min-height 38→44px; light-theme toggle
(System/Dark/Light) persisted in `localStorage sutra_theme`, applied in main.tsx before render;
`<meta name="mobile-web-app-capable" content="yes">`; dead `HomeView`/`Preview`/`preview.tsx`
deleted after confirming no build-entry references.

## 6. iOS port — remaining native work (from gaps, audit 2026-06-05)

Android builds/installs/runs on device with mic + notification perms + adb-reverse proxy. iOS is
scaffolded (`frontend/ios` Capacitor target, native plugins, Info.plist perm strings, SQLite
encryption config) but **NOT build-validated**.

- **P0:** CocoaPods not installed → `npx cap sync ios` skips `pod install` (install CocoaPods, sync,
  open Xcode, set signing, build to device). iOS screen-off/background capture is Android-only
  (Android has `MicForegroundService`); iOS needs a Capacitor Swift plugin using `AVAudioSession` +
  `AVAudioEngine`/`AVAudioRecorder`, with `UIBackgroundModes=audio` only under a clear product policy.
  iOS App Review / privacy policy for always-listening not yet formalized.
- **P1:** Capacitor CLI dev-audit flags `tar` via @capacitor/cli@6 (the npm fix path breaks Capacitor 8);
  iOS notifications not device-validated; **iOS proxy workflow undocumented** (Android uses adb reverse;
  iOS needs a LAN IP `VITE_PROXY_URL=http://<Mac-LAN-IP>:8787` or an HTTPS tunnel); some Settings still
  HTML selects/numeric; graph still canvas-primary; iOS first-run mic rationale needs a pre-permission screen.

## 7. Bug hunt — 45 single-file defensive fixes (2026-06-09/10, all APPLIED, build green)

All were defensive crash-guards that remove crash modes without changing happy-path behavior; none
were release blockers. Most load-bearing (real capture/processing loop):
- `capture.ts:175` — `MediaRecorder.start()` throw left capture running with an inactive recorder
  (silent audio drop); now tears down + reflects failure on the catch path.
- `Capture.tsx` — top-level route had no unmount cleanup → navigating away mid-recording orphaned the
  CaptureController (mic/AudioContext leak); added `useEffect(() => () => { void ctrlRef.current?.stop();
  ctrlRef.current=null; }, [])`.
- `cloudProvider.ts` — client abort timeout 60000ms was below the server's 180s budget for /extract +
  /chat (long meetings aborted); raised the json() default to 180000.

Other notable contracts surfaced:
- `api.py` recap & `scheduler.py` cron defaulted day to UTC but `build_rollup` filters by
  `app_timezone` (Asia/Kolkata) → near-midnight wrong-day; default in app_timezone.
- `search.ts` — `num()` settings helper `|| d` treats a user-configured 0 as falsy (e.g.
  rank_w_importance=0 is valid); fall back only on missing/NaN. rank_recency and rerank=crossencoder
  modes were silently ignored on device.
- `ingest.ts:24` — `translate: langCfg.translate` was a dead no-op (no provider/proxy read
  opts.translate); English-translate didn't work. Later fixed properly via `provider.translate()`.
- `capture.ts:149` — last-resort getUserMedia fallback `{audio:true}` re-enabled Android DSP
  (echoCancellation/noiseSuppression/AGC); honor Android-safe constraints.
- `main.py` SPA catch-all served `STATIC/full_path` with no containment check (path traversal); added
  `resolve()` + `startswith` guard.
- H1: runtime settings mutated a process-global singleton (`api.py put_settings_ep`) → now a DB-backed
  runtime-settings accessor in config.py (backend-variant only).
- Hindi-cleanup gap: english-mode "Clean up transcript" now routes through `provider.translate()` then
  a conservative de-noise (`refinement.ts`); non-English de-noises only (keeps script).

Scope legend: 📱 phone path (frontend+proxy, the installed app) vs ⚙️ backend-only (the server-side
full-app variant the phone doesn't use yet) — many fixes are backend-variant or cosmetic.
