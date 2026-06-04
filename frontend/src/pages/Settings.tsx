import { useEffect, useState } from "react";
import { UserPlus, Trash2, Mail, Shield, SlidersHorizontal, Users, Check, Loader2, Cloud, Smartphone, Database, Download, Languages } from "lucide-react";
import { api } from "../local/sutra";
import { MODE_COPY, type Mode, LANGS, type Lang } from "../providers";
import { rescheduleDailyRecap } from "../lib/recapScheduler";
import { fmtDate } from "../lib/format";
import { Chip, ErrorBar, isBenignError } from "../components/ui";

// Module-scoped so its identity is stable across renders — defining it INSIDE Settings made every
// keystroke remount the section and steal focus from inputs (one-char-then-blocked bug).
function Section({ icon, title, children }: any) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 14 }}>{icon}<strong>{title}</strong></div>
      {children}
    </div>
  );
}

export default function Settings() {
  const [people, setPeople] = useState<any[]>([]);
  const [cfg, setCfg] = useState<any>({});
  const [sessions, setSessions] = useState<any[]>([]);
  const [rollups, setRollups] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mode, setModeState] = useState<Mode>("hybrid");
  const [trainStats, setTrainStats] = useState<any>({ samples: 0, with_audio: 0, edits: 0 });
  const [enrollName, setEnrollName] = useState("");
  const [enrollMe, setEnrollMe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(null), 2500); };

  const reload = async () => {
    // allSettled: one failing endpoint degrades only its own section instead of rejecting the
    // whole batch and painting a full-page error over otherwise-healthy settings.
    const [p, c, s, r, md, ts] = await Promise.allSettled([
      api.listPeople(), api.getSettings(), api.listSessions(), api.rollups(), api.getMode(), api.training.stats(),
    ]);
    if (p.status === "fulfilled") setPeople(p.value);
    if (c.status === "fulfilled") setCfg(c.value);
    if (s.status === "fulfilled") setSessions(s.value);
    if (r.status === "fulfilled") setRollups(r.value);
    if (md.status === "fulfilled") setModeState(md.value as Mode);
    if (ts.status === "fulfilled") setTrainStats(ts.value);
    // Only surface a real, non-benign failure of the core settings/config read in the top banner.
    const fatal = [c, md].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
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
      <p className="page-sub">{notice ? <span className="chip ok"><Check size={12} /> {notice}</span> : saved ? <span className="chip ok"><Check size={12} /> saved</span> : "Everything is configurable and private to you."}</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      {loading && (
        <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 140 }} />)}</div>
      )}

      {!loading && (<>
      <Section icon={<Cloud size={16} color="var(--accent-2)" />} title="Capture mode">
        <div className="pill-toggle" style={{ display: "flex", marginBottom: 12 }}>
          {(["hybrid", "ondevice"] as Mode[]).map((m) => {
            const disabled = m === "ondevice"; // on-device models are Phase 3/4 (stub) — not selectable yet
            return (
              <button key={m} className={mode === m ? "on" : ""} disabled={disabled}
                title={disabled ? "On-device models ship later" : undefined}
                style={{ flex: 1, justifyContent: "center", opacity: disabled ? 0.45 : 1 }}
                onClick={() => { if (disabled) return; const prev = mode; setModeState(m); api.setMode(m).catch((e: any) => { setModeState(prev); setError(e.message); }); }}>
                {m === "hybrid" ? <Cloud size={14} /> : <Smartphone size={14} />} {MODE_COPY[m].label}
              </button>
            );
          })}
        </div>
        <div style={{ padding: "12px 14px", background: "var(--surface-2)", borderRadius: "var(--r-sm)" }}>
          <div className="row"><Shield size={14} color="var(--ok)" /><strong style={{ fontSize: 13 }}>Audio promise</strong></div>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{MODE_COPY[mode].audio}</div>
        </div>
        <div className="chip" style={{ marginTop: 8 }}>On-device mode ships in a later release — hybrid is the only mode today.</div>
      </Section>

      <Section icon={<Languages size={16} color="var(--accent-2)" />} title="Transcription language">
        <label className="field"><span>How your conversations are written down</span>
          <select className="input" value={(cfg.transcript_lang as Lang) || "english"} onChange={(e) => save({ transcript_lang: e.target.value })}>
            {(Object.keys(LANGS) as Lang[]).map((k) => <option key={k} value={k}>{LANGS[k].label}</option>)}
          </select>
          <span className="faint" style={{ fontSize: 12.5, marginTop: 6, display: "block" }}>{LANGS[(cfg.transcript_lang as Lang) || "english"].desc}</span>
          <span className="faint" style={{ fontSize: 12.5, marginTop: 4, display: "block", fontStyle: "italic" }}>{LANGS[(cfg.transcript_lang as Lang) || "english"].example}</span>
        </label>
      </Section>

      <Section icon={<Users size={16} color="var(--accent-2)" />} title="People">
        {people.length === 0 && <div className="faint" style={{ fontSize: 13, marginBottom: 10 }}>No one enrolled yet. Enroll yourself first so Sutra always tags “me”.</div>}
        <div className="stack" style={{ marginBottom: 14 }}>
          {people.map((p) => (
            <div key={p.id} className="between">
              <div className="row" style={{ minWidth: 0, flex: 1 }}>
                <span className="trunc">{p.canonical_name}</span>
                {p.is_me && <Chip kind="me">me</Chip>}
                {p.provisional && <Chip>unnamed</Chip>}
              </div>
              <button className="btn ghost sm" onClick={() => api.deletePerson(p.id).then(reload).catch((e: any) => setError(e.message))} aria-label={`Delete ${p.canonical_name}`}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        <div className="divider" />
        <label className="field"><span>Name</span><input className="input" value={enrollName} onChange={(e) => setEnrollName(e.target.value)} placeholder="e.g. Amartya" /></label>
        <label className="row" style={{ marginBottom: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={enrollMe} onChange={(e) => setEnrollMe(e.target.checked)} /> <span>This is me</span>
        </label>
        <div className="row">
          <button className="btn primary sm" onClick={enroll} disabled={busy || !enrollName.trim()}>{busy ? <Loader2 size={14} style={{ animation: "spin .8s linear infinite" }} /> : <UserPlus size={15} />} Enroll</button>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>In Hybrid mode, name a speaker inside any conversation and Sutra learns their voiceprint to auto-recognize them next time. Enrolling here just reserves the name; the voiceprint is learned on first label.</div>
      </Section>

      <Section icon={<Shield size={16} color="var(--ok)" />} title="Capture & privacy">
        <label className="field"><span>Speaker identification</span>
          <select className="input" value={mode === "hybrid" ? "auto" : "manual"} disabled>
            {mode === "hybrid"
              ? <option value="auto">Automatic — voiceprint (ECAPA)</option>
              : <option value="manual">Manual labeling</option>}
          </select>
          <span className="faint" style={{ fontSize: 12, marginTop: 5, display: "block" }}>
            {mode === "hybrid"
              ? "Speakers are grouped by voiceprint and matched to people you’ve named — name a speaker once and Sutra recognizes them in later conversations."
              : "On-device voiceprints ship later — in on-device mode, label speakers manually."}
          </span>
        </label>
        <label className="field"><span>Consent mode (unenrolled speakers)</span>
          <select className="input" value="off" disabled>
            <option value="off">Keep all</option>
          </select>
          <span className="faint" style={{ fontSize: 12, marginTop: 5, display: "block" }}>Auto-dropping/redacting turns from unknown speakers isn’t built yet — coming soon.</span>
        </label>
        <div className="faint" style={{ fontSize: 12.5 }}>Audio is processed in-flight and never written to disk.</div>
      </Section>

      <Section icon={<SlidersHorizontal size={16} color="var(--warn)" />} title="Models & ranking">
        <label className="field"><span>Extraction model</span>
          <input className="input" value="gpt-5.4-mini (server default)" disabled />
          <span className="faint" style={{ fontSize: 12, marginTop: 5, display: "block" }}>Set server-side; per-device override coming later.</span>
        </label>
        <label className="field"><span>Reranking</span>
          <select className="input" value={cfg.rerank === "llm" ? "llm" : "off"} onChange={(e) => save({ rerank: e.target.value })}>
            <option value="off">Off (RRF only)</option>
            <option value="llm">LLM rerank</option>
          </select>
        </label>
        <div className="row" style={{ gap: 10 }}>
          <label className="field" style={{ flex: 1 }}><span>Recency half-life (days)</span><input className="input" type="number" value={cfg.rank_half_life_days ?? 30} onChange={(e) => setCfg({ ...cfg, rank_half_life_days: e.target.value })} onBlur={(e) => save({ rank_half_life_days: Number(e.target.value) })} /></label>
          <label className="field" style={{ flex: 1 }}><span>Importance weight</span><input className="input" type="number" step="0.1" value={cfg.rank_w_importance ?? 0.5} onChange={(e) => setCfg({ ...cfg, rank_w_importance: e.target.value })} onBlur={(e) => save({ rank_w_importance: Number(e.target.value) })} /></label>
        </div>
      </Section>

      <Section icon={<Mail size={16} color="var(--accent-2)" />} title="Daily recap">
        <label className="row" style={{ marginBottom: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={!!cfg.recap_enabled} onChange={(e) => save({ recap_enabled: e.target.checked })} /> <span>Enabled</span>
        </label>
        <div className="row" style={{ gap: 10 }}>
          <label className="field" style={{ flex: 2 }}><span>Email to</span><input className="input" value={cfg.recap_to || ""} onChange={(e) => setCfg({ ...cfg, recap_to: e.target.value })} onBlur={(e) => save({ recap_to: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}><span>Time</span><input className="input" value={cfg.recap_time || "08:00"} onChange={(e) => setCfg({ ...cfg, recap_time: e.target.value })} onBlur={(e) => save({ recap_time: e.target.value })} /></label>
        </div>
        <button className="btn block" onClick={sendRecap} disabled={busy}>Send today’s recap now</button>
        <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>Fires daily on this device at the set time (a notification). The recap is generated when you open Sutra; email delivery is optional and needs SMTP configured.</div>
        {rollups.length > 0 && <div className="stack" style={{ marginTop: 12 }}>
          {rollups.slice(0, 5).map((r) => <div key={r.day} className="between"><span className="muted" style={{ fontSize: 13 }}>{r.day}</span>{r.emailed_at ? <Chip kind="ok">emailed</Chip> : <Chip>built</Chip>}</div>)}
        </div>}
      </Section>

      <Section icon={<Database size={16} color="var(--warn)" />} title="Improve Sutra (on-device training)">
        <div className="faint" style={{ fontSize: 12.5, marginBottom: 10 }}>
          Opt-in. Stored encrypted on your device only — never uploaded. Your corrections become training labels; export or wipe anytime.
        </div>
        <label className="row" style={{ marginBottom: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={!!cfg.training_optin} onChange={async (e) => { await api.training.setTextOptIn(e.target.checked); await reload(); }} /> <span>Capture transcripts + extractions (text)</span>
        </label>
        <label className="row" style={{ marginBottom: 12, cursor: "pointer", opacity: cfg.training_optin ? 1 : 0.5 }}>
          <input type="checkbox" checked={!!cfg.training_audio_optin} disabled={!cfg.training_optin} onChange={async (e) => { await api.training.setAudioOptIn(e.target.checked); await reload(); }} /> <span>Also keep audio for speech training (encrypted, on-device)</span>
        </label>
        <div className="row" style={{ gap: 7, flexWrap: "wrap", marginBottom: 10 }}>
          <Chip>{trainStats.samples} samples</Chip><Chip>{trainStats.edits} edits</Chip>{trainStats.with_audio > 0 && <Chip kind="warn">{trainStats.with_audio} with audio</Chip>}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn sm" onClick={() => api.training.export("extraction")}><Download size={14} /> Export extraction</button>
          <button className="btn sm" disabled={!trainStats.with_audio} onClick={() => api.training.export("asr")}><Download size={14} /> Export audio</button>
          {confirmWipe
            ? <><button className="btn danger sm" onClick={async () => { await api.training.wipe(); await reload(); setConfirmWipe(false); flash("Training data wiped."); }}><Trash2 size={14} /> Confirm wipe</button>
                <button className="btn sm" onClick={() => setConfirmWipe(false)}>Cancel</button></>
            : <button className="btn danger sm" onClick={() => setConfirmWipe(true)}><Trash2 size={14} /> Wipe</button>}
        </div>
      </Section>

      <Section icon={<Users size={16} className="faint" />} title="Sessions">
        {sessions.length === 0 ? <div className="faint" style={{ fontSize: 13 }}>No sessions yet.</div> :
          <div className="stack">{sessions.slice(0, 8).map((s) => (
            <div key={s.id} className="between"><span className="muted" style={{ fontSize: 13 }}>#{s.id} · {fmtDate(s.started_at)}</span><Chip>{s.turn_count} turns</Chip></div>
          ))}</div>}
      </Section>

      </>)}

      <p className="faint" style={{ textAlign: "center", fontSize: 12, marginTop: 8 }}>Sutra · transcripts & memory only, never audio.</p>
    </div>
  );
}
