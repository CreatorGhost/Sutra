# Cross-Device Sync Test Runbook (phone + laptop, ONE account)

**Goal:** get Tier B cloud sync actually working and prove it end-to-end across two clients
(laptop web app + Android phone) signed into the **same account**.

**Target chosen (simplest viable):** the **already-running LOCAL Docker stack** on this Mac
(`sutra-backend-1` on `:8000`, `sutra-db-1` on `:5433`, proxy on `:8787`). The remote test box
`187.127.172.178` is **unreachable** right now (connection times out), so it is NOT used.

> **Read this first — what sync actually is in this codebase.** Sync is **manual, opt-in, and
> one-way (phone → server).** There is **no auto-push** after a conversation and **no auto-pull**
> on the other device. The ONLY trigger is the user tapping **"Sync my memory now"** in
> **Settings → Connections**. The server is push-only: it stores a privacy-filtered REPLACE of the
> phone's memory under your user id. **There is no `/sync` GET / download endpoint.** The laptop web
> app reads the server copy via the **read** path (the hosted MCP / `/me` read services), NOT via a
> sync-down. So the realistic E2E test is: **record on the PHONE → "Sync my memory now" on the phone
> → read it back from the SERVER on the laptop.** (A phone↔phone "edit on B shows on A" loop does not
> exist; the phone is the single source of truth.) See "Honest scope" at the bottom.

---

## Current state (verified on this Mac, 2026-06-26)

| Thing | State | Consequence |
|---|---|---|
| `sutra-backend-1` (`:8000`) | **Up** | Control plane is live but Tier B is **OFF** |
| `sutra-db-1` (`:5433`) | **Up, healthy** | DB is ready; no DB work needed |
| proxy (`:8787`) | **Answering** (`{"service":"sutra-proxy"}`) | AI calls work; must share the JWT secret once Tier B is on |
| `SUTRA_JWT_SECRET` | **UNSET** in `.env`, `backend/.env`, and inside `sutra-backend-1` | `/auth/*` and `/sync` return 503 / fall through to SPA → **no account can be created, no sync possible** |
| `GET /.well-known/oauth-authorization-server` | HTTP 200 **HTML** (not JSON) | Confirms Tier B is disabled (SPA catch-all is handling `/auth` paths) |
| `POST /auth/signup` | **405** | No live signup endpoint yet |
| `adb` | `/opt/homebrew/bin/adb` present | Phone-over-USB path is available |
| `frontend/.env*` | none exist | Laptop/phone default to `localhost:8000` / `localhost:8787` until set |

**The one blocker between "now" and "works": Tier B is disabled.** Step 1 turns it on.

---

## Conventions

- **[AGENT]** = run on this Mac (the agent does it).
- **[USER]** = you must do it on the **physical phone** (the agent cannot touch the phone screen).
- Replace `<JWT_SECRET>` everywhere with the value generated in Step 1.
- Test account used below: email `tester@sutra.local`, password `testpass123` (≥8 chars). Change if you like.

---

## STEP 1 — [AGENT] Enable Tier B on the local backend (auth + sync + same secret on the proxy)

The backend and proxy share one `.env` via `docker-compose.yml` (`env_file: .env` on both), so setting
the secret **once** in the root `.env` makes both services agree (the proxy verifies the user JWT
**locally** with HS256 using the identical secret — a mismatch silently rejects every token).

```bash
cd /Users/adityapratapsingh/code/Sutra

# 1a. Generate a strong secret and write it into the root .env (the file BOTH services load).
SECRET=$(openssl rand -hex 32)
# Replace the empty "SUTRA_JWT_SECRET=" line in .env with the generated secret.
# (.env.example line 102 documents this key; the real .env may not have it yet.)
if grep -q '^SUTRA_JWT_SECRET=' .env; then
  sed -i '' "s|^SUTRA_JWT_SECRET=.*|SUTRA_JWT_SECRET=${SECRET}|" .env
else
  printf '\nSUTRA_JWT_SECRET=%s\n' "${SECRET}" >> .env
fi
# Make OAuth-discovery URLs sane for local (harmless if already set).
if grep -q '^SUTRA_PUBLIC_URL=' .env; then
  sed -i '' "s|^SUTRA_PUBLIC_URL=.*|SUTRA_PUBLIC_URL=http://localhost:8000|" .env
else
  printf 'SUTRA_PUBLIC_URL=http://localhost:8000\n' >> .env
fi
echo "Wrote SUTRA_JWT_SECRET (len=${#SECRET}) to .env"

# 1b. Recreate the backend AND proxy so they pick up the new secret (both read the same .env).
docker compose up -d backend proxy

# 1c. Wait for the backend to come back, then prove Tier B is ON.
#     well-known now returns JSON (not the SPA HTML) when Tier B is enabled.
until curl -s --max-time 3 http://localhost:8000/.well-known/oauth-authorization-server \
      | grep -q '"issuer"'; do echo "waiting for Tier B..."; sleep 2; done
echo "Tier B is ENABLED."

# 1d. Sanity: the proxy now carries the SAME secret (so it can verify per-user JWTs).
docker exec sutra-proxy printenv SUTRA_JWT_SECRET >/dev/null 2>&1 \
  && echo "proxy has the secret" \
  || echo "WARN: proxy missing secret — run: docker compose up -d proxy"
```

