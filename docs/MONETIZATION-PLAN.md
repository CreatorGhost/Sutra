# Sutra — Accounts, Subscriptions & Cloud-Data Plan (control plane)

> **Status: PROPOSED v2 — awaiting build approval. No code changes yet.**
> Owner decisions (2026-06-11/12):
> 1. **Hybrid model** — an account is **required** to use the app; identity, signups, and
>    purchases are tracked in **our database**. Memory stays on-device.
> 2. **Subscription tiers** exist in the schema from day 1, **but everything is free during
>    the testing phase** — billing ships later; usage is still metered now (that data is how
>    we price the tiers).
> 3. **Cloud sync is opt-in**: if the user allows sync, we keep their data in our DB; **the
>    moment they want it deleted, we delete it** — deletion is a first-class feature, not a
>    support ticket.

---

## 1. The model in one picture

```
┌─ PHONE (data plane — THEIR data) ─────────────┐     ┌─ OUR SERVERS (control plane — OUR data) ──────┐
│ memory, graph, priors: encrypted SQLite        │     │ users / entitlements / usage / billing         │
│ works offline forever, account or not          │     │ (Postgres — extends the existing Tier B DB)    │
│                                                │     │                                                 │
│ capture → audio in-flight ───────────────────────────► PROXY :8787  (content-stateless, as today)     │
│           + Authorization: Bearer <user JWT>   │     │   1. verify JWT (HS256, SUTRA_JWT_SECRET)       │
│                                                │     │   2. entitlement check (cached) → 402 if over   │
│ signup/login ────────────────────────────────────────► CONTROL PLANE :8000 (/auth/* — already built)   │
│                                                │     │   3. meter usage (async, durable)               │
│ OPT-IN: cloud sync of memory ────────────────────────► Tier B /sync (built) — THEIR data, held only    │
│   "Delete my cloud copy" / "Delete account" ─────────►   while they want it; deleted on demand         │
└────────────────────────────────────────────────┘     └─────────────────────────────────────────────────┘
```

**Why this answers the business problem:** every valuable action (transcribe / extract /
embed / rerank / chat) must flow through our proxy and costs us provider fees. That is the
unavoidable, per-user meterable choke point. We never need the user's *memory* in our DB to
bill them — only their *identity and entitlement*. No payment (post-testing) → no new
processing. Existing on-device memory is never held hostage (brand-critical + DPDP/GDPR-clean).

**Privacy invariants (unchanged, restated):** audio in-flight only, never persisted; proxy
stays **content-stateless** (it gains auth + counters, never user content); memory enters our
DB **only** via the explicit sync opt-in, and leaves it the moment the user asks.

**Honest copy (ships with the gate):** *"Your account activates Sutra and manages your plan.
Your memory stays on your device — an account does not upload anything. If you turn on cloud
sync, we store a copy so you can reach it anywhere; delete it from Settings at any time."*
Marketing sweep needed when this ships: PRODUCT.md "No subscription wall to start" and
README/OVERVIEW "no accounts" claims must be revised.

---

## 2. What already exists (reuse, don't rebuild)

| Piece | Where | State |
|---|---|---|
| Users + signup/login/me, argon2, HS256 JWT (`mint_token`/`current_user`) | `backend/app/auth/` | ✅ built + tested (Tier B) |
| Google/Facebook sign-in scaffold | `backend/app/oauth/social.py` | ✅ env-gated |
| Opt-in cloud sync of the share_cloud projection | `backend/app/sync.py` | ✅ built + tested |
| **`ON DELETE CASCADE` on every user-data table** | `schema.sql:250,289,303` | ✅ account deletion = one row delete |
| Per-table `DELETE FROM … WHERE user_id=$1` pattern | `sync.py:94-105` | ✅ reuse for "delete my cloud copy" |
| Proxy auth seam (`require_secret`, constant-time) on all 5 routes | `proxy.py:27-35` | ✅ shared-secret today |
| Per-user metering hook — `_meter(x_sutra_user, kind)` on every endpoint | `proxy.py:42-44, 83-144` | ✅ in-memory placeholder |
| Single client seam for headers (`fetchT`) | `frontend/src/providers/cloudProvider.ts:13-21` | ✅ one place to add Bearer |
| Onboarding step machine | `frontend/src/components/Onboarding.tsx` | ✅ insert one step |
| SignIn page + auth lib (JWT storage, 401 handling) | `frontend/src/pages/SignIn.tsx`, `lib/auth.ts` | ✅ built |
| Postgres in stack | docker compose `db` | ✅ |

