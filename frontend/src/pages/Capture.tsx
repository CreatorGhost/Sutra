import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Mic, Pause, Play, Square, Upload, Loader2, Check, ShieldCheck, ArrowRight, CalendarClock } from "lucide-react";
import { api } from "../local/sutra";
import { coalesceTurns } from "../local/coalesce";
import { buildSpeakerDisplay } from "../local/util";
import { CaptureController, type CaptureState } from "../lib/capture";
import { clock, timeAgo, fmtDate } from "../lib/format";
import { useWakeLock } from "../lib/useWakeLock";
import { recordHaptic } from "../lib/nativeChrome";
import { setCaptureGuard } from "../lib/captureGuard";
import { setHeaderStatus } from "../lib/headerTitle";
import { Chip, ErrorBar } from "../components/ui";
import { Waveform } from "../components/Waveform";

// Tolerant timestamp parser: accepts ISO ("…T…Z") or "YYYY-MM-DD HH:MM:SS".
const _ms = (v: any) => { if (!v) return NaN; const s = String(v); return Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z"); };

interface Turn {
  id: number; person_name?: string | null; is_me?: boolean; session_speaker_label: string;
  text: string; start_ts: number; speaker_confidence?: number | null; lang?: string;
  window_index?: number | null; end_ts?: number | null; abs_start?: string | null;
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
  const stopRef = useRef<() => Promise<void>>(async () => {}); // always points at the CURRENT stop()
  const stoppingRef = useRef(false); // a stop() is in flight — unmount must NOT start a second one
  const fileRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const [lastSession, setLastSession] = useState<{ id: number; title?: string; started_at?: string } | null>(null);
  const [openActions, setOpenActions] = useState<any[]>([]);
  const [upcoming, setUpcoming] = useState<any[]>([]);
  // Quietly surface the most recent memory so the lower half of an idle Capture screen isn't dead
  // space. Best-effort: stays hidden if nothing exists or the read fails.
  useEffect(() => { api.listConversations().then((cs: any[]) => setLastSession(cs?.[0] ?? null)).catch(() => {}); }, []);
  // "Today" snapshot: open action items + upcoming events. Best-effort (catch → empty, card hidden).
  // Re-run when `done` flips true — a fresh memory may have added actions/events.
  useEffect(() => {
    api.actionItems("open").then((a: any[]) => setOpenActions(a ?? [])).catch(() => {});
    api.upcomingEvents().then((e: any[]) => setUpcoming(e ?? [])).catch(() => {});
  }, [done]);
  const recording = state !== "idle" && state !== "paused";
  const active = state !== "idle"; // recording or paused — keep the waveform stage up
  // On unmount: if a recording is still live, run the FULL stop() flow (drain → close → process) as
  // fire-and-forget — in an SPA the async keeps going after unmount and Memory shows "Processing…".
  // setState-after-unmount is a safe no-op in React 19. Always also tear down the controller so the
  // mic MediaStream, AudioContext, MediaRecorder, VAD interval, visibilitychange listener and Android
  // ForegroundMic service can't be orphaned.
  useEffect(() => () => {
    if (sidRef.current && !stoppingRef.current) void stopRef.current();
    else void ctrlRef.current?.stop();
    ctrlRef.current = null;
  }, []);
  useWakeLock(recording || processing); // hold the screen awake THROUGH processing so a lock can't kill it
  useEffect(() => {
    if (state === "idle") { setElapsed(0); return; }
    if (state === "paused") return;            // freeze the timer while paused
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state]);
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // Mirror the live recording state into the app bar so it's visible while scrolling. Cleared on
  // unmount (StrictMode-safe: cleanup nulls it so a remount can't leave a stale status).
  useEffect(() => {
    if (processing) setHeaderStatus({ kind: "proc", text: "Processing…" });
    else if (state === "paused") setHeaderStatus({ kind: "paused", text: fmt(elapsed) + " · Paused" });
    else if (state !== "idle") setHeaderStatus({ kind: "rec", text: fmt(elapsed) + " · Recording" });
    else setHeaderStatus(null);
    return () => setHeaderStatus(null);
  }, [state, processing, elapsed]);

  const ensureSession = useCallback(async () => {
    if (sidRef.current) return sidRef.current;
    const s = await api.createSession();
    sidRef.current = s.id; setSessionId(s.id); return s.id;
  }, []);

  const uploadsRef = useRef<Promise<unknown>[]>([]);
  const uploadWindow = useCallback((blob: Blob, index: number, startedAtMs: number) => {
    setInflight((n) => n + 1);
    const p = (async () => {
      try {
        // Guarantee a session exists even if this window closed before ensureSession() resolved —
        // otherwise an early window's audio would be silently dropped (it's never stored).
        const sid = sidRef.current ?? (await ensureSession());
        const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
        const res = await api.ingestWindow(sid, blob, index, `window-${index}.${ext}`, startedAtMs);
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
        maxSeconds: 90, silenceMs: 1200,
        onWindow: (b, i, t) => void uploadWindow(b, i, t),
        onState: setState,
        onLevel: (rms) => setLevel(Math.min(1, rms * 14)),
        onError: setError,
      });
      ctrlRef.current = ctrl;
      await ctrl.start();        // starts/ resumes AudioContext within the gesture (iOS-safe)
      void recordHaptic(true);   // confirmed start — stronger Medium tap
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
    void recordHaptic();
    if (state === "paused") c.resume(); else c.pause();
  };

  const stop = async () => {
    stoppingRef.current = true; // set synchronously, BEFORE any await — the unmount cleanup keys on it
    void recordHaptic();
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
      finally { setProcessing(false); uploadsRef.current = []; sidRef.current = null; setSessionId(null); stoppingRef.current = false; }
    }
    else stoppingRef.current = false;
  };
  stopRef.current = stop; // the guard/unmount must always run the CURRENT closure (latest state)

  // Register the recording guard so Nav links and hardware-back can end+process a live recording
  // before leaving Capture. Guard ONLY while recording/paused — once processing starts the recording
  // is already over, leaving is harmless (the async finishes in the background; Memory shows
  // "Processing…"), so no confirm sheet then. Cleared on unmount.
  useEffect(() => {
    setCaptureGuard(active, () => stopRef.current());
    return () => setCaptureGuard(false, null);
  }, [active]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []); if (!files.length) return;
    setError(null); setDone(false); setTurns([]);
    sidRef.current = null; setSessionId(null); // each upload is its own fresh session (don't reuse a closed one)
    try {
      const sid = await ensureSession();
      setProcessing(true);
      // One or many: multiple files are treated as ordered ~2-min windows of ONE recording (pre-split
      // import), ingested in sequence into a single session — the same multi-window pipeline live
      // capture uses. A single file stays exactly as before (one window, no synthetic timeline).
      const WINDOW_MS = 120000;
      const base = Date.now();
      const multi = files.length > 1;
      for (let i = 0; i < files.length; i++) {
        const res = await api.ingestWindow(sid, files[i], i, files[i].name, multi ? base + i * WINDOW_MS : undefined);
        if (i === 0 && res?.turns?.length) setTurns(res.turns);
      }
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

  // Clear, screen-reader-first recording-state line so TalkBack announces start/stop/pause distinctly
  // (the engine-state status-line above is terse: "Listening for speech"/"Saving window…").
  const liveStatus = processing ? "Processing recording"
    : state === "paused" ? "Recording paused"
    : recording ? "Recording in progress"
    : done ? "Recording processed" : "";

  return (
    <div className="page fade-in capture-page focus-page">
      <span className="sr-only" role="status" aria-live="assertive">{liveStatus}</span>
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
            <input ref={fileRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm" multiple hidden onChange={onFile} />
          </div>
          {done && <div className="chip ok"><Check size={13} /> Processed — view it in Memory</div>}
        </div>
      </div>

      {turns.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div className="between" style={{ marginBottom: 12 }}>
            <h3>Live transcript</h3>
            {sessionId && done && <button className="btn sm" onClick={() => nav("/memory")}>Open memory →</button>}
          </div>
          {/* Coalesce only for display; crossWindow MUST be false here (labels aren't stabilized mid-recording). */}
          {(() => {
            const display = coalesceTurns(turns as any, { maxGapS: 2, maxMergeWords: 400, crossWindow: false });
            // Base = first displayed turn's absolute time, so each row shows elapsed-from-start.
            const _t0 = _ms((display[0] as any)?.abs_start);
            const sd = buildSpeakerDisplay(display);
            return display.map((t) => {
            const me = !!t.is_me;
            const who = t.person_name || sd.get(t.session_speaker_label) || "Speaker";
            return (
              <div key={t.id} className={`turn ${me ? "me" : ""}`}>
                <div className="who">
                  {who}{me && <Chip kind="me">me</Chip>}
                  <span className="ts mono">{clock((() => { const e = (_ms((t as any).abs_start) - _t0) / 1000; return Number.isFinite(e) && e >= 0 ? e : t.start_ts; })())}</span>
                  {t.lang && t.lang !== "en" && <span className="chip">{t.lang}</span>}
                </div>
                <div className="bubble">{t.text}</div>
              </div>
            );
            });
          })()}
        </div>
      )}
      {turns.length === 0 && !recording && !processing && (
        // Fill the idle lower half with calm, on-brand affordances instead of void:
        // a continue-where-you-left-off chip (only if a memory exists) + a privacy reassurance.
        <div className="capture-idle">
          <p className="faint" style={{ textAlign: "center", fontSize: "var(--fs-s)", marginTop: 0 }}>
            Tap the mic to start, or upload a recording.
          </p>
          {/* "Today" snapshot — top open actions (due ones first) + upcoming events. Only if non-empty. */}
          {(() => {
            // Stable sort: items WITH a due date first, original order otherwise.
            const actions = [...openActions].sort((a, b) => (a.due ? 0 : 1) - (b.due ? 0 : 1)).slice(0, 3);
            const events = upcoming.slice(0, 3);
            if (actions.length === 0 && events.length === 0) return null;
            return (
              <div className="card">
                <div className="row" style={{ marginBottom: 10 }}><CalendarClock size={15} color="var(--accent-2)" /><strong>Today</strong></div>
                <div className="stack" style={{ gap: 8 }}>
                  {actions.map((a) => (
                    <Link to={`/conversation/${a.conversation_id ?? a.source_conversation}`} key={`a${a.id}`} className="between tap" style={{ gap: 10, minHeight: 40 }}>
                      <span className="row" style={{ gap: 8, flex: 1, minWidth: 0, alignItems: "flex-start" }}><Square size={14} className="faint" style={{ flexShrink: 0, marginTop: 2 }} /><span className="clamp-2">{a.text}</span></span>
                      {a.due ? <Chip kind="warn">due {a.due}</Chip> : null}
                    </Link>
                  ))}
                  {events.map((ev) => (
                    <Link to={`/conversation/${ev.conversation_id}`} key={`e${ev.id}`} className="between tap" style={{ gap: 10, minHeight: 40 }}>
                      <span className="row" style={{ gap: 8, flex: 1, minWidth: 0, alignItems: "flex-start" }}><CalendarClock size={14} className="faint" style={{ flexShrink: 0, marginTop: 2 }} /><span className="clamp-2">{ev.title}</span></span>
                      <span className="faint mono" style={{ fontSize: "var(--fs-xs)", whiteSpace: "nowrap", flexShrink: 0 }}>{ev.start_ts ? fmtDate(ev.start_ts) : ev.when_text}</span>
                    </Link>
                  ))}
                  {openActions.length > actions.length && (
                    <Link to="/memory?tab=actions" className="row faint" style={{ fontSize: "var(--fs-s)", minHeight: 40 }}>All actions →</Link>
                  )}
                </div>
              </div>
            );
          })()}
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
