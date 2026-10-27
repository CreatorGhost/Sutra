// A one-shot Agent Client Protocol (ACP) client: JSON-RPC 2.0, one JSON message per line, over an agent
// CLI's stdio (`cursor-agent acp`, `grok agent stdio`, `droid exec --output-format acp`).
//
//   initialize → authenticate (only when asked for and offered) → session/new {cwd: empty temp dir,
//   no MCP servers} → session mode/model (best effort / when chosen) → session/prompt → collect the
//   `agent_message_chunk` text until the prompt's stopReason → kill the agent.
//
// We advertise no filesystem or terminal, refuse every tool-permission request, and answer every other
// agent→client request with an error: Sutra only wants text back. The flow follows ViewCode's
// AcpSessionRuntime / AcpTextGeneration (T3 Code fork, MIT, © T3 Tools Inc.) without the Effect library;
// see THIRD_PARTY_NOTICES.md.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { contextChoices, findContextOption, pickContext, resolveAcpModelId, splitModelParams } from "../src/shared/engineProbes";

export interface AcpOptions {
  /** Starts the agent (already resolved binary + args, cwd and env applied). */
  start: () => Promise<ChildProcessWithoutNullStreams>;
  cwd: string;
  authMethodId?: string;
  mode?: string;
  model?: string | null;
  /** Cursor's parameterized model picker: bare model ids, the context window as its own option. */
  parameterizedModels?: boolean;
  /** Screenshot files to send as image blocks (only to an agent that says it accepts images). */
  images?: string[];
  timeoutMs: number;
  /** Product name for error messages. */
  label: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };

class AcpError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

/** One JSON-RPC connection over a child's stdio. */
export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  stderr = "";
  private closed: Error | null = null;
  /** The session's latest config options, when the agent pushed an update (they change with the model). */
  configOptions: any[] | null = null;
  onNotification: (method: string, params: any) => void = () => {};

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.receive(line);
      }
    });
    child.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-20000); });
    child.stdin.on("error", () => { /* agent gone; the exit handler reports it */ });
    const fail = (why: string) => {
      if (this.closed) return;
      this.closed = new AcpError(why);
      for (const p of this.pending.values()) p.reject(this.closed);
      this.pending.clear();
    };
    child.on("error", (e) => fail(e.message));
    child.on("exit", (code) => fail(this.exitMessage(code)));
  }

  private exitMessage(code: number | null): string {
    const tail = this.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 400);
    return tail || `the agent exited${code != null ? ` with code ${code}` : ""}`;
  }

  private send(msg: object) {
    if (!this.closed) this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  request(method: string, params: object): Promise<any> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }

  private receive(line: string) {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; } // agents may log non-JSON to stdout
    if (msg.id != null && msg.method == null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new AcpError(String(msg.error.message ?? `${p.method} failed`) + (msg.error.data?.message ? `: ${msg.error.data.message}` : ""), msg.error.code));
      else p.resolve(msg.result ?? null);
      return;
    }
    if (msg.method && msg.id != null) { this.answer(msg.id, msg.method, msg.params); return; }
    if (msg.method) {
      const u = msg.params?.update;
      if (msg.method === "session/update" && u?.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) this.configOptions = u.configOptions;
      this.onNotification(msg.method, msg.params);
    }
  }

  /** Agent → client requests. Tool permissions are always refused (with the agent's own "reject"
   *  option when it offers one, so the turn continues without the tool); nothing else is supported. */
  private answer(id: number | string, method: string, params: any) {
    if (method === "session/request_permission") {
      const reject = (params?.options ?? []).find((o: any) => o?.kind === "reject_once") ?? (params?.options ?? []).find((o: any) => o?.kind === "reject_always");
      this.send({ id, result: { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } } });
      return;
    }
    this.send({ id, error: { code: -32601, message: `Sutra does not support ${method}` } });
  }
}

