import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Lightbulb, CheckSquare, ListChecks, Users, ChevronDown, CalendarClock } from "lucide-react";
import { api } from "../local/sutra";
import { clock, fmtDate } from "../lib/format";
import { Chip, Empty, ErrorBar } from "../components/ui";
import { setHeaderTitle } from "../lib/headerTitle";

export default function ConversationDetail() {
  const { id } = useParams();
  const cid = Number(id);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [openAction, setOpenAction] = useState<number | null>(null);

  const load = () => api.conversation(cid).then(setData).catch((e) => setError(e.message));
  // Reset on id change so navigating between conversations shows the skeleton, not the previous one.
  useEffect(() => { setData(null); setError(null); load(); }, [cid]);

  // Lift the loaded conversation title into the shared Header; reset on unmount / route change.
  useEffect(() => {
    setHeaderTitle(data ? (data.conversation?.title || "Untitled conversation") : null);
    return () => setHeaderTitle(null);
  }, [data]);

  const relabel = async (label: string, sessionId: number, isMe: boolean) => {
    if (!nameInput.trim() && !isMe) return;
    try {
      await api.relabel(sessionId, label, { name: isMe ? "Me" : nameInput.trim(), is_me: isMe });
      setEditing(null); setNameInput(""); load();
    } catch (e: any) { setError(e.message); }
  };

  if (error) return <div className="page"><ErrorBar message={error} /></div>;
  if (!data) return <div className="page"><div className="skeleton" style={{ height: 200 }} /></div>;

  const { conversation: c, memory: m, turns, participants, events } = data;
  const sessionId = c.session_id;

  return (
    <div className="page fade-in">
      <Link to="/memory" className="row faint" style={{ fontSize: 13, marginBottom: 14 }}><ArrowLeft size={16} /> Memory</Link>
      <h1 className="page-title">{c.title || "Untitled conversation"}</h1>
      <p className="page-sub">{fmtDate(c.started_at)}</p>

      {participants?.length > 0 && (
        <div className="row" style={{ gap: 7, flexWrap: "wrap", marginBottom: 16 }}>
          <Users size={15} className="faint" />
          {participants.map((p: any) => <Chip key={p.id} kind={p.is_me ? "me" : ""}>{p.canonical_name}</Chip>)}
        </div>
      )}

      {m && (
        <div className="stack" style={{ marginBottom: 20 }}>
          <div className="card">
            <div className="muted" style={{ fontSize: 12, marginBottom: 6, textTransform: "uppercase", letterSpacing: ".06em" }}>Summary</div>
            <div style={{ fontSize: 14.5, lineHeight: 1.6 }}>{m.summary}</div>
            <div className="row" style={{ gap: 7, marginTop: 12, flexWrap: "wrap" }}>
              <Chip kind="accent">★ importance {Number(m.importance_score).toFixed(2)}</Chip>
              {(m.type_tags || []).map((t: string) => <Chip key={t}>{t}</Chip>)}
            </div>
          </div>

          {m.action_items?.length > 0 && (
            <div className="card">
              <div className="row" style={{ marginBottom: 8 }}><CheckSquare size={16} color="var(--warn)" /><strong>Action items</strong></div>
              {m.action_items.map((a: any, i: number) => {
                const steps: string[] = Array.isArray(a.steps) ? a.steps : [];
                const open = openAction === i;
                return (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <button onClick={() => steps.length && setOpenAction(open ? null : i)} aria-expanded={open}
                      style={{ display: "flex", alignItems: "flex-start", gap: 8, width: "100%", background: "none", border: 0, padding: 0, textAlign: "left", cursor: steps.length ? "pointer" : "default", color: "inherit", font: "inherit" }}>
                      <span style={{ color: "var(--warn)" }}>•</span>
                      <span style={{ flex: 1 }}>{a.text}{a.owner ? <span className="faint"> — {a.owner}</span> : ""}{a.due ? <Chip kind="warn"> due {a.due}</Chip> : null}</span>
                      {steps.length > 0 && <ChevronDown size={15} className="faint" style={{ flexShrink: 0, marginTop: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />}
                    </button>
                    {open && steps.length > 0 && (
                      <ol style={{ margin: "6px 0 2px 26px", paddingLeft: 16, fontSize: 13.5, lineHeight: 1.55 }}>
                        {steps.map((s, j) => <li key={j} className="muted" style={{ marginBottom: 3 }}>{s}</li>)}
                      </ol>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {m.decisions?.length > 0 && (
            <div className="card">
              <div className="row" style={{ marginBottom: 8 }}><ListChecks size={16} color="var(--ok)" /><strong>Decisions</strong></div>
              {m.decisions.map((d: string, i: number) => <div key={i} style={{ marginBottom: 5 }}>• {d}</div>)}
            </div>
          )}

          {m.facts?.length > 0 && (
            <div className="card">
              <div className="row" style={{ marginBottom: 8 }}><Lightbulb size={16} color="var(--accent-2)" /><strong>Key facts</strong></div>
              {m.facts.map((f: string, i: number) => <div key={i} className="muted" style={{ marginBottom: 5, fontSize: 13.5 }}>• {f}</div>)}
            </div>
          )}
        </div>
      )}

      {events?.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="row" style={{ marginBottom: 10 }}><CalendarClock size={16} color="var(--accent-2)" /><strong>Schedule</strong></div>
          {events.map((ev: any) => (
            <div key={ev.id} className="between" style={{ marginBottom: 7, gap: 10, alignItems: "baseline" }}>
              <span style={{ flex: 1 }}>{ev.kind && ev.kind !== "other" && <Chip>{ev.kind}</Chip>} {ev.title}</span>
              <span className="faint mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{ev.start_ts ? fmtDate(ev.start_ts) : ev.when_text}</span>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginBottom: 12 }}>Transcript</h3>
      {turns?.length === 0 ? <Empty title="No turns" /> : turns.map((t: any) => {
        const who = t.person_name || `Speaker ${t.session_speaker_label}`;
        return (
          <div key={t.id} className={`turn ${t.is_me ? "me" : ""}`}>
            <div className="who">
              <button className="btn ghost sm" style={{ minHeight: 0, padding: "2px 8px", fontSize: 12 }}
                onClick={() => { setEditing(editing === t.session_speaker_label ? null : t.session_speaker_label); setNameInput(t.person_name && !t.is_me ? t.person_name : ""); }}>
                {who}{t.is_me && <Chip kind="me">me</Chip>}
              </button>
              <span className="ts mono">{clock(t.start_ts)}</span>
              {t.lang && t.lang !== "en" && <span className="chip">{t.lang}</span>}
            </div>
            {editing === t.session_speaker_label && (
              <div className="card fade-in" style={{ padding: 10, margin: "4px 0" }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Label this speaker (applies to all their turns; their voiceprint is learned):</div>
                <div className="row">
                  <input className="input" aria-label="Speaker name" placeholder="Name…" value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
                  <button className="btn primary sm" onClick={() => relabel(t.session_speaker_label, sessionId, false)}>Save</button>
                  <button className="btn sm" onClick={() => relabel(t.session_speaker_label, sessionId, true)}>This is me</button>
                </div>
              </div>
            )}
            <div className={`bubble ${t.redacted ? "redacted" : ""}`}>{t.text}</div>
          </div>
        );
      })}
    </div>
  );
}
