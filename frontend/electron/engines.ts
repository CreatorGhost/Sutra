// The AI-engine registry, runtime half: how to probe each CLI (version, sign-in, models) and how to send
// it one prompt. Static facts (labels, binaries, install/sign-in commands, argv) and every output parser
// live in src/shared/agentProtocol.ts + src/shared/engineProbes.ts, where they're unit-tested.
// Probe commands follow ViewCode's provider layers (T3 Code fork, MIT, © T3 Tools Inc.).
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { AGENTS, acpInvocation, agentInvocation, parseAgentOutput, type AgentId, type AgentRequest } from "../src/shared/agentProtocol";
import {
  parseAcpModels, parseClaudeAuthStatus, parseCodexAuthFile, parseCodexLoginStatus, parseCommandCodeModelList, parseCommandCodeStatus,
  parseCursorAbout, parseDroidModelList, parseGeminiAuth, parseGrokModels, parseVersion, type AuthProbe,
} from "../src/shared/engineProbes";
import { probeAcpSession, runAcpPrompt } from "./acp";
import { killTree, runProcess, spawnTool } from "./proc";

export interface ProbeResult extends AuthProbe { version: string | null; models: string[]; defaultModel: string | null; hint?: string | null }

const PROBE_MS = 10000;
const out = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`;
const quiet = (bin: string, args: string[], timeoutMs = PROBE_MS) =>
  runProcess(bin, args, { timeoutMs, cwd: tmpdir() }).catch(() => ({ code: null, stdout: "", stderr: "", timedOut: false }));
const version = async (bin: string) => parseVersion((await quiet(bin, ["--version"])).stdout);
const readText = (p: string) => readFile(p, "utf8").catch(() => null);
const statics = (id: AgentId) => ({ models: AGENTS[id].models, defaultModel: null });

/** One ACP session (no prompt) to learn the models an agent offers; empty when it can't open one. */
async function acpModels(id: AgentId, bin: string, extMethod?: string) {
  const inv = acpInvocation(id, null, process.env);
  try {
    const { session, ext } = await probeAcpSession({
      start: () => spawnTool(bin, inv.args, { cwd: tmpdir() }), cwd: tmpdir(), authMethodId: inv.authMethodId,
      timeoutMs: 15000, label: AGENTS[id].label, extMethod,
    }, killTree);
    return parseAcpModels(ext, session);
  } catch {
    return { models: [], defaultModel: null };
  }
}

const PROBES: Record<AgentId, (bin: string) => Promise<ProbeResult>> = {
  async claude(bin) {
    const [v, auth] = await Promise.all([version(bin), quiet(bin, ["auth", "status"])]);
    return { version: v, ...parseClaudeAuthStatus(auth.stdout), ...statics("claude") };
  },
  async codex(bin) {
    const [v, status, file] = await Promise.all([version(bin), quiet(bin, ["login", "status"]),
      readText(join(process.env["CODEX_HOME"] || join(homedir(), ".codex"), "auth.json"))]);
    const auth = parseCodexLoginStatus(out(status));
    const who = file ? parseCodexAuthFile(file) : { email: null, plan: null };
    const account = auth.signedIn ? [who.email, who.plan ?? auth.account].filter(Boolean).join(" · ") || auth.account : null;
    return { version: v, signedIn: auth.signedIn, account, ...statics("codex") };
  },
  async cursor(bin) {
    const about = parseCursorAbout(out(await quiet(bin, ["about", "--format", "json"])));
    const v = about.version ?? (await version(bin));
    const discovered = about.signedIn === false ? null : await acpModels("cursor", bin, "cursor/list_available_models");
    return { version: v, signedIn: about.signedIn, account: about.account, ...(discovered?.models.length ? discovered : statics("cursor")) };
  },
  async gemini(bin) {
    const dir = join(homedir(), ".gemini");
    const [v, settings, accounts] = await Promise.all([version(bin), readText(join(dir, "settings.json")), readText(join(dir, "google_accounts.json"))]);
    const auth = parseGeminiAuth({ settings, accounts, hasOauthCreds: existsSync(join(dir, "oauth_creds.json")), env: process.env });
    return { version: v, ...auth, ...statics("gemini"), hint: auth.signedIn === null ? "Couldn't confirm the Gemini sign-in — run `gemini` once if Sutra reports an error." : null };
  },
  async grok(bin) {
    const [v, models] = await Promise.all([version(bin), quiet(bin, ["models"], 15000)]);
    const m = parseGrokModels(out(models));
    const signedIn = process.env["XAI_API_KEY"]?.trim() ? true : m.authenticated;
    return { version: v, signedIn, account: signedIn ? (process.env["XAI_API_KEY"]?.trim() ? "API key" : null) : null,
      ...(m.models.length ? { models: m.models, defaultModel: m.defaultModel } : statics("grok")) };
  },
  async droid(bin) {
    const [v, list] = await Promise.all([version(bin), quiet(bin, ["exec", "-m", "?"])]);
    const dir = join(homedir(), ".factory");
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { /* never signed in */ }
    const key = !!process.env["FACTORY_API_KEY"]?.trim();
    // A login lives in ~/.factory/auth.* (or the OS keychain, which we can't see — then "unknown").
    const signedIn = key || files.some((f) => /^auth(\.v2\.(file|key)|\.json|\.enc)$/.test(f)) ? true : files.length ? null : false;
    const models = parseDroidModelList(out(list));
    return { version: v, signedIn, account: key ? "API key" : null, models: models.length ? models : AGENTS.droid.models, defaultModel: null };
  },
  async commandcode(bin) {
    const st = parseCommandCodeStatus((await quiet(bin, ["status", "--json"])).stdout);
    // `--list-models` fetches the catalog over the network (seconds); not worth it while signed out.
    const models = st?.authenticated === false ? { models: [], defaultModel: null } : parseCommandCodeModelList((await quiet(bin, ["--list-models"])).stdout);
    return { version: st?.version ?? (await version(bin)), signedIn: st ? st.authenticated : null, account: null, ...models };
  },
};

export const probeEngine = (id: AgentId, bin: string) => PROBES[id](bin);

/** Run one prompt through an engine in `dir` (a private empty temp dir) and return the raw reply text,
 *  plus the structured output when the CLI enforced the schema itself. */
export async function runEngine(id: AgentId, bin: string, req: AgentRequest, prompt: string, dir: string, timeoutMs: number): Promise<{ text: string; structured?: unknown }> {
  const info = AGENTS[id];
  if (info.protocol === "acp") {
    const inv = acpInvocation(id, req.model, process.env);
    const r = await runAcpPrompt({
      start: () => spawnTool(bin, inv.args, { cwd: dir }), cwd: dir, authMethodId: inv.authMethodId, mode: inv.mode, model: inv.model,
      timeoutMs, label: info.label, prompt,
    }, killTree);
    return { text: r.text.trim() };
  }
  if (id === "codex") {
    // Signed out, `codex exec` doesn't fail — it keeps reconnecting until our timeout. Ask first (fast).
    const status = parseCodexLoginStatus(out(await quiet(bin, ["login", "status"])));
    if (status.signedIn === false) throw new Error("Codex: Not logged in");
  }
  const inv = agentInvocation(id, req, dir, sep);
  if (inv.schemaFile) await writeFile(inv.schemaFile, JSON.stringify(req.schema));
  const r = await runProcess(bin, inv.args, { input: prompt, cwd: dir, timeoutMs });
  if (r.timedOut) throw new Error(`${info.label} took too long to answer.`);
  const last = inv.outFile ? await readText(inv.outFile) : null;
  try {
    // Gemini prints its JSON (answer or error) on stderr when the run fails.
    const primary = id === "gemini" && !r.stdout.trim() ? r.stderr : r.stdout;
    const parsed = parseAgentOutput(id, primary, last);
    if (r.code !== 0 && ((!parsed.text && parsed.structured == null) || (id === "codex" && !last))) throw new Error("");
    return parsed;
  } catch (e: any) {
    const own = String(e?.message ?? "");
    const why = own && !/didn't return JSON|incomplete JSON/.test(own) ? own : (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 400);
    throw new Error(`${info.label} failed${why ? `: ${why}` : ` (exit code ${r.code})`}`);
  }
}
