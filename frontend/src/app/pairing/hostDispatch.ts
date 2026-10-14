// What this computer does for a paired phone, once main has forwarded the request here (see
// electron/pairing/host.ts): describe itself, transcribe a window of audio with its own speech model,
// run a text job on its own AI engine, or save a finished meeting. Pure apart from the injected deps,
// so the dispatch is unit-tested with fakes; hostExecutor.ts wires in the real ones.
import { AI_FNS, type AiFn, type EngineSummary, type HostInfo } from "../../shared/pairing/protocol";
import type { ExecDevice, ExecMessage } from "../../shared/pairing/hostApi";
import { autoEngine, isAgentId, safeModel, type AgentId, type AgentStatus } from "../../shared/agentProtocol";
import { DEFAULT_SPEECH_MODEL } from "../../shared/speechModels";
import type { Provider, TranscribeOpts } from "../../providers/provider";

export interface HostDeps {
  settings(): Promise<Record<string, unknown>>;
  detect(): Promise<AgentStatus[]>;
  /** Why on-device transcription can't run right now, or null when it can. */
  speechProblem(settings: Record<string, unknown>): Promise<string | null>;
  toWav(audio: ArrayBuffer): Promise<Blob>;
  transcribe(wav: Blob, filename: string, opts: TranscribeOpts, model: string): Promise<unknown>;
  /** The text engine: `engine` null = automatic; `modelFor` picks each engine's model. */
  textProvider(engine: AgentId | null, modelFor: (id: AgentId) => string | null): Pick<Provider, AiFn>;
  importBundle(bundle: unknown): Promise<{ conversationId: number; created: boolean }>;
}

/** Everything about this computer a phone shows, except its name and version (main adds those). */
export type HostInfoBody = Omit<HostInfo, "hostName" | "appVersion">;

// Desktop settings, read the way providers/engineChoice reads them in the desktop app.
const chosenEngine = (s: Record<string, unknown>): AgentId | null => (isAgentId(s["ai_engine"]) ? s["ai_engine"] : null);
const sttModel = (s: Record<string, unknown>) => String(s["stt_model"] || DEFAULT_SPEECH_MODEL);
const engineModel = (s: Record<string, unknown>, id: AgentId) => safeModel(s[`ai_model_${id}`]);

export async function hostInfo(deps: HostDeps): Promise<HostInfoBody> {
  const s = await deps.settings();
  const agents = await deps.detect().catch(() => [] as AgentStatus[]);
  const engines: EngineSummary[] = agents.map((a) => ({
    id: a.id, label: a.label, ready: a.installed && a.signedIn !== false, account: a.account, models: a.models, defaultModel: a.defaultModel,
    ...(a.modelNames ? { modelNames: a.modelNames } : {}), ...(a.contexts ? { contexts: a.contexts } : {}),
  }));
  const activeEngine = chosenEngine(s) ?? autoEngine(agents)?.id ?? null;
  const error = await deps.speechProblem(s).catch((e) => String(e?.message ?? e));
  return {
    engines, activeEngine,
    activeModel: activeEngine ? engineModel(s, activeEngine) : null,
    speech: { ready: !error, model: sttModel(s), error },
  };
}

/** Only what LocalSpeechProvider reads, typed; the phone's language choice wins over the Mac's. */
function transcribeOpts(raw: unknown, s: Record<string, unknown>): TranscribeOpts {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const language = typeof o.language === "string" && o.language ? o.language.slice(0, 40) : String(s["transcript_lang"] || "english");
  return { language, voiceprints: o.voiceprints !== false };
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 2000 && v.every((x) => typeof x === "string");
const isObj = (v: unknown): v is object => !!v && typeof v === "object" && !Array.isArray(v);

/** The call's arguments, checked against what that Provider method takes. */
function checkArgs(fn: AiFn, args: unknown): unknown[] {
  const a = Array.isArray(args) ? args : null;
  const ok = !!a && (
    fn === "extract" || fn === "chat" ? isObj(a[0]) && typeof a[1] === "string" && typeof a[2] === "string" && a.length === 3
    : fn === "translate" ? isStrings(a[0]) && a.length === 1
    : fn === "refine" ? isStrings(a[0]) && (a[1] === undefined || a[1] === null || isObj(a[1])) && a.length <= 2
    : typeof a[0] === "string" && isStrings(a[1]) && a.length === 2);
  if (!ok) throw new Error("That AI request didn't make sense to your Mac.");
  return fn === "refine" && a![1] === null ? [a![0]] : a!;
}

export async function aiCall(params: unknown, deps: HostDeps): Promise<unknown> {
  const p = (params ?? {}) as { fn?: unknown; args?: unknown; engine?: unknown; model?: unknown };
  const fn = p.fn as AiFn;
  if (!AI_FNS.includes(fn)) throw new Error("Your Mac doesn't know that AI job.");
  const args = checkArgs(fn, p.args);
  const s = await deps.settings();
  // A phone may ask for a specific engine + model; otherwise it's whatever this computer uses.
  const engine = isAgentId(p.engine) ? p.engine : chosenEngine(s);
  const asked = isAgentId(p.engine) ? safeModel(p.model) : null;
  const provider = deps.textProvider(engine, (id) => (asked && id === engine ? asked : engineModel(s, id)));
  return (provider[fn] as (...a: unknown[]) => Promise<unknown>)(...args);
}

export async function transcribe(req: ExecMessage, deps: HostDeps): Promise<unknown> {
  if (!req.blob?.byteLength) throw new Error("No audio reached your Mac.");
  const s = await deps.settings();
  const problem = await deps.speechProblem(s);
  if (problem) throw new Error(`On your Mac: ${problem}`);
  const wav = await deps.toWav(req.blob);
  return deps.transcribe(wav, "phone-audio.wav", transcribeOpts((req.params as { opts?: unknown } | null)?.opts, s), sttModel(s));
}

/** Bundles name the phone they came from; trust the paired device's own name over what it says. */
const fromDevice = (bundle: unknown, device: ExecDevice) =>
  bundle && typeof bundle === "object" ? { ...(bundle as object), origin: { deviceName: device.name, platform: device.platform } } : bundle;

export async function runHostRequest(req: ExecMessage, deps: HostDeps): Promise<unknown> {
  switch (req.method) {
    case "host.info": return hostInfo(deps);
    case "stt.transcribe": return transcribe(req, deps);
    case "ai.call": return aiCall(req.params, deps);
    case "meetings.put": return deps.importBundle(fromDevice((req.params as { bundle?: unknown } | null)?.bundle, req.device));
  }
  throw new Error("Your Mac doesn't know that request.");
}
