import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, ListFilter, Mic, Plus, Trash2, UserPlus, X } from "lucide-react";
import { api } from "../../local/sutra";
import { BRIEF_CAP, clampBrief, type ProjectTerm } from "../../local/repo";
import { notifyDataChanged } from "../events";
import { shortDate } from "../format";
import { Popover, Switch, friendlyError, useToast } from "../ui";
import { setMeetingFilter } from "./filter";
import { PROJECT_COLORS, addTerm, plural, projectColor, projectName, removeHeardAs, removeTerm, splitVariants } from "./model";
import "../features.css";

type Member = { person_id: number | null; role: string | null; canonical_name: string; is_me: number; has_voiceprint: number };

const initials = (name?: string | null) => {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase() : "?";
};

/** One project: its name, colour, brief, people (with per-project roles), glossary and meetings.
 *  Everything autosaves on blur / on change — there's no Save button. */
export function ProjectPage() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [project, setProject] = useState<any | null | undefined>(undefined);
  const [people, setPeople] = useState<any[]>([]);
  const [meetings, setMeetings] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  const reload = useCallback(async () => {
    try {
      const [p, pl, convs] = await Promise.all([api.getProject(pid), api.listPeople(), api.listConversations()]);
      setProject(p ?? null);
      setPeople(pl as any[]);
      setMeetings((convs as any[]).filter((c) => c.project_id === pid));
      return p;
    } catch (e) { setError(friendlyError(e)); setProject(null); return null; }
  }, [pid]);

  useEffect(() => {
    setProject(undefined);
    void reload().then((p: any) => { setName(p?.name ?? ""); setBrief(p?.brief ?? ""); });
  }, [reload]);

  // Every write is local; refresh this page and let the sidebar pick up names/colours.
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try { await fn(); await reload(); notifyDataChanged(); if (done) showToast(done); }
    catch (e) { setError(friendlyError(e)); }
  };
  const patch = (p: Parameters<typeof api.updateProject>[1], done?: string) => act(() => api.updateProject(pid, p), done);

  if (project === undefined) {
    return <div className="doc" style={{ paddingTop: 70 }}>{[60, 80, 40, 90].map((w, i) => <div key={i} className="skel" style={{ height: i ? 16 : 34, width: `${w}%`, marginBottom: 16 }} />)}</div>;
  }
  if (!project) {
    return (
      <div className="center">
        <div>
          <p className="hero-title">Project not found</p>
          <p className="hero-text">{error ?? "It may have been deleted."}</p>
          <button className="btn" onClick={() => nav("/projects")}>All projects</button>
        </div>
      </div>
    );
  }

  const terms: ProjectTerm[] = project.terms ?? [];
  const color = projectColor(project);
  const remove = async () => {
    if (!window.confirm(`Delete “${projectName(project)}”? Its meetings stay — they're just no longer in a project.`)) return;
    await act(() => api.deleteProject(pid));
    setMeetingFilter(null);
    nav("/projects");
  };

  return (
    <>
      <div className="pane-top drag">
        {/* Always shown (not just on phones): a project page sits one level below the projects list. */}
        <button className="icon-btn ghost sm" onClick={() => nav("/projects")} aria-label="All projects" title="All projects"><ArrowLeft size={18} /></button>
        <div className="spacer" />
      </div>
      <div className="scroll">
        <article className="doc">
          <input
            className="m-title"
            value={name}
            placeholder="Untitled project"
            aria-label="Project name"
            autoFocus={params.get("new") === "1"}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { const v = name.trim(); if (v !== (project.name ?? "")) void patch({ name: v }); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
          <p className="m-sub">The brief and glossary help Sutra spell names and terms right, and fix mishearings in transcripts and notes.</p>

          <div className="meta">
            <span className="swatches" role="radiogroup" aria-label="Colour">
              {PROJECT_COLORS.map((c) => (
                <button key={c} style={{ ["--pc" as any]: c }} aria-pressed={c === color} aria-label={`Colour ${c}`} onClick={() => void patch({ color: c })} />
              ))}
            </span>
            <span className="faint when">{plural(meetings.length, "meeting")} · {plural(project.people?.length ?? 0, "person", "people")} · {plural(terms.length, "term")}</span>
          </div>

          <section className="sec">
            <h2>Brief</h2>
            <textarea
              className="field-area"
              value={brief}
              placeholder="What this project is about — products, tools, APIs, naming conventions. Used as-is to ground clean-ups and minutes."
              onChange={(e) => setBrief(e.target.value)}
              onBlur={() => { const v = clampBrief(brief); if (v !== brief) setBrief(v); if (v !== (project.brief ?? "")) void patch({ brief: v }, "Saved"); }}
            />
            <div className={`counter${brief.length > BRIEF_CAP ? " over" : ""}`}>{brief.length} / {BRIEF_CAP}</div>
            <div className="row-line">
              <div className="grow">
                <div className="t">Use this context</div>
                <div className="d">Grounds transcript clean-up, speaker names and minutes for this project's meetings. Stays on this device.</div>
              </div>
              <Switch label="Use this project's context" checked={project.context_enabled !== false} onChange={(v) => void patch({ context_enabled: v })} />
            </div>
          </section>

          <People pid={pid} members={(project.people ?? []) as Member[]} everyone={people} act={act} />
          <Glossary terms={terms} onChange={(next, done) => patch({ terms: next }, done)} />

          <section className="sec">
            <div className="sec-head">
              <h2>Meetings</h2>
              {meetings.length > 0 && (
                <button className="link-btn quiet" style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}
                  onClick={() => { setMeetingFilter(pid); nav("/"); }}>
                  <ListFilter size={14} /> Show in sidebar
                </button>
              )}
            </div>
            {meetings.length === 0 ? (
              <p className="lead">No meetings yet. Open a meeting and pick this project from “Add to project…”.</p>
            ) : (
              <div style={{ margin: "0 -10px" }}>
                {meetings.map((m) => (
                  <button key={m.id} className="item" onClick={() => nav(`/m/${m.id}`)}>
                    <div className="item-head">
                      <span className="item-title">{m.title || "Untitled meeting"}</span>
                      <span className="item-date">{shortDate(m.started_at ?? m.created_at)}</span>
                    </div>
                    {(m.subtitle || m.summary) && <div className="item-sub">{m.subtitle || m.summary}</div>}
                  </button>
                ))}
              </div>
            )}
          </section>

          {error && <div className="notice err"><div className="grow">{error}</div></div>}
          <button className="btn danger" onClick={() => void remove()}><Trash2 size={15} /> Delete project</button>
        </article>
      </div>
      {toast}
    </>
  );
}

