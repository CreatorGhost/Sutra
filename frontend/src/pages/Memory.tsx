import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Search as SearchIcon, Library, CheckSquare, Square, FileText, Loader2, CalendarClock } from "lucide-react";
import { api } from "../local/sutra";
import { fmtDate } from "../lib/format";
import { Chip, Empty, ErrorBar, SectionError, isBenignError } from "../components/ui";

type Tab = "browse" | "search" | "actions";

export default function Memory() {
  const [tab, setTab] = useState<Tab>("browse");
  const [convs, setConvs] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[] | null>(null);
  const [actions, setActions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-section failures degrade only their own section (quiet inline retry) instead of
  // tripping the global banner — one failing read no longer hijacks healthy content.
  const [convErr, setConvErr] = useState<string | null>(null);
  const [eventsErr, setEventsErr] = useState<string | null>(null);
  const [actionsErr, setActionsErr] = useState<string | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  const loadConvs = () => {
    setConvErr(null);
    return api.listConversations().then((cs) => setConvs(cs)).catch((e: any) => setConvErr(e.message));
  };
  const loadEvents = () => {
    setEventsErr(null);
    return api.upcomingEvents().then((ev) => setEvents(ev)).catch((e: any) => setEventsErr(e.message));
  };
  const loadActions = () => {
    setActionsErr(null);
    return api.actionItems().then((a) => setActions(a)).catch((e: any) => setActionsErr(e.message));
  };

  useEffect(() => {
    // allSettled: a failing events read can't reject the whole batch and blank the conversations.
    Promise.allSettled([loadConvs(), loadEvents()]).finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (tab === "actions") void loadActions(); }, [tab]);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setSearching(true); setSearchErr(null); setResults(null);
    try { const r = await api.search(q); setResults(r.results); }
    catch (e: any) { setSearchErr(e.message); setResults([]); }
    finally { setSearching(false); }
  };

  const toggleAction = async (a: any) => {
    const next = a.status === "open" ? "done" : "open";
    try {
      await api.updateAction(a.id, next);
      setActions((xs) => xs.map((x) => (x.id === a.id ? { ...x, status: next } : x)));
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="page fade-in">
      <p className="page-sub">Everything Sutra has remembered, searchable and connected.</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <div className="pill-toggle" role="tablist" aria-label="Memory views" style={{ display: "flex", marginBottom: 18 }}>
        {([["browse", "Conversations", Library], ["search", "Search", SearchIcon], ["actions", "Actions", CheckSquare]] as const).map(
          ([k, label, Icon]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} style={{ flex: 1, justifyContent: "center" }} onClick={() => { setError(null); setTab(k as Tab); }}>
              <Icon size={15} /> {label}
            </button>
          )
        )}
      </div>

      {tab === "search" && (
        <>
          <form onSubmit={runSearch} className="row" style={{ marginBottom: 16 }}>
            <input className="input" placeholder="Search your memory…" aria-label="Search your memory" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value.trim()) setResults(null); }} />
            <button className="btn primary" disabled={searching}>{searching ? <Loader2 size={16} style={{ animation: "spin .8s linear infinite" }} /> : <SearchIcon size={16} />}</button>
          </form>
          {searching ? (
            // Skeletons while the query resolves — no jump from empty-state to results.
            <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 88 }} />)}</div>
          ) : searchErr ? (
            isBenignError(searchErr)
              ? <Empty icon={<SearchIcon size={36} />} title="Search isn't available here" hint="Full-text search runs on the device build." />
              : <SectionError label="Search failed." onRetry={() => { if (q.trim()) void runSearch({ preventDefault() {} } as React.FormEvent); }} />
          ) : results === null ? (
            <Empty icon={<SearchIcon size={36} />} title="Search across all your memories" hint="Hybrid ranking: semantic + keyword, weighted by recency and importance." />
          ) : results.length === 0 ? (
            <Empty title="No matches" hint="Try different words." />
          ) : (
            <div className="stack">
              {results.map((r) => (
                <Link to={`/conversation/${r.conversation_id}`} key={r.id} className="card tap">
                  <div className="between" style={{ marginBottom: 6 }}>
                    <strong>{r.title}</strong>
                    <span className="faint mono" style={{ fontSize: 11 }}>{fmtDate(r.started_at)}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 13.5 }}>{r.summary}</div>
                  <div className="score-bar" style={{ marginTop: 10 }}><i style={{ width: `${Math.min(100, r.score * 100)}%` }} /></div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "browse" && (
        loading ? <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 92 }} />)}</div>
          : convErr ? (
            isBenignError(convErr)
              ? <Empty icon={<FileText size={36} />} title="Memory isn't available here" hint="Stored conversations open on the device build." />
              : <SectionError label="Couldn't load your conversations." onRetry={loadConvs} />
          )
          : convs.length === 0 ? <Empty icon={<FileText size={36} />} title="No conversations yet" hint="Record or upload audio on the Capture tab." />
          : <>
            {eventsErr && !isBenignError(eventsErr) && <SectionError label="Couldn't load upcoming events." onRetry={loadEvents} />}
            {events.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="row" style={{ marginBottom: 10 }}><CalendarClock size={15} color="var(--accent-2)" /><strong>Upcoming</strong></div>
                <div className="stack" style={{ gap: 8 }}>
                  {events.slice(0, 6).map((ev) => (
                    <Link to={`/conversation/${ev.conversation_id}`} key={ev.id} className="between tap" style={{ gap: 10 }}>
                      <span className="trunc">{ev.kind && ev.kind !== "other" ? `${ev.kind[0].toUpperCase()}${ev.kind.slice(1)}: ` : ""}{ev.title}</span>
                      <span className="faint mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{ev.start_ts ? fmtDate(ev.start_ts) : ev.when_text}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            <div className="stack">
              {convs.map((c) => (
                <Link to={`/conversation/${c.id}`} key={c.id} className="card tap">
                  <div className="between" style={{ marginBottom: 6 }}>
                    <strong>{c.title || `Conversation · ${fmtDate(c.started_at)}`}</strong>
                    <span className="faint mono" style={{ fontSize: 11 }}>{fmtDate(c.started_at)}</span>
                  </div>
                  {c.summary
                    ? <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>{c.summary}</div>
                    : c.status === "failed"
                      ? <div className="row" style={{ fontSize: 13, color: "var(--warn)", gap: 6 }}>Couldn't process — open to retry</div>
                      : <div className="row muted" style={{ fontSize: 13, gap: 6 }}><Loader2 size={13} style={{ animation: "spin .8s linear infinite" }} /> Processing…</div>}
                  <div className="row" style={{ marginTop: 10, gap: 7, flexWrap: "wrap" }}>
                    {typeof c.importance_score === "number" && <Chip kind="accent">★ {(c.importance_score).toFixed(2)}</Chip>}
                    {c.action_count > 0 && <Chip kind="warn">{c.action_count} action{c.action_count > 1 ? "s" : ""}</Chip>}
                    {(c.type_tags || []).slice(0, 3).map((t: string) => <Chip key={t}>{t}</Chip>)}
                  </div>
                </Link>
              ))}
            </div>
          </>
      )}

      {tab === "actions" && (
        actionsErr ? (
          isBenignError(actionsErr)
            ? <Empty icon={<CheckSquare size={36} />} title="Actions aren't available here" hint="Action items open on the device build." />
            : <SectionError label="Couldn't load action items." onRetry={loadActions} />
        )
        : actions.length === 0 ? <Empty icon={<CheckSquare size={36} />} title="No action items" hint="Action items from your conversations show up here." />
          : <div className="stack">
              {actions.map((a) => (
                <div key={a.id} className="card row" style={{ alignItems: "flex-start", gap: 12 }}>
                  <button className="btn ghost sm" style={{ minHeight: 0, padding: 4 }} onClick={() => toggleAction(a)} aria-label="toggle">
                    {a.status === "done" ? <CheckSquare size={18} color="var(--ok)" /> : <Square size={18} />}
                  </button>
                  <div style={{ flex: 1 }}>
                    <div style={{ textDecoration: a.status === "done" ? "line-through" : "none", color: a.status === "done" ? "var(--faint)" : "var(--text)" }}>{a.text}</div>
                    <div className="row" style={{ gap: 7, marginTop: 6, flexWrap: "wrap" }}>
                      {a.owner && <Chip>{a.owner}</Chip>}
                      {a.due && <Chip kind="warn">due {a.due}</Chip>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
      )}
    </div>
  );
}
