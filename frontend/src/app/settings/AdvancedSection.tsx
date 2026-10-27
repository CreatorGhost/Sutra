import { useEffect, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { api } from "../../local/sutra";
import { friendlyError } from "../ui";
import { Group, Row, SwitchRow, type SectionProps } from "./kit";

// Only the knobs the pipeline still reads: auto_minutes (extraction/people), rerank +
// rank_half_life_days + rank_w_importance (search), prior_half_life_days (your context ranking),
// training_optin (extraction capture). Everything else from the old Advanced page is gone from the logic.

function NumberRow({ title, desc, value, min, max, step, onSave }: { title: string; desc: string; value: number; min: number; max: number; step?: number; onSave: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || draft.trim() === "") { setDraft(String(value)); return; }
    const c = Math.min(max, Math.max(min, n));
    setDraft(String(c));
    if (c !== value) onSave(c);
  };
  return (
    <Row title={title} desc={desc}>
      <input type="number" min={min} max={max} step={step ?? 1} value={draft} aria-label={title}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
    </Row>
  );
}

export function AdvancedSection({ settings, put, toast }: SectionProps) {
  const [stats, setStats] = useState<{ samples: number; with_audio: number; edits: number } | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const reloadStats = async () => setStats(await api.training.stats() as any);
  useEffect(() => { void reloadStats().catch(() => {}); }, []);

  const num = (k: string, d: number) => { const n = Number(settings[k]); return Number.isFinite(n) && settings[k] != null && settings[k] !== "" ? n : d; };
  const rerank = settings["rerank"] === "llm" ? "llm" : "off";
  const optIn = !!settings["training_optin"];

  return (
    <>
      <Group label="Meetings">
        <SwitchRow title="Write minutes automatically" desc="When a recording is a meeting, Sutra writes formal minutes too. You can always make them by hand."
          checked={settings["auto_minutes"] !== false} onChange={(v) => void put({ auto_minutes: v })} />
        <SwitchRow title="Clean the transcript before the notes" desc="Fixes mishearings first, so the notes are written once from the cleaned text. Processing takes longer (several extra AI calls per meeting)."
          checked={settings["auto_clean"] === true} onChange={(v) => void put({ auto_clean: v })} />
      </Group>

      <Group label="Search">
        <Row title="Ranking" desc="Smarter re-reads the top results with the AI model. Slower.">
          <div className="mini-seg">
            <button aria-pressed={rerank === "off"} onClick={() => void put({ rerank: "off" })}>Standard</button>
            <button aria-pressed={rerank === "llm"} onClick={() => void put({ rerank: "llm" })}>Smarter</button>
          </div>
        </Row>
        <NumberRow title="Favor recent meetings" desc="Half-life in days: smaller means newer meetings rank higher."
          value={num("rank_half_life_days", 30)} min={1} max={365} onSave={(n) => void put({ rank_half_life_days: n })} />
        <NumberRow title="Favor important meetings" desc="0 ignores importance, 1 weighs it heavily."
          value={num("rank_w_importance", 0.5)} min={0} max={1} step={0.1} onSave={(n) => void put({ rank_w_importance: n })} />
      </Group>

      <Group label="Your context">
        <NumberRow title="How fast beliefs fade" desc="Half-life in days before an unconfirmed belief counts for half."
          value={num("prior_half_life_days", 60)} min={1} max={730} onSave={(n) => void put({ prior_half_life_days: n })} />
      </Group>

      <Group label="Improve Sutra" hint="Kept encrypted on this device and never uploaded. Export or wipe it any time.">
        <SwitchRow title="Keep training examples" desc="Saves transcripts with Sutra's notes and your corrections, to fine-tune models later. Text only."
          checked={optIn} onChange={(v) => void api.training.setTextOptIn(v).then(() => put({})).catch((e) => toast(friendlyError(e)))} />
        {(optIn || (stats?.samples ?? 0) > 0) && (
          confirmWipe ? (
            <Row title="Delete all training examples?" desc="This can't be undone.">
              <div className="actions">
                <button className="btn sm" onClick={() => setConfirmWipe(false)}>Cancel</button>
                <button className="btn sm danger" onClick={() => void api.training.wipe().then(reloadStats).then(() => { setConfirmWipe(false); toast("Training examples deleted"); })}>Delete</button>
              </div>
            </Row>
          ) : (
            <Row title={`${stats?.samples ?? 0} example${stats?.samples === 1 ? "" : "s"}`} desc={`${stats?.edits ?? 0} correction${stats?.edits === 1 ? "" : "s"}`}>
              <div className="actions">
                <button className="btn sm" disabled={!stats?.samples} onClick={() => void api.training.export("extraction").catch((e) => toast(friendlyError(e)))}><Download size={14} /> Export</button>
                <button className="icon-btn ghost sm" aria-label="Delete training examples" disabled={!stats?.samples} onClick={() => setConfirmWipe(true)}><Trash2 size={15} /></button>
              </div>
            </Row>
          )
        )}
      </Group>
    </>
  );
}
