# Tier B — hosted multi-tenant memory + read/write MCP + OAuth 2.1

> Compressed from `tier-b-plan.md` (Phase-1 architecture), `tier-b-phase23-contract.md`
> (locked P2/P3 interface contract), and `tier-b-test-guide.md` (human run/test guide).
> **Status: BUILT** — backend pytest 60/60, live E2E 68/68, leak scan clean. Public HTTPS
> deploy is the remaining piece (code ready, needs a host).
>
> Tier A (local, read-only — [`MCP.md`](./MCP.md)) stays the DEFAULT and is untouched.
> Tier B is **explicit opt-in**, syncs a projection to the server, per-user auth, hosted MCP
> (read + curated write). The stateless proxy (`backend/app/proxy.py`) is **not** touched;
> Tier B extends the FastAPI server variant (`backend/app/api.py`, `services/*`, `db/schema.sql`).

---

## Locked decisions

1. **Auth** = email+password (JWT HS256, `sub=user_id`, argon2/bcrypt). Google/Facebook
   OAuth slots in later over the SAME `users` table + JWT.
2. **Sync v1** = one-way phone→server push on opt-in. Phone stays source of truth for
   captured memory; server holds a `share_cloud`-respecting projection. Two-way deferred (P4).
3. **Write tools** mutate the SERVER copy only; curated, per-tool consented, audit-logged,
   reversible, never destructive.
4. **Tenant isolation = invariant #1:** every row carries `user_id`; every query scoped;
   missing scope = release blocker.
5. **Honest copy:** Tier B is never called "private." Use: *"Stored on our servers so you
   can reach it anywhere; only you, signed in, can access it."*
6. **Audio invariant:** only derived text/memory syncs; audio never persisted anywhere.
7. **Transport** = Streamable HTTP MCP via FastMCP mounted on FastAPI:
   `api.mount("/mcp", mcp.http_app(stateless_http=True))` with `lifespan=mcp_app.lifespan`
   (FastMCP issue-#1367 gotcha). Bearer auth for test; OAuth 2.1 = Phase 3.

## Opt-in gate

Tier B turns on **only** when `SUTRA_JWT_SECRET` is set. Unset → `/auth`, `/sync`,
`/settings/mcp-write`, OAuth endpoints, all MCP tools reject (503/401); server behaves as
the single-tenant variant. Schema (OAuth tables + origin/user_settings/audit_log columns)
applies automatically on boot (idempotent).

## Auth (`backend/app/auth/`)

- `users`: `id uuid pk, email unique citext, password_hash, created_at,
  auth_provider ('password'|'google'|'facebook' default 'password')`.
- `POST /auth/signup`, `POST /auth/login` → `{access_token (JWT), token_type}`; `GET /auth/me`.
  JWT secret = env `SUTRA_JWT_SECRET`.
- FastAPI dep `current_user(authorization) -> User`; reused by `/sync` + MCP auth.

## Multi-tenant schema

Add `user_id uuid NOT NULL REFERENCES users(id)` to **every** user-data table
(conversations, memories, turns, people, entities, edges, action_items, events, priors,
minutes, daily_rollups, settings…). Composite indexes `(user_id, <key>)`; FTS/vector also
filtered by user_id. Every repo/service fn gains a `user_id` param threaded into every WHERE.

## Sync intake (`POST /sync`, authed)

Body = phone's `share_cloud`-respecting projection (reuse device `exportJSONL` shape,
`sutra.ts:108-141`): conversations + memories + turns(non-redacted) + people(no voiceprint)
+ entities + edges(no turn_ids) + action_items(no draft body) + events + minutes +
priors(share_cloud=1). Server UPSERTs under `current_user.id`, replacing the prior
projection (idempotent, versioned by `synced_at`). Same whitelists re-enforced server-side.

## Hosted MCP (`backend/app/mcp_server.py`, FastMCP)

Mount `/mcp`, `stateless_http=True`, lifespan handoff. Auth maps bearer/OAuth token→user_id
(validated locally, never forwarded).

**10 READ tools** scoped to user (same set/shape as Tier A): search_memory,
get_conversation, list_conversations, list_people, get_graph_neighborhood, list_action_items,
upcoming_events, get_minutes, get_your_context, ask_memory. search/ask embeddings+LLM go
through the existing stateless proxy server-to-server.

### P2 — write tools (`backend/app/mcp_write.py`)

**Origin rule (CRITICAL — survives sync):**
- Add `origin TEXT NOT NULL DEFAULT 'device' CHECK (origin IN ('device','mcp'))` to
  `priors` + `action_items` (server schema). MCP-write rows get `origin='mcp'`.
- `/sync` replace step deletes ONLY `origin='device'` rows; `origin='mcp'` rows persist.
- Caveat (v1): MCP edits to device-origin rows may be overwritten by the next phone sync
  (phone = source of truth for device rows). Two-way sync = Phase 4.

