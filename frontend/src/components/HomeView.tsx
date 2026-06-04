import { Mic, StopCircle, Lock, Cloud, ChevronRight, User, CalendarClock } from "lucide-react";
import { Waveform } from "./Waveform";

export type Mode = "hybrid" | "ondevice";
const PRIVACY: Record<Mode, { icon: any; text: string; amber?: boolean }> = {
  ondevice: { icon: Lock, text: "On-device · audio stays on this phone" },
  hybrid: { icon: Cloud, text: "Hybrid · audio processed in cloud, never stored" },
};

function CountRing({ value, max = 100 }: { value: number; max?: number }) {
  const r = 17, c = 2 * Math.PI * r, p = Math.min(1, value / max);
  return (
    <div className="icon-btn" style={{ borderColor: "transparent", background: "var(--surface-2)" }}>
      <svg width="42" height="42" viewBox="0 0 42 42" style={{ position: "absolute" }}>
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="3" />
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 21 21)" />
      </svg>
      <span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{value}</span>
    </div>
  );
}

export interface HomeData {
  name: string; mode: Mode; recording: boolean; elapsed: string; level: number; memoryCount: number;
  latest: { meta: string; title: string; desc: string; chips: { label: string; kind?: string }[]; lang?: string } | null;
  comingUp: { title: string; when: string }[];
}

export function HomeView({ data, onToggleMode, onStartStop }: {
  data: HomeData; onToggleMode?: (m: Mode) => void; onStartStop?: () => void;
}) {
  const P = PRIVACY[data.mode];
  return (
    <div className="page fade-in" style={{ paddingTop: "calc(var(--sat) + 16px)" }}>
      <div className="between" style={{ marginBottom: 18 }}>
        <div className="greet">Hi <span className="accent">{data.name}</span></div>
        <div className="row" style={{ gap: 10 }}>
          <CountRing value={data.memoryCount} max={Math.max(10, data.memoryCount)} />
          <button className="icon-btn"><User size={18} /><span className="badge" /></button>
        </div>
      </div>

      {/* HERO capture card */}
      <div className="hero">
        <div className="hero-top">
          <div className="pill-toggle">
            {(["ondevice", "hybrid"] as Mode[]).map((m) => (
              <button key={m} className={data.mode === m ? "on" : ""} onClick={() => onToggleMode?.(m)}>
                {m === "ondevice" ? <Lock size={13} /> : <Cloud size={13} />}{m === "ondevice" ? "On-device" : "Hybrid"}
              </button>
            ))}
          </div>
        </div>
        <div className="wave-wrap"><Waveform active={data.recording} level={data.level} /></div>
        <div className="hero-timer">{data.elapsed}</div>
        <div className="hero-actions">
          <button className="btn cta" onClick={() => onStartStop?.()} style={{ minWidth: 150 }}>
            {data.recording ? <><StopCircle size={17} /> End session</> : <><Mic size={17} /> Start capture</>}
          </button>
        </div>
        <div style={{ display: "flex" }}>
          <span className={`privacy-badge ${data.mode === "hybrid" ? "amber" : ""}`}>
            <P.icon size={14} /> {P.text}
          </span>
        </div>
      </div>

      {/* latest memory */}
      {data.latest && (
        <>
          <div className="section-h">Latest memory</div>
          <div className="card tap">
            <ChevronRight size={18} className="chev" />
            <div className="meta">{data.latest.meta}</div>
            <div className="ctitle">{data.latest.title}</div>
            <div className="row" style={{ gap: 7, flexWrap: "wrap", marginTop: 9 }}>
              {data.latest.chips.map((c, i) => <span key={i} className={`chip ${c.kind ?? ""}`}>{c.label}</span>)}
              {data.latest.lang && <span className="lang-tag">{data.latest.lang}</span>}
            </div>
            <div className="cdesc">{data.latest.desc}</div>
          </div>
        </>
      )}

      {/* coming up (amber = scheduled) */}
      {data.comingUp.length > 0 && (
        <>
          <div className="section-h">Coming up</div>
          <div className="stack">
            {data.comingUp.map((c, i) => (
              <div key={i} className="coming-card">
                <div className="row" style={{ gap: 8 }}><CalendarClock size={15} color="var(--amber)" />
                  <div><div className="ctitle" style={{ margin: 0, fontSize: 16 }}>{c.title}</div>
                    <div className="meta" style={{ marginTop: 3 }}>{c.when}</div></div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
