import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Check, Trash2, Plus, X, UserPlus, Mic, MicOff, Cloud } from "lucide-react";
import { api } from "../../local/sutra";
import { PROJECT_LABEL, BRIEF_CAP, clampBrief, type ProjectTerm } from "../../local/repo";
import { Chip, ErrorBar, isBenignError, SkeletonDetail } from "../../components/ui";
import { Section, SwitchRow } from "../../components/settingsKit";
import { setHeaderTitle } from "../../lib/headerTitle";

// Project detail — author a project's context once. Read-first, autosave-on-blur (no Save button); all
// writes are local (on-device v1). People: typing suggests EXISTING enrolled people first so identity never
// forks. Two clearly-separate switches: "use on-device" (live) vs "back up to cloud" (deferred in v1).
type Member = { person_id: number | null; role: string | null; canonical_name: string; is_me: number; has_voiceprint: number };

export default function ProjectDetail() {
  const navigate = useNavigate();
  const { id: idParam } = useParams();
  const projectId = Number(idParam);

  const [project, setProject] = useState<any>(null);
  const [people, setPeople] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  // Local field drafts (committed to the DB on blur). Name + brief edit live here so typing never round-trips.
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Add-person + add-term drafts.
  const [newPerson, setNewPerson] = useState("");
  const [newRole, setNewRole] = useState("");
  const [newTerm, setNewTerm] = useState("");
  const [newAlias, setNewAlias] = useState("");

  const flash = () => { setSaved(true); setTimeout(() => setSaved(false), 1500); };

  const reload = async () => {
    const [pr, pl] = await Promise.allSettled([api.getProject(projectId), api.listPeople()]);
    if (pr.status === "fulfilled") {
      const p = pr.value as any;
      setProject(p);
      if (p) { setName(p.name ?? ""); setBrief(p.brief ?? ""); }
    }
    if (pl.status === "fulfilled") setPeople(pl.value as any[]);
    const fatal = [pr].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    if (fatal && !isBenignError(fatal.reason?.message ?? String(fatal.reason))) {
      setError(fatal.reason?.message ?? String(fatal.reason));
    }
    setLoading(false);
  };
  useEffect(() => { reload().catch((e) => { setError(e.message); setLoading(false); }); }, [projectId]);

  // Publish the loaded name to the shared Header (falls back to the label until it loads).
  useEffect(() => {
    setHeaderTitle(project ? (name.trim() || "Untitled project") : PROJECT_LABEL);
    return () => setHeaderTitle(null);
  }, [project, name]);

  // All writes are local-only; reload after each so derived bits (people join, counts) stay accurate.
  const patch = async (p: Parameters<typeof api.updateProject>[1]) => {
    setError(null);
    try { await api.updateProject(projectId, p); flash(); await reload(); }
    catch (e: any) { setError(e.message); }
  };
  const peopleAction = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); flash(); await reload(); } catch (e: any) { setError(e.message); }
  };

  const members: Member[] = (project?.people ?? []) as Member[];
  const memberIds = useMemo(() => new Set(members.map((m) => m.person_id).filter((x): x is number => x != null)), [members]);
  // Suggest enrolled people NOT already on this project, matching the typed prefix — so a known person is
  // re-used (identity never forks) before a fresh row is created.
  const suggestions = useMemo(() => {
    const term = newPerson.trim().toLowerCase();
    if (!term) return [];
    return people
      .filter((p) => !memberIds.has(p.id) && String(p.canonical_name).toLowerCase().includes(term))
      .slice(0, 5);
  }, [newPerson, people, memberIds]);

  const terms: ProjectTerm[] = (project?.terms ?? []) as ProjectTerm[];

  const addPerson = async (member: { person_id?: number; name?: string }) => {
    const role = newRole.trim();
    await peopleAction(() => api.addProjectPerson(projectId, { ...member, role: role || undefined }));
    setNewPerson(""); setNewRole("");
  };

  const addTerm = async () => {
    const canonical = newTerm.trim();
    if (!canonical) return;
    const heardAs = newAlias.trim() ? [newAlias.trim()] : [];
    await patch({ terms: [...terms, { canonical, heardAs }] });
    setNewTerm(""); setNewAlias("");
  };
  const removeTerm = async (canonical: string) =>
    patch({ terms: terms.filter((t) => t.canonical !== canonical) });

  const remove = async () => {
    setError(null);
    try { await api.deleteProject(projectId); navigate("/settings/projects"); }
    catch (e: any) { setError(e.message); setConfirmDelete(false); }
  };

  // Live brief counter; the cap is gentle (enforced via clampBrief on blur), not a hard input maxLength.
  const briefLen = brief.length;
  const briefRef = useRef<HTMLTextAreaElement | null>(null);

  if (loading) {
    return <div className="page fade-in"><SkeletonDetail /></div>;
  }
  if (!project) {
    return <div className="page fade-in"><ErrorBar message="This project no longer exists." /></div>;
  }

  return (
    <div className="page fade-in">
      <p className="page-sub">{saved ? <span className="chip ok"><Check size={12} /> saved</span> : "Authored by you — never invented. Edits save automatically."}</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      <Section title="Project">
        <label className="field"><span>Name</span>
          <input className="input" value={name} placeholder="e.g. Nectar"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if ((name.trim() || null) !== (project.name ?? null)) patch({ name: name.trim() }); }} />
        </label>
        <label className="field" style={{ marginBottom: 6 }}><span>Brief</span>
          <textarea ref={briefRef} className="input" rows={6} value={brief}
            placeholder="What this project is, the core tools/tech, APIs and integrations, naming conventions. Written verbatim into the context."
            onChange={(e) => setBrief(e.target.value)}
            onBlur={() => { const v = clampBrief(brief); if (v !== brief) setBrief(v); if (v !== (project.brief ?? "")) patch({ brief: v }); }} />
        </label>
        <div className="faint" style={{ fontSize: "var(--fs-xs)", textAlign: "right", color: briefLen >= BRIEF_CAP ? "var(--warn)" : undefined }}>
          {briefLen} / {BRIEF_CAP}
        </div>
      </Section>

      <Section icon={<UserPlus size={16} color="var(--accent-2)" />} title="People">
        {members.length === 0 && <div className="faint" style={{ fontSize: "var(--fs-s)", marginBottom: 10 }}>Add the people on this project and their role here. The same person can have a different role in another project.</div>}
        <div className="stack" style={{ marginBottom: 14, gap: 12 }}>
          {members.map((m) => (
            <div key={m.person_id ?? m.canonical_name} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
              <div className="between" style={{ gap: 10 }}>
                <div className="row" style={{ minWidth: 0, flex: 1, gap: 8 }}>
                  <span className="trunc" style={{ fontWeight: 650 }}>{m.canonical_name}</span>
                  {!!m.is_me && <Chip kind="me">me</Chip>}
                </div>
                {m.person_id != null && (
                  <button className="btn ghost sm" onClick={() => peopleAction(() => api.removeProjectPerson(projectId, m.person_id!))} aria-label={`Remove ${m.canonical_name}`}><Trash2 size={15} /></button>
                )}
              </div>
              <label className="field" style={{ margin: "10px 0 0" }}><span>Role on this project</span>
                <input className="input" defaultValue={m.role ?? ""} placeholder="e.g. backend, FastAPI, GCP"
                  onBlur={(e) => { const v = e.target.value.trim(); if (m.person_id != null && v !== (m.role ?? "")) peopleAction(() => api.setProjectPersonRole(projectId, m.person_id!, v || null)); }} />
              </label>
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                {m.has_voiceprint
                  ? <Chip kind="ok"><Mic size={11} /> Voice linked</Chip>
                  : <Chip><MicOff size={11} /> No voice yet</Chip>}
              </div>
              {!m.has_voiceprint && <div className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 6 }}>Name this person inside a conversation to link their voice — Sutra learns it on first label.</div>}
            </div>
          ))}
        </div>

        <div className="divider" />
        <div className="faint" style={{ fontSize: "var(--fs-xs)", marginBottom: 8 }}>Add a person</div>
        <label className="field" style={{ marginBottom: 8 }}><span>Name</span>
          <input className="input" value={newPerson} onChange={(e) => setNewPerson(e.target.value)} placeholder="e.g. Salendra" /></label>
        {suggestions.length > 0 && (
          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {suggestions.map((p) => (
              <button key={p.id} className="btn ghost sm" onClick={() => addPerson({ person_id: p.id })}>
                <UserPlus size={13} /> {p.canonical_name}{p.has_voiceprint ? <Mic size={11} style={{ opacity: 0.7 }} /> : null}
              </button>
            ))}
          </div>
        )}
        <label className="field"><span>Role on this project (optional)</span>
          <input className="input" value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder="e.g. frontend, Flutter" /></label>
        <div className="row">
          <button className="btn primary sm" onClick={() => addPerson({ name: newPerson.trim() })} disabled={!newPerson.trim()}>
            <Plus size={15} /> Add person
          </button>
        </div>
        {newPerson.trim() && suggestions.length === 0 && people.some((p) => !memberIds.has(p.id)) && (
          <div className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 8 }}>No match among enrolled people — this adds a new person.</div>
        )}
      </Section>

      <Section title="Terms">
        <div className="faint" style={{ fontSize: "var(--fs-s)", marginBottom: 10 }}>Names and tools that must be spelled correctly (e.g. AiSensy). Add what they're sometimes misheard as so cleanups fix them.</div>
        {terms.length > 0 && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {terms.map((t) => (
              <span key={t.canonical} className="chip accent" style={{ paddingRight: 6 }}>
                {t.canonical}{t.heardAs.length > 0 && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>· heard as {t.heardAs.join(", ")}</span>}
                <button onClick={() => removeTerm(t.canonical)} aria-label={`Remove ${t.canonical}`}
                  style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 2, margin: 0, lineHeight: 1, display: "inline-flex" }}><X size={13} /></button>
              </span>
            ))}
          </div>
        )}
        <label className="field" style={{ marginBottom: 8 }}><span>Term</span>
          <input className="input" value={newTerm} onChange={(e) => setNewTerm(e.target.value)} placeholder="e.g. AiSensy" /></label>
        <label className="field"><span>Heard as (optional)</span>
          <input className="input" value={newAlias} onChange={(e) => setNewAlias(e.target.value)} placeholder="e.g. AI sensor" /></label>
        <div className="row">
          <button className="btn primary sm" onClick={addTerm} disabled={!newTerm.trim()}><Plus size={15} /> Add term</button>
        </div>
      </Section>

      <Section icon={<Cloud size={16} color="var(--accent-2)" />} title="Context">
        <SwitchRow
          label="Use this project's context"
          caption="Grounds cleanups, speaker attribution and minutes for meetings mapped to this project. Stays on this device."
          checked={project.context_enabled !== false}
          onChange={(checked) => patch({ context_enabled: checked })}
        />
        <div className="faint" style={{ fontSize: "var(--fs-xs)", padding: "10px 2px 2px" }}>Cloud backup — coming soon.</div>
      </Section>

      <div className="row" style={{ marginTop: 8 }}>
        {confirmDelete ? (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn danger sm" onClick={remove}><Trash2 size={14} /> Delete project</button>
            <button className="btn ghost sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : (
          <button className="btn ghost sm" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete project</button>
        )}
      </div>
    </div>
  );
}
