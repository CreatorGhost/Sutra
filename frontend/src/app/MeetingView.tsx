import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, ChevronDown, Copy, Loader2, RotateCcw, Share, Sparkles, Tag as TagIcon, Trash2, Users, Wand2, X } from "lucide-react";
import { api } from "../local/sutra";
import { minutesToMarkdown } from "../local/minutes";
import { NOTE_STYLES, type DetailedNotes, type NoteStyle } from "../local/notes";
import { isMe, speakerName } from "../local/speakers";
import { notifyDataChanged, useDataVersion } from "./events";
import { duration, longDate, offsetLabel } from "./format";
import { AppIcon, Popover, friendlyError, useAppIcon, useToast } from "./ui";
import { MinutesNotes } from "./meeting/Minutes";
import { ProjectChip, useProjects } from "./meeting/ProjectChip";
import { projectName } from "./projects/model";
import { EnginePicker } from "./EnginePicker";
import "./features.css";

type Detail = NonNullable<Awaited<ReturnType<typeof api.conversation>>>;

/** Notes styles: the two note styles plus formal Minutes of Meeting. */
type ViewStyle = NoteStyle | "minutes";
const STYLES: Record<ViewStyle, { label: string; hint: string }> = {
  brief: { label: NOTE_STYLES.brief, hint: "Summary & actions" },
  detailed: { label: NOTE_STYLES.detailed, hint: "Topic by topic" },
  minutes: { label: "Minutes", hint: "Formal minutes" },
};
const STYLE_KEY = "sutra_note_style";
const readStyle = (): ViewStyle => {
  try { const v = localStorage.getItem(STYLE_KEY); return v === "detailed" || v === "minutes" ? v : "brief"; } catch { return "brief"; }
};

const PALETTE = ["#7aa2ff", "#f5a97f", "#8bd5ca", "#c6a0f6", "#eed49f", "#f0a6ca", "#91d7e3", "#a6da95"];
function speakerColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function MeetingView() {
  const { id } = useParams();
  const cid = Number(id);
  const nav = useNavigate();
  const version = useDataVersion();
  const [detail, setDetail] = useState<Detail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"notes" | "transcript">("notes");
  const [style, setStyle] = useState<ViewStyle>(readStyle);
  const [toast, showToast] = useToast();
  const projects = useProjects(version);

  const load = useCallback(async () => {
    try { setDetail(await api.conversation(cid)); setError(null); }
    catch (e) { setError(friendlyError(e)); setDetail(null); }
  }, [cid]);

  useEffect(() => { setDetail(undefined); setTab("notes"); }, [cid]);
  useEffect(() => { void load(); }, [load, version]);

  // While notes are still being written, poll quietly until they land.
  const pending = !!detail && !detail.memory && (detail.conversation as any).status !== "failed";
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [pending, load]);

  const chooseStyle = (s: ViewStyle) => {
    setStyle(s);
    try { localStorage.setItem(STYLE_KEY, s); } catch { /* ignore */ }
  };

  if (detail === undefined) return <PaneSkeleton />;
  if (!detail) {
    return (
      <div className="center">
        <div>
          <p className="hero-title">Meeting not found</p>
          <p className="hero-text">{error ?? "It may have been deleted."}</p>
          <button className="btn" onClick={() => nav("/")}>Back</button>
        </div>
      </div>
    );
  }

  const c: any = detail.conversation;
  const m: any = detail.memory;
  const title = m?.title || c.title || (pending ? "Writing notes…" : "Untitled meeting");

  // Copy / export follow the chosen style; Minutes fall back to Brief notes until they exist.
  const minutesMd = style === "minutes" ? minutesToMarkdown(title, detail.minutes as any) : "";
  const copy = async () => {
    const md = minutesMd || (await api.notesMarkdown(cid, style === "minutes" ? "brief" : style));
    showToast((await api.copyText(md)) ? (minutesMd ? "Minutes copied" : "Notes copied") : "Couldn't copy");
  };
  const exportMd = async () => {
    const md = minutesMd || (await api.notesMarkdown(cid, style === "minutes" ? "brief" : style, true));
    const safe = String(title).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "meeting";
    await api.exportText(`${safe}.md`, md);
  };
  const remove = async () => {
    if (!window.confirm(`Delete “${title}”? This removes its notes and transcript.`)) return;
    await api.deleteConversation(cid);
    notifyDataChanged();
    nav("/");
  };

  return (
    <>
      <div className="pane-top drag">
        <button className="icon-btn ghost sm back-btn" onClick={() => nav("/")} aria-label="Back"><ArrowLeft size={18} /></button>
        <div className="spacer" />
      </div>
      <div className="scroll">
        <article className="doc">
          <EditableTitle key={cid} value={title} disabled={!m} onSave={async (t) => { await api.setTitle(cid, t); notifyDataChanged(); }} />
          {(m?.subtitle || m?.summary) && <p className="m-sub">{m.subtitle || firstSentence(m.summary)}</p>}

          <div className="meta">
            <StylePicker style={style} onChange={chooseStyle} />
            <ProjectChip cid={cid} conversation={c} projects={projects} onError={showToast} />
            <TagEditor cid={cid} tags={c.tags ?? []} />
            <span className="faint when">
              {c.is_meeting && <span title="Sutra detected a meeting"><Users size={13} style={{ verticalAlign: -2, marginRight: 5 }} />Meeting · </span>}
              {[longDate(c.started_at ?? c.created_at), duration(c.started_at, c.ended_at)].filter(Boolean).join(" · ")}
              {c.source_app && <> · <SourceApp name={c.source_app} /></>}
            </span>
          </div>

          <div className="seg" role="tablist">
            <button role="tab" aria-selected={tab === "notes"} onClick={() => setTab("notes")}>Notes</button>
            <button role="tab" aria-selected={tab === "transcript"} onClick={() => setTab("transcript")}>Transcript</button>
          </div>

          {tab === "notes" ? (
            pending ? <Writing />
              : c.status === "failed" && !m ? <Failed cid={cid} onDone={load} />
              : style === "minutes" ? <MinutesNotes cid={cid} minutes={detail.minutes as any} meetingTitle={title} isMeeting={!!c.is_meeting} toast={showToast} />
              : style === "detailed" ? <DetailedNotesView cid={cid} actions={detail.actions as any[]} />
              : <BriefNotes memory={m} actions={detail.actions as any[]} />
          ) : (
            <>
              <TranscriptTools cid={cid} conversation={c} glossaryFrom={projects.find((p) => p.id === c.project_id && p.context_enabled !== false && p.terms?.length)} toast={showToast} />
              <Transcript turns={detail.turns as any[]} startedAt={c.started_at} cid={cid} />
            </>
          )}
        </article>
      </div>
      <AskBar cid={cid} onCopy={copy} onExport={exportMd} onDelete={remove} />
      {toast}
    </>
  );
}

