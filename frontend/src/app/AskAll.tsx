import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, ChevronDown, FolderClosed, FolderCode, Loader2, Sparkles } from "lucide-react";
import { api } from "../local/sutra";
import { shortDate } from "./format";
import { friendlyError } from "./ui";
import { EnginePicker } from "./EnginePicker";

interface Turn { q: string; a?: string; supported?: boolean; citations?: { conversation_id: number; title: string; date: string | null }[] }

/** "Ask Sutra" across every meeting — grounded answers with links back to the meetings they came from. */
export function AskAll() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const initial = params.get("q") ?? "";
  // Ask about one project (?project=<id>): its meetings, its brief, and its linked code folders.
  const projectParam = Number(params.get("project"));
  const [projectId, setProjectId] = useState<number | null>(Number.isInteger(projectParam) && projectParam > 0 ? projectParam : null);
  const [projects, setProjects] = useState<any[]>([]);
  useEffect(() => { void api.listProjects().then((ps) => setProjects(ps as any[])).catch(() => {}); }, []);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");

  const ask = async (question: string) => {
    question = question.trim();
    if (!question) return;
    const history = turns.flatMap((t) => (t.a ? [{ role: "user", content: t.q }, { role: "assistant", content: t.a }] : []));
    setTurns((xs) => [...xs, { q: question }]);
    let res: Turn;
    try {
      const r: any = await api.chat(question, history, projectId);
      res = { q: question, a: r.answer, supported: r.supported, citations: r.citations };
    } catch (e) { res = { q: question, a: friendlyError(e), supported: false }; }
    setTurns((xs) => xs.map((x) => (x.q === question && !x.a ? res : x)));
  };

  useEffect(() => {
    if (initial) { setTurns([]); void ask(initial); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  return (
    <>
      <div className="pane-top drag">
        <button className="icon-btn ghost sm back-btn" onClick={() => nav("/")} aria-label="Back"><ArrowLeft size={18} /></button>
      </div>
      <div className="scroll">
        <div className="doc">
          <h1 className="m-title" style={{ display: "flex", alignItems: "center", gap: 10 }}><Sparkles size={24} /> Ask Sutra</h1>
          <p className="m-sub">
            {project
              ? <>Answers from <b>{project.name || "this project"}</b>’s meetings{project.folder_count && project.code_access ? " and its code" : ""}, with links to where they were said.</>
              : "Answers come only from your own meetings, with links to where they were said."}
          </p>
          {turns.map((t, i) => (
            <section key={i} className="sec">
              <h3 style={{ marginTop: 0 }}>{t.q}</h3>
              {t.a === undefined ? <p className="muted"><Loader2 size={14} className="spin" /> {project?.folder_count && project.code_access ? "Searching meetings and code…" : "Searching your meetings…"}</p> : <p style={{ whiteSpace: "pre-wrap" }}>{t.a}</p>}
              {!!t.citations?.length && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  {t.citations.map((c) => (
                    <Link key={c.conversation_id} className="tag" style={{ textDecoration: "none", paddingRight: 10 }} to={`/m/${c.conversation_id}`}>
                      {c.title}{c.date ? ` · ${shortDate(c.date)}` : ""}
                    </Link>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
      <div className="pane-fade" />
      <div className="askbar">
        <form className="ask-input" onSubmit={(e) => { e.preventDefault(); const v = q; setQ(""); if (!turns.length) setParams({ q: v, ...(projectId ? { project: String(projectId) } : {}) }); else void ask(v); }}>
          <Sparkles size={17} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask anything about your meetings…" aria-label="Ask Sutra" autoFocus={!initial} />
          {projects.length > 0 && <ProjectScope projects={projects} value={projectId} onChange={setProjectId} />}
          <EnginePicker />
        </form>
      </div>
    </>
  );
}

/** Which meetings Ask looks at: all of them, or one project's (with its code, when folders are linked). */
function ProjectScope({ projects, value, onChange }: { projects: any[]; value: number | null; onChange: (id: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const cur = projects.find((p) => p.id === value) ?? null;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const pick = (id: number | null) => { setOpen(false); onChange(id); };
  const Icon = (p: any) => (p?.folder_count && p.code_access ? FolderCode : FolderClosed);
  const CurIcon = Icon(cur);
  return (
    <div className="mp-wrap scope" ref={ref} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" className="engine-chip" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        title="Ask about all meetings or one project" aria-label={cur ? `Asking about ${cur.name || "a project"}` : "Asking about all meetings"}>
        <CurIcon size={15} />
        <span className="engine-chip-name">{cur ? cur.name || "Untitled project" : "All meetings"}</span>
        <ChevronDown size={14} className="engine-chip-caret" />
      </button>
      {open && (
        <div className="scope-pop" role="listbox" aria-label="Ask about">
          {[null, ...projects].map((p) => {
            const sel = (p?.id ?? null) === value;
            const PIcon = p ? Icon(p) : Sparkles;
            return (
              <div key={p?.id ?? "all"} role="option" aria-selected={sel} tabIndex={0} className={`mp-row${sel ? " sel" : ""}`}
                onClick={() => pick(p?.id ?? null)} onKeyDown={(e) => { if (e.key === "Enter") pick(p?.id ?? null); }}>
                <PIcon size={14} />
                <div className="mp-row-main">
                  <div className="mp-name">{p ? p.name || "Untitled project" : "All meetings"}</div>
                  {p?.folder_count > 0 && p.code_access ? <div className="mp-sub">Meetings + code</div> : null}
                </div>
                {sel && <Check size={14} className="mp-check" />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
