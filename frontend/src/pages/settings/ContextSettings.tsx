import { useEffect, useState } from "react";
import { Brain, Check, Trash2, UserPlus, Sparkles, Pencil, Replace, Plus } from "lucide-react";
import { api } from "../../local/sutra";
import { Chip, ErrorBar, isBenignError } from "../../components/ui";
import { Section, SwitchRow } from "../../components/settingsKit";

// "Your Context" — surface DECAY (how fresh a belief is), never a raw number. We re-derive the same
// half-life recency the repo uses (0.5^(ageDays/halfLife)) from last_confirmed_at (falling back to
// created_at) and bucket it into a human label. A prior never re-confirmed slowly slides to "Stale".
const PRIOR_KINDS = ["person", "project", "org", "role", "topic", "goal", "pref"] as const;
type PriorKind = (typeof PRIOR_KINDS)[number];

function priorFreshness(p: any, halfLifeDays: number): { label: string; kind: string } {
  const ts: string | undefined = p.last_confirmed_at || p.created_at;
  if (!ts) return { label: "New", kind: "ok" };
  const t = Date.parse(String(ts).includes("T") ? ts : String(ts).replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return { label: "Strong", kind: "ok" };
  const ageDays = (Date.now() - t) / 86400000;
  const rec = Math.pow(0.5, ageDays / Math.max(0.5, halfLifeDays)); // 1 = fresh, ->0 = old
  if (rec >= 0.66) return { label: "Strong", kind: "ok" };
  if (rec >= 0.33) return { label: "Fading", kind: "warn" };
  return { label: "Stale", kind: "" };
}

export default function ContextSettings() {
  const [cfg, setCfg] = useState<any>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  // "Your Context" (priors)
  const [priors, setPriors] = useState<any[]>([]);
  const [priorEdit, setPriorEdit] = useState<number | null>(null);          // id being edited in-place
  const [priorEditDraft, setPriorEditDraft] = useState<{ subject: string; value: string }>({ subject: "", value: "" });
  const [priorSupersede, setPriorSupersede] = useState<number | null>(null); // id being superseded
  const [supersedeDraft, setSupersedeDraft] = useState<{ subject: string; value: string }>({ subject: "", value: "" });
  const [newPrior, setNewPrior] = useState<{ subject: string; value: string; kind: PriorKind }>({ subject: "", value: "", kind: "pref" });
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(null), 2500); };

  const reload = async () => {
    const [c, pr] = await Promise.allSettled([api.getSettings(), api.listPriors()]);
    if (c.status === "fulfilled") setCfg(c.value);
    if (pr.status === "fulfilled") setPriors(pr.value as any[]);
    const fatal = [c].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    if (fatal && !isBenignError(fatal.reason?.message ?? String(fatal.reason))) {
      setError(fatal.reason?.message ?? String(fatal.reason));
    }
    setLoading(false);
  };
  useEffect(() => { reload().catch((e) => { setError(e.message); setLoading(false); }); }, []);

  const save = async (patch: Record<string, unknown>) => {
    const prev = cfg;
    setCfg((c: any) => ({ ...c, ...patch }));
    try { await api.putSettings(patch); setSaved(true); setTimeout(() => setSaved(false), 1500); }
    catch (e: any) { setCfg(prev); setError(e.message); }
  };

  // --- "Your Context" (priors) actions. All local-only; reload after each so the list reflects the
  //     new status/decay. Errors degrade to the section banner without losing the rest of Settings. ---
  const priorAction = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await reload(); } catch (e: any) { setError(e.message); }
  };
  const startEditPrior = (p: any) => { setPriorSupersede(null); setPriorEdit(p.id); setPriorEditDraft({ subject: p.subject ?? "", value: p.value ?? "" }); };
  const saveEditPrior = async (id: number) => {
    if (!priorEditDraft.subject.trim()) return;
    await priorAction(() => api.editPrior(id, { subject: priorEditDraft.subject.trim(), value: priorEditDraft.value.trim() || null }));
    setPriorEdit(null);
  };
  const startSupersede = (p: any) => { setPriorEdit(null); setPriorSupersede(p.id); setSupersedeDraft({ subject: p.subject ?? "", value: "" }); };
  const saveSupersede = async (old: any) => {
    if (!supersedeDraft.subject.trim()) return;
    await priorAction(() => api.supersedePrior(old.id, {
      kind: old.kind, entity_id: old.entity_id ?? null, subject: supersedeDraft.subject.trim(),
      value: supersedeDraft.value.trim() || null, provenance: "user", status: "confirmed",
    }));
    setPriorSupersede(null);
  };
  const addPrior = async () => {
    if (!newPrior.subject.trim()) return;
    await priorAction(() => api.addPrior({
      kind: newPrior.kind, subject: newPrior.subject.trim(), value: newPrior.value.trim() || null,
      provenance: "user", status: "confirmed", confidence: 0.8, last_confirmed_at: new Date().toISOString(),
    }));
    setNewPrior({ subject: "", value: "", kind: "pref" });
    flash("Fact added to your context.");
  };

  return (
    <div className="page fade-in">
      <p className="page-sub">{notice ? <span className="chip ok"><Check size={12} /> {notice}</span> : saved ? <span className="chip ok"><Check size={12} /> saved</span> : "What Sutra knows about your world — and how it fades."}</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      {loading && (
        <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 140 }} />)}</div>
      )}

      {!loading && (
      <Section icon={<Brain size={16} color="var(--accent-2)" />} title="Your Context">
        <SwitchRow
          label="Use my context in answers"
          caption="Lets Sutra lean on what it knows about you and the people, projects and goals in your life when it answers. These are beliefs, not facts — they fade unless they keep coming up."
          checked={cfg.context_enabled !== false}
          onChange={(checked) => save({ context_enabled: checked })}
        />

        {(() => {
          const halfLife = Number(cfg.prior_half_life_days ?? 60) || 60;
          // Hide superseded/dismissed rows from the active list; the old belief is preserved in the DB.
          const active = priors.filter((p) => p.superseded_by == null && p.status !== "dismissed");
          if (!active.length) {
            return <div className="faint" style={{ fontSize: "var(--fs-s)", padding: "12px 2px 4px" }}>Nothing here yet. As you keep talking, Sutra will suggest things it notices about your world — and you can add a fact yourself below.</div>;
          }
          return (
            <div className="stack" style={{ marginTop: 12, gap: 12 }}>
              {active.map((p) => {
                const fresh = priorFreshness(p, halfLife);
                const fromYou = p.provenance === "user";
                const editing = priorEdit === p.id;
                const superseding = priorSupersede === p.id;
                return (
                  <div key={p.id} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
                    {editing ? (
                      <div className="stack" style={{ gap: 8 }}>
                        <label className="field" style={{ margin: 0 }}><span>What it's about</span>
                          <input className="input" value={priorEditDraft.subject} onChange={(e) => setPriorEditDraft({ ...priorEditDraft, subject: e.target.value })} /></label>
                        <label className="field" style={{ margin: 0 }}><span>Detail (optional)</span>
                          <input className="input" value={priorEditDraft.value} onChange={(e) => setPriorEditDraft({ ...priorEditDraft, value: e.target.value })} /></label>
                        <div className="row" style={{ gap: 8 }}>
                          <button className="btn primary sm" onClick={() => saveEditPrior(p.id)} disabled={!priorEditDraft.subject.trim()}><Check size={14} /> Save</button>
                          <button className="btn ghost sm" onClick={() => setPriorEdit(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : superseding ? (
                      <div className="stack" style={{ gap: 8 }}>
                        <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>Replace this with what's true now. The old version is kept but no longer used.</div>
                        <label className="field" style={{ margin: 0 }}><span>What it's about</span>
                          <input className="input" value={supersedeDraft.subject} onChange={(e) => setSupersedeDraft({ ...supersedeDraft, subject: e.target.value })} /></label>
                        <label className="field" style={{ margin: 0 }}><span>Detail (optional)</span>
                          <input className="input" value={supersedeDraft.value} onChange={(e) => setSupersedeDraft({ ...supersedeDraft, value: e.target.value })} placeholder="e.g. now leads the design team" /></label>
                        <div className="row" style={{ gap: 8 }}>
                          <button className="btn primary sm" onClick={() => saveSupersede(p)} disabled={!supersedeDraft.subject.trim()}><Replace size={14} /> Replace</button>
                          <button className="btn ghost sm" onClick={() => setPriorSupersede(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (<>
                      <div className="between" style={{ alignItems: "flex-start", gap: 10 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontWeight: 650, fontSize: "var(--fs-body)", overflowWrap: "anywhere" }}>{p.subject}</div>
                          {p.value && <div className="muted" style={{ fontSize: "var(--fs-s)", marginTop: 2, overflowWrap: "anywhere" }}>{p.value}</div>}
                        </div>
                        <Chip>{p.kind}</Chip>
                      </div>
                      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                        <Chip kind={fresh.kind}>{fresh.label}</Chip>
                        <Chip kind={fromYou ? "me" : ""}>{fromYou ? <><UserPlus size={11} /> You added this</> : <><Sparkles size={11} /> Suggested from your conversations</>}</Chip>
                      </div>
                      <SwitchRow
                        label="Allow in cloud answers"
                        caption="When sharing is on, this can be sent along with your question to help answer it in Hybrid mode. Off keeps it on this device."
                        checked={!!p.share_cloud}
                        onChange={(checked) => priorAction(() => api.setPriorShareCloud(p.id, checked))}
                      />
                      <div className="row" style={{ gap: 7, flexWrap: "wrap", marginTop: 4 }}>
                        {p.status !== "confirmed" && <button className="btn sm" onClick={() => priorAction(() => api.confirmPrior(p.id))}><Check size={14} /> Confirm</button>}
                        <button className="btn ghost sm" onClick={() => startEditPrior(p)}><Pencil size={14} /> Edit</button>
                        <button className="btn ghost sm" onClick={() => startSupersede(p)}><Replace size={14} /> Supersede</button>
                        <button className="btn ghost sm" onClick={() => priorAction(() => api.dismissPrior(p.id))}><Trash2 size={14} /> Dismiss</button>
                      </div>
                    </>)}
                  </div>
                );
              })}
            </div>
          );
        })()}

        <div className="divider" />
        <div className="faint" style={{ fontSize: "var(--fs-xs)", marginBottom: 8 }}>Add a fact</div>
        <label className="field"><span>What it's about</span>
          <input className="input" value={newPrior.subject} onChange={(e) => setNewPrior({ ...newPrior, subject: e.target.value })} placeholder="e.g. Priya" /></label>
        <label className="field"><span>Detail (optional)</span>
          <input className="input" value={newPrior.value} onChange={(e) => setNewPrior({ ...newPrior, value: e.target.value })} placeholder="e.g. my manager" /></label>
        <label className="field"><span>Type</span>
          <select className="input" value={newPrior.kind} onChange={(e) => setNewPrior({ ...newPrior, kind: e.target.value as PriorKind })}>
            {PRIOR_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <div className="row">
          <button className="btn primary sm" onClick={addPrior} disabled={!newPrior.subject.trim()}><Plus size={15} /> Add fact</button>
        </div>
      </Section>
      )}
    </div>
  );
}