/** Pick a select option for `wanted` from an ACP config option (flat or grouped options). */
function hasOptionValue(opt: any, wanted: string): boolean {
  for (const o of opt?.options ?? []) {
    if (Array.isArray(o?.options) ? o.options.some((g: any) => g?.value === wanted) : o?.value === wanted) return true;
  }
  return false;
}

const findConfig = (session: any, kind: string) =>
  (Array.isArray(session?.configOptions) ? session.configOptions : []).find((o: any) => o?.id === kind || o?.category === kind);

/** Start the agent and open a session; the caller must kill the child. */
async function openSession(o: AcpOptions, conn: AcpConnection) {
  const init = await conn.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false }, terminal: false,
      ...(o.parameterizedModels ? { _meta: { parameterizedModelPicker: true } } : {}),
    },
    clientInfo: { name: "sutra", version: "1" },
  });
  const methods: any[] = Array.isArray(init?.authMethods) ? init.authMethods : [];
  // Only a cached-login / env-key method the agent actually offers; never anything interactive.
  if (o.authMethodId && (methods.length === 0 || methods.some((m) => m?.id === o.authMethodId))) {
    await conn.request("authenticate", { methodId: o.authMethodId });
  }
  const session = await conn.request("session/new", { cwd: o.cwd, mcpServers: [] });
  const sessionId = String(session?.sessionId ?? "");
  if (!sessionId) throw new AcpError("the agent didn't open a session");
  return { init, session, sessionId };
}

async function configure(o: AcpOptions, conn: AcpConnection, session: any, sessionId: string) {
  if (o.mode) {
    const modeOpt = findConfig(session, "mode");
    try {
      if (modeOpt) { if (hasOptionValue(modeOpt, o.mode)) await conn.request("session/set_config_option", { sessionId, configId: modeOpt.id, value: o.mode }); }
      else if (session?.modes?.availableModes?.some((m: any) => m?.id === o.mode)) await conn.request("session/set_mode", { sessionId, modeId: o.mode });
    } catch { /* read-only mode is a nicety; the empty cwd + refused permissions still apply */ }
  }
  if (o.model && o.parameterizedModels) await configureParameterized(o, conn, session, sessionId, o.model);
  else if (o.model) {
    // A saved id may be stale or lack the session's config suffix; send the form the session accepts.
    const model = resolveAcpModelId(o.model, session);
    if (!model) throw new AcpError(`${o.label} no longer offers the model “${o.model}”. Pick another model in Settings → Intelligence.`);
    const modelOpt = findConfig(session, "model");
    try {
      if (modelOpt) await conn.request("session/set_config_option", { sessionId, configId: modelOpt.id, value: model });
      else await conn.request("session/set_model", { sessionId, modelId: model });
    } catch (e: any) {
      throw new AcpError(`${o.label} couldn't switch to the model “${model}”: ${e?.message ?? e}. Pick another model in Settings → Intelligence.`);
    }
  }
}

/** Cursor with `parameterizedModelPicker`: select the bare model, then the context window the user
 *  chose on the id ("…[context=1m]"), else Sutra's 300K default (the nearest the model offers). A Cursor
 *  CLI too old for the flag only takes suffixed ids: then fall back to the session's own form. After
 *  ViewCode's applyCursorAcpModelSelection. */
