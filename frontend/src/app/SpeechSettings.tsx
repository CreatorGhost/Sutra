// On-device speech settings: which transcription model runs on this computer, how Hindi is written,
// and the speaker-separation pack. Everything here runs locally in the desktop app (electron/speech/*).
// Owned separately from the AI-engine settings so the two can evolve independently.
import { Fragment, useEffect, useState } from "react";
import { Check, Download, Trash2, X } from "lucide-react";
import { desktop, type SttProgress, type SttStatus } from "../desktop/bridge";
import { SPEAKER_PACK, SPEAKER_PACK_ID, findSpeechModel, groupModels, hardwareLabel, recommendModel, type SpeechModel } from "../shared/speechModels";
import { engineChoice } from "../providers";
import { friendlyError } from "./ui";
import "./speech.css";

const mb = (n: number) => (n >= 1000 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);
const Dots = ({ n, label }: { n: number; label: string }) => (
  <span className="dots" title={`${label}: ${n}/5`} aria-label={`${label} ${n} of 5`}>
    {[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= n ? "on" : ""} />)}
  </span>
);

const GROUP_TITLE = { recommended: "Recommended for this computer", hindi: "Hindi & Hinglish", english: "English only", advanced: "Advanced", "whisper-cpp": "whisper.cpp" } as const;
/** Groups folded behind "More models" (shown anyway when the active model lives there). */
const EXTRA = new Set(["advanced", "whisper-cpp"]);

const SCRIPT_NOTE: Record<string, string> = {
  hinglish: "Hindi in English letters — “kal meeting hai”.",
  devanagari: "Hindi in Devanagari, English in English — “कल meeting है”.",
  english: "Transcripts are in English. Pick a script to keep Hindi as spoken.",
  verbatim: "Transcripts keep whatever script the model hears.",
};

