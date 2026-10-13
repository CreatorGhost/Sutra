// Local AI agents as Sutra's text engine: Claude Code (`claude -p`), Codex (`codex exec`) and Cursor
// Agent (`cursor-agent -p`). Each call runs in a fresh, empty private temp directory with tools off /
// a read-only sandbox, prompt on stdin (Cursor: as an argument). Prompt building + output parsing are
// pure and unit-tested in src/shared/agentProtocol.ts.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { AGENTS, agentInvocation, buildAgentPrompt, parseAgentOutput, type AgentId, type AgentRequest } from "../src/shared/agentProtocol";
import { findBinary, runProcess } from "./proc";

export interface AgentStatus { id: AgentId; label: string; path: string | null; version: string | null; install: string }

export async function detectAgents(): Promise<AgentStatus[]> {
  return Promise.all((Object.keys(AGENTS) as AgentId[]).map(async (id) => {
    const info = AGENTS[id];
    const path = await findBinary(info.binaries);
    let version: string | null = null;
    if (path) {
      try {
        const r = await runProcess(path, ["--version"], { timeoutMs: 8000 });
        version = (r.stdout || r.stderr).trim().split("\n")[0]?.slice(0, 80) || null;
      } catch { /* present but not runnable */ }
    }
    return { id, label: info.label, path, version, install: info.install };
  }));
}

/** Serialise agent calls: several parallel `claude -p` processes just compete for the same account. */
let queue: Promise<unknown> = Promise.resolve();

export function runAgent(id: AgentId, req: AgentRequest): Promise<{ text: string; json?: unknown }> {
  const job = queue.then(() => runAgentNow(id, req));
  queue = job.catch(() => {});
  return job;
}

async function runAgentNow(id: AgentId, req: AgentRequest): Promise<{ text: string; json?: unknown }> {
  const info = AGENTS[id];
  if (!info) throw new Error(`Unknown agent: ${id}`);
  const bin = await findBinary(info.binaries);
  if (!bin) throw new Error(`${info.label} isn't installed. Install it with: ${info.install} — then: ${info.signIn}`);

  const dir = await mkdtemp(join(tmpdir(), "sutra-agent-"));
  try {
    const inv = agentInvocation(id, req, dir, sep);
    // Claude Code and Codex enforce the schema themselves; Cursor gets it spelled out in the prompt.
    const prompt = buildAgentPrompt(req, !!req.schema && id === "cursor");
    if (inv.schemaFile) await writeFile(inv.schemaFile, JSON.stringify(req.schema));
    const args = inv.stdin ? inv.args : [...inv.args, prompt];
    const r = await runProcess(bin, args, { input: inv.stdin ? prompt : undefined, cwd: dir, timeoutMs: 240000 });
    if (r.timedOut) throw new Error(`${info.label} took too long to answer.`);
    const last = inv.outFile ? await readFile(inv.outFile, "utf8").catch(() => null) : null;
    if (r.code !== 0 && !last && !r.stdout.trim()) {
      const why = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
      throw new Error(`${info.label} failed${why ? `: ${why}` : ""}. Is it signed in?`);
    }
    return parseAgentOutput(id, r.stdout, last, !!req.schema);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