**Pass criteria:** the well-known endpoint returns JSON containing `"issuer"` (not `<!doctype html>`),
and `docker exec sutra-backend-1 printenv SUTRA_JWT_SECRET` prints the secret.

> If `sutra-proxy` was the stale "Exited" container, `docker compose up -d proxy` re-creates it from the
> updated `.env`. Both `sutra-backend-1` and `sutra-proxy` MUST show the same secret.

---

## STEP 2 — [AGENT] Create ONE real account (server-side, via the live API)

Do this once against the control plane. (You can also create it from the app UI in Step 3/4, but doing
it here first proves the endpoint and gives you a token to verify with.)

```bash
cd /Users/adityapratapsingh/code/Sutra

# 2a. Sign up (min 8-char password). 200 => account created + JWT minted.
curl -s -X POST http://localhost:8000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"tester@sutra.local","password":"testpass123"}' | tee /tmp/sutra_signup.json
echo

# 2b. Extract the token and validate it against /auth/me.
TOKEN=$(python3 -c 'import json,sys;print(json.load(open("/tmp/sutra_signup.json"))["access_token"])')
echo "TOKEN(len)=${#TOKEN}"
curl -s http://localhost:8000/auth/me -H "Authorization: Bearer ${TOKEN}" ; echo

# 2c. (Optional) prove /sync accepts the token with an empty body (idempotent; returns counts).
curl -s -X POST http://localhost:8000/sync \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  -d '{}' ; echo
```

**Pass criteria:** 2a returns `{"access_token": "...", "token_type":"bearer"}`; 2b returns
`{"id":"...","email":"tester@sutra.local","auth_provider":"password"}`; 2c returns
`{"ok":true,"synced_at":"...","counts":{...}}`.

> **One account, two devices:** you do NOT sign up twice. On the second device you **log in** with the
> same email+password (`POST /auth/login`) to mint a second valid token for the **same** `user_id`.
> Both tokens carry the same `sub`, so usage and sync from both devices land under one account.

---

## STEP 3 — [AGENT] Point the LAPTOP app at this backend and sign in

The laptop runs the web build. Vite inlines `VITE_API_URL` (control plane → `/auth` + `/sync`) and
`VITE_PROXY_URL` (proxy → AI calls). Defaults are already `localhost:8000` / `localhost:8787`, which is
exactly this stack — but create an explicit `frontend/.env` so it's unambiguous.

```bash
cd /Users/adityapratapsingh/code/Sutra/frontend

# 3a. Pin both URLs (Vite reads dotenv from frontend/, NOT the repo root).
cat > .env <<'EOF'
VITE_API_URL=http://localhost:8000
VITE_PROXY_URL=http://localhost:8787
EOF

# 3b. Run the web dev server (or `npm run build && npm run preview` for a prod-like build).
npm install            # if node_modules is stale
npm run dev            # serves the web app, typically http://localhost:5173
```

Then **[USER or AGENT via browser]** open the dev URL, go to **onboarding/account → Sign in**, and log
in with `tester@sutra.local` / `testpass123` (this calls `POST /auth/login` and stores the JWT in
`localStorage["sutra_tier_b_token"]`).

> **Web caveat (known):** the web build uses sql.js WASM and **the web bundle's WASM lacks FTS5**, so
> the web client cannot fully seed/process a memory DB the way the device can. Treat the laptop as the
> **reader / verifier** in this test, and the **phone as the recorder/source of truth.** If you only
> need to confirm the account + server projection from the laptop, use the curl reads in Step 5
> instead of relying on web DB processing.

**Laptop pass criteria:** Settings → Connections shows the signed-in email; "Sync my memory now" is
enabled (not greyed / not "enable cloud sync on the server").

---

## STEP 4 — [USER + AGENT] Point the PHONE app at this backend