function People({ pid, members, everyone, act }: {
  pid: number; members: Member[]; everyone: any[]; act: (fn: () => Promise<unknown>, done?: string) => Promise<void>;
}) {
  const [who, setWho] = useState("");
  const [role, setRole] = useState("");
  const [open, setOpen] = useState(false);
  const memberIds = useMemo(() => new Set(members.map((m) => m.person_id)), [members]);
  // Offer people Sutra already knows first, so one human never becomes two rows.
  const suggestions = useMemo(() => {
    const q = who.trim().toLowerCase();
    return everyone.filter((p) => !memberIds.has(p.id) && (!q || String(p.canonical_name).toLowerCase().includes(q))).slice(0, 6);
  }, [who, everyone, memberIds]);

  const add = async (member: { person_id?: number; name?: string }) => {
    if (member.person_id == null && !member.name?.trim()) return;
    setOpen(false);
    await act(() => api.addProjectPerson(pid, { ...member, role: role.trim() || undefined }));
    setWho(""); setRole("");
  };

  return (
    <section className="sec">
      <div className="sec-head"><h2>People</h2></div>
      <p className="lead">Who's on this project and what they do here. The same person can have a different role elsewhere.</p>
      <div className="rows">
        {members.map((m) => (
          <div key={m.person_id ?? m.canonical_name} className="row-line">
            <span className="avatar" aria-hidden>{initials(m.canonical_name)}</span>
            <div className="grow">
              <div className="t">{m.canonical_name}{m.is_me ? <span className="faint" style={{ fontWeight: 500 }}> · you</span> : null}</div>
              <input
                className="inline-input"
                defaultValue={m.role ?? ""}
                placeholder="Add a role on this project…"
                aria-label={`${m.canonical_name}'s role`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (m.person_id != null && v !== (m.role ?? "")) void act(() => api.setProjectPersonRole(pid, m.person_id!, v || null), "Role saved");
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
            </div>
            <span className={`voice${m.has_voiceprint ? " on" : ""}`} title={m.has_voiceprint ? "Sutra knows this voice" : "Name them in a meeting's transcript and Sutra learns their voice"}>
              <Mic size={13} /> {m.has_voiceprint ? "Voice linked" : "No voice yet"}
            </span>
            {m.person_id != null && (
              <button className="icon-btn ghost sm" aria-label={`Remove ${m.canonical_name}`} onClick={() => void act(() => api.removeProjectPerson(pid, m.person_id!))}><X size={15} /></button>
            )}
          </div>
        ))}
      </div>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); void add({ name: who.trim() }); }}>
        <Popover open={open && suggestions.length > 0} onOpenChange={setOpen} trigger={
          <input className="text-input" value={who} placeholder="Add a person…" aria-label="Person's name"
            onFocus={() => setOpen(true)} onChange={(e) => { setWho(e.target.value); setOpen(true); }} />
        }>
          {suggestions.map((p) => (
            <button type="button" key={p.id} onClick={() => void add({ person_id: p.id })}>
              <UserPlus size={14} /> {p.canonical_name}
              {p.has_voiceprint ? <span className="hint"><Mic size={12} /></span> : null}
            </button>
          ))}
        </Popover>
        <input className="text-input" value={role} placeholder="Role (optional)" aria-label="Role" onChange={(e) => setRole(e.target.value)} />
        <button className="btn" disabled={!who.trim()}><Plus size={15} /> Add</button>
      </form>
    </section>
  );
}

