// AI engine settings: which of the user's own agent CLIs writes summaries, notes, minutes, clean-ups,
// translations and answers. Detection (installed / signed in / models) comes from the main process.
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, RotateCw, SlidersHorizontal } from "lucide-react";
import { api } from "../local/sutra";
import { desktop, type AgentStatus } from "../desktop/bridge";
import { AGENTS, AGENT_IDS, agentReady, autoEngine, type AgentId } from "../shared/agentProtocol";
import { engineChoice } from "../providers";
import { EngineLogo } from "./engineLogos";
import { carryContext, engineOptions, listedModel, modelContext } from "./modelPicker";
import { withContext, type ContextOption } from "../shared/engineProbes";
import "./engines.css";

export { autoEngine };

const rank = (s: AgentStatus) => (agentReady(s) ? 0 : s.installed ? 1 : 2);

export function EngineSettings({ settings, onChange, variant = "settings", onStatus, onChoosing, onSkip }: {
  settings: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => Promise<void>;
  variant?: "settings" | "setup";
  onStatus?: (list: AgentStatus[]) => void;
  /** True while the "which AIs do you use?" chooser is showing (setup hides its own buttons then). */
  onChoosing?: (choosing: boolean) => void;
  /** Setup only: leave first-run setup without picking an engine. */
  onSkip?: () => void;
}) {
  const choice = engineChoice(settings);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  // The engines the user uses (after ViewCode's onboarding): only these CLIs are ever checked.
  // undefined = still loading; null = never chosen (older installs keep checking all of them).
  const [enabled, setEnabled] = useState<AgentId[] | null | undefined>(undefined);
  const [choosing, setChoosingState] = useState(false);
  const setChoosing = (v: boolean) => { setChoosingState(v); onChoosing?.(v); };

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
  useEffect(() => {
    if (!desktop) return;
    void desktop.prefs.get().then((p) => {
      const ids = p.enabledEngines ?? null;
      setEnabled(ids);
      // First run: ask before running anyone's CLI.
      if (ids === null && variant === "setup") setChoosing(true);
      else void load(false);
    }).catch(() => { setEnabled(null); void load(false); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveChoice = async (ids: AgentId[]) => {
    await desktop!.prefs.set({ enabledEngines: ids });
    setEnabled(ids);
    setAgents(null);
    setChoosing(false);
    await load(true);
  };

  if (!desktop) {
    return <p className="muted" style={{ fontSize: 14 }}>AI engines (Claude Code, Codex, Cursor, Gemini…) are available in the desktop app.</p>;
  }

  if (enabled === undefined) return null;
  if (choosing) {
    return <EngineChooser initial={enabled ?? []} variant={variant} onSave={(ids) => void saveChoice(ids)} onCancel={enabled === null && variant === "setup" ? undefined : () => setChoosing(false)} onSkip={onSkip} />;
  }

  const auto = autoEngine(agents);
  const active: AgentId | null = choice.ai !== "auto" && choice.ai !== "cloud" ? choice.ai : auto?.id ?? null;
  const rows: AgentStatus[] = agents
    ? [...agents].sort((a, b) => rank(a) - rank(b))
    : (enabled ?? AGENT_IDS).map((id) => ({ id, label: AGENTS[id].label } as AgentStatus));
  const activeInfo = active ? agents?.find((a) => a.id === active) : null;

  return (
    <div className="intel">
      <div className="eng-head">
        <div className="set-label">{variant === "setup" ? "On this computer" : "Notes & questions"}</div>
        <div className="eng-head-actions">
          <button className="eng-refresh" onClick={() => setChoosing(true)}><SlidersHorizontal size={13} /> Choose AIs</button>
          <button className="eng-refresh" onClick={() => void load(true)} disabled={busy} aria-label="Check again">
            <RotateCw size={13} className={busy ? "spin" : ""} /> {busy ? "Checking…" : "Refresh"}
          </button>
        </div>
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

/** "Which AI do you use?" — tick the engines; nothing is run until you continue, and only those are checked. */
function EngineChooser({ initial, variant, onSave, onCancel, onSkip }: {
  initial: AgentId[]; variant: "settings" | "setup"; onSave: (ids: AgentId[]) => void; onCancel?: () => void; onSkip?: () => void;
}) {
  const [picked, setPicked] = useState<Set<AgentId>>(() => new Set(initial));
  const toggle = (id: AgentId) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="intel">
      <div className="set-label">{variant === "setup" ? "Pick the ones you have" : "AIs Sutra can use"}</div>
      <div className="eng-choose" role="group" aria-label="AI engines">
        {AGENT_IDS.map((id) => {
          const on = picked.has(id);
          return (
            <button key={id} type="button" className={`eng-tile${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggle(id)}>
              <span className="eng-glyph" aria-hidden="true"><EngineLogo id={id} size={17} /></span>
              <span className="eng-tile-text">
                <span className="eng-tile-name">{AGENTS[id].label}</span>
                <span className="eng-vendor">{AGENTS[id].vendor}</span>
              </span>
              <span className="eng-tick" aria-hidden="true">{on && <Check size={12} strokeWidth={3} />}</span>
            </button>
          );
        })}
      </div>
      <div className={`eng-choose-actions${variant === "setup" ? " setup-actions" : ""}`}>
        {onCancel ? <button className="btn" onClick={onCancel}>Cancel</button> : onSkip && <button className="btn" onClick={onSkip}>Skip for now</button>}
        <button className="btn primary" disabled={picked.size === 0} onClick={() => onSave(AGENT_IDS.filter((id) => picked.has(id)))}>
          {variant === "setup" ? "Continue" : "Save"}
        </button>
      </div>
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
          <div className="model-input">Model <ModelSelect key={id} st={st} model={model} onModel={onModel} /></div>
        )}
        {st && active && st.installed && model && <ContextRow st={st} model={model} onModel={onModel} />}
      </div>
    </div>
  );
}

/** The engine's models as name + id (after ViewCode's model list); free text still works for ids we don't list. */
function ModelSelect({ st, model, onModel }: { st: AgentStatus; model: string; onModel: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const options = engineOptions(st, model || null);
  const listed = listedModel(st, model || null) ?? "";
  const cur = options.find((o) => (o.model ?? "") === listed) ?? options[0];
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const pick = (m: string) => { setOpen(false); if (m !== listed) onModel(m ? carryContext(st, model || null, m) : m); };

  return (
    <div className="ms" ref={ref} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" className="ms-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ms-name">{cur.name}</span>
        <code className="ms-id">{cur.model ?? cur.hint ?? ""}</code>
        <ChevronDown size={14} className="engine-chip-caret" />
      </button>
      {open && (
        <div className="ms-pop">
          <div className="mp-list" role="listbox" aria-label="Models">
            {options.map((o) => {
              const sel = o.key === cur.key;
              return (
                <div key={o.key} role="option" aria-selected={sel} tabIndex={0} className={`mp-row${sel ? " sel" : ""}`}
                  onClick={() => pick(o.model ?? "")} onKeyDown={(e) => { if (e.key === "Enter") pick(o.model ?? ""); }}>
                  <div className="mp-name">{o.name}<code className="ms-id">{o.model ?? (o.hint ? `uses ${o.hint}` : "the CLI's own choice")}</code></div>
                  {sel && <Check size={14} className="mp-check" />}
                </div>
              );
            })}
          </div>
          <input className="ms-custom" value={custom} placeholder="Other model id…" spellCheck={false} aria-label="Other model id"
            onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && custom.trim()) pick(custom.trim()); }} />
        </div>
      )}
    </div>
  );
}

/** The context window, for models that offer a choice (Cursor: 300K or 1M). Sutra defaults to 300K —
 *  plenty for meeting notes; 1M is there for very long transcripts. */
function ContextRow({ st, model, onModel }: { st: AgentStatus; model: string; onModel: (m: string) => void }) {
  const ctx = modelContext(st, model);
  if (ctx.choices.length < 2) return null;
  return (
    <div className="model-input">Context <ContextSwitch choices={ctx.choices} value={ctx.value} onPick={(v) => onModel(withContext(model, v))} /></div>
  );
}

export function ContextSwitch({ choices, value, onPick }: { choices: ContextOption[]; value: string | null; onPick: (v: string) => void }) {
  return (
    <div className="ctx-seg" role="radiogroup" aria-label="Context window">
      {choices.map((c) => (
        <button key={c.value} type="button" role="radio" aria-checked={c.value === value} className={c.value === value ? "on" : ""}
          onClick={() => { if (c.value !== value) onPick(c.value); }}>
          {c.label}
        </button>
      ))}
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