The phone is an **Android APK** that **bakes `VITE_API_URL` / `VITE_PROXY_URL` at build time** — the
native layer has no URL field. There are two ways to reach this Mac:

### Option A (recommended, NO rebuild): keep `localhost` + `adb reverse` over USB
Because the app's defaults are already `http://localhost:8000` / `http://localhost:8787`, you only need
to tunnel the phone's localhost to the Mac. **No APK rebuild needed.**

**[USER] on the phone:** enable Developer Options + USB debugging (Settings → About phone → tap *Build
number* 7×; then Developer options → USB debugging ON). Plug in the USB-C cable and accept the "Allow
USB debugging?" RSA prompt.

**[AGENT] on the Mac:**
```bash
cd /Users/adityapratapsingh/code/Sutra
adb devices                          # phone must show as 'device' (not 'unauthorized')
adb reverse tcp:8000 tcp:8000        # control plane (auth + sync)  <-- REQUIRED for sync
adb reverse tcp:8787 tcp:8787        # proxy (AI calls)             <-- REQUIRED to record
# Re-apply BOTH after every phone reconnect/reboot.
```

If a current Sutra APK is already installed on the phone, **no rebuild is required** — skip to Step 4
sign-in. If it is NOT installed (or you want a clean build):
```bash
cd /Users/adityapratapsingh/code/Sutra/frontend
npm run build && npx cap sync android
export ANDROID_HOME=$HOME/Library/Android/sdk
npx cap run android                  # builds, installs, launches on the connected phone
```

### Option B (rebuild required): bake the Mac's LAN IP into the APK
Use this only if you cannot keep a USB cable attached (e.g. testing screen-off over Wi-Fi).
**This REQUIRES an APK rebuild** because the URLs are compile-time constants.
```bash
cd /Users/adityapratapsingh/code/Sutra/frontend
MAC_IP=$(ipconfig getifaddr en0)     # the Mac's Wi-Fi LAN IP
VITE_API_URL=http://$MAC_IP:8000 VITE_PROXY_URL=http://$MAC_IP:8787 \
  npm run build && npx cap sync android
export ANDROID_HOME=$HOME/Library/Android/sdk
npx cap run android
# Phone must be on the SAME Wi-Fi; allow ports 8000 + 8787 through the Mac firewall.
# Servers already bind 0.0.0.0, so LAN reach works once the firewall permits it.
```
> Cleartext HTTP over LAN works for testing because `capacitor.config.ts` uses `androidScheme: "http"`
> + `cleartext: true` (see RUN-ON-DEVICE.md §"Production hardening"). For any real/public deploy this
> must flip to HTTPS — out of scope for this local test.

**[USER] on the phone (after launch):** complete onboarding, then in the account step **Log in** with
`tester@sutra.local` / `testpass123` (same account as the laptop). Grant **Microphone** and
**Notifications** permissions when prompted.

**Flag — APK rebuild needed?**
- Option A (USB + `adb reverse`): **No rebuild** if a Sutra APK is already installed.
- Option B (LAN IP): **Yes, rebuild required** (URLs are baked at build time).

---

## STEP 5 — The test: record on the PHONE → confirm it reached the SERVER (visible to the laptop)

This is the honest E2E given the push-only architecture: **phone records → phone syncs up → laptop
(and curl) reads the server copy.**

### 5a. [USER] Record + sync on the phone
1. Open **Capture** → tap the mic. Confirm the **"Sutra is listening"** notification appears.
2. Speak a short, **uniquely identifiable** conversation, e.g.:
   *"Sync test six twenty six. Aditya will email the runbook to the team on Friday."*
   (The unique phrase + a clear action item make it easy to find on the server.)
3. Tap **Stop & process** → wait for extraction (Memory shows a summary + the action item).
4. Go to **Settings → Connections → tap "Sync my memory now"**. Wait for the success/"last synced"
   confirmation. (This is the ONLY thing that uploads to the server.)

