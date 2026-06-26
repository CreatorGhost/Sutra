import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search as SearchIcon, Library, CheckSquare, Square, FileText, Mic, CalendarClock, Share2 } from "lucide-react";
import { api } from "../local/sutra";
import { fmtDate } from "../lib/format";
import { Chip, Empty, ErrorBar, SectionError, SkeletonList, isBenignError } from "../components/ui";
import GraphView from "../components/GraphView";

type Tab = "browse" | "actions" | "graph";
const TABS: Tab[] = ["browse", "actions", "graph"];

/** Tolerant parse for stored started_at / due strings that may use a space separator
 *  and lack a timezone (treated as UTC). Returns NaN for empty/unparseable input. */
function parseTs(s?: string | null): number {
  if (!s) return NaN;
  return Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

/** Compact, single-line due label. Stored due values may be a bare YYYY-MM-DD or a full ISO
 *  timestamp; a raw ISO string makes the warn chip very wide and clip at the viewport edge, so
 *  normalise to "Jun 13, 2026". Falls back to the raw string if it can't be parsed. */
function fmtDueDate(due: string): string {
  const ts = parseTs(due);
  if (isNaN(ts)) return due;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Calendar-day bucket label for a conversation's started_at. */
function convBucket(ts: number, todayStart: number): string {
  if (isNaN(ts)) return "Earlier";
  const dayMs = 86400000;
  if (ts >= todayStart) return "Today";
  if (ts >= todayStart - dayMs) return "Yesterday";
  if (ts >= todayStart - 6 * dayMs) return "This week";
  return "Earlier";
}

export default function Memory() {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTab = searchParams.get("tab");
  const tab: Tab = TABS.includes(paramTab as Tab) ? (paramTab as Tab) : "browse";
  const setTab = (k: Tab) => { setError(null); setSearchParams({ tab: k }, { replace: true }); };

  const [convs, setConvs] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[] | null>(null);
  const [actions, setActions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Actions load lazily on first visit to the tab; track it so the tab shows a skeleton on first
  // open instead of flashing the empty state before the read resolves.
  const [actionsLoaded, setActionsLoaded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-section failures degrade only their own section (quiet inline retry) instead of
  // tripping the global banner — one failing read no longer hijacks healthy content.
  const [convErr, setConvErr] = useState<string | null>(null);
  const [eventsErr, setEventsErr] = useState<string | null>(null);
  const [actionsErr, setActionsErr] = useState<string | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  // Track the latest search request so a slower earlier query can't land last and overwrite newer results.
  const reqIdRef = useRef(0);

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
    return api.actionItems().then((a) => setActions(a)).catch((e: any) => setActionsErr(e.message)).finally(() => setActionsLoaded(true));
  };

  useEffect(() => {
    // allSettled: a failing events read can't reject the whole batch and blank the conversations.
    Promise.allSettled([loadConvs(), loadEvents()]).finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (tab === "actions") void loadActions(); }, [tab]);

  // Ambient search: a query of >= 2 chars takes over the content area regardless of the active tab.
  const isSearchActive = q.trim().length >= 2;

  const runSearch = async (query: string) => {
    if (query.trim().length < 2) return;
    const id = ++reqIdRef.current;
    setSearching(true); setSearchErr(null); setResults(null);
    try { const r = await api.search(query); if (id === reqIdRef.current) setResults(r.results); }
    catch (e: any) { if (id === reqIdRef.current) { setSearchErr(e.message); setResults([]); } }
    finally { if (id === reqIdRef.current) setSearching(false); }
  };

  // Debounce the ambient search; Enter (form submit) fires immediately and cancels any pending run.
  useEffect(() => {
    if (q.trim().length < 2) { reqIdRef.current++; setResults(null); setSearchErr(null); setSearching(false); return; }
    const t = setTimeout(() => void runSearch(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSearchActive) void runSearch(q);
  };

  const toggleAction = async (a: any) => {
    const next = a.status === "open" ? "done" : "open";
    try {
      await api.updateAction(a.id, next);
      setActions((xs) => xs.map((x) => (x.id === a.id ? { ...x, status: next } : x)));
    } catch (e: any) { setError(e.message); }
  };

  // Date-grouped conversation buckets (calendar-day based; empty buckets skipped).
  const convGroups = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const t0 = todayStart.getTime();
    const order = ["Today", "Yesterday", "This week", "Earlier"];
    const map = new Map<string, any[]>();
    for (const c of convs) {
      const label = convBucket(parseTs(c.started_at), t0);
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(c);
    }
    return order.filter((l) => map.has(l)).map((l) => [l, map.get(l)!] as const);
  }, [convs]);

  // Action sections (open buckets by due-date, then Done). Empty sections are skipped.
  const actionGroups = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const t0 = todayStart.getTime();
    const tEnd = t0 + 86400000;
    const overdue: any[] = [], today: any[] = [], upcoming: any[] = [], noDate: any[] = [], done: any[] = [];
    for (const a of actions) {
      if (a.status === "done") { done.push(a); continue; }
      const due = parseTs(a.due);
      if (isNaN(due)) noDate.push(a);
      else if (due < t0) overdue.push(a);
      else if (due < tEnd) today.push(a);
      else upcoming.push(a);
    }
    const byDue = (x: any, y: any) => parseTs(x.due) - parseTs(y.due);
    overdue.sort(byDue); today.sort(byDue); upcoming.sort(byDue);
    return [
      ["Overdue", overdue], ["Today", today], ["Upcoming", upcoming], ["No date", noDate], ["Done", done],
    ].filter(([, list]) => (list as any[]).length > 0) as [string, any[]][];
  }, [actions]);

  const renderAction = (a: any) => (
    <div key={a.id} className="card row" style={{ alignItems: "flex-start", gap: 12 }}>
      <button className="btn ghost sm" style={{ minHeight: 44, minWidth: 44, padding: 13, margin: -9, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
        onClick={() => toggleAction(a)}
        role="checkbox" aria-checked={a.status === "done"}
        aria-label={`${a.status === "done" ? "Done" : "Open"}: ${a.text}`}>
        {a.status === "done" ? <CheckSquare size={18} color="var(--ok)" /> : <Square size={18} />}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflowWrap: "anywhere", textDecoration: a.status === "done" ? "line-through" : "none", color: a.status === "done" ? "var(--faint)" : "var(--text)" }}>{a.text}</div>
        <div className="row" style={{ gap: 7, marginTop: 6, flexWrap: "wrap" }}>
          {a.owner && <Chip><span className="trunc" style={{ maxWidth: 160 }}>{a.owner}</span></Chip>}
          {a.due && <Chip kind="warn">due {fmtDueDate(a.due)}</Chip>}
        </div>
      </div>
    </div>
  );

  return (
    <div className="page fade-in wide-page">
      {/* The "Memory" label lives in the brand bar; the descriptive copy now lives in the search placeholder. */}
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <div className="page-head">
        <form onSubmit={onSubmit}>
          <input className="input" style={{ width: "100%" }} placeholder="Search your memory…" aria-label="Search your memory" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <div className="pill-toggle" role="tablist" aria-label="Memory views" style={{ display: "flex", marginTop: 10 }}>
          {([["browse", "Conversations", Library], ["actions", "Actions", CheckSquare], ["graph", "Graph", Share2]] as const).map(
            ([k, label, Icon]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} style={{ flex: 1, justifyContent: "center" }} onClick={() => setTab(k as Tab)}>
                <Icon size={15} /> {label}
              </button>
            )
          )}
        </div>
      </div>

      {isSearchActive ? (
        searching ? (
          // Skeletons while the query resolves — no jump from empty-state to results.
          <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 88 }} />)}</div>
        ) : searchErr ? (
          isBenignError(searchErr)
            ? <Empty icon={<SearchIcon size={36} />} title="Search isn't available here" hint="Full-text search runs on the device build." />
            : <SectionError label="Search failed." onRetry={() => void runSearch(q)} />
        ) : !results || results.length === 0 ? (
          <Empty title="No matches" hint="Try different words." />
        ) : (
          <div className="stack cards-grid">
            {results.map((r) => (
              <Link to={`/conversation/${r.conversation_id}`} key={r.id} className="card tap">
                <div className="between" style={{ marginBottom: 6 }}>
                  <strong className="trunc">{r.title}</strong>
                  <span className="faint mono" style={{ fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>{fmtDate(r.started_at)}</span>
                </div>
                <div className="muted" style={{ fontSize: "var(--fs-s)" }}>{r.summary}</div>
                <div className="score-bar" style={{ marginTop: 10 }}><i style={{ width: `${Math.min(100, r.score * 100)}%` }} /></div>
              </Link>
            ))}
          </div>
        )
      ) : (
        // Crossfade the content region on tab change: keying on `tab` remounts this wrapper so the
        // body fades in (~140ms) in step with the pill toggle's color slide — no abrupt flash.
        <div className="mem-body" key={tab}>
        {tab === "browse" ? (
        loading ? <SkeletonList rows={4} />
          : convErr ? (
            isBenignError(convErr)
              ? <Empty icon={<FileText size={36} />} title="Memory isn't available here" hint="Stored conversations open on the device build." />
              : <SectionError label="Couldn't load your conversations." onRetry={loadConvs} />
          )
          : convs.length === 0 ? <Empty icon={<Mic size={36} />} title="No conversations yet" hint="Tap Capture to record your first one." />
          : <>
            {eventsErr && !isBenignError(eventsErr) && <SectionError label="Couldn't load upcoming events." onRetry={loadEvents} />}
            {events.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="row" style={{ marginBottom: 10 }}><CalendarClock size={15} color="var(--accent-2)" /><strong>Upcoming</strong></div>
                <div className="stack" style={{ gap: 8 }}>
                  {events.slice(0, 6).map((ev) => (
                    <Link to={`/conversation/${ev.conversation_id}`} key={ev.id} className="between tap" style={{ gap: 10, minHeight: 44 }}>
                      <span className="trunc">{ev.kind && ev.kind !== "other" ? `${ev.kind[0].toUpperCase()}${ev.kind.slice(1)}: ` : ""}{ev.title}</span>
                      <span className="faint mono" style={{ fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>{ev.start_ts ? fmtDate(ev.start_ts) : ev.when_text}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {/* Date-grouped flat rows replace the heavy per-conv cards. type_tags chips are dropped
                from this list view only — they remain on ConversationDetail. */}
            {(() => { let cardIdx = 0; return convGroups.map(([label, list]) => (
              <div key={label}>
                <h3 className="section-h">{label}</h3>
                <div className="settings-group-body conv-grid">
                  {list.map((c) => {
                    // Capped entrance cascade: first 6 cards stagger ~50ms apart; the rest mount
                    // instantly so long lists never feel slow.
                    const i = cardIdx++;
                    const staggered = i < 6;
                    const priorityChip = typeof c.importance_score === "number" && (c.importance_score > 0.75
                      ? <Chip kind="amber">Important</Chip>
                      : c.importance_score >= 0.5 ? <Chip kind="accent">Notable</Chip> : null);
                    // Action count is a neutral outlined count chip (check glyph), NOT amber — amber is
                    // reserved for priority ("Important") so the two never read alike.
                    const actionChip = c.action_count > 0 ? <Chip><CheckSquare size={11} /> {c.action_count} action{c.action_count > 1 ? "s" : ""}</Chip> : null;
                    const hasChips = !!priorityChip || !!actionChip;
                    return (
                    <Link key={c.id} className={`conv-row${staggered ? " stagger-rise" : ""}`} to={`/conversation/${c.id}`}
                      style={staggered ? ({ "--i": i } as React.CSSProperties) : undefined}>
                      {/* Title is the focal point (up to 2 lines); the date is demoted to a muted mono
                          caption beneath it; chips sit in one bottom-aligned row. */}
                      <strong className="conv-title">{c.title || `Conversation · ${fmtDate(c.started_at)}`}</strong>
                      {c.summary
                        ? <small className="conv-sub trunc">{c.summary}</small>
                        : c.status === "failed"
                          ? <small className="conv-sub trunc" style={{ color: "var(--warn)" }}>Couldn't process — open to retry</small>
                          : <small className="conv-sub trunc">Processing…</small>}
                      <div className="conv-meta">
                        <span className="faint mono" style={{ fontSize: "var(--fs-xs)" }}>{fmtDate(c.started_at)}</span>
                        {hasChips && <span className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>{priorityChip}{actionChip}</span>}
                      </div>
                    </Link>
                    );
                  })}
                </div>
              </div>
            )); })()}
          </>
      ) : tab === "actions" ? (
        !actionsLoaded ? <SkeletonList rows={4} />
        : actionsErr ? (
          isBenignError(actionsErr)
            ? <Empty icon={<CheckSquare size={36} />} title="Actions aren't available here" hint="Action items open on the device build." />
            : <SectionError label="Couldn't load action items." onRetry={loadActions} />
        )
        : actions.length === 0 ? <Empty icon={<CheckSquare size={36} />} title="No action items" hint="Action items from your conversations show up here." />
          : <>
              {actionGroups.map(([label, list]) => (
                <div key={label}>
                  <h3 className="section-h">{label}</h3>
                  <div className="stack">{list.map(renderAction)}</div>
                </div>
              ))}
            </>
      ) : (
        <GraphView />
      )}
        </div>
      )}
    </div>
  );
}
