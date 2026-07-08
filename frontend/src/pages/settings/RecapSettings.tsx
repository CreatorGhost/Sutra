import { useEffect, useState } from "react";
import { Mail, Check } from "lucide-react";
import { api } from "../../local/sutra";
import { rescheduleDailyRecap } from "../../lib/recapScheduler";
import { Chip, ErrorBar, isBenignError } from "../../components/ui";
import { Section, SwitchRow } from "../../components/settingsKit";

export default function RecapSettings() {
  const [cfg, setCfg] = useState<any>({});
  const [rollups, setRollups] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(null), 2500); };

  const reload = async () => {
    const [c, r] = await Promise.allSettled([api.getSettings(), api.rollups()]);
    if (c.status === "fulfilled") setCfg(c.value);
    if (r.status === "fulfilled") setRollups(r.value);
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
    try {
      await api.putSettings(patch); setSaved(true); setTimeout(() => setSaved(false), 1500);
      // Re-apply the daily recap schedule when its settings change (native; no-op on web).
      if ("recap_enabled" in patch || "recap_time" in patch) rescheduleDailyRecap().catch(() => {});
    }
    catch (e: any) { setCfg(prev); setError(e.message); }
  };

  const sendRecap = async () => {
    setBusy(true); setError(null);
    try { const r = await api.runRecap(); await reload(); flash(r.emailed ? "Recap emailed." : "Recap built (configure SMTP to email it)."); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="page fade-in">
      <p className="page-sub">{notice ? <span className="chip ok"><Check size={12} /> {notice}</span> : saved ? <span className="chip ok"><Check size={12} /> saved</span> : "A daily summary of what you talked about."}</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      {loading && (
        <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 140 }} />)}</div>
      )}

      {!loading && (
      <Section icon={<Mail size={16} color="var(--accent-2)" />} title="Daily recap">
        <SwitchRow label="Enabled" checked={!!cfg.recap_enabled} onChange={(checked) => save({ recap_enabled: checked })} />
        <div className="row" style={{ gap: 10 }}>
          <label className="field" style={{ flex: 2 }}><span>Email to</span><input className="input" value={cfg.recap_to || ""} onChange={(e) => setCfg({ ...cfg, recap_to: e.target.value })} onBlur={(e) => save({ recap_to: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}><span>Time</span><input className="input" value={cfg.recap_time || "08:00"} onChange={(e) => setCfg({ ...cfg, recap_time: e.target.value })} onBlur={(e) => save({ recap_time: e.target.value })} /></label>
        </div>
        <button className="btn block" onClick={sendRecap} disabled={busy}>Send today’s recap now</button>
        <div className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 8 }}>Fires daily on this device at the set time (a notification). The recap is generated when you open Sutra; email delivery is optional and needs SMTP configured.</div>
        {rollups.length > 0 && <div className="stack" style={{ marginTop: 12 }}>
          {rollups.slice(0, 5).map((r) => <div key={r.day} className="between"><span className="muted" style={{ fontSize: "var(--fs-s)" }}>{r.day}</span>{r.emailed_at ? <Chip kind="ok">emailed</Chip> : <Chip>built</Chip>}</div>)}
        </div>}
      </Section>
      )}
    </div>
  );
}
