import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderGit2, Plus, ChevronRight, Check } from "lucide-react";
import { api } from "../../local/sutra";
import { PROJECT_LABEL } from "../../local/repo";
import { Empty, ErrorBar, SkeletonList, isBenignError } from "../../components/ui";

// Initials for an avatar chip — first letter of the first two words, uppercased.
const initials = (name?: string | null) => {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
};

// Projects hub — lists user-authored, per-project context. Read-first: tap a TILE to open its detail,
// or "New project" to create + open a blank one. On-device only in v1; no provider needed here.
export default function ProjectsHub() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const [p] = await Promise.allSettled([api.listProjects()]);
    if (p.status === "fulfilled") setProjects(p.value as any[]);
    const fatal = [p].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    if (fatal && !isBenignError(fatal.reason?.message ?? String(fatal.reason))) {
      setError(fatal.reason?.message ?? String(fatal.reason));
    }
    setLoading(false);
  };
  useEffect(() => { reload().catch((e) => { setError(e.message); setLoading(false); }); }, []);

  const create = async () => {
    setBusy(true); setError(null);
    try {
      const id = await api.createProject();
      navigate(`/settings/projects/${id}`);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  return (
    <div className="page fade-in">
      <p className="page-sub">A project teaches Sutra a meeting's world — it names your people, spells your terms right, and attributes who said what. Authored once, used on this device only.</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      {loading && <SkeletonList rows={3} bar={false} />}

      {!loading && projects.length === 0 && (
        <Empty
          icon={<FolderGit2 size={26} color="var(--muted)" style={{ marginBottom: 8 }} />}
          title={`No ${PROJECT_LABEL.toLowerCase()} yet`}
          hint="Create one to ground a meeting in its tools, people and naming."
        />
      )}

      {!loading && projects.length > 0 && (
        <div className="project-grid">
          {projects.map((p, i) => {
            const names: string[] = p.people_names ?? [];
            const termCount = Array.isArray(p.terms) ? p.terms.length : 0;
            const on = p.context_enabled !== false;
            return (
              <button
                key={p.id}
                className="card tap project-tile stagger-rise"
                style={{ ["--i" as any]: Math.min(i, 6) }}
                onClick={() => navigate(`/settings/projects/${p.id}`)}
              >
                <div className="project-tile-head">
                  <span className="project-glyph" style={{ color: p.color || "var(--accent-2)" }}><FolderGit2 size={16} /></span>
                  <strong className="trunc">{p.name?.trim() || "Untitled project"}</strong>
                  <ChevronRight size={16} className="faint project-chev" />
                </div>
                <p className="project-snippet">
                  {p.brief?.trim()
                    || (termCount > 0 ? `${termCount} term${termCount === 1 ? "" : "s"} so cleanups spell them right.`
                      : "Add people and terms to ground this meeting's memories.")}
                </p>
                <div className="project-tile-foot">
                  {names.length > 0 ? (
                    <span className="project-people">
                      <span className="avatar-row" aria-hidden="true">
                        {names.slice(0, 3).map((n, k) => (
                          <span key={k} className="avatar" title={n}>{initials(n)}</span>
                        ))}
                        {p.people_count > 3 && <span className="avatar more">+{p.people_count - 3}</span>}
                      </span>
                      <span className="project-people-count">{p.people_count} {p.people_count === 1 ? "person" : "people"}</span>
                    </span>
                  ) : (
                    <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>No people yet</span>
                  )}
                  {on && (
                    <span className="context-on" aria-label="Context on">
                      <Check size={11} /> Context on
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {!loading && (
        <div className="row" style={{ marginTop: 16, justifyContent: "center" }}>
          <button className="btn sm" onClick={create} disabled={busy}>
            <Plus size={15} /> New project
          </button>
        </div>
      )}
    </div>
  );
}
