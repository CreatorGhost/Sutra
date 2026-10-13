// Parsers for the AI-engine probes (`--version`, sign-in status, model lists). Pure so they're unit-tested;
// electron/engines.ts runs the commands. The Cursor/Grok/Droid/Command Code parsers are ported from
// ViewCode (github.com/CreatorGhost/viewcode, T3 Code fork, MIT, © T3 Tools Inc.: parseCursorAboutOutput,
// parseGrokModelsCliOutput, parseDroidModelList, parseCommandCodeStatus, parseCommandCodeModelList).

export interface AuthProbe { signedIn: boolean | null; account: string | null }
export interface ModelsProbe { models: string[]; defaultModel: string | null }

const joinAccount = (...parts: (string | null | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join(" · ") || null;

function jsonLines(out: string): any[] {
  const found: any[] = [];
  const whole = out.trim();
  try { found.push(JSON.parse(whole)); return found; } catch { /* per line */ }
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { found.push(JSON.parse(t)); } catch { /* noise */ }
  }
  return found;
}

/** First non-empty line of `--version`, minus the binary name noise ("codex-cli 0.46.0" stays). */
export function parseVersion(out: string): string | null {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 80) : null;
}

/** `claude auth status` → {"loggedIn":true,"authMethod":"claude.ai","email":"…","subscriptionType":"max"}. */
export function parseClaudeAuthStatus(out: string): AuthProbe {
  const j = jsonLines(out).find((o) => o && typeof o === "object" && "loggedIn" in o);
  if (!j) return { signedIn: null, account: null };
  const plan = typeof j.subscriptionType === "string" ? j.subscriptionType : j.authMethod === "api_key" || j.apiKeySource ? "API key" : null;
  return { signedIn: !!j.loggedIn, account: j.loggedIn ? joinAccount(j.email ?? j.account?.email, j.orgName, plan) : null };
}

/** `codex login status` → "Logged in using ChatGPT" | "Logged in using an API key - sk-…" | "Not logged in". */
export function parseCodexLoginStatus(out: string): AuthProbe {
  if (/not logged in/i.test(out)) return { signedIn: false, account: null };
  const m = out.match(/logged in using (chatgpt|an api key)/i);
  if (m) return { signedIn: true, account: /chatgpt/i.test(m[1]) ? "ChatGPT" : "API key" };
  return { signedIn: null, account: null };
}

/** E-mail + plan from the id_token in ~/.codex/auth.json (a JWT; we only read its payload). */
export function parseCodexAuthFile(raw: string): { email: string | null; plan: string | null } {
  try {
    const token = JSON.parse(raw)?.tokens?.id_token;
    if (typeof token !== "string") return { email: null, plan: null };
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")), (c) => c.charCodeAt(0))));
    const auth = json?.["https://api.openai.com/auth"] ?? {};
    return { email: typeof json?.email === "string" ? json.email : null, plan: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null };
  } catch {
    return { email: null, plan: null };
  }
}

/** `cursor-agent about --format json` → {cliVersion, userEmail (null/"Not logged in" when signed out),
 *  subscriptionTier}. Older CLIs print "Key   Value" lines instead. */
export function parseCursorAbout(out: string): AuthProbe & { version: string | null } {
  const j = jsonLines(out).find((o) => o && typeof o === "object" && ("cliVersion" in o || "userEmail" in o));
  let version: string | null = null, email: string | null | undefined, tier: string | null = null;
  if (j) {
    version = typeof j.cliVersion === "string" ? j.cliVersion.trim() : null;
    email = "userEmail" in j ? (typeof j.userEmail === "string" ? j.userEmail.trim() : null) : undefined;
    tier = typeof j.subscriptionTier === "string" ? j.subscriptionTier.trim() : null;
  } else {
    const plain = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    const field = (k: string) => new RegExp(`^${k}\\s{2,}(.+)$`, "mi").exec(plain)?.[1]?.trim();
    version = field("CLI Version") ?? null;
    email = field("User Email");
    tier = field("Subscription Tier") ?? null;
  }
  if (email === undefined) return { version, signedIn: null, account: null };
  if (!email || /not logged in|login required|authentication required/i.test(email)) return { version, signedIn: false, account: null };
  return { version, signedIn: true, account: joinAccount(email, tier) };
}

/** Gemini CLI keeps its sign-in in ~/.gemini: settings.json `security.auth.selectedType` (or the older
 *  top-level `selectedAuthType`), oauth_creds.json for "Login with Google", google_accounts.json's
 *  `active` e-mail. An API key in the environment also counts. */
