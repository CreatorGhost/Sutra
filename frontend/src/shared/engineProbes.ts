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
  // The session's own list is authoritative: its ids are the exact strings session/set_model and
  // set_config_option accept. Cursor's cursor/list_available_models is a superset whose values drop
  // the required config suffix ("…opus-5" vs "…opus-5[context=300k]") and that also lists models the
  // session rejects, so it is only a fallback.
  const avail = session?.models?.availableModels;
  if (Array.isArray(avail) && avail.length) {
    return { models: avail.map((m: any) => String(m?.modelId ?? "")).filter(Boolean), defaultModel: session.models.currentModelId ?? null };
  }
  const opt = acpModelOption(session);
  if (opt) return { models: optionValues(opt), defaultModel: typeof opt.currentValue === "string" ? opt.currentValue : null };
  const listed = (listResponse as any)?.models;
  if (Array.isArray(listed)) {
    const models = listed.map((m: any) => String(m?.value ?? m?.modelId ?? "").trim()).filter(Boolean);
    if (models.length) return { models: [...new Set(models)], defaultModel: null };
  }
  return { models: [], defaultModel: null };
}

const acpModelOption = (session: any) =>
  (Array.isArray(session?.configOptions) ? session.configOptions : []).find((o: any) => o?.category === "model" || o?.id === "model");

function optionValues(opt: any): string[] {
  const values: string[] = [];
  for (const o of opt?.options ?? []) {
    if (Array.isArray(o?.options)) o.options.forEach((g: any) => g?.value && values.push(String(g.value)));
    else if (o?.value) values.push(String(o.value));
  }
  return values;
}

/** "…opus-5[context=300k]" → "…opus-5". */
const acpBaseModel = (id: string) => splitModelParams(id).base.toLowerCase();

/** A saved model id matched against the ids an engine now lists: exact, else the first with the same
 *  base name (a bare "…opus-5" saved before ids carried their config suffix). An engine that lists bare
 *  ids (Cursor) keeps a saved "…opus-5[context=1m]" as is: the suffix is the user's context choice.
 *  Unchanged when nothing matches — a missing model is reported when it's used, not dropped here. */
export function upgradeModelId(saved: string, offered: string[]): string {
  if (!saved || offered.includes(saved) || offered.includes(splitModelParams(saved).base)) return saved;
  return offered.find((id) => acpBaseModel(id) === acpBaseModel(saved)) ?? saved;
}

// ---- Cursor's parameterized model picker (after ViewCode's CursorProvider / CursorAcpSupport) ----
// With `parameterizedModelPicker` in the client's capabilities, Cursor's ACP sessions take bare model
// ids ("claude-opus-5") and expose the context window as its own `model_config` option. Sutra stores
// the user's context choice on the model id in Cursor's own syntax ("claude-opus-5[context=1m]"), so it
// travels with the model everywhere a model goes (Settings, the Ask-bar picker, a paired phone).

export interface ContextOption { value: string; label: string }

/** "x[context=1m, fast=true]" → { base: "x", params: { context: "1m", fast: "true" } }. */
export function splitModelParams(id: string): { base: string; params: Record<string, string> } {
  const at = id.indexOf("[");
  if (at < 0) return { base: id.trim(), params: {} };
  const params: Record<string, string> = {};
  for (const kv of id.slice(at + 1).replace(/\].*$/, "").split(",")) {
    const eq = kv.indexOf("=");
    if (eq > 0) params[kv.slice(0, eq).trim().toLowerCase()] = kv.slice(eq + 1).trim();
  }
  return { base: id.slice(0, at).trim(), params };
}

/** The model id carrying a context choice; null = the default (see pickContext). */
export function withContext(model: string, context: string | null): string {
  const base = splitModelParams(model).base;
  return context ? `${base}[context=${context}]` : base;
}

const optionToken = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "-");

