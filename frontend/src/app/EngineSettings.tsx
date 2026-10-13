// AI engine settings: which engine writes summaries, notes, minutes, clean-ups and answers.
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api } from "../local/sutra";
import { desktop, type AgentStatus } from "../desktop/bridge";
import { AGENTS, type AgentId } from "../shared/agentProtocol";
import { engineChoice } from "../providers";

export function EngineSettings({ settings, onChange }: { settings: Record<string, unknown>; onChange: (patch: Record<string, unknown>) => Promise<void> }) {
  const choice = engineChoice(settings);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  useEffect(() => {
    if (!desktop) return;
    void desktop.ai.detect().then(setAgents).catch(() => setAgents([]));
  }, []);
  if (!desktop) {
    return <p className="muted" style={{ fontSize: 14 }}>Local AI agents (Claude Code, Codex, Cursor…) are available in the desktop app.</p>;
  }
  const copy = (t: string) => void api.copyText(t);

  return (
    <div className="intel">
      <div className="set-label">Notes & questions</div>
      <div className="set-card">
        <EngineRow id="cloud" active={choice.ai === "cloud"} title="Sutra cloud" detail="Fastest. Also powers semantic search." onPick={() => void onChange({ ai_engine: "cloud" })} />
        {(Object.keys(AGENTS) as AgentId[]).map((id) => {
          const st = agents?.find((a) => a.id === id);
          return (
            <EngineRow key={id} id={id} active={choice.ai === id} title={AGENTS[id].label}
              detail={agents === null ? "Checking…" : st?.path ? `Installed${st.version ? ` · ${st.version}` : ""}` : "Not found"}
              disabled={!st?.path} onPick={() => void onChange({ ai_engine: id })}>
              {!st?.path && agents !== null && (
                <>
                  <div className="install"><code className="cmd">{AGENTS[id].install}</code><button className="icon-btn sm ghost" onClick={() => copy(AGENTS[id].install)} aria-label="Copy install command"><Copy size={13} /></button></div>
                  <div className="d">{AGENTS[id].signIn}</div>
                </>
              )}
              {choice.ai === id && st?.path && (
                <label className="model-input">Model
                  <input list={`models-${id}`} defaultValue={String(settings[`ai_model_${id}`] ?? "")} placeholder="default"
                    onBlur={(e) => void onChange({ [`ai_model_${id}`]: e.target.value.trim() })} />
                  <datalist id={`models-${id}`}>{AGENTS[id].models.map((m) => <option key={m} value={m} />)}</datalist>
                </label>
              )}
            </EngineRow>
          );
        })}
      </div>
      {choice.ai !== "cloud" && (
        <p className="muted" style={{ fontSize: 13, margin: "8px 2px 0" }}>
          Uses your own {AGENTS[choice.ai as AgentId].label} sign-in, with tools off, in an empty folder. Search uses keywords with a local agent.
        </p>
      )}
    </div>
  );
}

function EngineRow({ active, title, detail, disabled, onPick, children }: {
  id: string; active: boolean; title: string; detail: string; disabled?: boolean; onPick: () => void; children?: React.ReactNode;
}) {
  return (
    <div className={`set-row engine${active ? " active" : ""}`}>
      <button className="radio" aria-pressed={active} aria-label={`Use ${title}`} disabled={disabled} onClick={onPick}>{active ? <Check size={13} strokeWidth={3} /> : null}</button>
      <div className="grow">
        <div className="t">{title}</div>
        <div className="d">{detail}</div>
        {children}
      </div>
    </div>
  );
}