function SourceApp({ name }: { name: string }) {
  const icon = useAppIcon(name);
  return <span className="app-inline">{icon && <AppIcon src={icon} name={name} size={16} className="" />}{name}</span>;
}

function firstSentence(s: string): string {
  const m = String(s ?? "").match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim();
}

function PaneSkeleton() {
  return (
    <div className="doc" style={{ paddingTop: 70 }}>
      <div className="skel" style={{ height: 34, width: "60%", marginBottom: 12 }} />
      <div className="skel" style={{ height: 18, width: "80%", marginBottom: 30 }} />
      <div className="skel" style={{ height: 44, marginBottom: 30, borderRadius: 999 }} />
      {[0, 1, 2, 3].map((i) => <div key={i} className="skel" style={{ height: 16, width: `${90 - i * 12}%`, marginBottom: 12 }} />)}
    </div>
  );
}

function EditableTitle({ value, onSave, disabled }: { value: string; onSave: (v: string) => Promise<void>; disabled?: boolean }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setV(value), [value]);
  // Auto-grow so long titles wrap instead of clipping (textarea, since an <input> can't wrap).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [v]);
  const commit = () => { const t = v.replace(/\s+/g, " ").trim(); if (t && t !== value) void onSave(t); else setV(value); };
  return (
    <textarea
      ref={ref}
      rows={1}
      className="m-title"
      value={v}
      disabled={disabled}
      aria-label="Meeting title"
      onChange={(e) => setV(e.target.value.replace(/\n/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
        if (e.key === "Escape") { setV(value); (e.target as HTMLTextAreaElement).blur(); }
      }}
    />
  );
}