**Consent flags (server-side, default-deny):**
- `user_settings (user_id uuid PK references users(id) on delete cascade, data jsonb not null default '{}')`.
- Keys: `mcp_write_enabled` (master) + `mcp_write_add_fact`, `mcp_write_correct_fact`,
  `mcp_write_add_action`, `mcp_write_update_action`, `mcp_write_relabel_person` — **all default false**.
- `GET /settings/mcp-write` → flags; `PUT /settings/mcp-write` (partial patch, whitelist the 6 keys only).
- Every write checks `master AND per-tool`; denied → *"Memory updates are disabled. Enable
  them in Sutra Settings → Cloud sync."*

**The 5 write tools** (all scoped to token user_id, audit-logged, non-destructive):
1. `add_fact {subject req ≤200, value? ≤500, kind? enum person|project|org|role|topic|goal|pref =pref}`
   → INSERT prior `provenance='user', status='confirmed', confidence=0.8, share_cloud=1,
   origin='mcp'`. Returns `{id,kind,subject,value,status}`.
2. `correct_fact {prior_id req, subject? ≤200, value? ≤500}` (≥1 of subject/value) →
   supersede: insert replacement (user/confirmed/origin=mcp, copy unspecified), set old
   `superseded_by=new_id, valid_to=now()`. Old preserved. Foreign/already-superseded →
   "fact not found". Returns `{old_id,new_id,subject,value}`.
3. `add_action_item {text req ≤300, owner? ≤100, due? ISO}` → INSERT status='open',
   origin='mcp'. Returns `{id,text,owner,status,due}`.
4. `update_action_item {id req, status? open|done, text? ≤300, owner? ≤100, due? ISO}`
   (≥1 field) → PATCH, never delete. Returns updated row + `note` when device-origin:
   *"This item came from your phone; the change may be replaced on the next sync."*
5. `relabel_person {person_id req, name req ≤100}` → UPDATE people.canonical_name
   (before-value in audit). Returns `{id,canonical_name}`.

**Audit + visibility:** every write inserts
`audit_log (user_id, tool, args_summary jsonb, before jsonb, after jsonb, ts)`. before/after
= whitelisted snapshots (never embeddings/voiceprints); tokens/passwords never logged. READ
tool `list_memory_updates {limit? 1..100 =20}` → `[{id, tool, args_summary, ts}]`.

### P3 — OAuth 2.1 connector + social sign-in (`backend/app/oauth/`)

- **Discovery:** `GET /.well-known/oauth-protected-resource` (RFC 9728: resource=`<base>/mcp`)
  + `GET /.well-known/oauth-authorization-server` (RFC 8414: code_challenge_methods=["S256"],
  grant_types code+refresh_token, auth_methods "none").
- `POST /oauth/register` (DCR RFC 7591): public client, no secret; persist
  `oauth_clients (client_id, name, redirect_uris jsonb, created_at)`.
- `GET/POST /oauth/authorize`: validate client_id + exact redirect_uri + S256 code_challenge
  (**PKCE required**) + state; minimal HTML login+consent; single-use code (10min TTL) bound
  to user_id+client_id+code_challenge+redirect_uri in `oauth_codes`.
- `POST /oauth/token`: authorization_code (verify PKCE verifier S256, single-use, expiry,
  client+redirect match) → access_token = SAME JWT shape as /auth/login + `aud="sutra-mcp"`;
  refresh_token rotating, hashed at rest in `oauth_tokens`.
- `/mcp` auth accepts (a) Phase-1 bearer JWT (no aud, back-compat) + (b) OAuth JWT (validate
  aud=sutra-mcp). 401 includes
  `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`.
  No open redirects; exact redirect match; codes/refresh hashed; constant-time; nothing secret logged.
- **Social scaffold (env-gated):** `GET /auth/providers` → `{password:true, google:<bool>,
  facebook:<bool>}`. `GET /auth/oauth/{provider}/start` + `/callback` via authlib:
  find-or-create user by verified email (`auth_provider`, password_hash NULL), return SAME JWT
  (web redirect `/signin#token=...`). Unconfigured → 501. Env: GOOGLE_CLIENT_ID/SECRET,
  FACEBOOK_CLIENT_ID/SECRET.

> Security hardening added later: a login-CSRF nonce is echoed on the token fragment
> (`/signin#token=…&nonce=…`) and only adopted when it matches the one the client generated;
> cross-provider account-linking is refused (409) and the Facebook branch requires a verified email.

## Frontend

- `frontend/src/pages/SignIn.tsx` (email/password, JWT in secure storage; skippable).
- `frontend/src/lib/cloudSync.ts` (build projection, POST /sync).
- Settings → **"Cloud sync & always-on access"**: sign in/out, sync now, connector URL,
  per-scope toggles, write master + per-tool toggles (default OFF), master `tier_b_enabled`
  default OFF. Master write SwitchRow "Allow AI to update my memory" + 5 per-tool rows
  ("Add facts", "Correct facts", "Add to-dos", "Update to-dos", "Rename people").

