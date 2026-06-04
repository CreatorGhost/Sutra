import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Mic, Pause, Play, Square, Upload, Loader2, Check, ShieldCheck, ArrowRight } from "lucide-react";
import { api } from "../local/sutra";
import { CaptureController, type CaptureState } from "../lib/capture";
import { clock, timeAgo } from "../lib/format";
import { useWakeLock } from "../lib/useWakeLock";
import { Chip, ErrorBar } from "../components/ui";
import { Waveform } from "../components/Waveform";
import { MODE_COPY } from "../providers";

interface Turn {
  id: number; person_name?: string | null; is_me?: boolean; session_speaker_label: string;
  text: string; start_ts: number; speaker_confidence?: number | null; lang?: string;
}

export default function Capture() {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [state, setState] = useState<CaptureState>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [inflight, setInflight] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const ctrlRef = useRef<CaptureController | null>(null);
  const sidRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const [privacy, setPrivacy] = useState(MODE_COPY.hybrid.audio);
  const [lastSession, setLastSession] = useState<{ id: number; title?: string; started_at?: string } | null>(null);
  useEffect(() => { api.getMode().then((m: any) => setPrivacy(MODE_COPY[m as keyof typeof MODE_COPY].audio)).catch(() => {}); }, []);
  // Quietly surface the most recent memory so the lower half of an idle Capture screen isn't dead
  // space. Best-effort: stays hidden if nothing exists or the read fails.
  useEffect(() => { api.listConversations().then((cs: any[]) => setLastSession(cs?.[0] ?? null)).catch(() => {}); }, []);
  const recording = state !== "idle" && state !== "paused";
  const active = state !== "idle"; // recording or paused — keep the waveform stage up
  useWakeLock(recording || processing); // hold the screen awake THROUGH processing so a lock can't kill it
  useEffect(() => {
    if (state === "idle") { setElapsed(0); return; }
    if (state === "paused") return;            // freeze the timer while paused
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state]);
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const ensureSession = useCallback(async () => {
    if (sidRef.current) return sidRef.current;
    const s = await api.createSession();
    sidRef.current = s.id; setSessionId(s.id); return s.id;
  }, []);

  const uploadsRef = useRef<Promise<unknown>[]>([]);
  const uploadWindow = useCallback((blob: Blob, index: number) => {
    setInflight((n) => n + 1);
    const p = (async () => {
      try {
        // Guarantee a session exists even if this window closed before ensureSession() resolved —
        // otherwise an early window's audio would be silently dropped (it's never stored).
        const sid = sidRef.current ?? (await ensureSession());
        const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
        const res = await api.ingestWindow(sid, blob, index, `window-${index}.${ext}`);
        if (res?.turns?.length) setTurns((prev) => [...prev, ...res.turns]);
      } catch (e: any) { setError(e.message); }
      finally { setInflight((n) => n - 1); }
    })();
    uploadsRef.current.push(p);
    return p;
  }, [ensureSession]);

  const start = async () => {
    setError(null); setDone(false);
    try {
      const ctrl = new CaptureController({
        maxSeconds: 150, silenceMs: 1200,
        onWindow: (b, i) => void uploadWindow(b, i),
        onState: setState,
        onLevel: (rms) => setLevel(Math.min(1, rms * 14)),
        onError: setError,
      });
      ctrlRef.current = ctrl;
      await ctrl.start();        // starts/ resumes AudioContext within the gesture (iOS-safe)
      await ensureSession();     // session is ready well before the first window closes
    } catch (e: any) {
      console.error("[capture] start failed:", e?.name, "-", e?.message, e);
      const name = e?.name ? `${e.name}: ` : "";
      setError(`Mic unavailable — ${name}${e?.message ?? e}`);
      setState("idle");
    }
  };

  const togglePause = () => {
    const c = ctrlRef.current; if (!c) return;
    if (state === "paused") c.resume(); else c.pause();
  };

  const stop = async () => {
    const c = ctrlRef.current; const sid = sidRef.current;
    await c?.stop(); ctrlRef.current = null;
    setState("idle");
    if (sid) {
      setProcessing(true);
      try {
        // Drain ALL in-flight uploads deterministically (no stale-ref polling) so processSession never
        // runs before the last window's turns are inserted.
        await Promise.allSettled(uploadsRef.current);
        await api.closeSession(sid);
        const r: any = await api.processSession(sid);
        if (r?.failed > 0) setError(`Processed with issues — ${r.failed} part(s) failed${r.lastError ? ": " + r.lastError : ""}. Reopen to retry.`);
        else setDone(true);
      } catch (e: any) { setError(e.message); }
      finally { setProcessing(false); uploadsRef.current = []; sidRef.current = null; setSessionId(null); }
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    setError(null); setDone(false); setTurns([]);
    sidRef.current = null; setSessionId(null); // each upload is its own fresh session (don't reuse a closed one)
    try {
      const sid = await ensureSession();
      setProcessing(true);
      const res = await api.ingestWindow(sid, f, 0, f.name);
      if (res?.turns?.length) setTurns(res.turns);
      await api.closeSession(sid);
      const r: any = await api.processSession(sid);
      if (r?.failed > 0) setError(`Couldn't fully process this audio — ${r.failed} part(s) failed${r.lastError ? ": " + r.lastError : ""}.`);
      else setDone(true);
    } catch (e: any) { setError(e.message); }
    finally { setProcessing(false); sidRef.current = null; setSessionId(null); if (fileRef.current) fileRef.current.value = ""; }
  };

  const statusText = processing ? "Processing…"
    : state === "speaking" ? "Listening — speech detected"
    : state === "listening" ? "Listening for speech"
    : state === "cutting" ? "Saving window…"
    : state === "paused" ? "Paused" : inflight > 0 ? "Transcribing…" : "Ready";
  const dotClass = recording ? (state === "speaking" ? "live" : "idle") : inflight > 0 || processing ? "proc" : "idle";

  return (
    <div className="page fade-in capture-page">
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <div className="hero mic-card">
        <div className="mic-wrap" style={{ ["--level" as any]: recording ? level : 0 }}>
          <div className={`mic-stage ${active ? "rec" : ""}`}>
            <button
              className={`mic-btn ${state === "speaking" ? "speaking" : ""}`}
              onClick={start}
              disabled={processing}
              aria-label="Start recording"
            >
              <Mic size={40} />
            </button>
            <div className="wave-stage" aria-hidden={!active}>
              <div className="wave-wrap"><Waveform active={recording} level={level} /></div>
              <div className="rec-timer mono">{fmt(elapsed)}</div>
            </div>
          </div>
          <div className="status-line" role="status" aria-live="polite">
            <span className={`status-dot ${dotClass}`} />
            {statusText}
            {inflight > 0 && <Loader2 size={14} className="spin" />}
          </div>
          <div className="row" style={{ gap: 10, justifyContent: "center" }}>
            {active ? (
              <>
                <button className="btn sm" onClick={togglePause} disabled={processing}>
                  {state === "paused" ? <><Play size={15} /> Resume</> : <><Pause size={15} /> Pause</>}
                </button>
                <button className="btn danger sm" onClick={stop} disabled={processing}><Square size={15} /> End &amp; process</button>
              </>
            ) : (
              <button className="btn ghost sm" onClick={() => fileRef.current?.click()} disabled={processing}>
                <Upload size={15} /> Upload audio
              </button>
            )}
            <input ref={fileRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" hidden onChange={onFile} />
          </div>
          {done && <div className="chip ok"><Check size={13} /> Processed — view it in Memory</div>}
        </div>
      </div>
      <p className="capture-intro">{privacy}</p>

      {turns.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div className="between" style={{ marginBottom: 12 }}>
            <h3>Live transcript</h3>
            {sessionId && done && <button className="btn sm" onClick={() => nav("/memory")}>Open memory →</button>}
          </div>
          {turns.map((t) => {
            const me = t.is_me;
            const who = t.person_name || `Speaker ${t.session_speaker_label}`;
            return (
              <div key={t.id} className={`turn ${me ? "me" : ""}`}>
                <div className="who">
                  {who}{me && <Chip kind="me">me</Chip>}
                  <span className="ts mono">{clock(t.start_ts)}</span>
                  {t.lang && t.lang !== "en" && <span className="chip">{t.lang}</span>}
                </div>
                <div className="bubble">{t.text}</div>
              </div>
            );
          })}
        </div>
      )}
      {turns.length === 0 && !recording && !processing && (
        // Fill the idle lower half with calm, on-brand affordances instead of void:
        // a continue-where-you-left-off chip (only if a memory exists) + a privacy reassurance.
        <div className="capture-idle">
          <p className="faint" style={{ textAlign: "center", fontSize: 13, marginTop: 0 }}>
            Tap the mic to start, or upload a recording.
          </p>
          {lastSession && (
            <Link to={`/conversation/${lastSession.id}`} className="card tap capture-last">
              <div className="meta">Last memory · {timeAgo(lastSession.started_at)}</div>
              <div className="row between" style={{ marginTop: 6, gap: 10 }}>
                <span className="trunc" style={{ fontWeight: 600 }}>{lastSession.title || "Untitled conversation"}</span>
                <ArrowRight size={16} className="faint" style={{ flexShrink: 0 }} />
              </div>
            </Link>
          )}
          <div className="row capture-reassure">
            <ShieldCheck size={15} color="var(--ok)" style={{ flexShrink: 0 }} />
            <span>Sutra keeps the summary, people and action items — your audio is never saved.</span>
          </div>
        </div>
      )}
    </div>
  );
}
