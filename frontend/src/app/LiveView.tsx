import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Camera, Loader2, Mic, ShieldCheck, Square } from "lucide-react";
import { speakerName } from "../local/speakers";
import { clock } from "./format";
import { useNow, useRecorder } from "./recorder";
import { LevelBars } from "./ui";
import { useMac } from "../pairing/runtime";
import { desktop } from "../desktop/bridge";

/** The recording screen: big clock, live level, and the transcript as each ~90 s window lands. */
export function LiveView() {
  const nav = useNavigate();
  const { state: rec, start, stop, clearError, switchScreen } = useRecorder();
  const now = useNow(rec.status === "recording");
  const mac = useMac();
  const viaMac = !!mac.pairing && mac.status.state !== "revoked";
  const endRef = useRef<HTMLDivElement | null>(null);
  // Screenshots on and more than one screen: show which is captured (starts on the call's screen) and let
  // the user switch.
  type Screens = Awaited<ReturnType<NonNullable<typeof desktop>["capture"]["screens"]>>;
  const [screens, setScreens] = useState<Screens | null>(null);
  const [switching, setSwitching] = useState(false);
  const loadScreens = async () => {
    const on = (await desktop?.prefs.get().catch(() => null))?.captureScreen;
    const s = on ? await desktop!.capture.screens().catch(() => null) : null;
    setScreens(s && s.screens.length > 1 ? s : null);
  };
  useEffect(() => {
    if (rec.capture !== "recording" || !desktop) { setScreens(null); return; }
    void loadScreens();
  }, [rec.capture]);
  const pick = async (id: number) => {
    setSwitching(true);
    try { await switchScreen(id); await loadScreens(); } catch { /* keep the current screen */ } finally { setSwitching(false); }
  };
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [rec.turns.length]);

  // When the notes are ready, open them.
  const prevStatus = useRef(rec.status);
  useEffect(() => {
    if (prevStatus.current === "processing" && rec.status === "idle" && rec.lastConversationId) nav(`/m/${rec.lastConversationId}`, { replace: true });
    prevStatus.current = rec.status;
  }, [rec.status, rec.lastConversationId, nav]);

  const recording = rec.status === "recording";
  return (
    <div className="live">
      <div className="pane-top drag">
        <button className="icon-btn ghost sm back-btn" onClick={() => nav("/")} aria-label="Back"><ArrowLeft size={18} /></button>
      </div>
      <div className="live-head">
        {rec.status === "processing" ? (
          <>
            <div className="hero-mark"><Loader2 size={24} className="spin" /></div>
            <p className="hero-title">Writing your notes…</p>
            <p className="hero-text">Transcribing the last few seconds and pulling out the summary, decisions and action items.</p>
          </>
        ) : recording || rec.status === "starting" ? (
          <>
            <div className="muted" style={{ fontWeight: 600 }}>
              <span className="live-dot" />{rec.status === "starting" ? "Starting…" : `Recording${rec.app ? ` · ${rec.app}` : ""}`}
            </div>
            <div className="live-clock">{rec.startedAt ? clock(now - rec.startedAt) : "0:00"}</div>
            <div style={{ color: "var(--rec)", marginBottom: screens ? 8 : 20 }}><LevelBars level={rec.level} count={7} /></div>
            {screens && (
              <div className="shot-screens" role="radiogroup" aria-label="Screenshots from">
                <span className="faint"><Camera size={14} /> Screenshots from</span>
                {screens.screens.map((d, i) => (
                  <button key={d.id} role="radio" aria-checked={d.id === screens.current} disabled={switching}
                    className={`btn sm${d.id === screens.current ? " on" : ""}`} onClick={() => d.id !== screens.current && void pick(d.id)} title={d.label}>
                    Screen {i + 1}<span className="faint"> · {d.label}</span>
                  </button>
                ))}
              </div>
            )}
            <button className="btn primary" onClick={() => void stop()} disabled={!recording}><Square size={13} fill="currentColor" /> Stop & write notes</button>
          </>
        ) : (
          <>
            <div className="hero-mark"><Mic size={24} /></div>
            <p className="hero-title">Ready when you are</p>
            <p className="hero-text">
              {rec.mode === "mic" ? "Sutra listens through your microphone." : "Sutra records your mic and the meeting's audio — no bot joins the call."}
            </p>
            <button className="btn primary" onClick={() => void start()}>Start recording</button>
          </>
        )}
        {rec.notice && !rec.error && (
          <div className="notice" style={{ maxWidth: 560, margin: "22px auto 0", textAlign: "left" }}>
            <div className="grow">{rec.notice}</div>
            <button className="icon-btn ghost sm" onClick={clearError} aria-label="Dismiss">×</button>
          </div>
        )}
        {rec.error && (
          <div className="notice err" style={{ maxWidth: 560, margin: "22px auto 0", textAlign: "left" }}>
            <div className="grow">{rec.error}</div>
            <button className="icon-btn ghost sm" onClick={clearError} aria-label="Dismiss">×</button>
          </div>
        )}
      </div>
      <div className="live-body">
        {recording && viaMac && mac.status.state !== "online" ? (
          <p className="faint" style={{ textAlign: "center" }}>Your Mac isn't reachable — this recording is saved on your phone and will be transcribed when it is.</p>
        ) : recording && rec.turns.length === 0 && (
          <p className="faint" style={{ textAlign: "center" }}>The transcript appears here as you talk — in chunks of about a minute and a half.</p>
        )}
        <div className="transcript">
          {rec.turns.map((t, i) => (
            <div key={t.id ?? i}>
              <div className="turn-head"><span className="speaker">{speakerName(t)}</span></div>
              <div className="turn-text">{t.text}</div>
            </div>
          ))}
        </div>
        <div ref={endRef} />
        <p className="faint" style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", fontSize: 13, marginTop: 28 }}>
          <ShieldCheck size={14} /> {viaMac ? "Audio stays encrypted on your phone only until your Mac transcribes it." : "Audio is transcribed in-flight and never stored."}
        </p>
      </div>
    </div>
  );
}
