// Tier B auth client (opt-in, hosted). Talks to the server variant's /auth/* endpoints (NOT the
// stateless proxy). Tier A works with NO account — nothing here is touched unless the user signs in
// for cloud sync. The bearer JWT is the only credential we hold; it's never logged.
//
// Token storage: the device DB is already SQLCipher-encrypted, but there's no native secure-storage
// plugin wired in this project, so the 7-day bearer token lives in localStorage (web + native WebView).
// It's an access token, not a password; sign-out clears it. If/when a Keychain/EncryptedSharedPrefs
// plugin lands, only readToken/writeToken/clearToken below need to change.

// Server-variant base URL. Separate from the proxy (VITE_PROXY_URL) — Tier B is a different service.
// Defaults to a sensible localhost for dev; set VITE_API_URL for hosted.
export const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

const TOKEN_KEY = "sutra_tier_b_token";
const EMAIL_KEY = "sutra_tier_b_email";

export type AuthUser = { id: string; email: string; auth_provider: string };

// ---- token storage (the only place that reads/writes the credential) ----
export function readToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(token: string, email?: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    if (email) localStorage.setItem(EMAIL_KEY, email);
  } catch { /* storage unavailable — token stays in this session only */ }
}
export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(EMAIL_KEY); } catch { /* ignore */ }
}
export function isSignedIn(): boolean {
  return !!readToken();
}
/** Last-known email (for the Settings header before /auth/me resolves). Not authoritative. */
export function cachedEmail(): string | null {
  try { return localStorage.getItem(EMAIL_KEY); } catch { return null; }
}

// ---- transport ----
async function postJson<T>(path: string, body: unknown, ms = 20000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  let r: Response;
  try {
    r = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("Server timed out — check the address and your connection.");
    throw new Error("Couldn't reach the server. Check the address and your connection.");
  } finally {
    clearTimeout(t);
  }
  if (!r.ok) throw new Error(await errorText(r));
  return r.json() as Promise<T>;
}

// Map a server error response to a human, non-leaky message. The foundation returns generic strings
// (e.g. "invalid email or password") which are safe to surface; everything else is collapsed.
async function errorText(r: Response): Promise<string> {
  if (r.status === 503) return "Cloud sync isn't enabled on this server yet.";
  let detail = "";
  try { const j: any = await r.json(); detail = typeof j?.detail === "string" ? j.detail : ""; } catch { /* non-JSON */ }
  if (r.status === 401) return detail || "Invalid email or password.";
  if (r.status === 409) return "An account with that email already exists.";
  if (r.status === 422) return detail || "Enter a valid email and a password of at least 8 characters.";
  return detail || `Sign-in failed (${r.status}).`;
}

// ---- public API ----
type TokenResponse = { access_token: string; token_type: string };

export async function signup(email: string, password: string): Promise<void> {
  const r = await postJson<TokenResponse>("/auth/signup", { email: email.trim(), password });
  writeToken(r.access_token, email.trim());
}

export async function login(email: string, password: string): Promise<void> {
  const r = await postJson<TokenResponse>("/auth/login", { email: email.trim(), password });
  writeToken(r.access_token, email.trim());
}

export function signOut(): void {
  clearToken();
}

/** Permanently delete the account + every server-side copy (the server cascades: memory projection,
 *  plan, usage, OAuth grants, settings). Requires the password as fresh confirmation. The device's
 *  local memory is NOT touched. Clears the stored token on success. */
