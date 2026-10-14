// PURE: one-click "Reach from anywhere" — the parts of setting up the user's own Cloudflare relay that
// are only text: reading wrangler's output, the sign-in prompt, the pinned Node.js download, and the
// state the Settings screen shows. The steps themselves run in electron/pairing/relaySetup.ts.
// Ported from ViewCode's Quick connect (packages/shared/src/viewcodeRelaySetup.ts,
// apps/server/src/relay/workersDevSubdomain.ts); the relay itself is Sutra's (infra/sutra-relay).

export const WRANGLER_PACKAGE = "wrangler@4";
export const DEFAULT_WORKER_NAME = "sutra-relay";

/** wrangler 4 needs Node 22+. Electron 33 ships Node 20, so a Mac without Node gets this one, pinned. */
export const NODE_VERSION = "22.23.3";
/** SHA-256 of each official archive, from https://nodejs.org/dist/v22.23.3/SHASUMS256.txt. */
export const NODE_SHA256: Record<string, string> = {
  "darwin-arm64": "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
  "darwin-x64": "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8",
  "linux-arm64": "5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2",
  "linux-x64": "1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af",
  "win-arm64": "33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535",
  "win-x64": "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71",
};

/** The official Node archive for this computer, or null where there is none. */
export function nodeDist(platform: string, arch: string): { url: string; sha256: string; folder: string; zip: boolean } | null {
  const os = platform === "win32" ? "win" : platform === "darwin" || platform === "linux" ? platform : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  const sha256 = os && cpu ? NODE_SHA256[`${os}-${cpu}`] : undefined;
  if (!os || !cpu || !sha256) return null;
  const folder = `node-v${NODE_VERSION}-${os}-${cpu}`;
  const zip = os === "win";
  return { url: `https://nodejs.org/dist/v${NODE_VERSION}/${folder}.${zip ? "zip" : "tar.gz"}`, sha256, folder, zip };
}

/** `v22.15.1` → 22; null when unreadable. */
export function nodeMajor(text: string): number | null {
  const m = /v?(\d+)\.\d+\.\d+/.exec(text);
  return m ? Number(m[1]) : null;
}

/** `--use-system-ca` (trust the OS certificate store, for TLS-inspecting proxies) exists from Node 22.15 / 23.8. */
export function supportsSystemCa(text: string): boolean {
  const m = /v?(\d+)\.(\d+)\.\d+/.exec(text);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 23 || (major === 23 && minor >= 8) || (major === 22 && minor >= 15);
}

