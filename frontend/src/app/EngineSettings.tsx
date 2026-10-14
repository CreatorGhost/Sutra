// AI engine settings: which of the user's own agent CLIs writes summaries, notes, minutes, clean-ups,
// translations and answers. Detection (installed / signed in / models) comes from the main process.
import { useEffect, useState } from "react";
import { Check, Copy, RotateCw } from "lucide-react";
import { api } from "../local/sutra";
import { desktop, type AgentStatus } from "../desktop/bridge";
import { AGENTS, AGENT_IDS, agentReady, autoEngine, type AgentId } from "../shared/agentProtocol";
import { engineChoice } from "../providers";
import { EngineLogo } from "./engineLogos";
import "./engines.css";

export { autoEngine };

const rank = (s: AgentStatus) => (agentReady(s) ? 0 : s.installed ? 1 : 2);

export function EngineSettings({ settings, onChange, variant = "settings", onStatus }: {
  settings: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => Promise<void>;
  variant?: "settings" | "setup";
  onStatus?: (list: AgentStatus[]) => void;
}) {
  const choice = engineChoice(settings);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (refresh: boolean) => {
    if (!desktop) return;
    setBusy(true);
    try {
      const list = await desktop.ai.detect(refresh);
      setAgents(list);
      onStatus?.(list);
    } catch {
      setAgents([]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(false); }, []);

  if (!desktop) {
    return <p className="muted" style={{ fontSize: 14 }}>AI engines (Claude Code, Codex, Cursor, Gemini…) are available in the desktop app.</p>;
  }

  const auto = autoEngine(agents);
  const active: AgentId | null = choice.ai !== "auto" && choice.ai !== "cloud" ? choice.ai : auto?.id ?? null;
  const rows: AgentStatus[] = agents
    ? [...agents].sort((a, b) => rank(a) - rank(b))
    : AGENT_IDS.map((id) => ({ id, label: AGENTS[id].label } as AgentStatus));
  const activeInfo = active ? agents?.find((a) => a.id === active) : null;

  return (
    <div className="intel">
      <div className="eng-head">
        <div className="set-label">{variant === "setup" ? "On this computer" : "Notes & questions"}</div>
        <button className="eng-refresh" onClick={() => void load(true)} disabled={busy} aria-label="Check again">
          <RotateCw size={13} className={busy ? "spin" : ""} /> {busy ? "Checking…" : "Refresh"}
        </button>
      </div>
      <div className="set-card">
        {rows.map((st) => (
          <EngineRow key={st.id} st={agents ? st : null} id={st.id} active={active === st.id}
            model={String(settings[`ai_model_${st.id}`] ?? "")}
            onPick={() => void onChange({ ai_engine: st.id })}
            onModel={(m) => void onChange({ [`ai_model_${st.id}`]: m })} />
        ))}
      </div>
      {agents && !auto && choice.ai === "auto" ? (
        <p className="eng-foot">Install one of these and sign in, then press Refresh. Until then Sutra can record and transcribe, but can't write notes.</p>
      ) : activeInfo ? (
        <p className="eng-foot">
          {choice.ai === "auto" ? `Using ${activeInfo.label} — the first one that's ready. ` : ""}
          Runs with your own {activeInfo.label} sign-in, tools off, in an empty folder. Nothing goes through Sutra's servers. Search uses keywords.
        </p>
      ) : null}
    </div>
  );
}

function EngineRow({ st, id, active, model, onPick, onModel }: {
  st: AgentStatus | null; id: AgentId; active: boolean; model: string; onPick: () => void; onModel: (m: string) => void;
}) {
  const info = AGENTS[id];
  const copy = (t: string) => void api.copyText(t);
  // Install commands stay folded: most people use one or two of these, the rest is noise.
  const [showInstall, setShowInstall] = useState(false);
  const ready = !!st && agentReady(st);
  const state = !st ? "checking" : ready ? "ready" : st.installed ? "signin" : "missing";
  const status = {
    checking: "Checking…",
    ready: [st?.signedIn ? "Ready" : "Installed", st?.account, st?.version].filter(Boolean).join(" · "),
    signin: ["Sign in needed", st?.version].filter(Boolean).join(" · "),
    missing: "Not installed",
  }[state];

  return (
    <div className={`set-row engine${active ? " active" : ""}`}>
      <button className="radio" aria-pressed={active} aria-label={`Use ${info.label}`} disabled={!st?.installed} onClick={onPick}>
        {active ? <Check size={13} strokeWidth={3} /> : null}
      </button>
      <span className="eng-glyph" aria-hidden="true"><EngineLogo id={id} size={17} /></span>
      <div className="grow">
        <div className="t">{info.label}{info.vendor !== info.label && <span className="eng-vendor">{info.vendor}</span>}</div>
        <div className="d eng-status">
          <i className={`eng-dot ${state}`} />{status}
          {state === "missing" && (
            <button className="eng-link" aria-expanded={showInstall} onClick={() => setShowInstall((v) => !v)}>{showInstall ? "Hide" : "How to install"}</button>
          )}
        </div>
        {st && state === "missing" && showInstall && <Cmd text={st.install} label="install" onCopy={copy} />}
        {st && state === "signin" && <Cmd text={st.signIn} label="sign-in" onCopy={copy} />}
        {st && active && st.installed && (
          <label className="model-input">Model
            <input key={id} list={`models-${id}`} defaultValue={model} placeholder={st.defaultModel ? `default (${st.defaultModel})` : "default"}
              spellCheck={false} onBlur={(e) => { const v = e.target.value.trim(); if (v !== model) onModel(v); }} />
            <datalist id={`models-${id}`}>{st.models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
        )}
      </div>
    </div>
  );
}

function Cmd({ text, label, onCopy }: { text: string; label: string; onCopy: (t: string) => void }) {
  return (
    <div className="install">
      <code className="cmd">{text}</code>
      <button className="icon-btn sm ghost" onClick={() => onCopy(text)} aria-label={`Copy ${label} command`} title="Copy"><Copy size={13} /></button>
    </div>
  );
}
