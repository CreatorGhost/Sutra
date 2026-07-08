import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal, Database, Users, Download, Trash2, Check, Save, Upload } from "lucide-react";
import { api } from "../../local/sutra";
import { fmtDate } from "../../lib/format";
import { exportBackup, importBackup } from "../../lib/backup";
import { Chip, ErrorBar, isBenignError } from "../../components/ui";
import { Section, SwitchRow } from "../../components/settingsKit";

export default function AdvancedSettings() {
  const [cfg, setCfg] = useState<any>({});
  const [sessions, setSessions] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [trainStats, setTrainStats] = useState<any>({ samples: 0, with_audio: 0, edits: 0 });
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(null), 2500); };
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);

  const doExport = async () => {
    try { await exportBackup(); flash("Backup saved."); }
    catch (e: any) { if (!isBenignError(e?.message)) setError(e?.message ?? String(e)); }
  };
  const doImport = async () => {
    if (!pendingFile) return;
    setRestoring(true);
    try {
      await importBackup(pendingFile);
      // Success: rebuild the whole app against the restored DB. The cached connection is gone.
      window.location.reload();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setPendingFile(null);
      setRestoring(false);
    }
  };

  const reload = async () => {
    const [c, s, ts] = await Promise.allSettled([api.getSettings(), api.listSessions(), api.training.stats()]);
    if (c.status === "fulfilled") setCfg(c.value);
    if (s.status === "fulfilled") setSessions(s.value);
    if (ts.status === "fulfilled") setTrainStats(ts.value);
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

  return (
    <div className="page fade-in">
      <p className="page-sub">{notice ? <span className="chip ok"><Check size={12} /> {notice}</span> : saved ? <span className="chip ok"><Check size={12} /> saved</span> : "Models, ranking, on-device training and your sessions."}</p>
      <ErrorBar message={error} onDismiss={() => setError(null)} />

      {loading && (
        <div className="stack">{[1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 140 }} />)}</div>
      )}

      {!loading && (<>
      <Section icon={<SlidersHorizontal size={16} color="var(--warn)" />} title="Models & ranking">
        <div className="field">
          <div className="between"><span>Extraction model</span><Chip>Server default</Chip></div>
          <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 5, display: "block" }}>Set server-side; per-device override coming later.</span>
        </div>
        {/* Raw ranking knobs are developer-grade — keep them collapsed behind an Advanced
            disclosure so the default Settings view stays consumer-friendly. */}
        <details>
          <summary className="faint" style={{ fontSize: "var(--fs-s)", cursor: "pointer", userSelect: "none", marginTop: 4 }}>Advanced</summary>
          <div style={{ marginTop: 12 }}>
            <label className="field"><span>Reranking</span>
              <select className="input" value={cfg.rerank === "llm" ? "llm" : "off"} onChange={(e) => save({ rerank: e.target.value })}>
                <option value="off">Standard</option>
                <option value="llm">Smarter (slower)</option>
              </select>
            </label>
            <div className="row" style={{ gap: 10 }}>
              <label className="field" style={{ flex: 1 }}><span>Recency half-life (days)</span><input className="input" type="number" min={1} max={365} value={cfg.rank_half_life_days ?? 30} onChange={(e) => setCfg({ ...cfg, rank_half_life_days: e.target.value })} onBlur={(e) => save({ rank_half_life_days: Number(e.target.value) })} /></label>
              <label className="field" style={{ flex: 1 }}><span>Importance weight</span><input className="input" type="number" min={0} max={1} step="0.1" value={cfg.rank_w_importance ?? 0.5} onChange={(e) => setCfg({ ...cfg, rank_w_importance: e.target.value })} onBlur={(e) => save({ rank_w_importance: Number(e.target.value) })} /></label>
            </div>
          </div>
        </details>
      </Section>

      <Section icon={<Database size={16} color="var(--warn)" />} title="Improve Sutra (on-device training)">
        <div className="faint" style={{ fontSize: "var(--fs-xs)", marginBottom: 10 }}>
          Opt-in. Stored encrypted on your device only — never uploaded. Your corrections become training labels; export or wipe anytime.
        </div>
        <SwitchRow label="Capture transcripts + extractions" caption="Text labels only; raw audio remains off." checked={!!cfg.training_optin} onChange={async (checked) => { await api.training.setTextOptIn(checked); await reload(); }} />
        {/* Audio-training opt-in is HIDDEN until the audio capture path (training.captureAudio) is
            actually wired. Showing it today would imply audio is kept on-device when it never is —
            audio stays in-flight only. The underlying setting plumbing (api.training.setAudioOptIn)
            is left intact; only the UI control is hidden. */}
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

      <Section icon={<Save size={16} color="var(--warn)" />} title="Backup & restore">
        <div className="faint" style={{ fontSize: "var(--fs-xs)", marginBottom: 10 }}>
          A reinstall wipes everything on this device — there's no automatic cloud copy. Keep your own backup so you can bring your memory back.
        </div>
        <div className="field">
          <button className="btn sm" onClick={doExport}><Save size={14} /> Save a backup</button>
          <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 6, display: "block" }}>
            Your full memory as a single file you keep. Anyone with this file can read it — store it safely.
          </span>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0] ?? null; setPendingFile(f); e.target.value = ""; }}
          />
          {!pendingFile
            ? <button className="btn sm" onClick={() => fileRef.current?.click()}><Upload size={14} /> Restore from a backup</button>
            : <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span className="muted" style={{ fontSize: "var(--fs-s)" }}>Replace everything on this device with the backup?</span>
                <button className="btn danger sm" disabled={restoring} onClick={doImport}><Upload size={14} /> {restoring ? "Restoring…" : "Replace everything"}</button>
                <button className="btn sm" disabled={restoring} onClick={() => setPendingFile(null)}>Cancel</button>
              </div>}
          <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 6, display: "block" }}>
            Restoring overwrites the conversations, people and context on this device, then restarts the app.
          </span>
        </div>
      </Section>

      <Section icon={<Users size={16} className="faint" />} title="Sessions">
        {sessions.length === 0 ? <div className="faint" style={{ fontSize: "var(--fs-s)" }}>No sessions yet.</div> :
          <div className="stack">{sessions.slice(0, 8).map((s) => (
            <div key={s.id} className="between"><span className="muted" style={{ fontSize: "var(--fs-s)" }}>#{s.id} · {fmtDate(s.started_at)}</span><Chip>{s.turn_count} turns</Chip></div>
          ))}</div>}
      </Section>
      </>)}
    </div>
  );
}