### 5b. [AGENT] Confirm it landed on the server (read it back as the same account)
The phone synced under `tester@sutra.local`. Read the server projection with that account's token.
```bash
cd /Users/adityapratapsingh/code/Sutra

# Re-mint a token for the SAME account (any device's token works; they're user-scoped).
LOGIN=$(curl -s -X POST http://localhost:8000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"tester@sutra.local","password":"testpass123"}')
TOKEN=$(printf '%s' "$LOGIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')

# Easiest cross-check: re-POST an empty /sync is NOT a read. Instead query the DB directly to PROVE
# the phone's data is on the server (search_tsv recomputed server-side, ids reassigned per push).
docker exec sutra-db-1 psql -U sutra -d sutra -c \
  "SELECT u.email, count(distinct c.id) AS conversations, count(distinct m.id) AS memories
     FROM users u
     LEFT JOIN conversations c ON c.user_id = u.id
     LEFT JOIN memories      m ON m.user_id = u.id
    WHERE u.email = 'tester@sutra.local'
    GROUP BY u.email;"

# Find your unique phrase / action item in the synced memory:
docker exec sutra-db-1 psql -U sutra -d sutra -c \
  "SELECT m.title, left(m.summary,120) AS summary
     FROM memories m JOIN users u ON u.id = m.user_id
    WHERE u.email='tester@sutra.local'
      AND (m.summary ILIKE '%sync test%' OR m.summary ILIKE '%email the runbook%');"

docker exec sutra-db-1 psql -U sutra -d sutra -c \
  "SELECT a.text, a.owner, a.status
     FROM action_items a JOIN users u ON u.id = a.user_id
    WHERE u.email='tester@sutra.local';"
```

**Pass criteria:** the conversation/memory counts are > 0 for `tester@sutra.local`, and your unique
phrase ("sync test" / "email the runbook") appears in the synced summary, and the action item
("…email the runbook…") is present. That proves: **phone → server sync works under the shared
account.**

### 5c. [USER/AGENT] Confirm the laptop sees the same account
On the laptop web app (Step 3), in **Settings → Connections** the signed-in email is
`tester@sutra.local` and "last synced" reflects the push. Because the phone is the source of truth and
the web reads via the server/MCP read path, the laptop is confirming the **same server-side memory**
you just verified by curl in 5b.

> **Want a second push to prove idempotency?** Record a second snippet on the phone and tap "Sync my
> memory now" again — re-running 5b should show the **new** conversation while old ones remain
> (wholesale-replace converges; only MCP-origin priors/action_items survive untouched).

---

## Quick teardown (optional)

```bash
cd /Users/adityapratapsingh/code/Sutra
adb reverse --remove-all                         # drop the USB tunnels
# Delete the test account + all its server data (needs the password to confirm):
LOGIN=$(curl -s -X POST http://localhost:8000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"tester@sutra.local","password":"testpass123"}')
TOKEN=$(printf '%s' "$LOGIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')
curl -s -X DELETE http://localhost:8000/auth/account \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
  -d '{"password":"testpass123"}' ; echo
# To turn Tier B back OFF: blank SUTRA_JWT_SECRET in .env and `docker compose up -d backend proxy`.
```

---

## Honest scope / what this test does and does NOT prove

- **DOES prove:** one account works across phone + laptop; the phone's recorded memory reaches the
  server (privacy-filtered, idempotent); the laptop is signed into and reading that same server copy.
- **Does NOT prove a phone↔phone live mirror.** There is no auto-sync and no download/pull endpoint:
  the phone is the single source of truth and only a manual "Sync my memory now" pushes up. A
  "record on device A, watch it appear on device B" loop is **not implemented** — both clients
  converge only by reading the server, and only the phone writes to it.

---

## Remaining blockers needing a DECISION (not code-mechanical)

1. **Tier B is a write/restart action.** Step 1 edits `.env` and recreates two containers. Confirm
   you want the local stack flipped to Tier B ON (it changes the running server's behavior:
   `/auth` + `/sync` go live). Reversible by blanking the secret.
2. **Proxy secret parity.** The proxy MUST carry the **identical** `SUTRA_JWT_SECRET`. The shared
   `.env` makes this automatic here, but if you ever run the proxy from a different env/host, copy the
   secret or every per-user token silently fails (or, if the proxy secret is empty, it ignores bearers
   and degrades to anon — no loud error).
3. **Remote test box `187.127.172.178` is unreachable** (connection times out from this Mac). If the
   real target is that box rather than localhost, it must be brought online + reachable + Tier B
   enabled there first; there is **no committed remote-deploy runbook** in the repo (only the memory
   note). Decision: localhost (this runbook) vs. fix/deploy the remote box.
4. **Web FTS5 limitation.** The web bundle's sql.js WASM lacks FTS5, so the laptop cannot fully
   process/seed a memory DB like the device can. Decide whether the laptop is acceptable as a
   read-only verifier (this runbook assumes yes) or whether you need a second **phone** as device B.
5. **No HTTPS / not device-bound tokens.** This is plain-HTTP local testing only. The 7-day JWT has no
   device binding and no revocation (logout only clears local storage; deleting the account is the only
   server-side invalidation). Fine for a local test; must be hardened (TLS, the §2b proxy secret)
   before any non-USB / public use.
