// Desktop only: this window serves the requests paired phones send (forwarded by main over
// desktop.pairing.serve — see hostDispatch.ts for what each does) and tells phones when something they
// show changed (the AI engine or model, the speech model). Started once from useIntegrations().
import { desktop } from "../../desktop/bridge";
import { api, SETTINGS_CHANGED_EVENT } from "../../local/sutra";
import { importMeetingBundle } from "../../local/meetingBundle";
import { askScopeFromHint } from "../../local/repo";
import { AgentProvider } from "../../providers/agentProvider";
import { LocalSpeechProvider } from "../../providers/localSttProvider";
import type { ExecMessage } from "../../shared/pairing/hostApi";
import { notifyDataChanged } from "../events";
import { localSttReady } from "../Intelligence";
import { friendlyError } from "../ui";
import { toSpeechWav } from "./audioDecode";
import { runHostRequest, type HostDeps } from "./hostDispatch";

/** AI jobs from phones run on the user's own CLI; a few at a time is plenty. */
const MAX_AI_JOBS = 3;
/** Settings phones show (Settings → Intelligence / Transcription). */
const HOST_KEYS = /^(ai_engine|ai_model_|stt_model$|transcript_lang$)/;

const deps: HostDeps = {
  settings: () => api.getSettings(),
  detect: () => desktop!.ai.detect(),
  speechProblem: localSttReady,
  toWav: (audio) => toSpeechWav(audio),
  transcribe: (wav, filename, opts, model) => new LocalSpeechProvider(model).transcribeDiarize(wav, filename, opts),
  textProvider: (engine, modelFor) => new AgentProvider(engine, modelFor),
  importBundle: async (bundle) => {
    const r = await importMeetingBundle(bundle);
    notifyDataChanged();
    return r;
  },
  askScope: (hint) => askScopeFromHint(hint),
};

let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_AI_JOBS) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

async function serve(req: ExecMessage): Promise<void> {
  const pairing = desktop!.pairing!;
  try {
    const result = await (req.method === "ai.call" ? limited(() => runHostRequest(req, deps)) : runHostRequest(req, deps));
    pairing.result({ reqId: req.reqId, ok: true, result });
  } catch (e) {
    pairing.result({ reqId: req.reqId, ok: false, error: friendlyError(e) });
  }
}

let started = false;

export function startHostExecutor(): void {
  const pairing = desktop?.pairing;
  if (started || !pairing) return;
  started = true;
  pairing.serve((req) => void serve(req));

  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; pairing.hostChanged(); }, 500);
  };
  window.addEventListener(SETTINGS_CHANGED_EVENT, (e) => {
    const keys = (e as CustomEvent<string[]>).detail ?? [];
    if (keys.some((k) => HOST_KEYS.test(k))) changed();
  });
  desktop!.stt.onProgress((p) => { if (p.done) changed(); });
}