function StylePicker({ style, onChange }: { style: ViewStyle; onChange: (s: ViewStyle) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span className="k">Style</span>
      <Popover open={open} onOpenChange={setOpen} trigger={
        <button className="chip-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
          {STYLES[style].label} <ChevronDown size={14} />
        </button>
      }>
        {(Object.keys(STYLES) as ViewStyle[]).map((s) => (
          <button key={s} role="menuitemradio" aria-checked={s === style} onClick={() => { onChange(s); setOpen(false); }}>
            <span style={{ width: 16 }}>{s === style ? <Check size={14} /> : null}</span>
            {STYLES[s].label}
            <span className="hint">{STYLES[s].hint}</span>
          </button>
        ))}
      </Popover>
    </span>
  );
}

function TagEditor({ cid, tags }: { cid: number; tags: string[] }) {
  const [draft, setDraft] = useState("");
  const save = async (next: string[]) => { await api.setTags(cid, next); notifyDataChanged(); };
  const add = () => {
    const t = draft.trim().replace(/^#/, "");
    setDraft("");
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase())) void save([...tags, t]);
  };
  return (
    <span className="tags">
      <TagIcon size={15} />
      {tags.map((t) => (
        <span key={t} className="tag">{t}<button aria-label={`Remove ${t}`} onClick={() => void save(tags.filter((x) => x !== t))}><X size={12} /></button></span>
      ))}
      <input
        className="tag-input"
        value={draft}
        placeholder={tags.length ? "" : "Add a tag…"}
        aria-label="Add a tag"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </span>
  );
}

function Writing() {
  return (
    <div className="notice">
      <Loader2 size={16} className="spin" style={{ marginTop: 2 }} />
      <div className="grow">
        <div style={{ fontWeight: 600 }}>Writing your notes…</div>
        <div className="muted">The transcript is saved. Summary, decisions and action items appear here in a moment.</div>
      </div>
    </div>
  );
}

function Failed({ cid, onDone }: { cid: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const retry = async () => {
    setBusy(true); setErr(null);
    try { await api.reprocessConversation(cid); notifyDataChanged(); onDone(); }
    catch (e) { setErr(friendlyError(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="notice err">
      <div className="grow">
        <div style={{ fontWeight: 600 }}>Couldn't write notes for this meeting</div>
        <div className="muted">{err ?? "The transcript is safe. Check your AI engine in Settings → Intelligence, then retry."}</div>
      </div>
      <button className="btn" onClick={retry} disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} Retry</button>
    </div>
  );
}

function Bullets({ items, empty }: { items: string[]; empty?: string }) {
  if (!items?.length) return empty ? <ul className="bullets"><li className="none">{empty}</li></ul> : null;
  return <ul className="bullets">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

function ActionList({ actions }: { actions: { id?: number; text: string; owner?: string | null; status?: string }[] }) {
  const [local, setLocal] = useState(actions);
  useEffect(() => setLocal(actions), [actions]);
  const toggle = async (a: (typeof actions)[number]) => {
    if (a.id == null) return;
    const status = a.status === "done" ? "open" : "done";
    setLocal((xs) => xs.map((x) => (x.id === a.id ? { ...x, status } : x)));
    await api.updateAction(a.id, status);
  };
  return (
    <div>
      {local.map((a, i) => (
        <div key={a.id ?? i} className={`todo${a.status === "done" ? " done" : ""}`}>
          <button className={`check${a.status === "done" ? " on" : ""}`} onClick={() => void toggle(a)} disabled={a.id == null}
            role="checkbox" aria-checked={a.status === "done"} aria-label={a.text}>
            {a.status === "done" && <Check size={13} strokeWidth={3} />}
          </button>
          <span className="todo-text">{a.owner ? <span className="owner">{a.owner}: </span> : null}{a.text}</span>
        </div>
      ))}
    </div>
  );
}

function BriefNotes({ memory, actions }: { memory: any; actions: any[] }) {
  if (!memory) return null;
  return (
    <>
      <section className="sec"><h2>Summary</h2><p>{memory.summary}</p></section>
      <section className="sec"><h2>Decisions</h2><Bullets items={memory.decisions} empty="none" /></section>
      {actions.length > 0 && <section className="sec"><h2>Action items</h2><ActionList actions={actions} /></section>}
      {memory.open_questions?.length > 0 && <section className="sec"><h2>Open questions</h2><Bullets items={memory.open_questions} /></section>}
    </>
  );
}

function DetailedNotesView({ cid, actions }: { cid: number; actions: any[] }) {
  const [notes, setNotes] = useState<DetailedNotes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (force = false) => {
    setBusy(true); setErr(null);
    try { setNotes(await api.detailedNotes(cid, force)); }
    catch (e) { setErr(friendlyError(e)); }
    finally { setBusy(false); }
  }, [cid]);
  useEffect(() => { setNotes(null); void run(false); }, [run]);

  if (err) {
    return (
      <div className="notice err">
        <div className="grow"><div style={{ fontWeight: 600 }}>Couldn't write detailed notes</div><div className="muted">{err}</div></div>
        <button className="btn" onClick={() => void run(true)}><RotateCcw size={14} /> Retry</button>
      </div>
    );
  }
  if (!notes) {
    return (
      <div>
        <div className="muted" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 18 }}><Loader2 size={15} className="spin" /> Writing detailed notes…</div>
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel" style={{ height: 15, width: `${92 - i * 9}%`, marginBottom: 12 }} />)}
      </div>
    );
  }
  return (
    <>
      {notes.overview && <section className="sec"><h2>Overview</h2><p>{notes.overview}</p></section>}
      {notes.topics.map((t, i) => <section key={i} className="sec"><h2>{t.heading}</h2><Bullets items={t.points} /></section>)}
      <section className="sec"><h2>Decisions</h2><Bullets items={notes.decisions} empty="none" /></section>
      {actions.length > 0 && <section className="sec"><h2>Action items</h2><ActionList actions={actions} /></section>}
      {notes.open_questions.length > 0 && <section className="sec"><h2>Open questions</h2><Bullets items={notes.open_questions} /></section>}
      {notes.next_steps.length > 0 && <section className="sec"><h2>Next steps</h2><Bullets items={notes.next_steps} /></section>}
      <button className="btn" onClick={() => void run(true)} disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} Regenerate</button>
    </>
  );
}