function Glossary({ terms, onChange }: { terms: ProjectTerm[]; onChange: (next: ProjectTerm[], done?: string) => Promise<void> }) {
  const [term, setTerm] = useState("");
  const [heard, setHeard] = useState("");
  const submit = async () => {
    if (!term.trim()) return;
    await onChange(addTerm(terms, term, splitVariants(heard)), "Term added");
    setTerm(""); setHeard("");
  };
  return (
    <section className="sec">
      <div className="sec-head"><h2>Glossary</h2></div>
      <p className="lead">Names and words to spell exactly, with what they're sometimes misheard as — clean-up replaces those.</p>
      <div className="rows">
        {terms.map((t) => (
          <div key={t.canonical} className="term">
            <span className="t">{t.canonical}</span>
            {t.heardAs.length > 0 && <span className="heard">heard as</span>}
            {t.heardAs.map((h) => (
              <span key={h} className="tag">{h}
                <button aria-label={`Remove ${h}`} onClick={() => void onChange(removeHeardAs(terms, t.canonical, h))}><X size={12} /></button>
              </span>
            ))}
            <input
              className="inline-input"
              placeholder="+ heard as…"
              aria-label={`Add a way ${t.canonical} is misheard`}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const el = e.target as HTMLInputElement;
                const v = splitVariants(el.value);
                el.value = "";
                if (v.length) void onChange(addTerm(terms, t.canonical, v));
              }}
            />
            <button className="icon-btn ghost sm" aria-label={`Remove ${t.canonical}`} onClick={() => void onChange(removeTerm(terms, t.canonical))}><X size={15} /></button>
          </div>
        ))}
      </div>
      <form className="add-row" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input className="text-input" value={term} placeholder="Term, e.g. AiSensy" aria-label="Term" onChange={(e) => setTerm(e.target.value)} />
        <input className="text-input" value={heard} placeholder="Heard as, e.g. AI sensor, AI Sensi" aria-label="Heard as" onChange={(e) => setHeard(e.target.value)} />
        <button className="btn" disabled={!term.trim()}>{terms.some((t) => t.canonical.toLowerCase() === term.trim().toLowerCase()) ? <Check size={15} /> : <Plus size={15} />} Add</button>
      </form>
    </section>
  );
}
