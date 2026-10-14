// The user's AI agent CLIs as Sutra's text engine: detection (installed? signed in? which models?) and
// running one request. Each call runs in a fresh, empty private temp directory with tools off / a
// read-only mode and the prompt on stdin (or over ACP's stdio). Engines that can't enforce a JSON schema
// get it in the prompt; every JSON reply is validated and retried once with the errors.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTS, AGENT_IDS, agentBinaries, buildAgentPrompt, extractJson, installCommand, looksSignedOut,
  type AgentId, type AgentRequest, type AgentStatus,
} from "../src/shared/agentProtocol";
import { validateJson } from "../src/shared/jsonSchemaLite";
import { probeEngine, runEngine } from "./engines";
import { findBinary } from "./proc";

export type { AgentStatus };

const RUN_TIMEOUT_MS = 240000;
const DETECT_TTL_MS = 5 * 60000;

async function detectOne(id: AgentId): Promise<AgentStatus> {
  const info = AGENTS[id];
  const base: AgentStatus = {
    id, label: info.label, installed: false, path: null, version: null, signedIn: null, account: null,
    models: info.models, defaultModel: null, install: installCommand(id, process.platform), signIn: info.signIn, hint: null,
  };
  const path = await findBinary(agentBinaries(id, process.platform));
  if (!path) return { ...base, hint: `Install it with: ${base.install}` };
  try {
    const p = await probeEngine(id, path);
    return {
      ...base, installed: true, path, version: p.version, signedIn: p.signedIn, account: p.account,
      models: p.models.length ? p.models : info.models, defaultModel: p.defaultModel,
      hint: p.signedIn === false ? `Sign in with: ${info.signIn}` : p.hint ?? null,
    };
  } catch (e: any) {
    return { ...base, installed: true, path, hint: `Couldn't check ${info.label}: ${String(e?.message ?? e).slice(0, 160)}` };
  }
}

let detected: { at: number; result: Promise<AgentStatus[]> } | null = null;
/** The engines the user said they use (first-run "Which AI do you use?"); null = not chosen yet → all. */
let enabled: AgentId[] | null = null;

export function setEnabledEngines(ids: AgentId[] | null): void {
  enabled = ids ? AGENT_IDS.filter((id) => ids.includes(id)) : null;
  detected = null;
}

/** Probe the user's engines in parallel (short timeouts each) — CLIs they didn't pick are never run.
 *  Cached for a few minutes; `refresh` re-probes. */
export function detectAgents(refresh = false): Promise<AgentStatus[]> {
  if (refresh || !detected || Date.now() - detected.at > DETECT_TTL_MS) {
    const result = Promise.all((enabled ?? AGENT_IDS).map(detectOne));
    detected = { at: Date.now(), result };
    result.catch(() => { detected = null; });
  }
  return detected.result;
}

/** Serialise agent calls: several parallel CLI runs just compete for the same account and rate limit. */
let queue: Promise<unknown> = Promise.resolve();

export function runAgent(id: AgentId, req: AgentRequest): Promise<{ text: string; json?: unknown }> {
  const job = queue.then(() => runAgentNow(id, req));
  queue = job.catch(() => {});
  return job;
}

async function runAgentNow(id: AgentId, req: AgentRequest): Promise<{ text: string; json?: unknown }> {
  const info = AGENTS[id];
  if (!info) throw new Error(`Unknown AI engine: ${id}`);
  const bin = await findBinary(agentBinaries(id, process.platform));
  if (!bin) throw new Error(`${info.label} isn't installed. Install it with “${installCommand(id, process.platform)}”, then sign in with “${info.signIn}” — or pick another engine in Settings → Intelligence.`);

  const dir = await mkdtemp(join(tmpdir(), "sutra-agent-"));
  try {
    let retryErrors: string[] | undefined;
    for (let attempt = 0; ; attempt++) {
      const prompt = buildAgentPrompt(req, !!req.schema && !info.nativeSchema, retryErrors);
      const r = await runEngine(id, bin, req, prompt, dir, RUN_TIMEOUT_MS);
      if (!req.schema) {
        if (!r.text) throw new Error(`${info.label} returned an empty answer.`);
        return { text: r.text };
      }
      let json: unknown, errors: string[];
      try {
        json = r.structured ?? extractJson(r.text);
        errors = validateJson(req.schema, json);
      } catch (e: any) {
        json = undefined;
        errors = [String(e?.message ?? e)];
      }
      if (!errors.length) return { text: r.text || JSON.stringify(json), json };
      if (attempt >= 1) throw new Error(`${info.label} returned notes in the wrong shape (${errors.slice(0, 2).join("; ")}). Try again, or pick another model in Settings → Intelligence.`);
      retryErrors = errors;
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (looksSignedOut(msg)) {
      detected = null; // the cached "signed in" was wrong; re-probe next time Settings opens
      throw new Error(`${info.label} isn't signed in. Run “${info.signIn}” in a terminal, then retry. (${msg.slice(0, 200)})`);
    }
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
