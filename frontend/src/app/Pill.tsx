// The pill: a tiny always-on-top window at the top-centre of the screen (see electron/main.ts).
//   detected   → [app icon] Google Chrome in call      (● Record)  ×
//   recording  → ● 12:04  ▂▅▇▅▂  Google Chrome          (■ Stop)  ↗  ⊘
//   processing → ◌ Writing notes…                          (● Record)  ⊘
//   done       → ✓ Notes ready                           (Open)
// ⊘ hides the pill until the next recording (tray → "Show recording pill" brings it back).
// On a MacBook's notched screen it's an island that grows out of the camera instead (NotchIsland).
// It renders from state pushed by the main process and sends actions back; it owns no data itself.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, EyeOff, FileText, Loader2, Square, X } from "lucide-react";
import { desktop, type PillState } from "../desktop/bridge";
import { clock } from "./format";
import { useNow } from "./recorder";
import { AppIcon, LevelBars } from "./ui";

type Act = "record" | "stop" | "dismiss" | "open" | "hide";
const act = (a: Act) => desktop?.pill.action(a);

export function Pill() {
  const [st, setSt] = useState<PillState>({ mode: "hidden", recorder: { status: "idle" } });
  useEffect(() => desktop?.pill.onState(setSt), []);
  return st.notch ? <NotchIsland st={st} notch={st.notch} /> : <FloatingPill st={st} />;
}

