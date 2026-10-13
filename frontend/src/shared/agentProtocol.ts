// Local AI agents (Claude Code, Codex, Cursor Agent) as Sutra's text engine — the PURE half: how each
// CLI is invoked, how the prompt is built, and how its output is turned back into JSON. The Electron
// main process (electron/agents.ts) spawns the binaries; the renderer never does.
//
// Every call is text only (transcripts/notes → JSON). Agents run with tools disabled / a read-only
// sandbox, in an empty temporary working directory, with the prompt on stdin.

export type AgentId = "claude" | "codex" | "cursor";

export interface AgentInfo {
  id: AgentId;
  label: string;
  /** Binary names to look for on PATH, in order. */
  binaries: string[];
  install: string;
  /** How to sign in once installed. */
  signIn: string;
  docs: string;
  /** Suggested --model values (free text is accepted too). */
  models: string[];
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  claude: {
    id: "claude", label: "Claude Code", binaries: ["claude"],
    install: "npm install -g @anthropic-ai/claude-code", signIn: "Run `claude` once to sign in.",
    docs: "https://docs.claude.com/en/docs/claude-code",
    models: ["sonnet", "opus", "haiku"],
  },
  codex: {
    id: "codex", label: "Codex CLI", binaries: ["codex"],
    install: "npm install -g @openai/codex", signIn: "Run `codex login` once.",
    docs: "https://github.com/openai/codex",
    models: ["gpt-5-codex", "gpt-5", "o4-mini"],
  },
  cursor: {
    id: "cursor", label: "Cursor Agent", binaries: ["cursor-agent", "agent"],
    install: "curl https://cursor.com/install -fsS | bash", signIn: "Run `cursor-agent login` once.",
    docs: "https://docs.cursor.com/en/cli/overview",
    models: ["auto", "sonnet-4.5", "gpt-5"],
  },
};

/** A model name from Settings goes on a command line — keep it to a safe charset. */
export function safeModel(m: unknown): string | null {
  const s = String(m ?? "").trim();
  return s && /^[\w.:\/@-]{1,80}$/.test(s) ? s : null;
}

export interface AgentRequest {
  system: string;
  user: string;
  /** JSON Schema (the inner `schema`, not the OpenAI {name, strict, schema} wrapper). */
  schema?: object;
  model?: string | null;
}

/** The single prompt sent on stdin. When the CLI can't enforce a schema itself we ask for bare JSON. */
export function buildAgentPrompt(req: AgentRequest, enforceSchemaInPrompt: boolean): string {
  const parts = [
    "You are the text engine of Sutra, a private meeting-notes app. Do not use tools, read or write files, or run commands — answer from the text below only.",
    req.system.trim(),
  ];
  if (req.schema && enforceSchemaInPrompt) {
    parts.push(`Reply with ONLY one JSON object (no prose, no code fences) that validates against this JSON Schema:\n${JSON.stringify(req.schema)}`);
  }
  parts.push(req.user.trim());
  return parts.join("\n\n");
}

export interface AgentInvocation {
  args: string[];
  /** Whether the prompt goes on stdin (else it is the last argument). */
  stdin: boolean;
  /** For Codex: files main must create before spawning (schema) and read after (last message). */
  schemaFile?: string;
  outFile?: string;
}

/** Command-line arguments per agent. `tmp` is the private temp dir the call runs in. */
export function agentInvocation(id: AgentId, req: AgentRequest, tmp: string, sep = "/"): AgentInvocation {
  const model = safeModel(req.model);
  if (id === "claude") {
    const args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence"];
    if (model) args.push("--model", model);
    if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));
    return { args, stdin: true };
  }
  if (id === "codex") {
    const outFile = `${tmp}${sep}last-message.txt`;
    const schemaFile = req.schema ? `${tmp}${sep}schema.json` : undefined;
    const args = ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never", "-o", outFile];
    if (schemaFile) args.push("--output-schema", schemaFile);
    if (model) args.push("-m", model);
    args.push("-");
    return { args, stdin: true, schemaFile, outFile };
  }
  // Cursor Agent: print mode takes the prompt as an argument.
  const args = ["-p", "--output-format", "json"];
  if (model && model !== "auto") args.push("--model", model);
  return { args, stdin: false };
}

/** Pull the first JSON object/array out of free text (tolerates ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const s = String(text ?? "").trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
  const start = s.search(/[{[]/);
  if (start < 0) throw new Error("The agent didn't return JSON.");
  const open = s[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error("The agent returned incomplete JSON.");
}

/** Turn a CLI's stdout (+ Codex's last-message file) into the answer text / structured JSON. */
export function parseAgentOutput(id: AgentId, stdout: string, lastMessage: string | null, wantJson: boolean): { text: string; json?: unknown } {
  let text: string;
  if (id === "codex") {
    text = (lastMessage ?? stdout).trim();
  } else {
    // claude / cursor-agent --output-format json → { is_error, result, structured_output? }
    const env = extractJson(stdout) as any;
    if (env?.is_error) throw new Error(String(env.result || env.error || "The agent reported an error."));
    if (wantJson && env?.structured_output != null) return { text: JSON.stringify(env.structured_output), json: env.structured_output };
    text = String(env?.result ?? "").trim();
  }
  return wantJson ? { text, json: extractJson(text) } : { text };
}
