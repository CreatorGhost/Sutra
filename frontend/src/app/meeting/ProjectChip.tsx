import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronDown, FolderClosed, Loader2, Plus } from "lucide-react";
import { api } from "../../local/sutra";
import { notifyDataChanged } from "../events";
import { Popover, friendlyError } from "../ui";
import { chipState, projectColor, projectName, type ProjectLike } from "../projects/model";

/** All projects, refreshed whenever app data changes. */
export function useProjects(version: number): any[] {
  const [projects, setProjects] = useState<any[]>([]);
  useEffect(() => {
    let alive = true;
    api.listProjects().then((ps) => { if (alive) setProjects(ps as any[]); }).catch(() => {});
    return () => { alive = false; };
  }, [version]);
  return projects;
}

/** The meeting's project in the meta row: mapped (with undo when Sutra mapped it), a suggestion to
 *  confirm, or "Add to project…". Mapping is always the user's call and re-runs minutes (facade). */
export function ProjectChip({ cid, conversation, projects, onError }: {
  cid: number; conversation: any; projects: ProjectLike[]; onError: (msg: string) => void;
}) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = chipState(conversation, projects);

  const run = async (fn: () => Promise<unknown>) => {
    setOpen(false); setBusy(true);
    try { await fn(); notifyDataChanged(); }
    catch (e) { onError(friendlyError(e)); }
    finally { setBusy(false); }
  };
  const map = (pid: number | null) => run(() => api.setConversationProject(cid, pid));
  const create = () => run(async () => {
    const pid = await api.createProject();
    await api.setConversationProject(cid, pid);
    nav(`/projects/${pid}?new=1`);
  });

  const current = state.kind === "mapped" ? state.project.id : null;
  const menu = (
    <>
      <div className="menu-scroll">
        {projects.map((p) => (
          <button key={p.id} role="menuitemradio" aria-checked={p.id === current} onClick={() => void map(p.id)}>
            <span style={{ width: 16 }}>{p.id === current ? <Check size={14} /> : null}</span>
            <span className="pdot" style={{ ["--pc" as any]: projectColor(p) }} />
            {projectName(p)}
          </button>
        ))}
      </div>
      {projects.length > 0 && <div className="sep" />}
      {current != null && <button onClick={() => { setOpen(false); nav(`/projects/${current}`); }}><span style={{ width: 16 }} />Open project</button>}
      {current != null && <button onClick={() => void map(null)}><span style={{ width: 16 }} />Remove from project</button>}
      <button onClick={() => void create()}><span style={{ width: 16 }}><Plus size={14} /></span>New project…</button>
    </>
  );

  if (state.kind === "suggested") {
    return (
      <span className="proj-chip">
        <span className="k">Project</span>
        <span className="mtag">
          Is this <span className="pdot" style={{ ["--pc" as any]: projectColor(state.project) }} />
          <span><b style={{ color: "var(--text)", fontWeight: 600 }}>{projectName(state.project)}</b>?</span>
        </span>
        {busy ? <Loader2 size={14} className="spin" /> : (
          <>
            <button className="link-btn" onClick={() => void run(() => api.confirmProjectSuggestion(cid, state.project.id))}>Yes</button>
            <button className="link-btn quiet" onClick={() => void run(() => api.dismissProjectSuggestion(cid))}>No</button>
          </>
        )}
      </span>
    );
  }

  return (
    <span className="proj-chip">
      <span className="k">Project</span>
      <Popover open={open} onOpenChange={setOpen} trigger={
        <button className="chip-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
          style={state.kind === "none" ? { color: "var(--text-2)" } : undefined}>
          {busy ? <Loader2 size={14} className="spin" />
            : state.kind === "mapped" ? <span className="pdot" style={{ ["--pc" as any]: projectColor(state.project) }} />
            : <FolderClosed size={14} />}
          {state.kind === "mapped" ? projectName(state.project) : "Add to project…"}
          <ChevronDown size={14} />
        </button>
      }>{menu}</Popover>
      {state.kind === "mapped" && state.auto && !busy && (
        <span className="faint">auto · <button className="link-btn quiet" style={{ fontSize: 13 }} onClick={() => void map(null)}>undo</button></span>
      )}
    </span>
  );
}
