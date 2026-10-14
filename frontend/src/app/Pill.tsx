// The pill: a tiny always-on-top window at the top-centre of the screen (see electron/main.ts).
//   detected   → [app icon] Google Chrome in call      (● Record)  ×
//   recording  → ● 12:04  ▂▅▇▅▂  Google Chrome          (■ Stop)
//   processing → ◌ Writing notes…                          (● Record)  ⊘
// ⊘ hides the pill until the next recording (tray → "Show recording pill" brings it back).
//   done       → ✓ Notes ready                           (Open)
// It renders from state pushed by the main process and sends actions back; it owns no data itself.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, EyeOff, Loader2, Square, X } from "lucide-react";
import { desktop, type PillState } from "../desktop/bridge";
import { clock } from "./format";
import { useNow } from "./recorder";
import { AppIcon, LevelBars } from "./ui";

export function Pill() {
  const [st, setSt] = useState<PillState>({ mode: "hidden", recorder: { status: "idle" } });
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => desktop?.pill.onState(setSt), []);
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

  const act = (a: "record" | "stop" | "dismiss" | "open" | "hide") => desktop?.pill.action(a);
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
