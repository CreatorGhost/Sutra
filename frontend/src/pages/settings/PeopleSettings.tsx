import { useEffect, useState } from "react";
import { Users, UserPlus, Trash2, Loader2 } from "lucide-react";
import { api } from "../../local/sutra";
import { Chip, ErrorBar, isBenignError } from "../../components/ui";
import { tapHaptic } from "../../lib/nativeChrome";
import { Section, SwitchRow } from "../../components/settingsKit";

export default function PeopleSettings() {
  const [people, setPeople] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrollName, setEnrollName] = useState("");
  const [enrollMe, setEnrollMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [personDelete, setPersonDelete] = useState<number | null>(null);

  const reload = async () => {
    const [p] = await Promise.allSettled([api.listPeople()]);
    if (p.status === "fulfilled") setPeople(p.value);
    const fatal = [p].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    if (fatal && !isBenignError(fatal.reason?.message ?? String(fatal.reason))) {
      setError(fatal.reason?.message ?? String(fatal.reason));
    }
    setLoading(false);
  };
  useEffect(() => { reload().catch((e) => { setError(e.message); setLoading(false); }); }, []);

  const enroll = async () => {
    if (!enrollName.trim()) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("name", enrollName.trim());
      fd.append("is_me", String(enrollMe));
      await api.enroll(fd);
      setEnrollName(""); setEnrollMe(false);
      await reload();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="page fade-in">
      <p className="page-sub">The people Sutra recognizes by voice.</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      {loading && (
        <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 140 }} />)}</div>
      )}

      {!loading && (
      <Section icon={<Users size={16} color="var(--accent-2)" />} title="People">
        {people.length === 0 && <div className="faint" style={{ fontSize: "var(--fs-s)", marginBottom: 10 }}>No one enrolled yet. Enroll yourself first so Sutra always tags “me”.</div>}
        <div className="stack" style={{ marginBottom: 14 }}>
          {people.map((p) => (
            <div key={p.id} className="between">
              <div className="row" style={{ minWidth: 0, flex: 1 }}>
                <span className="trunc">{p.canonical_name}</span>
                {!!p.is_me && <Chip kind="me">me</Chip>}
                {!!p.provisional && <Chip>unnamed</Chip>}
              </div>
              {personDelete === p.id ? (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn danger sm" onClick={() => api.deletePerson(p.id).then(() => { setPersonDelete(null); reload(); }).catch((e: any) => setError(e.message))}>Delete</button>
                  <button className="btn ghost sm" onClick={() => setPersonDelete(null)}>Cancel</button>
                </div>
              ) : (
                <button className="btn ghost sm" onClick={() => { void tapHaptic(); setPersonDelete(p.id); }} aria-label={`Delete ${p.canonical_name}`}><Trash2 size={15} /></button>
              )}
            </div>
          ))}
        </div>
        <div className="divider" />
        <label className="field"><span>Name</span><input className="input" value={enrollName} onChange={(e) => setEnrollName(e.target.value)} placeholder="e.g. Amartya" /></label>
        <SwitchRow label="This is me" checked={enrollMe} onChange={setEnrollMe} />
        <div className="row">
          <button className="btn primary sm" onClick={enroll} disabled={busy || !enrollName.trim()}>{busy ? <Loader2 size={14} style={{ animation: "spin .8s linear infinite" }} /> : <UserPlus size={15} />} Enroll</button>
        </div>
        <div className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 8 }}>In Hybrid mode, name a speaker inside any conversation and Sutra learns their voiceprint to auto-recognize them next time. Enrolling here just reserves the name; the voiceprint is learned on first label.</div>
      </Section>
      )}
    </div>
  );
}
