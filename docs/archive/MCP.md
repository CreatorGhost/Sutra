# Tier A MCP — locked contract & access decision

> Compressed from `mcp-plan.md` (the implementer contract that still backs the
> shipped code) and `mcp-access-decision.md` (the access/hosting research). The
> user-facing setup guide is [`../../mcp-server/README.md`](../../mcp-server/README.md).
> Tier A = **local, read-only**, default-deny, audio path untouched. The hosted
> read+write path is [`TIER-B.md`](./TIER-B.md).

---

## Architecture — reverse WebSocket bridge

A WebView can't host inbound HTTP and there's no Capacitor native-plugin scaffold,
so **the app dials OUT** a WebSocket to the MCP server on the user's laptop.

- `mcp-server/` = stdio MCP server + WS listener on `127.0.0.1:8765`.
- Phone reaches laptop via `adb reverse tcp:8765 tcp:8765` (USB) or LAN. Web dev
  (`localhost:5173`) connects directly.
- Read-only v1, default-deny. **Redaction + whitelisting enforced app-side** (the
  data holder), never trusted to the laptop.
- Mutual auth via one pairing token (Settings → MCP server env); constant-time
  compare on both sides.
- OPTION (ii) — a user-owned synced store — is a later drop-in: same tool contract,
  swap the data source.

## Settings keys (single-row JSON via `api.putSettings`, no migration)

- `mcp_enabled` — OFF; **hard gate re-checked every request**.
- `mcp_token` — 64-char lowercase hex, `crypto.getRandomValues(32 bytes)`.
- `mcp_bridge_url` — `ws://localhost:8765`.
- `mcp_allow_transcripts` / `_people` / `_graph` / `_priors` — ON (`!== false`).

## WS protocol (JSON text frames)

1. server→app `{type:auth, token}`; app verifies constant-time.
2. on pass, app→server `{type:ready, app:sutra, v:1, token}` (server verifies too).
3. server→app `{type:req, id, method, params}`.
4. app→server `{type:res, id, ok, result|error}`. App re-checks `mcp_enabled` per req.

Error strings are safe (no SQL/stack/vendor/token). Reconnect backoff 1→30s, retry
on visibility, single active device socket (newest wins).

## `mcpBridge.ts` exports (LOCKED)

- `initMcpBridge(): Promise<void>` (idempotent)
- `restartMcpBridge(): Promise<void>`
- `getMcpBridgeStatus(): {state: "disabled"|"connecting"|"connected"|"auth_failed"|"error", detail?}`

Runs on web + native, outbound-only.

## 10 handler methods (read-only, EXACT tool names)

| Tool | Params (defaults) | Maps to / gate |
|---|---|---|
| `search_memory` | query ≤500, topN 1..50=10 | api.search |
| `get_conversation` | id | repo.conversationDetailSafe (transcripts gate turns only) |
| `list_conversations` | limit 1..200=50 | |
| `list_people` | — | api.listPeople (people gate) |
| `get_graph_neighborhood` | entity?, hops 0..3=2, limit 1..240=120 | graph gate |
| `list_action_items` | status open\|done\|all=open | |
| `upcoming_events` | from?, limit 1..50=50 | |
| `get_minutes` | conversationId | |
| `get_your_context` | query?, topN 1..20=8 | repo.topPriors(q, topN, cloud=TRUE), priors gate |
| `ask_memory` | question ≤2000, history ≤10 | api.chat |

Plus resources-backed: `get_privacy` (api.health), `get_daily_rollup` (day YYYY-MM-DD).

## Serializers (LOCKED, field-by-field — never spread DB rows)

- `conversationDetailSafe` = `conversationDetail` but filters `redacted !== 1` **before** coalesce.
- Graph evidence: emit deduped `[{conversation_id}]` only — **turn_ids NEVER leave**.
- `list_people`: NO voiceprint / voiceprint_dim / created_at.
- `get_your_context`: only `share_cloud=1 AND (confirmed OR user)` priors; NEVER emit
  attrs whole / source_turn_ids / entity_id / norm_subject / share_cloud.
- `has_draft = generated_draft != null` (body never leaves).

## HARD RULES (test-enforced)

