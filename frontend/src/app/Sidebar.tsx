import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Loader2, Search, Settings as Gear, Sparkles, Square, X } from "lucide-react";
import { api } from "../local/sutra";
import { desktop, type DetectionState } from "../desktop/bridge";
import { useDataVersion } from "./events";
import { clock, groupByPeriod, shortDate } from "./format";
import { useNow, useRecorder } from "./recorder";
import { AppIcon } from "./ui";

interface MeetingRow {
  id: number;
  title: string | null;
  subtitle: string | null;
  summary: string | null;
  started_at: string | null;
  created_at: string | null;
  status: string | null;
  tags: string[];
  source_app: string | null;
}

function matches(m: MeetingRow, q: string): boolean {
  const hay = `${m.title ?? ""} ${m.subtitle ?? ""} ${m.summary ?? ""} ${(m.tags ?? []).join(" ")} ${m.source_app ?? ""}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function Sidebar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const version = useDataVersion();
  const { state: rec, start, stop } = useRecorder();
  const now = useNow(rec.status === "recording");
  const [rows, setRows] = useState<MeetingRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [detection, setDetection] = useState<DetectionState>({ active: null, visible: false });

  useEffect(() => {
    let alive = true;
    api.listConversations()
      .then((r: any[]) => { if (alive) setRows(r as MeetingRow[]); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [version, rec.status]);

  useEffect(() => {
    if (!desktop) return;
    void desktop.detection.get().then(setDetection).catch(() => {});
    return desktop.detection.onChange(setDetection);
  }, []);

  const filtered = useMemo(() => (rows ?? []).filter((m) => !query.trim() || matches(m, query)), [rows, query]);
  const groups = useMemo(() => groupByPeriod(filtered, (m) => m.started_at ?? m.created_at), [filtered]);
  const activeId = Number(pathname.match(/^\/m\/(\d+)/)?.[1] ?? NaN);
  const recording = rec.status === "recording" || rec.status === "starting";

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && query.trim()) nav(`/ask?q=${encodeURIComponent(query.trim())}`);
    if (e.key === "Escape") setQuery("");
  };

  return (
    <aside className="sidebar">
      <div className="side-top drag">
        <label className="search">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} placeholder="Search…" aria-label="Search meetings" />
          {query && <button className="icon-btn ghost sm" onClick={() => setQuery("")} aria-label="Clear search"><X size={14} /></button>}
        </label>
      </div>

      {recording ? (
        <div className="banner rec">
          <span className="live-dot" />
          <span className="grow">
            Recording{rec.app ? <span className="muted"> · {rec.app}</span> : null}
          </span>
          <span className="faint" style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}>{rec.startedAt ? clock(now - rec.startedAt) : ""}</span>
          <button className="link" onClick={() => nav("/live")}>Open</button>
        </div>
      ) : rec.status === "processing" ? (
        <div className="banner"><Loader2 size={15} className="spin" /><span className="grow">Writing your notes…</span></div>
      ) : detection.visible && detection.active ? (
        <div className="banner">
          <AppIcon src={detection.active.icon} name={detection.active.app} size={18} className="app-icon" />
          <span className="grow">{detection.active.app} <span className="muted">in call</span></span>
          <button className="link" onClick={() => void start({ app: detection.active!.app })}>Record</button>
          <button className="x" aria-label="Dismiss" onClick={() => desktop?.pill.action("dismiss")}><X size={14} /></button>
        </div>
      ) : null}

      <nav className="list" aria-label="Meetings">
        {query.trim() && (
          <button className="item" onClick={() => nav(`/ask?q=${encodeURIComponent(query.trim())}`)}>
            <div className="item-head"><span className="item-title" style={{ display: "flex", gap: 8, alignItems: "center" }}><Sparkles size={14} /> Ask Sutra</span></div>
            <div className="item-sub">“{query.trim()}” across all your meetings</div>
          </button>
        )}
        {rows === null ? (
          <div style={{ padding: 8 }}>{[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 58, margin: "8px 0" }} />)}</div>
        ) : groups.length === 0 ? (
          <div className="list-empty">{query ? "No meetings match." : "Your meetings will appear here."}</div>
        ) : (
          groups.map((g) => (
            <section key={g.label}>
              <div className="group-label">{g.label}</div>
              {g.items.map((m) => (
                <button key={m.id} className={`item${m.id === activeId ? " active" : ""}`} onClick={() => nav(`/m/${m.id}`)}>
                  <div className="item-head">
                    <span className="item-title">{m.title || (m.status === "failed" ? "Couldn't write notes" : "Writing notes…")}</span>
                    <span className="item-date">{shortDate(m.started_at ?? m.created_at)}</span>
                  </div>
                  <div className="item-sub">
                    {m.status === "failed" && <span className="dot" style={{ background: "var(--warn)" }} />}
                    {m.subtitle || m.summary || (m.status === "failed" ? "Open to retry." : "Transcribed — notes are on the way.")}
                  </div>
                </button>
              ))}
            </section>
          ))
        )}
      </nav>

      <div className="side-bottom">
        <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings"><Gear size={18} /></button>
        {recording ? (
          <button className="record-btn live" onClick={() => void stop()} disabled={rec.status === "starting"}>
            {rec.status === "starting" ? <Loader2 size={16} className="spin" /> : <Square size={14} fill="currentColor" />}
            {rec.status === "starting" ? "Starting…" : <>Stop <span className="timer">{rec.startedAt ? clock(now - rec.startedAt) : ""}</span></>}
          </button>
        ) : (
          <button className="record-btn" disabled={rec.status === "processing"} onClick={() => { void start({ app: detection.active?.app ?? null }); nav("/live"); }}>
            {rec.status === "processing" ? <><Loader2 size={16} className="spin" /> Saving…</> : "Start recording"}
          </button>
        )}
      </div>
    </aside>
  );
}
