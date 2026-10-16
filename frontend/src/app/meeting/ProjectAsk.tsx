// Right after a meeting stops: which project was it for? The answer shapes the notes (the project's
// brief, people and code folders), so they wait for it — or let Sutra decide after 90 s.
import { Sparkles, X } from "lucide-react";
import { useRecorder } from "../recorder";
import { projectColor, projectName } from "../projects/model";
import { useProjects } from "./ProjectChip";

export function ProjectAsk() {
  const { state, answerProject } = useRecorder();
  const projects = useProjects(state.askProject ? 1 : 0);
  if (!state.askProject) return null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="pa-title">
      <div className="sheet project-ask">
        <div className="sheet-head"><h2 id="pa-title">Which project was this meeting for?</h2></div>
        <p className="d">Its notes are written with that project's brief, people and code.</p>
        <div className="pa-list">
          {projects.map((p) => (
            <button key={p.id} className="btn" onClick={() => answerProject(p.id)}>
              <span className="pdot" style={{ ["--pc" as any]: projectColor(p) }} /> {projectName(p)}
            </button>
          ))}
        </div>
        <div className="actions">
          <button className="btn" onClick={() => answerProject(null)}><X size={14} /> No project</button>
          <button className="btn primary" onClick={() => answerProject(undefined)}><Sparkles size={14} /> Let Sutra decide</button>
        </div>
      </div>
    </div>
  );
}