No output (incl. tool descriptions + error strings) ever contains: voiceprint(_dim),
embedding, generated_draft body, redacted turns or flag, mcp_token, SQLCipher material,
or vendor/model names. OFF by default; wrong/missing token serves nothing; v1 is
read-only (no mutating facade calls); proxy + audio path untouched.

## `mcp-server/` package spec

- ESM (`"type":"module"`); `@modelcontextprotocol/sdk ^1.29.0` (**v1 line, NOT v2-alpha**),
  `zod ^3.25`, `ws ^8.21.0`. tsconfig NodeNext/ES2022/strict.
- v1 import paths `.../server/mcp.js`, `.../server/stdio.js`.
- `registerTool(name, {title, description, inputSchema:{key:z.type()}}, handler)` —
  `inputSchema` is a **plain object map of zod validators** (not `z.object()`).
- **stdio discipline: NEVER write stdout; logs via `console.error`.**
- Env: `SUTRA_MCP_TOKEN` (required, exit 1 if missing), `SUTRA_BRIDGE_PORT`=8765,
  `SUTRA_BRIDGE_HOST`=127.0.0.1, `SUTRA_REQUEST_TIMEOUT_MS`=30000 (120000 for ask/search).
- `McpServer {name:sutra-memory, version:0.1.0}` registers 10 tools + 3 resources
  (`sutra://privacy`, `sutra://conversation/{id}`, `sutra://daily-rollup/{day}`).
- Bridge disconnected → `isError` with "Phone unreachable…" hint. No `outputSchema` in
  v1 (keep contract loose for OPTION ii).

## Verify

- App build `npm --prefix frontend run build`; unit `npm --prefix frontend test` (vitest).
- Server `npm --prefix mcp-server run build`.
- Smoke `npx @modelcontextprotocol/inspector --cli node mcp-server/dist/index.js --method tools/list`.
- E2E `SUTRA_MCP_TOKEN=<t> npm --prefix mcp-server run e2e`.
- Proxy for search/ask: `docker compose up -d proxy` (:8787).

---

## Access / hosting decision (research record)

**Two distinct frictions:** (1) **packaging** — install Node, clone, build, edit
config, copy 64-char token, `adb reverse` — cheap to fix, stays local. (2) **transport
ceiling** — phone must be USB-tethered + foregrounded; Claude.ai web cannot reach a
localhost bridge (web connectors require a public OAuth HTTPS endpoint). Only a hosted
HTTP endpoint removes #2.

**Decisions (locked at the time):**

- **Tier 0 (do):** publish `npx sutra-mcp` + QR pairing (QR encodes `{host,port,token}`;
  phone scans in Settings → auto-fills `mcp_bridge_url` + `mcp_token`). Package is ~2
  edits from publishable (`mcp-server/package.json` already has `bin`/`files`/shebang;
  remove `"private"`). Effort: S.
- **Tier 1 (optional):** `.mcpb` bundle (MCPB v2.1.2), one `pairing_token` field → OS
  Keychain; still stdio/local-only — does **not** remove the tether or enable Claude.ai-web.
- **Rejected:** storing user memory in our backend as plaintext (inverts the local-first
  moat; still GDPR/subpoena/breach exposed even "encrypted at rest" if we hold the key;
  dishonest to market as private).
- Server-side zero-knowledge is impossible for `search_memory`/`ask_memory` — both **must**
  decrypt server-side to embed/rank/feed an LLM.
- The honest always-on path = **user-owned deploy** (run the existing FastAPI+pgvector
  variant on your own box; same locked MCP tool contract → zero tool changes).
- "Lose my phone" → solve with encrypted backup/restore (phone holds the key), not server storage.

**Decision rule:** make the current local path delightfully easy first (Tier 0). Build a
hosted endpoint only if the real requirement is Claude.ai-web / phone-off reachability —
and if so, build it **user-owned**, never "our server holds your memory." A hosted relay
can have OAuth-at-edge **or** be a blind relay, not both — a relay sees memory in plaintext
in transit on every query, so "memory never leaves your phone" becomes FALSE; disclose
honestly. The "private + easy + always-on, on the phone" trifecta does not exist
(protocol/physics limit).

> Postscript: **Tier B hosted memory was subsequently built** as the explicit-opt-in,
> honestly-labelled hosted path — this decision doc predates and informs it. See
> [`TIER-B.md`](./TIER-B.md).