## Security invariants (tested)

1. Tenant isolation: A's token never reads/writes B's rows. 2. No /sync or MCP without valid
JWT; passwords hashed; tokens never logged. 3. Writes only with scope ON; audit-logged;
reversible; non-destructive. 4. Whitelists hold server-side (no voiceprint/embedding/
redacted-turn/draft-body/token/vendor-name in MCP output). 5. Proxy stays stateless; audio
never persisted; opt-in + honest copy.

---

## Run / test guide (verified E2E on macOS, docker Postgres host port 5433)

Tier B lives entirely in the FastAPI server variant (`app.main:app`). Proxy untouched + stateless.

**Start the stack:**
- DB: `docker compose up -d db` (pgvector/pgvector:pg16, host 5433→5432).
- Backend **Option A** (docker, serves PWA on :8000): in `.env` set `SUTRA_JWT_SECRET`,
  `SUTRA_PUBLIC_URL=http://localhost:8000`, optional `OPENAI_API_KEY` (`AI_PROVIDER=mock`
  works offline); `docker compose build backend` (needs fastmcp, Authlib, itsdangerous);
  `up -d backend`. Log line: *"Tier B enabled: /auth + /sync + OAuth connector + hosted MCP (/mcp) active"*.
- Backend **Option B** (uvicorn): `SUTRA_JWT_SECRET=… SUTRA_PUBLIC_URL=http://localhost:8000
  DATABASE_URL=postgresql://sutra:sutra@localhost:5433/sutra AI_PROVIDER=mock SPEAKER_ID_MODE=off
  RECAP_ENABLED=false python -m uvicorn app.main:app --host 0.0.0.0 --port 8000`.
- Frontend (Option B): `VITE_API_URL=http://localhost:8000 npm run dev` (:5173).
- Sanity: `curl -s http://localhost:8000/.well-known/oauth-authorization-server`.

**Auth (CLI):** `POST /auth/signup {email,password}` → `{access_token,token_type}`;
`GET /auth/me` with `Authorization: Bearer $TOKEN`.

**Sync:** App → Settings → Cloud sync → master toggle → "Sync my memory now". CLI:
`POST /sync` with bearer + projection body → `{ok,synced_at,counts}`.

**Connect MCP — endpoint `http://localhost:8000/mcp/` (Streamable HTTP):**
- Way 1 (bearer): `claude mcp add --transport http sutra http://localhost:8000/mcp/ --header "Authorization: Bearer $TOKEN"`; or `npx @modelcontextprotocol/inspector`.
- Way 2 (OAuth 2.1): discovery → `POST /oauth/register` → PKCE pair → open
  `/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&state=…&code_challenge=…&code_challenge_method=S256`
  → login+consent → copy code from redirect → `POST /oauth/token` (grant_type=authorization_code,
  code, redirect_uri, client_id, code_verifier) → access_token aud=sutra-mcp. Plain Phase-1 JWT still works.

**Write consent + tools:** default-deny, gated twice (master + per-tool). CLI:
`PUT /settings/mcp-write {mcp_write_enabled:true, mcp_write_add_fact:true, …}`. Tools: add_fact,
correct_fact (supersede), add_action_item, update_action_item (never deletes), relabel_person.
Trail: `list_memory_updates {limit?}`. Survives sync: re-sync → `origin='mcp'` rows survive,
device rows replaced. Isolation holds for writes (foreign id → not found).

**Audit SQL:** `PGPASSWORD=sutra psql -h localhost -p 5433 -U sutra -d sutra -c
"SELECT tool, args_summary, ts FROM audit_log ORDER BY ts DESC LIMIT 20;"`

**Social sign-in:** scaffold built, env-gated; can't live-test without real creds. No creds →
`/auth/providers {password:true,google:false,facebook:false}`, `/auth/oauth/google/start` → 501.
Enable: set GOOGLE_/FACEBOOK_CLIENT_ID+SECRET + SUTRA_PUBLIC_URL (public origin); provider
redirect URI `<SUTRA_PUBLIC_URL>/auth/oauth/{provider}/callback`.

**Public reachability:** remote connectors (claude.ai web) need a public HTTPS deploy +
`SUTRA_PUBLIC_URL` = public origin + TLS in front. Local testing = Inspector/SDK/Claude Code
against localhost.

**Re-run automated checks:** create `sutra_test` DB on 5433; `TEST_DATABASE_URL=…
SUTRA_JWT_SECRET=test-secret DATABASE_URL=… AI_PROVIDER=mock SPEAKER_ID_MODE=off
RECAP_ENABLED=false python -m pytest` → 60 passed. Frontend: `npm --prefix frontend run build`.

> Tier A is unchanged: local stdio MCP over a paired WebSocket, read-only, audio never leaves
> the device — see [`MCP.md`](./MCP.md) and [`../../mcp-server/README.md`](../../mcp-server/README.md).