export async function deleteAccount(password: string): Promise<void> {
  const token = readToken();
  if (!token) throw new Error("Not signed in.");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let r: Response;
  try {
    r = await fetch(API_BASE + "/auth/account", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify({ password }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("Server timed out — check the address and your connection.");
    throw new Error("Couldn't reach the server. Check the address and your connection.");
  } finally {
    clearTimeout(t);
  }
  if (r.status === 401) { clearToken(); throw new Error("Your session expired — sign in again."); }
  if (r.status === 403) throw new Error("That password doesn't match — account not deleted.");
  if (!r.ok) throw new Error(await errorText(r));
  clearToken();
}

/** Validate the stored token against the server and return the account. Throws if signed out, the
 *  token is bad/expired, or Tier B is disabled — callers should clear the token on failure. */
export async function me(): Promise<AuthUser> {
  const token = readToken();
  if (!token) throw new Error("Not signed in.");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let r: Response;
  try {
    r = await fetch(API_BASE + "/auth/me", { headers: authHeader(), signal: ctrl.signal });
  } catch {
    throw new Error("Couldn't reach the server. Check the address and your connection.");
  } finally {
    clearTimeout(t);
  }
  if (r.status === 401) { clearToken(); throw new Error("Your session expired — sign in again."); }
  if (!r.ok) throw new Error(await errorText(r));
  const u = (await r.json()) as AuthUser;
  try { localStorage.setItem(EMAIL_KEY, u.email); } catch { /* ignore */ }
  return u;
}

/** Authorization header for authenticated server calls (/sync). Empty object when signed out. */
export function authHeader(): Record<string, string> {
  const token = readToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---- write-consent flags (Tier B, server-side, default-deny) ----
// The six MCP write-consent flags the server tracks. Master gate + one per write tool; ALL default
// false (default-deny). Mirrors GET/PUT /settings/mcp-write — the server whitelists exactly these keys.
export type McpWriteFlags = {
  mcp_write_enabled: boolean;
  mcp_write_add_fact: boolean;
  mcp_write_correct_fact: boolean;
  mcp_write_add_action: boolean;
  mcp_write_update_action: boolean;
  mcp_write_relabel_person: boolean;
};

export const MCP_WRITE_FLAG_KEYS: (keyof McpWriteFlags)[] = [
  "mcp_write_enabled",
  "mcp_write_add_fact",
  "mcp_write_correct_fact",
  "mcp_write_add_action",
  "mcp_write_update_action",
  "mcp_write_relabel_person",
];

// Default-deny: any flag the server omits is treated as false (a missing flag never reads as enabled).
function coerceWriteFlags(j: any): McpWriteFlags {
  const f = j ?? {};
  return {
    mcp_write_enabled: f.mcp_write_enabled === true,
    mcp_write_add_fact: f.mcp_write_add_fact === true,
    mcp_write_correct_fact: f.mcp_write_correct_fact === true,
    mcp_write_add_action: f.mcp_write_add_action === true,
    mcp_write_update_action: f.mcp_write_update_action === true,
    mcp_write_relabel_person: f.mcp_write_relabel_person === true,
  };
}

/** Read the current write-consent flags. Throws (with a human, non-leaky message) if signed out,
 *  the token expired, or Tier B is disabled — callers fall back to all-off + signed-out. */
export async function getMcpWrite(): Promise<McpWriteFlags> {
  const token = readToken();
  if (!token) throw new Error("Not signed in.");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let r: Response;
  try {
    r = await fetch(API_BASE + "/settings/mcp-write", { headers: authHeader(), signal: ctrl.signal });
  } catch {
    throw new Error("Couldn't reach the server. Check the address and your connection.");
  } finally {
    clearTimeout(t);
  }
  if (r.status === 401) { clearToken(); throw new Error("Your session expired — sign in again."); }
  if (!r.ok) throw new Error(await errorText(r));
  return coerceWriteFlags(await r.json());
}

/** Merge a partial flags patch server-side and return the merged result. Only the six whitelisted
 *  keys are ever sent. Throws on failure so the optimistic caller can roll back. */
export async function putMcpWrite(patch: Partial<McpWriteFlags>): Promise<McpWriteFlags> {
  const token = readToken();
  if (!token) throw new Error("Not signed in.");
  // Whitelist client-side too (defense in depth): never send a key the server doesn't expect.
  const body: Partial<McpWriteFlags> = {};
  for (const k of MCP_WRITE_FLAG_KEYS) {
    if (k in patch && typeof patch[k] === "boolean") body[k] = patch[k];
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let r: Response;
  try {
    r = await fetch(API_BASE + "/settings/mcp-write", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("Server timed out — check the address and your connection.");
    throw new Error("Couldn't reach the server. Check the address and your connection.");
  } finally {
    clearTimeout(t);
  }
  if (r.status === 401) { clearToken(); throw new Error("Your session expired — sign in again."); }
  if (!r.ok) throw new Error(await errorText(r));
  return coerceWriteFlags(await r.json());
}

// ---- sign-in providers (Tier B, env-gated server-side) ----
// Which sign-in methods the server has configured. Password is always available; Google/Facebook only
// when the server has real OAuth app credentials (default false — honest about untestability w/o creds).
export type AuthProviders = { password: boolean; google: boolean; facebook: boolean };

/** Probe which sign-in providers the server enabled. Best-effort: callers default to password-only
 *  (and no social buttons) on any failure, so the email/password form always works offline/standalone. */
export async function getAuthProviders(): Promise<AuthProviders> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let r: Response;
  try {
    r = await fetch(API_BASE + "/auth/providers", { signal: ctrl.signal });
  } catch {
    throw new Error("Couldn't reach the server.");
  } finally {
    clearTimeout(t);
  }
  if (!r.ok) throw new Error(`providers probe failed (${r.status})`);
  const j: any = await r.json();
  return {
    password: j?.password !== false, // password is the always-on default
    google: j?.google === true,
    facebook: j?.facebook === true,
  };
}

// Login-CSRF guard for the social redirect. Without it, anyone could craft
// `https://app/signin#token=<attacker JWT>` and a victim who opens it would be silently signed into
// the attacker's account — their next "Sync my memory now" would upload THEIR memory to the attacker.
// So: each attempt generates a CSPRNG nonce, kept in sessionStorage (per-tab, unreadable cross-origin);
// the server echoes it back in the fragment; the token is adopted ONLY when both match.
const OAUTH_NONCE_KEY = "sutra_oauth_nonce";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Kick off a social sign-in: mint + remember the per-attempt nonce, then hand off to the server's
 *  OAuth start endpoint (which carries the nonce through to the callback fragment). */
export function beginSocialLogin(provider: "google" | "facebook"): void {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try { sessionStorage.setItem(OAUTH_NONCE_KEY, nonce); } catch { /* per-tab storage unavailable */ }
  window.location.href = `${API_BASE}/auth/oauth/${provider}/start?nonce=${nonce}`;
}

/** Consume a `#token=<jwt>&nonce=<hex>` fragment after a social-login redirect: adopt the JWT only if
 *  the echoed nonce matches the one this tab generated in beginSocialLogin (anti login-CSRF), then
 *  strip the fragment either way. Returns true when a token was consumed. The JWT is never logged. */
export function consumeTokenFragment(): boolean {
  let hash = "";
  try { hash = window.location.hash || ""; } catch { return false; }
  if (!hash || hash.length < 2) return false;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  if (!token) return false;
  // Single-use: read + delete the expected nonce before comparing, so a rejected token can't be retried.
  let expected: string | null = null;
  try {
    expected = sessionStorage.getItem(OAUTH_NONCE_KEY);
    sessionStorage.removeItem(OAUTH_NONCE_KEY);
  } catch { /* unavailable -> reject below */ }
  const echoed = params.get("nonce");
  const ok = !!expected && !!echoed && timingSafeEqual(expected, echoed);
  if (ok) writeToken(token);
  // Clear the fragment in BOTH cases so no credential (ours or an injected one) lingers in the URL/history.
  try {
    const url = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", url);
  } catch { /* history unavailable */ }
  return ok;
}