function FloatingPill({ st }: { st: PillState }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const now = useNow(st.mode === "recording", 500);

  // Size the native window to the capsule so clicks around it pass through to the apps below.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !desktop) return;
    const send = () => desktop!.pill.resize(Math.ceil(el.getBoundingClientRect().width) + 28);
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
  }, [st.mode]);

  const hide = <button className="close" onClick={() => act("hide")} aria-label="Hide" title="Hide (shows again next recording; or tray → Show recording pill)"><EyeOff size={15} /></button>;
  const started = st.recorder.startedAt ?? null;

  return (
    <div className="pill-stage">
      {st.mode === "hidden" ? null : (
        <div className="pill" ref={ref} key={st.mode} role="status">
          {st.mode === "detected" && (
            <>
              <AppIcon src={st.icon} name={st.app} />
              <span className="who">{st.app}</span>
              <span className="what">in call</span>
              <button className="pill-btn" onClick={() => act("record")} title={st.service ? `Record this ${st.service} call` : "Record this call"}>
                <span className="rec-ring" /> Record
              </button>
              <button className="close" onClick={() => act("dismiss")} aria-label="Dismiss"><X size={16} /></button>
            </>
          )}
          {st.mode === "recording" && (
            <>
              <span className="live-dot" />
              <span className="clock">{started ? clock(now - started) : "0:00"}</span>
              <LevelBars level={st.recorder.level ?? 0} />
              {st.app && <span className="what" style={{ marginLeft: 0 }}>{st.app}</span>}
              <button className="pill-btn" onClick={() => act("stop")} disabled={st.recorder.status === "starting"}>
                <Square size={12} fill="currentColor" /> Stop
              </button>
              <button className="close" onClick={() => act("open")} aria-label="Open Sutra" title="Open Sutra">↗</button>
              {hide}
            </>
          )}
          {st.mode === "processing" && (
            <>
              <Loader2 size={16} className="spin" />
              <span className="who">Writing notes…</span>
              {/* Notes save in the background, so the next call can be recorded right away. */}
              <button className="pill-btn" onClick={() => act("record")} title="Record a new call">
                <span className="rec-ring" /> Record
              </button>
              {hide}
            </>
          )}
          {st.mode === "done" && (
            <>
              <Check size={17} className="ok" />
              <span className="who">Notes ready</span>
              <button className="pill-btn" onClick={() => act("open")}>Open</button>
              <span style={{ width: 2 }} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Dynamic-Island-style: grows out of the camera notch, shows a glanceable status on either side of it,
 *  and opens downward (on hover, or for a moment when something happens) into the full controls.
 *  The window is a fixed transparent stage; only the island itself takes clicks. */
function NotchIsland({ st, notch }: { st: PillState; notch: { width: number; height: number } }) {
  // Keep showing the last real state while the island shrinks back into the notch.
  const [shown, setShown] = useState<PillState | null>(null);
  const [open, setOpen] = useState(false); // drawn out of the notch (vs tucked behind the camera)
  const [hover, setHover] = useState(false);
  const [peek, setPeek] = useState(false);
  const mode = st.mode;

  useEffect(() => {
    if (mode === "hidden") { setOpen(false); setHover(false); desktop?.pill.hover(false); return; }
    setShown(st);
    // Next frame, so the first paint is notch-sized and the island visibly grows out of it.
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
    return () => cancelAnimationFrame(r);
  }, [st, mode]);

  // Something new happened: open fully for a moment so it's noticed, then settle to the compact island.
  useEffect(() => {
    if (mode === "hidden") return;
    setPeek(true);
    const t = setTimeout(() => setPeek(false), mode === "recording" ? 1800 : 4500);
    return () => clearTimeout(t);
  }, [mode]);

  const s = shown ?? st;
  const now = useNow(s.mode === "recording", 500);
  const expanded = open && (hover || peek);
  const wing = s.mode === "recording" ? 72 : 46;
  const size = !open
    ? { width: notch.width, height: notch.height }
    : expanded
      ? { width: Math.max(notch.width + 230, 420), height: notch.height + 76 }
      : { width: notch.width + wing * 2, height: notch.height };
  const enter = (on: boolean) => { setHover(on); desktop?.pill.hover(on); };
  const started = s.recorder.startedAt ?? null;
  const time = started ? clock(now - started) : "0:00";

  let left: React.ReactNode = null, right: React.ReactNode = null, title = "", sub = "", actions: React.ReactNode = null, lead: React.ReactNode = null;
  if (s.mode === "detected") {
    left = <AppIcon src={s.icon} name={s.app} size={18} />;
    right = <span className="ni-pulse" />;
    lead = <AppIcon src={s.icon} name={s.app} size={34} />;
    title = s.app ?? "Call"; sub = s.service ? `${s.service} call` : "In a call";
    actions = <>
      <button className="ni-btn rec" onClick={() => act("record")}><span className="rec-ring" /> Record</button>
      <button className="ni-icon" onClick={() => act("dismiss")} aria-label="Dismiss" title="Not this call"><X size={15} /></button>
    </>;
  } else if (s.mode === "recording") {
    left = <><span className="live-dot" /><span className="ni-clock">{time}</span></>;
    right = <LevelBars level={s.recorder.level ?? 0} />;
    lead = <span className="ni-lead rec"><span className="live-dot" /></span>;
    title = `Recording · ${time}`; sub = s.app ?? "Microphone";
    actions = <>
      <button className="ni-btn" onClick={() => act("stop")} disabled={s.recorder.status === "starting"}><Square size={11} fill="currentColor" /> Stop</button>
      <button className="ni-icon" onClick={() => act("open")} aria-label="Open Sutra" title="Open Sutra"><ArrowUpRight size={15} /></button>
      <button className="ni-icon" onClick={() => act("hide")} aria-label="Hide" title="Hide until the next recording"><EyeOff size={14} /></button>
    </>;
  } else if (s.mode === "processing") {
    left = <Loader2 size={15} className="spin" />;
    right = <FileText size={14} className="ni-dim" />;
    lead = <span className="ni-lead"><Loader2 size={18} className="spin" /></span>;
    title = "Writing your notes…"; sub = "You can record the next call now";
    actions = <>
      <button className="ni-btn rec" onClick={() => act("record")}><span className="rec-ring" /> Record</button>
      <button className="ni-icon" onClick={() => act("hide")} aria-label="Hide" title="Hide until the next recording"><EyeOff size={14} /></button>
    </>;
  } else if (s.mode === "done") {
    left = <Check size={16} className="ok" />;
    right = <FileText size={14} className="ok" />;
    lead = <span className="ni-lead ok"><Check size={18} /></span>;
    title = "Notes ready"; sub = "Summary, decisions and action items";
    actions = <button className="ni-btn" onClick={() => act("open")}>Open</button>;
  }

  return (
    <div className="ni-stage">
      <div className={`ni${expanded ? " expanded" : ""}${open ? " open" : ""}`} style={size} role="status"
        onMouseEnter={() => enter(true)} onMouseLeave={() => enter(false)}>
        <div className="ni-row" style={{ height: notch.height, gridTemplateColumns: `1fr ${notch.width}px 1fr` }}>
          <div className="ni-wing l">{left}</div>
          <span aria-hidden="true" />
          <div className="ni-wing r">{right}</div>
        </div>
        <div className="ni-panel">
          {lead}
          <div className="ni-text"><div className="ni-title">{title}</div><div className="ni-sub">{sub}</div></div>
          <div className="ni-actions">{actions}</div>
        </div>
      </div>
    </div>
  );
}