/** Raw / Cleaned switch and "Clean up transcript". Cleaning keeps the raw text, uses the project's
 *  glossary (refinement service) and rebuilds the notes, so the whole view refreshes afterwards. */
function TranscriptTools({ cid, conversation: c, glossaryFrom, toast }: { cid: number; conversation: any; glossaryFrom?: any; toast: (m: string) => void }) {
  const [busy, setBusy] = useState<null | "clean" | "raw" | "cleaned">(null);
  const [err, setErr] = useState<string | null>(null);
  const clean = async () => {
    setBusy("clean"); setErr(null);
    try {
      const r = await api.cleanConversation(cid);
      if (r.ok) { toast("Transcript cleaned · notes updated"); notifyDataChanged(); }
      else setErr(r.reason === "cloud-only" ? "Clean-up needs an AI engine — connect one in Settings → Intelligence."
        : r.reason === "empty" ? "There's no transcript to clean yet." : "Couldn't clean the transcript — try again.");
    } catch (e) { setErr(friendlyError(e)); }
    finally { setBusy(null); }
  };
  // Switching re-derives the notes from the chosen text; the flag flips first, so a failed refresh
  // (offline) still shows the text the user picked.
  const show = async (cleaned: boolean) => {
    if (cleaned === !!c.refined) return;
    setBusy(cleaned ? "cleaned" : "raw"); setErr(null);
    try { await api.setConversationRefined(cid, cleaned); }
    catch { toast("Switched — notes will refresh once your AI engine is available"); }
    finally { setBusy(null); notifyDataChanged(); }
  };
  return (
    <>
      <div className="tx-tools">
        {c.hasClean && (
          <span className="mini-seg" role="group" aria-label="Transcript text">
            <button aria-pressed={!c.refined} onClick={() => void show(false)} disabled={!!busy}>{busy === "raw" ? <Loader2 size={12} className="spin" /> : null} Raw</button>
            <button aria-pressed={!!c.refined} onClick={() => void show(true)} disabled={!!busy}>{busy === "cleaned" ? <Loader2 size={12} className="spin" /> : null} Cleaned</button>
          </span>
        )}
        <button className="btn" onClick={() => void clean()} disabled={!!busy}>
          {busy === "clean" ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}
          {busy === "clean" ? "Cleaning…" : c.hasClean ? "Clean again" : "Clean up transcript"}
        </button>
        <span className="faint grow">
          {busy === "clean" ? "Fixing mishearings and filler, then rewriting the notes — this can take a minute."
            : glossaryFrom ? `Uses the ${projectName(glossaryFrom)} glossary.` : c.hasClean ? "" : "Fixes mishearings and filler. The original is kept."}
        </span>
      </div>
      {err && <div className="notice err"><div className="grow">{err}</div></div>}
    </>
  );
}

