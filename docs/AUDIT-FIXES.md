# Sutra — Audit Fix Log (overnight run, 2026-07-09)

Status of the six-agent audit findings after the autonomous fix pass. Verified changes are committed
to `feat/meeting-capture` (NOT pushed, NOT deployed). Legend: ✅ done+verified · 🟡 partial · 🚩 flagged (needs you).

## Verification (all green before commit)
- `tsc --noEmit`: clean · `vitest run`: 149/149 · backend `compileall app`: exit 0 · `ratelimit.py` self-check: OK
- Snyk unavailable in this environment (not connected) — relied on tests + compile + static checks instead.
- Backend runtime/pytest NOT run: neither interpreter has asyncpg/fastmcp + no Postgres here. Backend changes verified at compile + logic-self-test level only. Run `pytest` against a real DB to confirm.

## ✅ Done + verified (committed)
1. **Unauth `/api/*` P0 closed** — `main.py` no longer mounts the single-tenant router (kept `OVERRIDABLE` import for `_load_overrides`). Every `/api/*` route was unauthenticated (anon read/tamper + paid LLM/SMTP); now they 404. Zero clients used them (phone → proxy + Tier B only).
2. **Auth rate limiting** — new `backend/app/ratelimit.py` (in-process sliding window, 10/min/IP), wired onto `/auth/signup` + `/auth/login`. ponytail ceiling: per-process, resets on restart — swap for Redis if multi-worker. `/oauth/*` endpoints still unthrottled (same dep, trivial follow-up).
3. **CORS default** — `config.py` + `.env.example` now include `http://localhost` (Android WebView) + `capacitor://localhost` (iOS). Fresh deploys no longer break device sign-in/sync. (Electron `file://`/null origin still needs `allow_origin_regex` per deploy — noted, not added.)
4. **Frontend env loading** — added `frontend/.env.example` (Vite only reads `frontend/`); root `.env.example` VITE section now points there instead of documenting keys Vite never reads.
5. **Web FTS5 fix** — the FTS5 `sql-wasm.wasm` (working-tree build) is committed; the stale non-FTS5 blob no longer risks a DOA web build from a clean clone. Deleted the redundant `.sql-wasm-fts5-backup.wasm`.
6. **Marketing honesty** — PRODUCT.md/README.md/FEATURES.md: dropped false "no account / works out of the box" (account is now required); qualified "hardware-backed key" (Android keystore / desktop OS-keychain, not universal); "one-tap email draft" retagged *Later* (generator exists, no UI button).
7. **.gitignore** — added `frontend/out/`, `graphify-out/`, `.impeccable/`, `*.sql-wasm-fts5-backup.wasm` (were ~16M of sweepable artifacts).
8. **Dead code removed** — `config.py` `window_max_seconds`/`window_min_seconds`/`recap_timezone` (0 refs); `services/util.py` `to_pgvector` (0 refs); `.env.example` personal email in `RECAP_TO` blanked. (Kept `daily_rollup` — the audit called it dead but it has 8 live refs.)
9. **Outstanding WIP committed** — `mcp-server/` (was 100% untracked), `frontend/ios/`, the redesign pages/libs, and the pending tracked deletions are now in git so the P0 data-loss risk is closed. Source only — node_modules/out/dist stay ignored.

## 🚩 Flagged — cannot complete autonomously (need you / external resources). Recipes:

**TLS end-to-end (#7) — the top launch blocker.** Needs a domain + certs + deploy; can't provision here.
Recipe: put Caddy in front of both services (auto-HTTPS), then flip Capacitor.
- `docker-compose` add: a `caddy` service reverse-proxying `api.<domain>`→control-plane:8000 and `proxy.<domain>`→proxy:8787; Caddy fetches Let's Encrypt certs automatically.
- `frontend/capacitor.config.ts:14`: make scheme conditional — `androidScheme: process.env.SUTRA_PROD === "1" ? "https" : "http"`, drop `cleartext`/`allowMixedContent` in prod. (NOT applied — would break your current `adb reverse` USB dev flow; apply when you cut a release.)
- Set `frontend/.env` `VITE_API_URL`/`VITE_PROXY_URL` to the https hosts.

**Deploy control plane over HTTPS (#8)** — the mandatory account gate is unusable in the wild until the box at 187.127.172.178 serves the control plane over HTTPS with `SUTRA_JWT_SECRET` set. (Not deployed — I don't push/deploy autonomously.)

**Proxy token revocation (#13)** — a deleted user's unexpired JWT still works on the cost-center proxy for ≤7 days. Exact fix in `proxy_gate.py`: when the DB is reachable, verify the user row still exists and 401 if gone. Add to `check_quota` (or `require_user`) a `SELECT 1 FROM users WHERE id=$1`; on empty → `_unauthorized("account_gone")`; keep fail-open when DB is down. NOT applied blind — it's on the hot recording path and I can't runtime-verify it without Postgres; getting it wrong 401s every recorder.

**Password reset + email verification (#11)** — needs: `password_reset_tokens` table + `users.email_verified`, `POST /auth/request-reset` + `/auth/reset` + `/auth/verify`, single-use hashed tokens, and SMTP delivery (config already exists). Sizable + live-DB schema change + unverifiable here → build against a real DB and test.

**Privacy policy + ToS (#14)** — drafts in `docs/legal/` (grounded in real app behavior). REQUIRE a lawyer's review + a hosted URL before store submission. Store listings (Play + App Store) hard-require the privacy-policy URL.

**iOS background audio (#15)** — `Info.plist` has no `UIBackgroundModes`; ambient capture dies on lock. Needs a native `AVAudioSession`/`AVAudioEngine` plugin (real work, Mac + Xcode). NOT adding the plist key blind — declaring an unused background mode risks App Store rejection. Descope iOS for v1 or schedule the native work.

**App signing / release (#16)** — no signing config on Android/iOS/Electron, no CI. Needs keystores + store accounts (yours). Unsigned artifacts are Gatekeeper/Play-blocked.

**Billing / upgrade UI (#17)** — 402 metering is live but a capped user has no way to pay. Needs a payment provider (Stripe) + product decision.

**Web read lens (#18)** — `/sync` is push-only; no `/me/*` read API. Per memory the reads exist in `tenant.py` and just need REST wrappers — a contained backend build, then the web UI to consume it.

**Orphaned `/api` pipeline physical deletion (#2b)** — now unmounted = unreachable = harmless. Physically deleting `api.py` + the orphaned services/scheduler/seed (~1,600 LOC, −4 deps) needs relocating `OVERRIDABLE` and pruning tests; deferred to a reviewed follow-up rather than a blind 3am mass-delete.

## Minor / follow-ups
- `proxy_accept_shared_secret` defaults `true` (config.py:117) — flip false after the account cutover so an APK-baked secret can't get uncapped dev-plan access.
- Proxy CORS defaults to `*` (proxy.py) — tighten `PROXY_ALLOWED_ORIGINS` in prod.
- Landing 3D deps (`three`/`@react-three/*`/`gsap`/`postprocessing`/`maath`) still in package.json — routes are unmounted so they no longer ship, but removing the deps needs `npm install` to update the lockfile (didn't run installs); `maath` is fully dead.
- `.env.example`/`config.py`/eval filenames still name models/vendors — fine internally; scrub before any open-source.
- iOS Info.plist has no cloud-backup exclusion analogous to Android's `allowBackup=false` — review before iOS ship.
