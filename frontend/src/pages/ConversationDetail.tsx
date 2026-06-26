import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Lightbulb, CheckSquare, ListChecks, Users, ChevronDown, CalendarClock, AlertTriangle, FileText, Share2, Copy, Check, BookOpen, MessageSquare, Pencil, FolderGit2, X } from "lucide-react";
import { api } from "../local/sutra";
import { buildSpeakerDisplay, speakerColor } from "../local/util";
import { assembleProjectContext } from "../local/projectContext";
import { PROJECT_LABEL } from "../local/repo";
import { clock, fmtDate } from "../lib/format";
import { Chip, Empty, ErrorBar, Spinner, SkeletonDetail } from "../components/ui";
import { setHeaderTitle, setHeaderAction } from "../lib/headerTitle";

// PURE: which roster names appear as a whole word in the transcript but aren't yet assigned to any speaker
// — candidate "spoken-name" cues to OFFER (confirm-only). Word-bounded so "Sal" doesn't fire on "salary".
function spokenNameCues(rosterNames: string[], assignedNames: Set<string>, transcript: string): string[] {
  const lower = transcript.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rosterNames) {
    const name = raw.trim();
    const k = name.toLowerCase();
    if (!name || seen.has(k) || assignedNames.has(k)) continue;
    seen.add(k);
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u");
    if (re.test(lower)) out.push(name);
  }
  return out;
}

