import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, FolderClosed, Loader2, Plus } from "lucide-react";
import { api } from "../../local/sutra";
import { PROJECT_LABEL } from "../../local/repo";
import { useDataVersion } from "../events";
import { friendlyError } from "../ui";
import { meetingCounts, peopleLine, plural, projectColor, projectName } from "./model";
import "../features.css";

/** Every project: what it is, who's on it, how many terms and meetings it grounds. */
export function ProjectsPage() {
  const nav = useNavigate();
  const version = useDataVersion();
  const [projects, setProjects] = useState<any[] | null>(null);
  const [counts, setCounts] = useState<Map<number, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listProjects(), api.listConversations()])
      .then(([ps, convs]) => { if (alive) { setProjects(ps as any[]); setCounts(meetingCounts(convs as any[])); } })
      .catch((e) => { if (alive) { setError(friendlyError(e)); setProjects([]); } });
    return () => { alive = false; };
  }, [version]);

  const create = async () => {
    setBusy(true);
    try { nav(`/projects/${await api.createProject()}?new=1`); }
    catch (e) { setError(friendlyError(e)); setBusy(false); }
  };

  return (
    <>
      <div className="pane-top drag">
        <button className="icon-btn ghost sm back-btn" onClick={() => nav("/")} aria-label="Back"><ArrowLeft size={18} /></button>
        <div className="spacer" />
      </div>
      <div className="scroll">
        <div className="doc">
          <div className="page-head">
            <h1>{PROJECT_LABEL}</h1>
            {!!projects?.length && ( /* empty: the empty state has its own button */
              <button className="btn" onClick={() => void create()} disabled={busy}>
                {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} New project
              </button>
            )}
          </div>
          <p className="m-sub">A project's brief and glossary help Sutra spell names and terms right, and fix mishearings in transcripts and notes.</p>
          {error && <div className="notice err"><div className="grow">{error}</div></div>}

          {projects === null ? (
            [0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 64, margin: "14px 0" }} />)
          ) : projects.length === 0 ? (
            <div className="center" style={{ paddingTop: 60 }}>
              <div>
                <div className="hero-mark"><FolderClosed size={24} /></div>
                <p className="hero-title">No projects yet</p>
                <p className="hero-text">Group meetings by project, and teach Sutra the people and words that come up in them.</p>
                <button className="btn primary" onClick={() => void create()} disabled={busy}><Plus size={15} /> New project</button>
              </div>
            </div>
          ) : (
            <div className="plist">
              {projects.map((p) => {
                const terms = Array.isArray(p.terms) ? p.terms.length : 0;
                const meetings = counts.get(p.id) ?? 0;
                return (
                  <button key={p.id} className="prow" style={{ ["--pc" as any]: projectColor(p) }} onClick={() => nav(`/projects/${p.id}`)}>
                    <span className="pdot"><FolderClosed size={13} /></span>
                    <span className="grow">
                      <div className="name">{projectName(p)}</div>
                      {p.brief?.trim() && <div className="snip">{p.brief.trim()}</div>}
                      <div className="facts">
                        {[peopleLine(p.people_names ?? [], p.people_count ?? 0), plural(terms, "term"), plural(meetings, "meeting"),
                          p.context_enabled === false ? "Context off" : null].filter(Boolean).join(" · ")}
                      </div>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
