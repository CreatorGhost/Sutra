import { useEffect, useState } from "react";
import { Cloud, Shield, Smartphone, Languages, FileText, Check } from "lucide-react";
import { api } from "../../local/sutra";
import { MODE_COPY, type Mode, LANGS, type Lang } from "../../providers";
import { Chip, ErrorBar, isBenignError } from "../../components/ui";
import { Section, SwitchRow } from "../../components/settingsKit";

export default function CaptureSettings() {
  const [cfg, setCfg] = useState<any>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mode, setModeState] = useState<Mode>("hybrid");

  const reload = async () => {
    const [c, md] = await Promise.allSettled([api.getSettings(), api.getMode()]);
    if (c.status === "fulfilled") setCfg(c.value);
    if (md.status === "fulfilled") setModeState(md.value as Mode);
    const fatal = [c, md].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
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

  return (
    <div className="page fade-in">
      <p className="page-sub">{saved ? <span className="chip ok"><Check size={12} /> saved</span> : "Choose how recordings are processed and written down."}</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      {loading && (
        <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 140 }} />)}</div>
      )}

      {!loading && (<>
      <Section icon={<Cloud size={16} color="var(--accent-2)" />} title="Capture mode">
        <div className="pill-toggle" role="radiogroup" aria-label="Capture mode" style={{ display: "flex", marginBottom: 12 }}>
          {(["hybrid", "ondevice"] as Mode[]).map((m) => {
            const disabled = m === "ondevice"; // on-device models are Phase 3/4 (stub) — not selectable yet
            return (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} disabled={disabled}
                title={disabled ? "On-device models ship later" : undefined}
                style={{ flex: 1, justifyContent: "center", opacity: disabled ? 0.45 : 1 }}
                onClick={() => { if (disabled) return; const prev = mode; setModeState(m); api.setMode(m).catch((e: any) => { setModeState(prev); setError(e.message); }); }}>
                {m === "hybrid" ? <Cloud size={14} /> : <Smartphone size={14} />} {MODE_COPY[m].label}
              </button>
            );
          })}
        </div>
        <div style={{ padding: "12px 14px", background: "var(--surface-2)", borderRadius: "var(--r-sm)" }}>
          <div className="row"><Shield size={14} color="var(--ok)" /><strong style={{ fontSize: "var(--fs-s)" }}>Audio promise</strong></div>
          <div className="muted" style={{ fontSize: "var(--fs-s)", marginTop: 4 }}>{MODE_COPY[mode].audio}</div>
        </div>
      </Section>

      <Section icon={<Languages size={16} color="var(--accent-2)" />} title="Transcription language">
        <label className="field"><span>How your conversations are written down</span>
          <select className="input" value={(cfg.transcript_lang as Lang) || "english"} onChange={(e) => save({ transcript_lang: e.target.value })}>
            {(Object.keys(LANGS) as Lang[]).map((k) => <option key={k} value={k}>{LANGS[k].label}</option>)}
          </select>
          <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 6, display: "block" }}>{LANGS[(cfg.transcript_lang as Lang) || "english"].desc}</span>
          <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 4, display: "block", fontStyle: "italic" }}>{LANGS[(cfg.transcript_lang as Lang) || "english"].example}</span>
        </label>
      </Section>

      <Section icon={<FileText size={16} color="var(--accent-2)" />} title="Meetings">
        <SwitchRow
          label="Auto-generate minutes"
          caption="When a recording looks like a meeting, Sutra writes minutes automatically. You can also generate them by hand on any conversation."
          checked={cfg.auto_minutes !== false}
          onChange={(checked) => save({ auto_minutes: checked })}
        />
      </Section>

      <Section icon={<Shield size={16} color="var(--ok)" />} title="Capture & privacy">
        <div className="field">
          <div className="between"><span>Speaker identification</span>
            {mode === "hybrid" ? <Chip kind="ok">Automatic</Chip> : <Chip>Manual labeling</Chip>}
          </div>
          <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 5, display: "block" }}>
            {mode === "hybrid"
              ? "Speakers are grouped by voiceprint and matched to people you’ve named — name a speaker once and Sutra recognizes them in later conversations."
              : "On-device voiceprints ship later — in on-device mode, label speakers manually."}
          </span>
        </div>
        <div className="field">
          <div className="between"><span>Consent mode (unenrolled speakers)</span><Chip>Coming soon</Chip></div>
          <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 5, display: "block" }}>Auto-dropping/redacting turns from unknown speakers isn’t built yet — coming soon.</span>
        </div>
        <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>Audio is processed in-flight and never written to disk.</div>
      </Section>
      </>)}
    </div>
  );
}