export function SpeechSettings({ settings, onChange }: { settings: Record<string, unknown>; onChange: (patch: Record<string, unknown>) => Promise<void> }) {
  const choice = engineChoice(settings);
  const [st, setSt] = useState<SttStatus | null>(null);
  const [progress, setProgress] = useState<SttProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const refresh = () => { void desktop?.stt.status().then((s) => { setSt(s); if (s.downloading) setProgress((p) => p ?? s.downloading); }).catch(() => {}); };
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
    return <p className="muted" style={{ fontSize: 14 }}>On-device transcription is available in the desktop app.</p>;
  }

  const lang = String(settings["transcript_lang"] || "english");
  const installed = new Set(st?.installed ?? []);
  const rec = recommendModel(st?.hardware ?? null);
  const groups = groupModels(rec.id, { whisperCli: !!st?.whisperCli });
  const activeId = choice.sttModel;
  const active = findSpeechModel(activeId);

  const download = async (id: string) => {
    setErr(null);
    setProgress({ id, received: 0, total: 1 });
    try {
      await desktop!.stt.download(id);
      // Switch to a model the moment it lands unless one the user picked is already usable.
      if (id !== SPEAKER_PACK_ID && !installed.has(activeId)) await onChange({ stt_model: id });
    } catch (e) { const m = friendlyError(e); if (!/cancel/i.test(m)) setErr(m); }
    finally { setProgress(null); refresh(); }
  };
  const remove = async (id: string) => { await desktop!.stt.remove(id); refresh(); };

  const row = (m: SpeechModel) => {
    const has = installed.has(m.id);
    const on = activeId === m.id && has;
    const dl = progress?.id === m.id ? progress : null;
    const pct = dl ? Math.min(100, (dl.received / Math.max(1, dl.total)) * 100) : 0;
    return (
      <div key={m.id} className={`model${on ? " active" : ""}`}>
        <button className="radio" aria-label={`Use ${m.label}`} aria-pressed={on} disabled={!has}
          onClick={() => void onChange({ stt_model: m.id })}>{on ? <Check size={13} strokeWidth={3} /> : null}</button>
        <div className="grow">
          <div className="t">
            {m.label}
            {!m.hindi && <span className="badge dim">{m.languages === "English" ? "English only" : "No Hindi"}</span>}
          </div>
          <div className="d">{m.note}</div>
          <div className="meters">
            <span>{mb(m.sizeMB)}</span>
            <span>Speed <Dots n={m.speed} label="Speed" /></span>
            <span>Accuracy <Dots n={m.accuracy} label="Accuracy" /></span>
            {!m.verified && <span className="speech-unverified" title="This download link couldn't be checked yet">Unverified link</span>}
          </div>
          {dl && (
            <>
              <div className="bar"><i style={{ width: `${dl.phase === "extract" ? 100 : pct}%` }} /></div>
              <div className="speech-phase">
                {dl.phase === "extract" ? "Unpacking…" : dl.item === SPEAKER_PACK_ID && m.id !== SPEAKER_PACK_ID ? "Getting speaker separation first…" : `${mb(dl.received / 1048576)} of ${mb(dl.total / 1048576)}`}
              </div>
            </>
          )}
        </div>
        {dl ? (
          <button className="btn" onClick={() => void desktop!.stt.cancel()} aria-label="Cancel download"><X size={14} /> {dl.phase === "extract" ? "…" : `${Math.round(pct)}%`}</button>
        ) : has ? (
          <button className="icon-btn sm ghost" onClick={() => void remove(m.id)} aria-label={`Delete ${m.label}`} title="Delete model"><Trash2 size={15} /></button>
        ) : (
          <button className="btn" disabled={!!progress || (m.engine === "sherpa" && st?.runtime.ok === false)} onClick={() => void download(m.id)}><Download size={14} /> Get</button>
        )}
      </div>
    );
  };

  const visible = groups.filter((g) => !EXTRA.has(g.key) || more || (active && g.models.includes(active)));
  const speakersReady = installed.has(SPEAKER_PACK_ID);
  const speakersDl = progress?.id === SPEAKER_PACK_ID;

  return (
    <div className="intel speech">
      <div className="set-label">Transcription</div>
      <p className="speech-hint">
        Runs on this computer — audio never leaves it.
        {st && <> Recommended for your {hardwareLabel(st.hardware)}.</>}
      </p>

      {st && !st.runtime.ok && (
        <div className="notice err" style={{ marginBottom: 12 }}><div className="grow">{st.runtime.error}</div></div>
      )}

      <div className="set-card">
        <div className="set-row">
          <div className="grow">
            <div className="t">Hindi script</div>
            <div className="d">{SCRIPT_NOTE[lang] ?? SCRIPT_NOTE.verbatim}</div>
          </div>
          <div className="mini-seg" role="group" aria-label="Hindi script">
            <button aria-pressed={lang === "hinglish"} onClick={() => void onChange({ transcript_lang: "hinglish" })}>Roman</button>
            <button aria-pressed={lang === "devanagari"} onClick={() => void onChange({ transcript_lang: "devanagari" })} lang="hi">देवनागरी</button>
          </div>
        </div>
      </div>

      {visible.map((g) => (
        <Fragment key={g.key}>
          <div className="set-label speech-group">{GROUP_TITLE[g.key]}</div>
          <div className="set-card models">{g.models.map(row)}</div>
        </Fragment>
      ))}
      {groups.some((g) => EXTRA.has(g.key)) && (
        <button className="speech-more" onClick={() => setMore((v) => !v)}>{more ? "Fewer models" : "More models"}</button>
      )}

      <div className="set-label speech-group">Speaker separation</div>
      <div className="set-card">
        <div className="set-row">
          <div className="grow">
            <div className="t">Who said what</div>
            <div className="d">
              {speakersReady ? "Ready. Tells the other people on a call apart and learns voices you name." : `${mb(SPEAKER_PACK.sizeMB)} — downloads with your first model.`}
            </div>
            {speakersDl && progress && <div className="bar"><i style={{ width: `${progress.phase === "extract" ? 100 : Math.min(100, (progress.received / Math.max(1, progress.total)) * 100)}%` }} /></div>}
          </div>
          {speakersReady ? <span className="speech-ok"><Check size={14} strokeWidth={3} /> On</span>
            : speakersDl ? <button className="btn" onClick={() => void desktop!.stt.cancel()}><X size={14} /> Cancel</button>
            : <button className="btn" disabled={!!progress || st?.runtime.ok === false} onClick={() => void download(SPEAKER_PACK_ID)}><Download size={14} /> Get</button>}
        </div>
      </div>

      {st && (
        <p className="speech-foot">
          {st.diskMB > 0 ? `Models use ${mb(st.diskMB)} on this computer.` : "Nothing downloaded yet."}
          {active && !installed.has(active.id) && !progress && " Download a model to start recording."}
        </p>
      )}
      {err && <div className="notice err" style={{ marginTop: 12 }}><div className="grow">{err}</div><button className="icon-btn sm ghost" onClick={() => setErr(null)} aria-label="Dismiss"><X size={14} /></button></div>}
    </div>
  );
}

/** Whether recording can start with the local speech setup (checked before every recording). */
export async function localSttReady(settings: Record<string, unknown>): Promise<string | null> {
  const c = engineChoice(settings);
  if (c.stt !== "local" || !desktop) return null;
  const st = await desktop.stt.status();
  const model = findSpeechModel(c.sttModel);
  if (!model || model.id === SPEAKER_PACK_ID) return "Choose a transcription model in Settings → Transcription.";
  if (model.engine === "sherpa" && !st.runtime.ok) return st.runtime.error ?? "The on-device speech engine can't run on this computer.";
  if (model.engine === "whisper-cpp" && !st.whisperCli) return `${model.label} needs whisper.cpp, which isn't installed — pick another model in Settings → Transcription.`;
  if (st.downloading) return "Your transcription model is still downloading — recording can start once it finishes.";
  if (!st.installed.includes(model.id)) return "Download a transcription model in Settings → Transcription first. It runs on this computer, so audio never leaves it.";
  // sherpa models need the speaker pack's voice-activity detector to cut audio into phrases.
  if (model.engine === "sherpa" && !st.installed.includes(SPEAKER_PACK_ID)) return "Finish setting up speaker separation in Settings → Transcription first.";
  return null;
}