/** Cursor's context-window option among a model's config options. */
export function findContextOption(configOptions: unknown): any | null {
  if (!Array.isArray(configOptions)) return null;
  return configOptions.find((o: any) => {
    if (o?.category !== "model_config") return false;
    const id = optionToken(o?.id);
    return id === "context" || id === "context-size" || String(o?.name ?? "").toLowerCase().includes("context");
  }) ?? null;
}

export function contextChoices(opt: any): ContextOption[] {
  const out: ContextOption[] = [];
  for (const o of opt?.options ?? []) {
    for (const e of Array.isArray(o?.options) ? o.options : [o]) {
      if (e?.value != null && String(e.value)) out.push({ value: String(e.value), label: String(e.name ?? e.value) });
    }
  }
  return out;
}

/** "300k" → 300000, "1m" → 1000000 (NaN when it isn't a size). */
const contextTokens = (v: string) => {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)/i.exec(v.trim());
  return m ? Number(m[1]) * (m[2].toLowerCase() === "m" ? 1e6 : m[2].toLowerCase() === "k" ? 1e3 : 1) : NaN;
};

/** Sutra's default context window: 300K — meeting notes don't need a million tokens. A model without a
 *  300K option gets its largest one under 1M (e.g. GPT's 272K), else its smallest. */
export const DEFAULT_CONTEXT = "300k";

/** The option value to send for a wanted context ("1m", "300K", or null for the default); null when
 *  the model has no context options at all. */
export function pickContext(choices: ContextOption[], wanted: string | null | undefined): string | null {
  if (!choices.length) return null;
  const token = optionToken(wanted ?? DEFAULT_CONTEXT);
  const exact = choices.find((c) => optionToken(c.value) === token || optionToken(c.label) === token);
  if (exact) return exact.value;
  const sized = choices.map((c) => ({ c, n: contextTokens(c.value) || contextTokens(c.label) })).filter((x) => x.n > 0).sort((a, b) => a.n - b.n);
  if (!sized.length) return choices[0].value;
  const want = contextTokens(wanted ?? DEFAULT_CONTEXT);
  // The largest at or under what was asked for, else the smallest offered.
  const under = sized.filter((x) => !(want > 0) || x.n <= want);
  return (under.length ? under[under.length - 1] : sized[0]).c.value;
}

/** Cursor's `cursor/list_available_models`: every model (bare id), its display name, and the context
 *  windows it offers. */
export function parseCursorModels(listResponse: unknown): ModelsProbe & { modelNames: Record<string, string>; contexts: Record<string, ContextOption[]> } {
  const modelNames: Record<string, string> = {};
  const contexts: Record<string, ContextOption[]> = {};
  const models: string[] = [];
  const listed = (listResponse as any)?.models;
  for (const m of Array.isArray(listed) ? listed : []) {
    const id = splitModelParams(String(m?.value ?? m?.modelId ?? "")).base;
    if (!id || models.includes(id)) continue;
    models.push(id);
    const name = String(m?.name ?? "").trim();
    if (name) modelNames[id] = name;
    const ctx = contextChoices(findContextOption(m?.configOptions));
    if (ctx.length > 1) contexts[id] = ctx;
  }
  return { models, defaultModel: null, modelNames, contexts };
}

/** The exact model id this session accepts for a saved choice. A saved id can be stale or missing its
 *  config suffix (picked from an older list), so it's matched on its base name and upgraded to the
 *  session's form — the session's current pick first when several share that base. Returns the saved
 *  id untouched when the session doesn't list its models, and null when the model is gone. */
export function resolveAcpModelId(wanted: string, session: any): string | null {
  const opt = acpModelOption(session);
  const accepted = opt ? optionValues(opt) : (Array.isArray(session?.models?.availableModels) ? session.models.availableModels : []).map((m: any) => String(m?.modelId ?? "")).filter(Boolean);
  if (!accepted.length || accepted.includes(wanted)) return wanted;
  const base = acpBaseModel(wanted);
  const same = accepted.filter((id: string) => acpBaseModel(id) === base);
  if (!same.length) return null;
  const current = opt ? opt.currentValue : session?.models?.currentModelId;
  return same.includes(current) ? current : same[0];
}