function Transcript({ turns, startedAt, cid }: { turns: any[]; startedAt?: string | null; cid: number }) {
  const [renamed, setRenamed] = useState(false);
  if (!turns.length) return <p className="muted">No transcript for this meeting.</p>;
  return (
    <>
      {renamed && (
        <div className="notice">
          <div className="grow">Speaker renamed. Refresh the notes so they use the new name?</div>
          <RefreshNotes cid={cid} onDone={() => setRenamed(false)} />
        </div>
      )}
      <div className="transcript">
        {turns.map((t) => (
          <div key={t.id}>
            <div className="turn-head">
              <SpeakerButton turn={t} onRenamed={() => setRenamed(true)} />
              <span className="turn-time">{offsetLabel(startedAt, t.abs_start)}</span>
            </div>
            <div className="turn-text">{t.text}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function RefreshNotes({ cid, onDone }: { cid: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await api.reprocessConversation(cid); notifyDataChanged(); onDone(); } finally { setBusy(false); }
    }}>{busy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} Refresh notes</button>
  );
}

function SpeakerButton({ turn, onRenamed }: { turn: any; onRenamed: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const label = speakerName(turn);
  const color = isMe(turn) ? "var(--text)" : speakerColor(String(turn.person_id ?? turn.session_speaker_label));
  const save = async (body: { name: string; is_me?: boolean }) => {
    if (!body.name.trim()) return;
    // "This is me" maps to the owner's person row (named in Settings) when one exists.
    const me = body.is_me ? ((await api.listPeople()) as any[]).find((p) => p.is_me) : null;
    await api.relabel(turn.session_id, turn.session_speaker_label, me ? { person_id: me.id } : { name: body.name.trim(), is_me: body.is_me });
    setOpen(false);
    notifyDataChanged();
    onRenamed();
  };
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={
      <button className="speaker" style={{ ["--spk" as any]: color }} onClick={() => { setName(turn.person_name ?? ""); setOpen((o) => !o); }} title="Rename speaker">
        {label}
      </button>
    }>
      <form onSubmit={(e) => { e.preventDefault(); void save({ name }); }} style={{ padding: 4 }}>
        <input autoFocus value={name} placeholder={`Who is ${label}?`} onChange={(e) => setName(e.target.value)} aria-label="Speaker name" />
      </form>
      <button onClick={() => void save({ name })} disabled={!name.trim()}>Rename everywhere in this meeting</button>
      <button onClick={() => void save({ name: "Me", is_me: true })}>This is me</button>
    </Popover>
  );
}

function AskBar({ cid, onCopy, onExport, onDelete }: { cid: number; onCopy: () => void; onExport: () => void; onDelete: () => void }) {
  const [q, setQ] = useState("");
  const [qa, setQa] = useState<{ q: string; a: string | null }[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { setQa([]); setQ(""); }, [cid]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [qa]);

  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    setQ("");
    const history = qa.filter((x) => x.a).map((x) => ({ q: x.q, a: x.a! }));
    setQa((xs) => [...xs, { q: question, a: null }]);
    let a: string;
    try { a = await api.askMeeting(cid, question, history); } catch (e) { a = friendlyError(e); }
    setQa((xs) => xs.map((x, i) => (i === xs.length - 1 && x.q === question && x.a === null ? { ...x, a } : x)));
  };

  return (
    <>
      {qa.length > 0 && (
        <div className="answers" role="log" aria-live="polite">
          <div className="answers-head"><span>About this meeting</span><button className="icon-btn ghost sm" onClick={() => setQa([])} aria-label="Close answers"><X size={14} /></button></div>
          {qa.map((x, i) => (
            <div key={i} className="qa">
              <div className="q">{x.q}</div>
              <div className="a">{x.a ?? <span className="muted"><Loader2 size={13} className="spin" /> Thinking…</span>}</div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
      <div className="pane-fade" />
      <div className="askbar">
        <form className="ask-input" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
          <Sparkles size={17} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about this meeting…" aria-label="Ask about this meeting" />
          <EnginePicker />
        </form>
        <div className="ask-actions">
          <button className="icon-btn" onClick={onCopy} aria-label="Copy notes" title="Copy notes"><Copy size={17} /></button>
          <button className="icon-btn" onClick={onExport} aria-label="Export" title="Export as Markdown"><Share size={17} /></button>
          <button className="icon-btn danger" onClick={onDelete} aria-label="Delete meeting" title="Delete"><Trash2 size={17} /></button>
        </div>
      </div>
    </>
  );
}