export function parseGeminiAuth(input: { settings: string | null; accounts: string | null; hasOauthCreds: boolean; env: Record<string, string | undefined> }): AuthProbe {
  let selected: string | null = null, email: string | null = null;
  try { const s = JSON.parse(input.settings ?? ""); selected = s?.security?.auth?.selectedType ?? s?.selectedAuthType ?? null; } catch { /* no settings */ }
  try { const a = JSON.parse(input.accounts ?? ""); email = typeof a?.active === "string" ? a.active : null; } catch { /* no accounts */ }
  const envKey = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA"].some((k) => input.env[k]?.trim());
  if (input.hasOauthCreds && (selected == null || selected === "oauth-personal")) return { signedIn: true, account: email ?? "Google account" };
  if (envKey || selected === "gemini-api-key" || selected === "vertex-ai") return { signedIn: envKey ? true : null, account: "API key" };
  if (selected) return { signedIn: null, account: email };
  return { signedIn: false, account: null };
}

/** `grok models` exits 0 signed in or not:
 *    You are logged in with grok.com.        (or "You are not authenticated.")
 *    Default model: grok-4.6
 *    Available models:
 *      * grok-4.6 (default)
 *      - grok-4.5 */
export function parseGrokModels(out: string): ModelsProbe & { authenticated: boolean | null } {
  const authenticated = /you are logged in/i.test(out) ? true : /not authenticated|not logged in/i.test(out) ? false : null;
  const models: string[] = [];
  let defaultModel: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const b = line.match(/^\s*[*-]\s+(\S+)(.*)$/);
    if (!b || models.includes(b[1])) continue;
    models.push(b[1]);
    if (/\(default\)/i.test(b[2] ?? "")) defaultModel = b[1];
  }
  defaultModel ??= out.match(/^\s*Default model:\s*(\S+)/im)?.[1] ?? null;
  return { authenticated, models, defaultModel };
}

/** `droid exec -m ?` (an unknown model) lists ids on stderr and exits:
 *    Available built-in models:
 *      auto, claude-opus-5-5, gpt-6-sol, …
 *    Available custom models:
 *      custom:My-Llama-0 (My Llama) */
export function parseDroidModelList(out: string): string[] {
  const models: string[] = [];
  const add = (s: string) => { if (s && !models.includes(s)) models.push(s); };
  let section: "built-in" | "custom" | undefined;
  for (const line of out.split(/\r?\n/)) {
    const heading = line.match(/^Available (built-in|custom) models:/i);
    if (heading) { section = heading[1].toLowerCase() === "custom" ? "custom" : "built-in"; continue; }
    if (!/^\s+\S/.test(line)) { if (line.trim()) section = undefined; continue; }
    if (section === "built-in") line.split(",").forEach((s) => add(s.trim()));
    else if (section === "custom") { const c = line.trim().match(/^(\S+)(?:\s+\((.+)\))?$/); if (c) add(c[1]); }
  }
  return models;
}

/** `command-code status --json` → {"authenticated":false,"version":"1.82.1"}; exits 1 when signed out,
 *  so the exit code isn't the verdict. */
export function parseCommandCodeStatus(out: string): { authenticated: boolean; version: string | null } | null {
  const j = jsonLines(out).find((o) => o && typeof o.authenticated === "boolean");
  return j ? { authenticated: j.authenticated, version: typeof j.version === "string" ? j.version : null } : null;
}

/** `command-code --list-models`: group headings, then `<id>  <description>` rows; "(default)" marks the
 *  CLI default. Stops at the usage footer so headless-only "decision" models aren't offered. */
export function parseCommandCodeModelList(out: string): ModelsProbe {
  const models: string[] = [];
  let defaultModel: string | null = null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(Pass the full id|Docs:|Decision models)/.test(line)) break;
    if (/^Available models\b/.test(line)) continue;
    const row = /^(\S+)\s{2,}(.*)$/.exec(line);
    if (!row || row[1] === "cmd" || models.includes(row[1])) continue;
    models.push(row[1]);
    if (/\(default\)\s*$/.test(row[2])) defaultModel = row[1];
  }
  return { models, defaultModel };
}

/** Models an ACP session advertises: Cursor's `cursor/list_available_models` ({models:[{value,name}]}),
 *  else the standard `session/new` result (`models.availableModels` or a `model` config option). */
export function parseAcpModels(listResponse: unknown, session: any): ModelsProbe {
  const listed = (listResponse as any)?.models;
  if (Array.isArray(listed)) {
    const models = listed.map((m: any) => String(m?.value ?? m?.modelId ?? "").trim()).filter(Boolean);
    if (models.length) return { models: [...new Set(models)], defaultModel: null };
  }
  const avail = session?.models?.availableModels;
  if (Array.isArray(avail) && avail.length) {
    return { models: avail.map((m: any) => String(m?.modelId ?? "")).filter(Boolean), defaultModel: session.models.currentModelId ?? null };
  }
  const opt = (session?.configOptions ?? []).find((o: any) => o?.category === "model" || o?.id === "model");
  if (opt) {
    const values: string[] = [];
    for (const o of opt.options ?? []) {
      if (Array.isArray(o?.options)) o.options.forEach((g: any) => g?.value && values.push(String(g.value)));
      else if (o?.value) values.push(String(o.value));
    }
    return { models: values, defaultModel: typeof opt.currentValue === "string" ? opt.currentValue : null };
  }
  return { models: [], defaultModel: null };
}