/** Cloudflare Worker names: lowercase letters, digits and dashes. */
export const isValidWorkerName = (name: string) => /^[a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?$/.test(name);

/** The address `wrangler deploy` printed for `name`: https://<name>.<subdomain>.workers.dev */
export function parseWorkerUrl(output: string, name: string): string | null {
  return new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`, "i").exec(output)?.[0]?.toLowerCase() ?? null;
}

/** Nobody signed in to wrangler. Unrecognised output counts as signed in, so a reworded message can't loop the login. */
export const wranglerNeedsLogin = (output: string, exitCode: number) =>
  exitCode !== 0 || /not authenticated|not logged in|you are not/i.test(output);

/** The account has no workers.dev subdomain yet, so the Worker got no public address. */
export const detectMissingWorkersDevSubdomain = (output: string) => /workers\.dev subdomain/i.test(output);

/** `wrangler delete` of a Worker that's already gone. */
export const detectWorkerAlreadyDeleted = (output: string) => /\[code: 10007\]|script_not_found|does not exist|could not be found/i.test(output);

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
export const stripAnsi = (text: string) => text.replace(ANSI, "");

/** Remove every secret before output is kept or shown (the host secret only ever reaches wrangler on stdin). */
export function redactSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

export interface DeviceLoginPrompt { url: string | null; code: string | null }

/** The link and code from `wrangler login --device` ("please visit: https://dash.cloudflare.com/oauth2/device … enter the code: ABCD-EFGH").
 *  Only https links on cloudflare.com count. */
export function parseDeviceLoginPrompt(output: string): DeviceLoginPrompt {
  const text = stripAnsi(output);
  const visit = text.search(/please visit:?/i);
  const after = visit === -1 ? text : text.slice(visit);
  const url = /https:\/\/[a-z0-9.-]*cloudflare\.com\/[^\s"'<>]*/i.exec(after)?.[0] ?? null;
  const code = /enter the code:?\s*\n?\s*([A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})*)\b/i.exec(text)?.[1] ?? null;
  return { url, code };
}

/** The sign-in link with the code filled in, the way wrangler builds it. */
export function deviceLoginOpenUrl(p: DeviceLoginPrompt): string | null {
  if (!p.url) return null;
  if (!p.code) return p.url;
  try { const u = new URL(p.url); u.searchParams.set("user_code", p.code); return u.toString(); } catch { return p.url; }
}

/** The JSON object in wrangler output, which may carry warnings around it. */
function jsonIn(output: string): unknown {
  const s = output.indexOf("{"), e = output.lastIndexOf("}");
  if (s === -1 || e < s) return null;
  try { return JSON.parse(output.slice(s, e + 1)); } catch { return null; }
}

export interface CloudflareAccount { id: string; name: string }

/** Accounts in `wrangler whoami --json`; null when unreadable. */
export function parseWhoamiAccounts(output: string): CloudflareAccount[] | null {
  const j = jsonIn(output) as { accounts?: unknown } | null;
  if (!j || !Array.isArray(j.accounts)) return null;
  return j.accounts
    .filter((a): a is { id: string; name?: unknown } => !!a && typeof (a as any).id === "string" && (a as any).id.trim() !== "")
    .map((a) => ({ id: a.id.trim(), name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : a.id.trim() }));
}

/** The bearer token from `wrangler auth token --json` (OAuth or API token); null otherwise. */
export function parseWranglerAuthToken(output: string): string | null {
  const j = jsonIn(output) as { type?: unknown; token?: unknown } | null;
  if (!j || (j.type !== "oauth" && j.type !== "api_token") || typeof j.token !== "string") return null;
  return j.token.trim() || null;
}

/** The account a deploy went to, from the onboarding link wrangler prints when it won't pick a subdomain itself. */
export const parseDeployAccountId = (output: string) =>
  /dash\.cloudflare\.com\/([0-9a-f]{32})\/workers\/onboarding/i.exec(output)?.[1]?.toLowerCase() ?? null;

/** 256 random bits, URL-safe. */
export function generateHostSecret(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let s = "";
  for (const b of random(32)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- verifying the relay answers ------------------------------------------------------------------

/** network: this network reset/blocked the new address (common for a fresh workers.dev name behind a
 *  corporate firewall); rejected: the relay refused this Mac's secret; transient: DNS, timeout, 5xx. */
export type ProbeProblem = "network" | "rejected" | "transient";
export type ProbeOutcome = { ok: true } | { ok: false; problem: ProbeProblem; detail: string };

/** The relay answers 426 (upgrade required) to `GET /host/<id>` exactly when the secret matches. */
export function classifyProbeStatus(status: number): ProbeOutcome {
  if (status === 426) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, problem: "rejected", detail: `The relay answered ${status}.` };
  return { ok: false, problem: "transient", detail: `The relay answered ${status}.` };
}

export function classifyProbeError(detail: string): ProbeOutcome {
  const network = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed|EPROTO|ERR_SSL|SSL routines|TLS|CERT|certificate|self[- ]signed|UND_ERR_SOCKET/i.test(detail);
  return { ok: false, problem: network ? "network" : "transient", detail };
}

/** Seconds between checks: quick, then once a minute, ~10 minutes in all. A fresh workers.dev name
 *  can be reset by a firewall for a while, so one failure is never the verdict. */
export const VERIFY_DELAYS_S = [5, 10, 20, 40, 60, 60, 60, 60, 60, 60, 60, 60, 60];

// ---- what Settings shows --------------------------------------------------------------------------

export type SetupStep = "tools" | "signin" | "deploy" | "secret" | "verify" | "remove";

export type RelaySetupState =
  | { status: "idle"; message?: string }
  | { status: "running"; step: SetupStep; message: string; signIn?: { url: string | null; code: string | null; openUrl: string | null } }
  | { status: "needs-account"; message: string; accounts: CloudflareAccount[] }
  | { status: "needs-subdomain"; message: string; dashboard: string }
  | { status: "done"; message: string }
  | { status: "unreachable"; message: string; details?: string }
  | { status: "failed"; message: string; details?: string; installNode?: boolean };

/** What this Mac remembers about the relay it deployed (not secret; the host secret lives in pairing.json). */
export interface DeployedRelay { name: string; url: string; accountId: string | null }

export function parseDeployedRelay(text: string | null): DeployedRelay | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Partial<DeployedRelay>;
    if (typeof j.name !== "string" || !isValidWorkerName(j.name) || typeof j.url !== "string") return null;
    return { name: j.name, url: j.url, accountId: typeof j.accountId === "string" && j.accountId ? j.accountId : null };
  } catch { return null; }
}
