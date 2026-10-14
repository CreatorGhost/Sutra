// The project page's "Code" section (desktop): the folders where the project's code lives. Ask can read
// them, read-only, to answer questions about the code. Linking one reads its AGENTS.md / CLAUDE.md /
// README / manifest to fill an empty brief and suggest people and glossary terms (each added only when
// the user says so). A folder without agent instructions gets a "Create AGENTS.md" offer: Sutra drafts
// it, the user edits it, and it's written only on Save (never over an existing file).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Check, FileText, FolderCode, FolderOpen, Loader2, MessageSquareText, Plus, Sparkles, X } from "lucide-react";
import { api } from "../../local/sutra";
import { desktop } from "../../desktop/bridge";
import type { ProjectTerm } from "../../local/repo";
import { hasAgentFile, isAgentFile, type FillSuggestion, type FolderScan } from "../../shared/projectFolders";
import { Switch, friendlyError } from "../ui";
import { addTerm } from "./model";

type Act = (fn: () => Promise<unknown>, done?: string) => Promise<void>;

export function ProjectFolders({ pid, project, act, onBrief, notify }: {
  pid: number;
  project: any;
  act: Act;
  /** Put a brief in the editor and save it. */
  onBrief: (brief: string) => Promise<void>;
  notify: (msg: string) => void;
}) {
  const nav = useNavigate();
  const paths: string[] = project.folders ?? [];
  const [scans, setScans] = useState<Record<string, FolderScan>>({});
  const [busy, setBusy] = useState<null | "link" | "fill">(null);
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<FillSuggestion | null>(null);
  const [draft, setDraft] = useState<{ folder: string; text: string | null } | null>(null);
  const key = paths.join("\n");

  const rescan = async () => {
    if (!desktop?.folders || !paths.length) { setScans({}); return; }
    const list = await api.scanProjectFolders(paths).catch(() => [] as FolderScan[]);
    setScans(Object.fromEntries(list.map((s) => [s.path, s])));
  };
  useEffect(() => { void rescan(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!desktop?.folders) {
    return (
      <section className="sec">
        <div className="sec-head"><h2>Code</h2></div>
        <p className="lead">Link this project's code folders from Sutra on your Mac. Then Ask can look at the code too — here as well, when your phone is paired.</p>
      </section>
    );
  }

  /** Read the folders and suggest; an empty brief is filled straight away (it's editable). */
  const fill = async (auto: boolean) => {
    setBusy("fill"); setError(null);
    try {
      const s = await api.suggestFromFolders(pid);
      const briefEmpty = !String(project.brief ?? "").trim();
      if (briefEmpty && s.brief) { await onBrief(s.brief); s.brief = ""; notify("Brief filled from the folder — edit it any time"); }
      if (s.brief || s.people.length || s.terms.length) setSuggest(s);
      else if (!auto) notify("Nothing new to suggest from the folder");
    } catch (e) { setError(friendlyError(e)); }
    finally { setBusy(null); }
  };

  const link = async () => {
    setBusy("link"); setError(null);
    try {
      const path = await api.linkProjectFolder(pid);
      if (!path) return;
      await act(async () => {}, "Folder linked");
      setBusy(null);
      await fill(true);
    } catch (e) { setError(friendlyError(e)); }
    finally { setBusy(null); }
  };

  const unlink = (path: string) => act(() => api.unlinkProjectFolder(pid, path), "Folder unlinked");

  const startDraft = async (folder: string) => {
    setDraft({ folder, text: null }); setError(null);
    try { const text = await api.draftAgentsFile(pid, folder); setDraft({ folder, text }); }
    catch (e) { setDraft(null); setError(friendlyError(e)); }
  };
  const saveDraft = async () => {
    if (!draft?.text) return;
    try { await api.saveAgentsFile(draft.folder, draft.text); setDraft(null); await rescan(); notify("AGENTS.md saved"); }
    catch (e) { setError(friendlyError(e)); }
  };

  const granted = paths.filter((p) => scans[p]?.granted && scans[p]?.exists);
  const codeOn = project.code_access !== false;

  return (
    <section className="sec code-sec">
      <div className="sec-head">
        <h2>Code</h2>
        {granted.length > 0 && codeOn && (
          <button className="link-btn quiet head-link" onClick={() => nav(`/ask?project=${pid}`)}>
            <MessageSquareText size={14} /> Ask about this project
          </button>
        )}
      </div>
      <p className="lead">The folders where this project's code lives. Ask can read them to answer questions about the code — read-only; Sutra never changes your files.</p>

      <div className="rows">
        {paths.map((path) => {
          const s = scans[path];
          const ok = !!s?.granted && !!s?.exists;
          return (
            <div key={path} className="folder-row">
              <span className="folder-icon" aria-hidden><FolderCode size={17} /></span>
              <div className="grow">
                <div className="t">{s?.name ?? path.split(/[\\/]/).pop()}</div>
                <div className="folder-path" title={path}>{path}</div>
                {s && !ok && (
                  <div className="folder-warn"><AlertTriangle size={13} /> {s.exists ? "Sutra no longer has access to this folder." : "This folder isn't on this computer."}
                    {s.exists && <button className="link-btn" onClick={() => void link()}>Link it again</button>}
                  </div>
                )}
                {ok && (
                  <div className="folder-files">
                    {s.files.length === 0 && <span className="faint">No README or agent instructions found</span>}
                    {s.files.map((f) => (
                      <button key={f.rel} className={`file-chip${isAgentFile(f.rel) ? " agent" : ""}`} title={`Show ${f.rel} in Finder`}
                        onClick={() => void desktop!.folders!.reveal(path, f.rel)}>
                        <FileText size={12} /> {f.rel}
                      </button>
                    ))}
                  </div>
                )}
                {ok && !!s.contributors?.length && (
                  <div className="folder-who" title={s.contributors.map((c) => `${c.name} — ${c.commits} commits`).join("\n")}>
                    {s.contributors.length === 1 ? "1 contributor" : `${s.contributors.length} contributors`} in git · {s.contributors.slice(0, 3).map((c) => c.name).join(", ")}{s.contributors.length > 3 ? "…" : ""}
                  </div>
                )}
                {ok && !hasAgentFile(s) && (
                  <div className="agents-offer">
                    <span>No <code>AGENTS.md</code> or <code>CLAUDE.md</code> here. One helps every coding agent — and Sutra — understand the project.</span>
                    <button className="btn sm" disabled={!!draft} onClick={() => void startDraft(path)}><Sparkles size={14} /> Create AGENTS.md</button>
                  </div>
                )}
              </div>
              {ok && <button className="icon-btn ghost sm" aria-label={`Show ${s.name} in Finder`} title="Show in Finder" onClick={() => void desktop!.folders!.reveal(path)}><FolderOpen size={15} /></button>}
              <button className="icon-btn ghost sm" aria-label={`Unlink ${s?.name ?? path}`} title="Unlink" onClick={() => void unlink(path)}><X size={15} /></button>
            </div>
          );
        })}
      </div>

      {draft && (
        <div className="agents-draft">
          <div className="agents-draft-head">
            <b>AGENTS.md</b> <span className="faint">for {scans[draft.folder]?.name ?? draft.folder}</span>
            <button className="icon-btn ghost sm" aria-label="Discard draft" onClick={() => setDraft(null)}><X size={15} /></button>
          </div>
          {draft.text === null
            ? <p className="muted"><Loader2 size={14} className="spin" /> Reading the folder and drafting…</p>
            : <>
                <textarea className="field-area mono" value={draft.text} spellCheck={false} aria-label="AGENTS.md draft" onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
                <div className="agents-draft-actions">
                  <span className="faint">Saved as a new file in the folder — review it first.</span>
                  <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
                  <button className="btn primary" disabled={!draft.text.trim()} onClick={() => void saveDraft()}><Check size={15} /> Save to folder</button>
                </div>
              </>}
        </div>
      )}

      {suggest && (
        <Suggestions s={suggest} project={project} pid={pid} act={act} onBrief={onBrief} onDone={() => setSuggest(null)} onChange={setSuggest} />
      )}

      <div className="add-row">
        <button className="btn" disabled={busy !== null} onClick={() => void link()}>
          {busy === "link" ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} Link a folder
        </button>
        {granted.length > 0 && (
          <button className="btn" disabled={busy !== null} onClick={() => void fill(false)}>
            {busy === "fill" ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} {busy === "fill" ? "Reading the folder…" : "Suggest from folder"}
          </button>
        )}
      </div>

      {paths.length > 0 && (
        <div className="row-line">
          <div className="grow">
            <div className="t">Let Ask read the code</div>
            <div className="d">Your AI engine opens these folders read-only when you ask about this project or one of its meetings.</div>
          </div>
          <Switch label="Let Ask read the code" checked={codeOn} onChange={(v) => void act(() => api.updateProject(pid, { code_access: v }))} />
        </div>
      )}
      {error && <div className="notice err"><div className="grow">{error}</div></div>}
    </section>
  );
}

/** Suggestions from the folder: each added only when the user says so. */
function Suggestions({ s, project, pid, act, onBrief, onDone, onChange }: {
  s: FillSuggestion; project: any; pid: number; act: Act; onBrief: (b: string) => Promise<void>;
  onDone: () => void; onChange: (s: FillSuggestion | null) => void;
}) {
  const terms: ProjectTerm[] = project.terms ?? [];
  const update = (next: FillSuggestion) => (next.brief || next.people.length || next.terms.length ? onChange(next) : onDone());
  const addPerson = async (p: FillSuggestion["people"][number]) => {
    await act(() => api.addProjectPerson(pid, { name: p.name, role: p.role ?? undefined }), `${p.name} added`);
    update({ ...s, people: s.people.filter((x) => x !== p) });
  };
  const addPeople = async (list: FillSuggestion["people"]) => {
    await act(async () => { for (const p of list) await api.addProjectPerson(pid, { name: p.name, role: p.role ?? undefined }); }, `${list.length} people added`);
    update({ ...s, people: [] });
  };
  const addTerms = async (list: FillSuggestion["terms"]) => {
    const next = list.reduce((acc, t) => addTerm(acc, t.canonical, t.heardAs), terms);
    await act(() => api.updateProject(pid, { terms: next }), list.length > 1 ? `${list.length} terms added` : "Term added");
    update({ ...s, terms: s.terms.filter((t) => !list.includes(t)) });
  };
  return (
    <div className="suggest">
      <div className="suggest-head">
        <Sparkles size={15} /> <b>Suggested from the folder</b>
        <button className="icon-btn ghost sm" aria-label="Dismiss suggestions" onClick={onDone}><X size={15} /></button>
      </div>
      {s.brief && (
        <div className="suggest-block">
          <div className="suggest-label">Brief</div>
          <p className="suggest-brief">{s.brief}</p>
          <button className="btn sm" onClick={() => void onBrief(s.brief).then(() => update({ ...s, brief: "" }))}><Check size={14} /> Replace the brief</button>
        </div>
      )}
      {s.people.length > 0 && (
        <div className="suggest-block">
          <div className="suggest-label">People {s.people.some((p) => p.commits) && <span className="suggest-note">from the git history</span>}
            {s.people.length > 1 && <button className="link-btn" onClick={() => void addPeople(s.people)}>Add all</button>}</div>
          <div className="chips">
            {s.people.map((p) => (
              <button key={p.name} className="tag add" title={p.commits ? `${p.commits} commits in this code` : undefined} onClick={() => void addPerson(p)}>
                <Plus size={12} /> {p.name}{p.role ? <span className="faint"> · {p.role}</span> : p.commits ? <span className="faint"> · {p.commits} commits</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
      {s.terms.length > 0 && (
        <div className="suggest-block">
          <div className="suggest-label">Glossary {s.terms.length > 1 && <button className="link-btn" onClick={() => void addTerms(s.terms)}>Add all</button>}</div>
          <div className="chips">
            {s.terms.map((t) => (
              <button key={t.canonical} className="tag add" title={t.heardAs.length ? `Heard as: ${t.heardAs.join(", ")}` : undefined} onClick={() => void addTerms([t])}>
                <Plus size={12} /> {t.canonical}{t.heardAs.length ? <span className="faint"> · {t.heardAs[0]}{t.heardAs.length > 1 ? "…" : ""}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