**The actual gaps:** per-user proxy auth (today one shared secret baked into the APK — all
users identical, can't track or cut off anyone), durable metering + quotas, the account step
in onboarding, the two deletion endpoints + their UI, billing (deferred).

---

## 3. Control-plane schema (new tables, alongside Tier B's `users`)

```sql
CREATE TABLE plans (
  id            text PRIMARY KEY,              -- 'testing' | 'free' | 'pro' | … | 'dev'
  name          text NOT NULL,
  transcribe_seconds_month integer,            -- NULL = unlimited (named transcribe_*, not audio_*:
                                               -- the no-audio-columns invariant test bans audio-like names)
  ai_calls_month        integer,               -- extract+chat+embed+rerank combined; NULL = unlimited
  price_inr_month       integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entitlements (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id       text NOT NULL REFERENCES plans(id) DEFAULT 'testing',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','past_due','canceled')),
  period_start  timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  override_caps jsonb NOT NULL DEFAULT '{}',   -- per-user exceptions (comps, abuse clamps)
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_events (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN ('transcribe','voiceprint','extract','chat','embed','rerank')),
  amount    numeric NOT NULL,                  -- transcribe: audio SECONDS; others: 1 per call
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_user_month ON usage_events (user_id, kind, at);
```

**Seeded plans for the testing phase:**
- `testing` — **default for every signup**. Feels unlimited, but carries a high *abuse
  ceiling* (recommend ~1,000 min audio + 5,000 AI calls/month) — the proxy is on a public IP
  and pays our provider bill; an uncapped free plan invites a five-figure surprise. Real
  testers will never hit it; a scraper will.
- `dev` — NULL caps (truly unlimited), assigned to our own accounts.
- `free` / `pro` / (more tiers as you decide) — **rows exist with placeholder prices, nothing
  enforces them yet.** When testing ends: set real prices, flip the signup default from
  `testing` → `free`, existing testers stay grandfathered until you migrate them.

"Who signed up" = `users` (+ `created_at`); "who bought" = `entitlements.plan_id/status`
(+ Phase-B payment records). Both queryable with plain SQL — no admin UI built until needed.

---

## 4. Cloud-sync data lifecycle & deletion (owner decision #3)

Sync stays exactly as built (opt-in, share_cloud-respecting projection). What's added is the
**exit path**, as product UI:

1. **`DELETE /sync` — "Delete my cloud copy"** (authed). Deletes **all** of the caller's
   synced rows — same table list `sync.py` already maintains, but unconditional (device
   **and** mcp-origin rows). Runs in one transaction, returns per-table counts so the app can
   show "Deleted N conversations, M memories…". Idempotent. Account + plan survive; sync can
   be turned back on later. Also flips the server-side sync state so nothing re-appears until
   the user re-syncs.
2. **`DELETE /auth/account` — "Delete my account"** (authed + fresh password confirm; social
   accounts confirm by typed email). One `DELETE FROM users WHERE id=$1` — the verified
   `ON DELETE CASCADE` wipes memory projection, entitlements, usage, audit log, OAuth
   clients/tokens, settings, everything. Tokens die immediately (`current_user` looks the row
   up per request → 401). The phone keeps its local memory untouched and returns to the
   onboarding account step.
3. **App UI:** Settings → Connections → Cloud sync gains **"Delete my cloud copy"** (two-step
   confirm, shows returned counts). Settings → Account gains **"Delete my account"** (two-step
   + password confirm).
4. **Guard:** both endpoints refuse the legacy single-tenant *system user* (sys_uid) — that
   sentinel owns pre-Tier-B rows and must never be deletable via API.
5. **Honesty:** deletion is immediate from the live database; no DB backups are configured
   today, so it is also complete. If/when backups are added, the copy must state the backup
   retention window — never silently keep ghosts.

## 5. Proxy changes (`backend/app/proxy.py`) — the enforcement point

1. **Auth:** extend the existing dependency to accept `Authorization: Bearer <JWT>` —
   verify HS256 with the same `SUTRA_JWT_SECRET` (no network hop; reuse `auth/security.py`).
   `sub` = user_id; claims add `aud:"sutra-app"`.
   - Transition: env `PROXY_ACCEPT_SHARED_SECRET=true` keeps `X-Sutra-Secret` working for
     old installs (maps to a sentinel `legacy` user on the `dev` plan). Flip off after cutover.
   - 401 body gains machine-readable codes: `{"code":"token_expired"}` vs `{"code":"unauthorized"}`.
2. **Entitlement gate:** before doing work, check month-to-date usage vs plan caps.
   - Proxy gets a **read-mostly Postgres connection** (first DB in the proxy — fine because it
     stores **zero user content**; content-statelessness is the invariant, not DB-lessness).
     Entitlement+usage snapshot cached in-process per user, **60s TTL**.
   - Over cap → **`402 {"code":"quota_exceeded","kind":"transcribe","resets_at":"<ISO>"}`**.
     During testing this only fires at the abuse ceiling.
3. **Durable metering:** `_meter()` enqueues to an in-process buffer; a background task
   batch-inserts `usage_events` every ~5s (never blocks or fails a user request). Transcribe
   meters seconds from the provider's `duration`.
4. **`/usage` endpoint** becomes real: authed, returns month-to-date by kind + caps +
   resets_at (Settings → Account reads this).
5. DB unreachable → **fail open** for cached-`active` users, fail closed for unknown tokens.

## 6. App changes (`frontend/`)

1. **Onboarding gains one step:** welcome → privacy → **account** → capture-mode → language.
   Sign in / create account / Continue with Google (when enabled), reusing `lib/auth.ts` +
   the SignIn patterns. Blocking (the decision); requires network — capture is
   network-dependent anyway, so nothing usable is lost. Honest copy per §1.
2. **`cloudProvider.fetchT`** attaches `Authorization: Bearer <token>` (during transition it
   sends both Bearer and the legacy `X-Sutra-Secret`).
3. **New UX states:** `402 quota_exceeded` → friendly "Monthly limit reached — resets <date>"
   card on Capture (+ upgrade CTA post-testing); `401 token_expired` → silent re-auth prompt;
   processing paused, never lost (existing retry/recovery already handles failed windows).
4. **Settings → Account section:** email, plan name, usage meter (from `/usage`), sign out,
   **Delete my account**. Cloud-sync section gains **Delete my cloud copy**.
5. Existing installs (update path): no stored token at launch → the account step shows once.
   Local data untouched.

## 7. Phase 0 prerequisite — TLS (non-negotiable before real accounts)

Passwords and bearer tokens never travel plain HTTP. Before Phase 1 reaches any real user:
a domain + HTTPS in front of :8000 and :8787 (Caddy auto-TLS on the box, or a Cloudflare
Tunnel — **needs a domain name from the owner**). Capacitor flips to `androidScheme:"https"`
+ cleartext off in the same release.

Logistics: the server has **no registry egress** (`docker pull` fails) — ship Postgres/Caddy
images via `docker save | ssh … docker load`, as done for `sutra-proxy`.

## 8. Phases & verification gates

| Phase | Scope | Gate |
|---|---|---|
| **0. TLS** | Domain + Caddy/CF-tunnel for :8000/:8787; HTTPS APK config | `curl https://…/health` green; APK talks HTTPS |
| **1. Control plane + sync + delete** | Deploy full Tier B server (auth **+ sync + hosted MCP** — all built) + `plans/entitlements/usage_events` migration + seeded `testing`/`dev` plans + **both deletion endpoints** | signup→login→sync→`DELETE /sync` returns counts→re-sync works; `DELETE /auth/account` cascades clean (SQL-verified); pytest additions green |
| **2. Proxy gate + app** | Proxy JWT verify + entitlement check + durable metering + real `/usage`; app onboarding account step + Bearer header + 402/401 UX + Account settings + both delete buttons; dual-accept transition flag ON | E2E: fresh install → signup → capture works (testing plan) → clamp user via `override_caps` → quota card shows, old memory fine → delete cloud copy → counts shown → delete account → app returns to account step, local data intact; legacy APK still works |
| **3. Pricing + billing** (after testing) | Set real tier prices; flip signup default `testing`→`free`; Razorpay (India) and/or Stripe — checkout + webhooks → `entitlements`; upgrade CTA | sandbox payment → plan flips → caps lift; webhook replay-safe |
| **4. Hardening** | Refresh-token rotation for app sessions (reuse the connector's rotating-refresh infra), rate limits, `PROXY_ACCEPT_SHARED_SECRET=false` cutover | — |

Rough effort: P0 small · P1 small-medium (deploy + one migration + 2 endpoints) · P2 the real
work (proxy ~1 module + app ~5 touchpoints) · P3 medium, isolated, post-testing.

## 9. Deliberately deferred / open knobs

- **Tier names and prices** — schema-ready; business decision when testing ends.
- **Payment provider** (Razorpay vs Stripe vs both) — Phase 3.
- **Testing-plan abuse ceiling** (proposed 1,000 min + 5,000 calls/month) — tune anytime via
  one SQL UPDATE.
- **Anonymous trial** ("try before creating an account") — cheap later via a device-scoped
  token; out of scope per the account-required decision.
- **BYO-key tier** (`X-OpenAI-Key` path already scaffolded) — possible power-user plan.
- Usage rollup table, device binding, IP rate limits — add when measurements demand.