async function configureParameterized(o: AcpOptions, conn: AcpConnection, session: any, sessionId: string, wanted: string) {
  const { base, params } = splitModelParams(wanted);
  const modelOpt = findConfig(session, "model");
  const select = (value: string) => modelOpt
    ? conn.request("session/set_config_option", { sessionId, configId: modelOpt.id, value })
    : conn.request("session/set_model", { sessionId, modelId: value });
  let options: any = session?.configOptions;
  try {
    const r = await select(base);
    options = conn.configOptions ?? (Array.isArray(r?.configOptions) ? r.configOptions : options);
  } catch (e: any) {
    const legacy = resolveAcpModelId(wanted, session);
    if (!legacy || legacy === base) throw new AcpError(`${o.label} couldn't switch to the model “${base}”: ${e?.message ?? e}. Pick another model in Settings → Intelligence.`);
    try { await select(legacy); } catch (e2: any) {
      throw new AcpError(`${o.label} couldn't switch to the model “${legacy}”: ${e2?.message ?? e2}. Pick another model in Settings → Intelligence.`);
    }
    return; // the suffixed id already carries its context
  }
  const ctxOpt = findContextOption(options);
  const value = ctxOpt ? pickContext(contextChoices(ctxOpt), params["context"] ?? null) : null;
  if (!ctxOpt || !value || value === ctxOpt.currentValue) return;
  try {
    await conn.request("session/set_config_option", { sessionId, configId: ctxOpt.id, value });
  } catch (e: any) {
    // The default is a nicety; a window the user picked is not silently dropped.
    if (params["context"]) throw new AcpError(`${o.label} couldn't use the ${value.toUpperCase()} context window: ${e?.message ?? e}. Pick another in Settings → Intelligence.`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new AcpError(`${label} took too long to answer.`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Send one prompt and return the agent's reply text. */
export async function runAcpPrompt(o: AcpOptions & { prompt: string }, kill: (c: ChildProcessWithoutNullStreams) => void): Promise<{ text: string; stopReason: string }> {
  const child = await o.start();
  const conn = new AcpConnection(child);
  let text = "";
  let completeFromNotification: ((r: { stopReason?: string }) => void) | null = null;
  conn.onNotification = (method, params) => {
    if (method === "session/update") {
      const u = params?.update;
      if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += String(u.content.text ?? "");
    } else if (/session\/prompt_complete$/.test(method)) {
      // Grok may finish a turn with an `_x.ai/session/prompt_complete` notification instead of answering.
      completeFromNotification?.(params ?? {});
    }
  };
  try {
    const result = await withTimeout((async () => {
      const { init, session, sessionId } = await openSession(o, conn);
      if (o.images?.length && init?.agentCapabilities?.promptCapabilities?.image !== true) throw new AcpError(`${o.label} can't look at screenshots.`);
      await configure(o, conn, session, sessionId);
      const viaNotification = new Promise<{ stopReason?: string }>((r) => { completeFromNotification = r; });
      const prompt: object[] = [{ type: "text", text: o.prompt }];
      for (const f of o.images ?? []) {
        prompt.push({ type: "text", text: basename(f).replace(/\.jpg$/, "") }, { type: "image", mimeType: "image/jpeg", data: readFileSync(f).toString("base64") });
      }
      return Promise.race([conn.request("session/prompt", { sessionId, prompt }), viaNotification]);
    })(), o.timeoutMs, o.label);
    const stopReason = String(result?.stopReason ?? "end_turn");
    if (stopReason === "cancelled") throw new AcpError(`${o.label} cancelled the request.`);
    if (stopReason === "refusal") throw new AcpError(`${o.label} declined to answer.`);
    if ((stopReason === "error" || stopReason === "rate_limit") && !text.trim()) throw new AcpError(stopReason === "rate_limit" ? `${o.label} is rate-limited right now — try again shortly.` : `${o.label} reported an error.`);
    return { text, stopReason };
  } catch (e: any) {
    const why = String(e?.message ?? e);
    throw new AcpError(why.startsWith(o.label) ? why : `${o.label}: ${why}`);
  } finally {
    kill(child);
  }
}

/** Open a session without prompting (detection): the advertised models, plus `extMethod`'s answer
 *  (e.g. Cursor's `cursor/list_available_models`) when given. */
export async function probeAcpSession(o: AcpOptions & { extMethod?: string }, kill: (c: ChildProcessWithoutNullStreams) => void): Promise<{ session: any; ext: unknown }> {
  const child = await o.start();
  const conn = new AcpConnection(child);
  try {
    return await withTimeout((async () => {
      const { session } = await openSession(o, conn);
      let ext: unknown = null;
      if (o.extMethod) { try { ext = await conn.request(o.extMethod, {}); } catch { /* optional */ } }
      return { session, ext };
    })(), o.timeoutMs, o.label);
  } finally {
    kill(child);
  }
}
