// "Where does the thinking happen?" — transcription engine + model, and the engine for notes/questions.
// Shown in Settings and as the first-run setup card on Home (desktop).
import { useEffect, useState } from "react";
import { Check, Cloud, Copy, Cpu, Download, Loader2, Trash2, X } from "lucide-react";
import { api } from "../local/sutra";
import { desktop, type AgentStatus, type SttProgress, type SttStatus } from "../desktop/bridge";
import { AGENTS, type AgentId } from "../shared/agentProtocol";
import { DEFAULT_WHISPER_MODEL, WHISPER_MODELS } from "../shared/localModels";
import { engineChoice } from "../providers";
import { friendlyError } from "./ui";

const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);
const Dots = ({ n, label }: { n: number; label: string }) => (
  <span className="dots" title={`${label}: ${n}/5`} aria-label={`${label} ${n} of 5`}>
    {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= n ? "on" : ""} />)}
  </span>
);

export function Intelligence({ settings, onChange }: { settings: Record<string, unknown>; onChange: (patch: Record<string, unknown>) => Promise<void> }) {
  const choice = engineChoice(settings);
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [progress, setProgress] = useState<SttProgress | null>(null);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => { void desktop?.stt.status().then(setStt).catch(() => {}); };
  useEffect(() => {
    if (!desktop) return;
    refresh();
    void desktop.ai.detect().then(setAgents).catch(() => setAgents([]));
    return desktop.stt.onProgress((p) => {
      setProgress(p.done || p.error ? null : p);
      if (p.error && !/cancel/i.test(p.error)) setErr(p.error);
      if (p.done || p.error) refresh();
    });
  }, []);

  if (!desktop) {
    return <p className="muted" style={{ fontSize: 14 }}>Local transcription models and local AI agents (Claude Code, Codex, Cursor) are available in the desktop app. Here, Sutra uses its cloud service.</p>;
  }

  const download = async (id: string) => {
    setErr(null);
    setProgress({ id, received: 0, total: 1 });
    try { await desktop!.stt.download(id); await onChange({ stt_model: id }); }
    catch (e) { const m = friendlyError(e); if (!/cancel/i.test(m)) setErr(m); }
    finally { setProgress(null); refresh(); }
  };
  const remove = async (id: string) => { await desktop!.stt.remove(id); refresh(); };
  const copy = (t: string) => void api.copyText(t);

  return (
    <div className="intel">
      <div className="set-label">Transcription</div>
      <div className="choice-row">
        <button className={`choice${choice.stt === "cloud" ? " on" : ""}`} onClick={() => void onChange({ stt_engine: "cloud" })}>
          <Cloud size={18} /><span><b>Sutra cloud</b><small>Speaker separation, voice recognition, tuned for Hinglish.</small></span>
        </button>
        <button className={`choice${choice.stt === "local" ? " on" : ""}`} onClick={() => void onChange({ stt_engine: "local", stt_model: settings["stt_model"] || DEFAULT_WHISPER_MODEL })}>
          <Cpu size={18} /><span><b>On this computer</b><small>Whisper runs locally. Audio never leaves your machine.</small></span>
        </button>
      </div>

      {choice.stt === "local" && (
        <>
          {stt && !stt.binary && (
            <div className="notice" style={{ marginTop: 12 }}>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>Install whisper.cpp to transcribe locally</div>
                <code className="cmd">brew install whisper-cpp</code>
                <div className="muted" style={{ fontSize: 13 }}>Windows/Linux: install a whisper.cpp build that provides <code>whisper-cli</code> on your PATH.</div>
              </div>
              <button className="icon-btn sm" onClick={() => copy("brew install whisper-cpp")} aria-label="Copy command"><Copy size={14} /></button>
            </div>
          )}
          <div className="set-card models" style={{ marginTop: 12 }}>
            {WHISPER_MODELS.map((m) => {
              const installed = !!stt?.installed.includes(m.id);
              const active = choice.sttModel === m.id;
              const dl = progress?.id === m.id ? progress : null;
              return (
                <div key={m.id} className={`model${active ? " active" : ""}`}>
                  <button className="radio" aria-label={`Use ${m.label}`} aria-pressed={active} disabled={!installed}
                    onClick={() => void onChange({ stt_model: m.id })}>{active && installed ? <Check size={13} strokeWidth={3} /> : null}</button>
                  <div className="grow">
                    <div className="t">
                      {m.label}
                      {m.recommended && <span className="badge">Recommended</span>}
                      {!m.multilingual && <span className="badge dim">English only</span>}
                    </div>
                    <div className="d">{m.note}</div>
                    <div className="meters"><span>{mb(m.sizeMB)}</span><span>Speed <Dots n={m.speed} label="Speed" /></span><span>Accuracy <Dots n={m.accuracy} label="Accuracy" /></span></div>
                    {dl && <div className="bar"><i style={{ width: `${Math.min(100, (dl.received / Math.max(1, dl.total)) * 100)}%` }} /></div>}
                  </div>
                  {dl ? (
                    <button className="btn" onClick={() => void desktop!.stt.cancel()}><X size={14} /> {Math.round((dl.received / Math.max(1, dl.total)) * 100)}%</button>
                  ) : installed ? (
                    <button className="icon-btn sm ghost" onClick={() => void remove(m.id)} aria-label={`Delete ${m.label}`} title="Delete model"><Trash2 size={15} /></button>
                  ) : (
                    <button className="btn" disabled={!!progress} onClick={() => void download(m.id)}><Download size={14} /> Get</button>
                  )}
                </div>
              );
            })}
          </div>
          {stt && !stt.installed.includes(choice.sttModel) && !progress && (
            <p className="muted" style={{ fontSize: 13, margin: "8px 2px 0" }}>Download a model to start recording. Large v3 Turbo (quantized) is the best fit for most Macs.</p>
          )}
        </>
      )}

      <div className="set-label" style={{ marginTop: 22 }}>Notes & questions</div>
      <div className="set-card">
        <EngineRow id="cloud" active={choice.ai === "cloud"} title="Sutra cloud" detail="Fastest. Also powers semantic search." onPick={() => void onChange({ ai_engine: "cloud" })} />
        {(Object.keys(AGENTS) as AgentId[]).map((id) => {
          const st = agents?.find((a) => a.id === id);
          return (
            <EngineRow key={id} id={id} active={choice.ai === id} title={AGENTS[id].label}
              detail={agents === null ? "Checking…" : st?.path ? `Installed${st.version ? ` · ${st.version}` : ""}` : "Not found"}
              disabled={!st?.path} onPick={() => void onChange({ ai_engine: id })}>
              {!st?.path && agents !== null && (
                <>
                  <div className="install"><code className="cmd">{AGENTS[id].install}</code><button className="icon-btn sm ghost" onClick={() => copy(AGENTS[id].install)} aria-label="Copy install command"><Copy size={13} /></button></div>
                  <div className="d">{AGENTS[id].signIn}</div>
                </>
              )}
              {choice.ai === id && st?.path && (
                <label className="model-input">Model
                  <input list={`models-${id}`} defaultValue={String(settings[`ai_model_${id}`] ?? "")} placeholder="default"
                    onBlur={(e) => void onChange({ [`ai_model_${id}`]: e.target.value.trim() })} />
                  <datalist id={`models-${id}`}>{AGENTS[id].models.map((m) => <option key={m} value={m} />)}</datalist>
                </label>
              )}
            </EngineRow>
          );
        })}
      </div>
      {choice.ai !== "cloud" && (
        <p className="muted" style={{ fontSize: 13, margin: "8px 2px 0" }}>
          Uses your own {AGENTS[choice.ai as AgentId].label} sign-in, with tools off, in an empty folder. Search uses keywords with a local agent.
        </p>
      )}
      {err && <div className="notice err" style={{ marginTop: 12 }}><div className="grow">{err}</div><button className="icon-btn sm ghost" onClick={() => setErr(null)} aria-label="Dismiss"><X size={14} /></button></div>}
    </div>
  );
}

function EngineRow({ active, title, detail, disabled, onPick, children }: {
  id: string; active: boolean; title: string; detail: string; disabled?: boolean; onPick: () => void; children?: React.ReactNode;
}) {
  return (
    <div className={`set-row engine${active ? " active" : ""}`}>
      <button className="radio" aria-pressed={active} aria-label={`Use ${title}`} disabled={disabled} onClick={onPick}>{active ? <Check size={13} strokeWidth={3} /> : null}</button>
      <div className="grow">
        <div className="t">{title}</div>
        <div className="d">{detail}</div>
        {children}
      </div>
    </div>
  );
}

/** Whether the local setup can record right now (used before starting a recording). */
export async function localSttReady(settings: Record<string, unknown>): Promise<string | null> {
  const c = engineChoice(settings);
  if (c.stt !== "local" || !desktop) return null;
  const st = await desktop.stt.status();
  if (!st.binary) return "Local transcription needs whisper.cpp — install it with “brew install whisper-cpp”, or switch to Sutra cloud in Settings.";
  if (!st.installed.includes(c.sttModel)) return "Download your local transcription model in Settings first.";
  return null;
}