// Tolerant timestamp parser: accepts ISO ("…T…Z") or "YYYY-MM-DD HH:MM:SS".
const _ms = (v: any) => { if (!v) return NaN; const s = String(v); return Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z"); };

// A labeled bullet list inside the Minutes card; renders nothing when the section is empty.
function MinList({ title, items }: { title: string; items?: string[] }) {
  if (!items || !items.length) return null;
  return (
    <div>
      <div className="muted" style={{ fontSize: "var(--fs-xs)", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".06em" }}>{title}</div>
      {items.map((x, i) => <div key={i} style={{ marginBottom: 4, fontSize: "var(--fs-s)", lineHeight: 1.55, overflowWrap: "anywhere" }}>• {x}</div>)}
    </div>
  );
}

export default function ConversationDetail() {
  const { id } = useParams();
  const cid = Number(id);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [openAction, setOpenAction] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [genMin, setGenMin] = useState(false);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"overview" | "transcript">("overview");
  const [hintDone, setHintDone] = useState(() => { try { return localStorage.getItem("sutra_hint_speaker") === "1"; } catch { return false; } });
  // Projects (P3 mapping): the project list (for the picker + chip names) and the mapped project's hydrated
  // context (for the provenance line). pickerOpen toggles the one-line picker; provOpen expands provenance.
  const [projects, setProjects] = useState<any[]>([]);
  const [project, setProject] = useState<any>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [provOpen, setProvOpen] = useState(false);
  const [cueDone, setCueDone] = useState<Record<string, boolean>>({});
  const actionsRef = useRef<HTMLDivElement>(null);
  const decisionsRef = useRef<HTMLDivElement>(null);
  const factsRef = useRef<HTMLDivElement>(null);
  // When a conversation has no memory yet (still processing), default to the transcript so the
  // overview segment isn't empty; runs once per id.
  const viewInitRef = useRef<number | null>(null);

  const load = () => api.conversation(cid).then((d) => { setOpenAction(null); if (d) setData(d); else setError("This conversation no longer exists."); }).catch((e) => setError(e.message));
  // Reset on id change so navigating between conversations shows the skeleton, not the previous one.
  // Guard against stale resolutions: tapping A then B quickly leaves two reads in flight, and a
  // slow read of A must not land last and overwrite B's data.
  useEffect(() => {
    let alive = true;
    setData(null); setError(null); setOpenAction(null);
    api.conversation(cid)
      .then((d) => { if (!alive) return; if (d) setData(d); else setError("This conversation no longer exists."); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [cid]);

  // Load the project list once (for the picker + resolving guess names) and the conversation's mapped
  // project (for the provenance line). Re-runs when the conversation's project mapping changes.
  useEffect(() => { let alive = true; api.listProjects().then((ps) => { if (alive) setProjects(ps ?? []); }).catch(() => {}); return () => { alive = false; }; }, []);
  const mappedId = data?.conversation?.project_id ?? null;
  useEffect(() => {
    let alive = true;
    if (mappedId == null) { setProject(null); return; }
    api.getProject(Number(mappedId)).then((p) => { if (alive) setProject(p); }).catch(() => {});
    return () => { alive = false; };
  }, [mappedId]);

  // Lift the loaded conversation title into the shared Header; reset on unmount / route change.
  useEffect(() => {
    setHeaderTitle(data ? (data.conversation?.title || "Untitled conversation") : null);
    return () => setHeaderTitle(null);
  }, [data]);

  // Publish a Share action in the bar when minutes exist (mirrors the inline share button); clear on unmount.
  useEffect(() => {
    if (data?.minutes) setHeaderAction({ label: "Share minutes", onTap: () => api.shareMinutes(cid).catch((e: any) => setError(e.message)) });
    else setHeaderAction(null);
    return () => setHeaderAction(null);
  }, [data, cid]);

  // Pick the opening segment once per conversation: overview if memory exists, else transcript
  // (so a still-processing conversation doesn't land on an empty overview). Reset on id change.
  useEffect(() => { viewInitRef.current = null; }, [cid]);
  useEffect(() => {
    if (!data || viewInitRef.current === cid) return;
    viewInitRef.current = cid;
    setView(data.memory ? "overview" : "transcript");
  }, [data, cid]);

  const relabel = async (label: string, sessionId: number, isMe: boolean, explicitName?: string) => {
    const name = isMe ? "Me" : (explicitName?.trim() || nameInput.trim());
    if (!name && !isMe) return;
    try {
      await api.relabel(sessionId, label, { name, is_me: isMe });
      // First successful label means the user understands the affordance — retire the hint.
      try { localStorage.setItem("sutra_hint_speaker", "1"); } catch { /* private mode */ }
      setHintDone(true);
      setEditing(null); setNameInput(""); load();
    } catch (e: any) { setError(e.message); }
  };

  // Map / unmap the conversation to a project (always a USER choice; re-runs minutes best-effort).
  const mapProject = async (projectId: number | null) => {
    setPickerOpen(false); setError(null);
    try { await api.setConversationProject(cid, projectId); load(); }
    catch (e: any) { setError(e.message); }
  };
  const confirmSuggestion = async (projectId: number) => {
    setError(null);
    try { await api.confirmProjectSuggestion(cid, projectId); load(); }
    catch (e: any) { setError(e.message); }
  };
  const dismissSuggestion = async () => {
    setError(null);
    try { await api.dismissProjectSuggestion(cid); load(); }
    catch (e: any) { setError(e.message); }
  };
  // Create a fresh project, map it, and jump the user to its editor to author the context.
  const newProject = async () => {
    setPickerOpen(false); setError(null);
    try { const pid = await api.createProject(); await api.setConversationProject(cid, pid); load(); }
    catch (e: any) { setError(e.message); }
  };

  const dismissHint = () => {
    try { localStorage.setItem("sutra_hint_speaker", "1"); } catch { /* private mode */ }
    setHintDone(true);
  };

  // No per-conversation reprocess exists, so we run the global recovery pass — it picks up any
  // recording (this one included) that was transcribed but never fully processed — then refresh.
  const retry = async () => {
    setRetrying(true); setError(null);
    try {
      await api.reprocessIncomplete();
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setRetrying(false); }
  };

  if (error) return <div className="page"><ErrorBar message={error} /></div>;
  if (!data) return <div className="page fade-in"><SkeletonDetail /></div>;

  const { conversation: c, memory: m, turns, participants, events, minutes } = data;
  const sessionId = c.session_id;
  // Display-only: unnamed speakers render as a clean "Speaker 1/2/3" (raw cluster ids "c1" never leak).
  // The raw session_speaker_label stays the key passed to relabel below.
  const speakerDisplay = buildSpeakerDisplay(turns ?? []);

  // ---- Projects: mapping state + provenance + spoken-name cues (all read from already-loaded data) ----
  const mappedProjectName = (projects.find((p) => p.id === c.project_id)?.name) || (project?.name) || "Untitled project";
  const suggestedId: number | null = c.suggested_project_id ?? null;
  const suggested = suggestedId != null ? projects.find((p) => p.id === suggestedId) : null;
  // Provenance: what the mapped project's context WOULD apply (people roster + canonical glossary terms),
  // assembled from the SAME pure function the AI consumers use, gated on the project's local-context switch.
  const ctx = (project && project.context_enabled !== false) ? assembleProjectContext(project) : null;
  const provPeople = ctx?.attributionHints.length ?? 0;
  const provTerms = (project?.terms ?? []).length;
  const provNames = (ctx?.attributionHints ?? []).map((h: any) => h.name);
  const provGlossaryTerms = (project?.terms ?? []).map((t: any) => t.canonical);

  // Spoken-name CONFIRM cues: roster names spoken in the transcript but not yet assigned to a speaker.
  // OFFER-only (never silent). Built from the mapped project's roster + the (raw) transcript text.
  const transcriptText = (turns ?? []).map((t: any) => String(t.text ?? "")).join("\n");
  const assignedNames = new Set<string>((turns ?? []).filter((t: any) => t.person_name).map((t: any) => String(t.person_name).toLowerCase()));
  const unnamedLabels = Array.from(new Set<string>((turns ?? []).filter((t: any) => !t.person_name).map((t: any) => String(t.session_speaker_label))));
  const cues = (ctx && unnamedLabels.length) ? spokenNameCues(ctx.attributionHints.map((h: any) => h.name), assignedNames, transcriptText).filter((n) => !cueDone[n.toLowerCase()]) : [];

  // Project-roster name suggestions for the inline name editor: the mapped project's people who
  // aren't yet assigned to a speaker in this conversation. Offered as one-tap chips (capped) so the
  // common case — naming a speaker as a known teammate — is a single tap, not retyping.
  const rosterSuggestions: string[] = (ctx?.attributionHints ?? [])
    .map((h: any) => String(h.name).trim())
    .filter((n: string) => n && !assignedNames.has(n.toLowerCase()))
    .slice(0, 6);

  // Confirm a spoken-name cue: assign it to an unnamed speaker (its voiceprint is learned). When exactly
  // one unnamed speaker remains the mapping is unambiguous; otherwise we attach to the first unnamed label
  // (the user can always re-label per-turn). Never auto-applied — only on the explicit Yes.
  const confirmCue = async (name: string) => {
    setError(null);
    const label = unnamedLabels[0];
    if (label == null) return;
    try {
      await api.relabel(sessionId, label, { name, is_me: false });
      setCueDone((d) => ({ ...d, [name.toLowerCase()]: true }));
      load();
    } catch (e: any) { setError(e.message); }
  };
  const dismissCue = (name: string) => setCueDone((d) => ({ ...d, [name.toLowerCase()]: true }));

  const genMinutes = async () => {
    setGenMin(true); setError(null);
    try {
      const r = await api.generateMinutes(cid);
      if (!r.ok) setError(r.reason === "empty" ? "Nothing to summarize yet." : "Couldn't generate minutes — try again.");
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setGenMin(false); }
  };

  // Explicit copy (alongside Share): builds the same Markdown and copies it, then flashes a brief
  // confirmation. Works on the Android WebView via the clipboard API with an execCommand fallback.
  const copyMinutes = async () => {
    setError(null);
    try {
      const r = await api.copyMinutes(cid);
      if (!r.ok) { setError("Couldn't copy minutes."); return; }
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="page fade-in wide-page detail-page">
      <p className="page-sub">{fmtDate(c.started_at)}</p>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        {c.is_meeting ? <Chip kind="accent">Meeting</Chip> : null}

        {/* Project chip: mapped (with an undo when it was a silent auto-map), a faint GUESS when only
            suggested, or "+ Add to a project" when unmapped. Tapping opens a one-line picker. */}
        {c.project_id != null ? (
          <button className="chip" onClick={() => setPickerOpen((o) => !o)} style={{ font: "inherit", cursor: "pointer", minHeight: 36, display: "inline-flex", alignItems: "center", gap: 6 }} aria-label={`${PROJECT_LABEL}: ${mappedProjectName} — change`}>
            <FolderGit2 size={13} /> {mappedProjectName}
          </button>
        ) : suggested ? (
          <button className="chip faint" onClick={() => setPickerOpen((o) => !o)} style={{ font: "inherit", cursor: "pointer", minHeight: 36, display: "inline-flex", alignItems: "center", gap: 6 }} aria-label={`Suggested ${PROJECT_LABEL}: ${suggested.name}`}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--accent-2)", display: "inline-block" }} /> {suggested.name || "Untitled project"}?
          </button>
        ) : (
          <button className="btn ghost sm" onClick={() => setPickerOpen((o) => !o)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <FolderGit2 size={13} /> Add to a {PROJECT_LABEL.replace(/s$/, "").toLowerCase()}
          </button>
        )}

        {/* Silent auto-map gets a visible undo (project_auto=1). Changing via the picker also clears it. */}
        {c.project_id != null && c.project_auto && (
          <button className="btn ghost sm" onClick={() => mapProject(null)} aria-label="Undo automatic project mapping">
            Mapped automatically — undo
          </button>
        )}
      </div>

      {/* One-line project picker (projects + None + New). One tap each; unmapped stays a valid state. */}
      {pickerOpen && (
        <div className="card fade-in" style={{ marginBottom: 16, padding: 10 }}>
          <div className="muted" style={{ fontSize: "var(--fs-xs)", marginBottom: 8, textTransform: "uppercase", letterSpacing: ".06em" }}>Map to a {PROJECT_LABEL.replace(/s$/, "").toLowerCase()}</div>
          <div className="row" style={{ gap: 7, flexWrap: "wrap" }}>
            {projects.map((p) => (
              <button key={p.id} className={`chip ${p.id === c.project_id ? "me" : ""}`} style={{ font: "inherit", cursor: "pointer", minHeight: 36 }} onClick={() => mapProject(p.id)}>
                {p.name || "Untitled project"}
              </button>
            ))}
            <button className="chip" style={{ font: "inherit", cursor: "pointer", minHeight: 36 }} onClick={() => mapProject(null)}>None</button>
            <button className="btn ghost sm" onClick={newProject}>+ New {PROJECT_LABEL.replace(/s$/, "").toLowerCase()}</button>
          </div>
        </div>
      )}

      {/* MEDIUM-confidence suggestion (unmapped): one-tap confirm or dismiss. Never auto-applied. */}
      {c.project_id == null && suggested && (
        <div className="card fade-in" style={{ marginBottom: 16, padding: "10px 12px" }}>
          <div className="between" style={{ gap: 10, alignItems: "center" }}>
            <span style={{ fontSize: "var(--fs-s)", lineHeight: 1.4 }}>Part of <strong>{suggested.name || "Untitled project"}</strong>?</span>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn primary sm" onClick={() => confirmSuggestion(suggested.id)}>Yes</button>
              <button className="btn ghost sm" onClick={dismissSuggestion} aria-label="Dismiss suggestion"><X size={14} /></button>
            </div>
          </div>
        </div>
      )}

      {c.status && c.status !== "done" && (
        <div className="card fade-in" style={{ marginBottom: 16, padding: "12px 14px" }}>
          <div className="row" style={{ gap: 8, marginBottom: 6, alignItems: "flex-start" }}>
            <AlertTriangle size={16} color="var(--warn)" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <strong>Couldn't finish processing this conversation</strong>
              <div className="muted" style={{ fontSize: "var(--fs-s)", marginTop: 3, lineHeight: 1.5 }}>
                The audio was transcribed, but the summary, action items and people weren't finished.
                You can retry below — anything already saved is kept.
              </div>
            </div>
          </div>
          <button className="btn primary sm" onClick={retry} disabled={retrying} style={{ marginTop: 4 }}>
            {retrying ? <><Spinner /> Processing…</> : "Retry processing"}
          </button>
        </div>
      )}

      {participants?.length > 0 && (
        <div className="row" style={{ gap: 7, flexWrap: "wrap", marginBottom: 16 }}>
          <Users size={15} className="faint" style={{ flexShrink: 0 }} />
          {participants.map((p: any) => <span key={p.id} className={`chip ${p.is_me ? "me" : ""}`} style={{ whiteSpace: "normal", overflowWrap: "anywhere", maxWidth: "100%" }}>{p.canonical_name}</span>)}
        </div>
      )}

      <div className="pill-toggle" role="tablist" aria-label="Conversation views" style={{ display: "flex", marginBottom: 18 }}>
        {([["overview", "Overview", BookOpen], ["transcript", "Transcript", MessageSquare]] as const).map(
          ([k, label, Icon]) => (
            <button key={k} role="tab" aria-selected={view === k} className={view === k ? "on" : ""} style={{ flex: 1, justifyContent: "center" }} onClick={() => setView(k as "overview" | "transcript")}>
              <Icon size={15} /> {label}
            </button>
          )
        )}
      </div>

      {view === "overview" && (<>

      {m && (
        <div className="row" style={{ gap: 7, flexWrap: "wrap", marginBottom: 16 }}>
          {m.action_items?.length > 0 && <button className="chip" style={{ font: "inherit", cursor: "pointer", minHeight: 40 }} onClick={() => actionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>Actions {m.action_items.length}</button>}
          {m.decisions?.length > 0 && <button className="chip" style={{ font: "inherit", cursor: "pointer", minHeight: 40 }} onClick={() => decisionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>Decisions {m.decisions.length}</button>}
          {m.facts?.length > 0 && <button className="chip" style={{ font: "inherit", cursor: "pointer", minHeight: 40 }} onClick={() => factsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>Facts {m.facts.length}</button>}
        </div>
      )}

      {m && (
        <div className="stack detail-grid" style={{ marginBottom: 20 }}>
          <div className="card">
            <div className="muted" style={{ fontSize: "var(--fs-xs)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".06em" }}>Summary</div>
            <div style={{ fontSize: "var(--fs-body)", lineHeight: 1.6, overflowWrap: "anywhere" }}>{m.summary}</div>
            <div className="row" style={{ gap: 7, marginTop: 12, flexWrap: "wrap" }}>
              <Chip kind="accent">★ importance {Number(m.importance_score).toFixed(2)}</Chip>
              {(m.type_tags || []).map((t: string) => <Chip key={t}>{t}</Chip>)}
            </div>
          </div>

          {m.action_items?.length > 0 && (
            <div className="card" ref={actionsRef}>
              <div className="row" style={{ marginBottom: 8 }}><CheckSquare size={16} color="var(--warn)" /><strong>Action items</strong></div>
              {m.action_items.map((a: any, i: number) => {
                const steps: string[] = Array.isArray(a.steps) ? a.steps : [];
                const open = openAction === i;
                return (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <button onClick={() => steps.length && setOpenAction(open ? null : i)} aria-expanded={open}
                      style={{ display: "flex", alignItems: "flex-start", gap: 8, width: "100%", background: "none", border: 0, padding: 0, textAlign: "left", cursor: steps.length ? "pointer" : "default", color: "inherit", font: "inherit" }}>
                      <span style={{ color: "var(--warn)", flexShrink: 0 }}>•</span>
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{a.text}{a.owner ? <span className="faint"> — {a.owner}</span> : ""}{a.due ? <span className="chip warn" style={{ whiteSpace: "normal", verticalAlign: "middle" }}>due {a.due}</span> : null}</span>
                      {steps.length > 0 && <ChevronDown size={15} className="faint" style={{ flexShrink: 0, marginTop: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />}
                    </button>
                    {open && steps.length > 0 && (
                      <ol style={{ margin: "6px 0 2px 26px", paddingLeft: 16, fontSize: "var(--fs-s)", lineHeight: 1.55 }}>
                        {steps.map((s, j) => <li key={j} className="muted" style={{ marginBottom: 3 }}>{s}</li>)}
                      </ol>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {m.decisions?.length > 0 && (
            <div className="card" ref={decisionsRef}>
              <div className="row" style={{ marginBottom: 8 }}><ListChecks size={16} color="var(--ok)" /><strong>Decisions</strong></div>
              {m.decisions.map((d: string, i: number) => <div key={i} style={{ marginBottom: 5, overflowWrap: "anywhere" }}>• {d}</div>)}
            </div>
          )}

          {m.facts?.length > 0 && (
            <div className="card" ref={factsRef}>
              <div className="row" style={{ marginBottom: 8 }}><Lightbulb size={16} color="var(--accent-2)" /><strong>Key facts</strong></div>
              {m.facts.map((f: string, i: number) => <div key={i} className="muted" style={{ marginBottom: 5, fontSize: "var(--fs-s)", overflowWrap: "anywhere" }}>• {f}</div>)}
            </div>
          )}
        </div>
      )}

      {(c.is_meeting || minutes) && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="between" style={{ marginBottom: minutes ? 12 : 8, alignItems: "center", gap: 10 }}>
            <div className="row" style={{ gap: 8 }}><FileText size={16} color="var(--accent-2)" /><strong>Minutes of meeting</strong></div>
            <div className="row" style={{ gap: 6 }}>
              {minutes && (
                <button className="btn ghost sm" aria-label={copied ? "Minutes copied" : "Copy minutes"} onClick={copyMinutes}>
                  {copied ? <Check size={15} color="var(--ok)" /> : <Copy size={15} />}
                </button>
              )}
              {minutes && (
                <button className="btn ghost sm" aria-label="Share minutes" onClick={() => api.shareMinutes(cid).catch((e: any) => setError(e.message))}>
                  <Share2 size={15} />
                </button>
              )}
              <button className="btn sm" disabled={genMin} onClick={genMinutes}>
                {genMin ? <><Spinner /> {minutes ? "Regenerating…" : "Generating…"}</> : (minutes ? "Regenerate" : "Generate minutes")}
              </button>
            </div>
          </div>
          {/* Provenance: lightweight line stating the project context applied to these minutes; expands
              inline to the named people + canonical terms it carried in. Only shown when a mapped project
              with local context ON actually contributed something. */}
          {minutes && ctx && (provPeople > 0 || provTerms > 0) && (
            <div style={{ marginBottom: 12 }}>
              <button className="btn ghost sm" onClick={() => setProvOpen((o) => !o)} aria-expanded={provOpen}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-xs)" }}>
                <Check size={13} color="var(--ok)" /> Context applied · {provPeople} {provPeople === 1 ? "person" : "people"} · {provTerms} {provTerms === 1 ? "term" : "terms"}
                <ChevronDown size={13} className="faint" style={{ transform: provOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
              </button>
              {provOpen && (
                <div className="muted" style={{ fontSize: "var(--fs-xs)", lineHeight: 1.6, marginTop: 6, paddingLeft: 4 }}>
                  {provNames.length > 0 && <div>Named: {provNames.join(", ")}</div>}
                  {provGlossaryTerms.length > 0 && <div>Spelled correctly: {provGlossaryTerms.join(", ")}</div>}
                </div>
              )}
            </div>
          )}
          {!minutes ? (
            <div className="muted" style={{ fontSize: "var(--fs-s)", lineHeight: 1.55 }}>
              This looks like a meeting. Generate concise, shareable minutes — attendees, agenda, decisions, and action items — from the transcript.
            </div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {minutes.summary && <div style={{ fontSize: "var(--fs-s)", lineHeight: 1.6, overflowWrap: "anywhere" }}>{minutes.summary}</div>}
              {minutes.attendees?.length > 0 && (
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <Users size={14} className="faint" style={{ flexShrink: 0 }} />
                  {minutes.attendees.map((a: string, i: number) => <span key={i} className="chip" style={{ whiteSpace: "normal", overflowWrap: "anywhere", maxWidth: "100%" }}>{a}</span>)}
                </div>
              )}
              <MinList title="Agenda" items={minutes.agenda} />
              <MinList title="Discussion" items={minutes.discussion} />
              <MinList title="Decisions" items={minutes.decisions} />
              {minutes.action_items?.length > 0 && (
                <div>
                  <div className="muted" style={{ fontSize: "var(--fs-xs)", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".06em" }}>Action items</div>
                  {minutes.action_items.map((a: any, i: number) => (
                    <div key={i} style={{ marginBottom: 4, fontSize: "var(--fs-s)", lineHeight: 1.55, overflowWrap: "anywhere" }}>
                      • {a.task}{a.owner ? <span className="faint"> — {a.owner}</span> : ""}{a.due ? <span className="chip warn" style={{ whiteSpace: "normal", verticalAlign: "middle" }}>due {a.due}</span> : null}
                    </div>
                  ))}
                </div>
              )}
              <MinList title="Next steps" items={minutes.next_steps} />
              {minutes.generated_at && <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>Generated {fmtDate(minutes.generated_at)}</div>}
            </div>
          )}
        </div>
      )}

      {/* Non-meeting fallback: a real meeting can be mis-detected as not-a-meeting, hiding the full
          Minutes card. Offer a single, unobtrusive generate affordance — generateMinutes works on any
          conversation and flips is_meeting=true on success, so the full card appears on the next load. */}
      {!c.is_meeting && !minutes && (
        <div className="row" style={{ gap: 8, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn ghost sm" disabled={genMin} onClick={genMinutes}>
            {genMin ? <><Spinner /> Generating…</> : <><FileText size={15} /> Generate minutes</>}
          </button>
          <span className="faint" style={{ fontSize: "var(--fs-xs)", flex: 1, minWidth: 140 }}>Was this a meeting? Generate shareable minutes from the transcript.</span>
        </div>
      )}

      {events?.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="row" style={{ marginBottom: 10 }}><CalendarClock size={16} color="var(--accent-2)" /><strong>Schedule</strong></div>
          {events.map((ev: any) => (
            <div key={ev.id} className="between" style={{ marginBottom: 7, gap: 10, alignItems: "baseline" }}>
              <span style={{ flex: 1 }}>{ev.kind && ev.kind !== "other" && <Chip>{ev.kind}</Chip>} {ev.title}</span>
              <span className="faint mono" style={{ fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>{ev.start_ts ? fmtDate(ev.start_ts) : ev.when_text}</span>
            </div>
          ))}
        </div>
      )}

      </>)}

      {view === "transcript" && (<>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {!c.hasClean ? (
          <button className="btn primary sm" disabled={cleaning}
            onClick={async () => {
              setCleaning(true); setError(null);
              try { await api.cleanConversation(cid); await load(); }
              catch (e: any) { setError(e.message); }
              finally { setCleaning(false); }
            }}>
            {cleaning ? <><Spinner /> Cleaning…</> : "Clean up transcript"}
          </button>
        ) : c.refined ? (
          <>
            <Chip kind="ok">Cleaned up</Chip>
            <button className="btn sm"
              onClick={async () => { try { await api.setConversationRefined(cid, false); await load(); } catch (e: any) { setError(e.message); } }}>
              Show original
            </button>
          </>
        ) : (
          <button className="btn sm"
            onClick={async () => { try { await api.setConversationRefined(cid, true); await load(); } catch (e: any) { setError(e.message); } }}>
            Show cleaned
          </button>
        )}
      </div>

      {!hintDone && turns?.length > 0 && (
        <div className="row faint" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12, fontSize: "var(--fs-s)" }}>
          <Pencil size={13} />
          <span style={{ flex: 1 }}>Tap a name to label the speaker — Sutra learns their voice.</span>
          <button className="btn ghost sm" onClick={dismissHint}>Got it</button>
        </div>
      )}

      {/* Spoken-name CONFIRM cues: a project-roster name was heard in the transcript but no speaker is
          named yet. OFFER it (confirm-only) — on Yes we relabel an unnamed speaker (learns the voiceprint).
          Never auto-applied; the raw session_speaker_label stays the relabel key. */}
      {cues.length > 0 && unnamedLabels.length > 0 && (
        <div className="stack cards-grid" style={{ gap: 8, marginBottom: 14 }}>
          {cues.map((name) => (
            <div key={name} className="card fade-in" style={{ padding: "10px 12px" }}>
              <div className="between" style={{ gap: 10, alignItems: "center" }}>
                <span style={{ fontSize: "var(--fs-s)", lineHeight: 1.4 }}>Heard <strong>{name}</strong> — is one of the unnamed speakers {name}?</span>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn primary sm" onClick={() => confirmCue(name)}>Yes</button>
                  <button className="btn ghost sm" onClick={() => dismissCue(name)} aria-label={`Dismiss ${name} suggestion`}>No</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {turns?.length === 0 ? <Empty title="No turns" /> : turns.map((t: any, ti: number) => {
        // Capped entrance: only the first ~6 visible turns stagger in; turns below the fold mount
        // instantly — deliberately NOT the all-turns waterfall the .capture-page rule warns against.
        const staggered = ti < 6;
        const named = !!t.person_name;
        const who = t.person_name || speakerDisplay.get(t.session_speaker_label) || "Speaker";
        // Stable per-speaker dot color, keyed on the RAW cluster label so it survives renaming.
        const dotColor = speakerColor(t.session_speaker_label);
        // Show elapsed-from-conversation-start (real offset into the uploaded file), not the
        // per-window diarization offset; fall back to start_ts when abs times are missing/invalid.
        const _el = (_ms(t.abs_start) - _ms(c.started_at)) / 1000;
        return (
          <div key={t.id} className={`turn${staggered ? " detail-turn" : ""} ${t.is_me ? "me" : ""}`}
            style={staggered ? ({ "--i": ti } as React.CSSProperties) : undefined}>
            <div className="who">
              {/* Tap-to-name affordance: color-keyed dot + label + pencil. Unnamed speakers carry a
                  dashed underline so the "name me" affordance reads as obviously editable. */}
              <button className={`speaker-chip btn ghost sm ${named ? "" : "speaker-unnamed"}`}
                style={{ minHeight: 44, padding: "11px 8px", margin: "-9px 0", fontSize: "var(--fs-xs)" }}
                aria-label={named ? `Rename ${who}` : `Name ${who}`}
                onClick={() => { setEditing(editing === t.session_speaker_label ? null : t.session_speaker_label); setNameInput(t.person_name && !t.is_me ? t.person_name : ""); }}>
                <span className="speaker-dot" style={{ background: dotColor }} aria-hidden="true" />
                {who}{!!t.is_me && <Chip kind="me">me</Chip>}<Pencil size={12} className="faint" aria-hidden="true" />
              </button>
              <span className="ts mono">{clock(Number.isFinite(_el) && _el >= 0 ? _el : t.start_ts)}</span>
              {t.lang && t.lang !== "en" && <span className="chip">{t.lang}</span>}
            </div>
            {editing === t.session_speaker_label && (
              <div className="card fade-in" style={{ padding: 10, margin: "4px 0" }}>
                <div className="muted" style={{ fontSize: "var(--fs-xs)", marginBottom: 6 }}>Label this speaker (applies to all their turns; their voiceprint is learned):</div>
                {/* When the conversation is mapped to a project, offer its roster names first — one tap
                    relabels (keyed on the raw session_speaker_label) and learns the voiceprint. */}
                {rosterSuggestions.length > 0 && (
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    {rosterSuggestions.map((name) => (
                      <button key={name} className="chip" style={{ font: "inherit", cursor: "pointer", minHeight: 36 }}
                        onClick={() => relabel(t.session_speaker_label, sessionId, false, name)}>{name}</button>
                    ))}
                  </div>
                )}
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

      </>)}
    </div>
  );
}
