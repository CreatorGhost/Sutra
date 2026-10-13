// Local speech settings: transcription model picker (and, later, speaker separation). Owned separately
// from the AI-engine settings so the two can evolve independently.
import { useEffect, useState } from "react";
import { Check, Cloud, Copy, Cpu, Download, Trash2, X } from "lucide-react";
import { api } from "../local/sutra";
import { desktop, type SttProgress, type SttStatus } from "../desktop/bridge";
import { DEFAULT_WHISPER_MODEL, WHISPER_MODELS } from "../shared/localModels";
import { engineChoice } from "../providers";
import { friendlyError } from "./ui";

const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);
const Dots = ({ n, label }: { n: number; label: string }) => (
  <span className="dots" title={`${label}: ${n}/5`} aria-label={`${label} ${n} of 5`}>
    {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= n ? "on" : ""} />)}
  </span>
);

export function SpeechSettings({ settings, onChange }: { settings: Record<string, unknown>; onChange: (patch: Record<string, unknown>) => Promise<void> }) {
  const choice = engineChoice(settings);
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [progress, setProgress] = useState<SttProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => { void desktop?.stt.status().then(setStt).catch(() => {}); };
  useEffect(() => {
    if (!desktop) return;
    refresh();
    return desktop.stt.onProgress((p) => {
      setProgress(p.done || p.error ? null : p);
      if (p.error && !/cancel/i.test(p.error)) setErr(p.error);
      if (p.done || p.error) refresh();
    });
  }, []);

  if (!desktop) {
    return <p className="muted" style={{ fontSize: 14 }}>Local transcription models are available in the desktop app.</p>;
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
      {err && <div className="notice err" style={{ marginTop: 12 }}><div className="grow">{err}</div><button className="icon-btn sm ghost" onClick={() => setErr(null)} aria-label="Dismiss"><X size={14} /></button></div>}
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
