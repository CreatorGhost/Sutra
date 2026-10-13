// The engine + model switch inside an Ask bar: "Claude Code · sonnet ⌄". It edits the same settings as
// Settings → Intelligence (ai_engine, ai_model_<id>), so the next answer — and every later AI job —
// uses the pick. Desktop only: phone/web answer through the cloud.
import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { api } from "../local/sutra";
import { desktop, type AgentStatus } from "../desktop/bridge";
import { AGENTS, agentReady, safeModel, type AgentId } from "../shared/agentProtocol";
import { engineChoice } from "../providers";
import { autoEngine } from "./EngineSettings";
import { Popover } from "./ui";

const EVT = "sutra:engine";

export function EnginePicker() {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [open, setOpen] = useState(false);

  const loadSettings = () => { void api.getSettings().then((s) => setSettings(s as Record<string, unknown>)).catch(() => {}); };
  useEffect(() => {
    if (!desktop) return;
    loadSettings();
    void desktop.ai.detect().then(setAgents).catch(() => setAgents([]));
    // Keep every picker (meeting Ask bar, Ask Sutra) in step.
    window.addEventListener(EVT, loadSettings);
    return () => window.removeEventListener(EVT, loadSettings);
  }, []);

  if (!desktop || !agents) return null;
  const ready = agents.filter(agentReady);
  const choice = engineChoice(settings);
  const active: AgentStatus | null = (choice.ai !== "auto" && choice.ai !== "cloud" ? ready.find((a) => a.id === choice.ai) : null) ?? autoEngine(agents);
  const modelOf = (id: AgentId) => safeModel(settings[`ai_model_${id}`]);

  const pick = async (id: AgentId, model?: string | null) => {
    const patch: Record<string, unknown> = { ai_engine: id };
    if (model !== undefined) patch[`ai_model_${id}`] = model ?? "";
    await api.putSettings(patch);
    setSettings((s) => ({ ...s, ...patch }));
    window.dispatchEvent(new Event(EVT));
    setOpen(false);
  };

  const model = active ? modelOf(active.id) : null;
  const label = active ? AGENTS[active.id].label : "No AI engine";

  return (
    <Popover open={open} onOpenChange={setOpen} trigger={
      <button type="button" className="engine-chip" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        aria-label={`AI engine: ${label}${model ? `, model ${model}` : ""}`} title="Switch AI engine or model">
        <span className="eng-glyph sm" aria-hidden="true">{active ? AGENTS[active.id].initials : "?"}</span>
        <span className="engine-chip-name">{label}</span>
        {active && <span className="engine-chip-model">{model || active.defaultModel || "default"}</span>}
        <ChevronDown size={14} />
      </button>
    }>
      <div className="engine-menu">
        <div className="menu-label">Answer with</div>
        {ready.length === 0 && <div className="menu-empty">No engine is signed in on this computer.</div>}
        <div className="menu-scroll">
          {ready.map((a) => {
            const on = active?.id === a.id;
            const cur = modelOf(a.id);
            const models = [...new Set([...(a.models ?? []), ...(cur ? [cur] : [])])];
            return (
              <div key={a.id} className="engine-group">
                <button role="menuitemradio" aria-checked={on} onClick={() => void pick(a.id)}>
                  <span className="eng-glyph sm" aria-hidden="true">{AGENTS[a.id].initials}</span>
                  <span className="grow">{AGENTS[a.id].label}</span>
                  {a.account && <span className="hint">{a.account}</span>}
                  {on && <Check size={15} />}
                </button>
                {on && (
                  <div className="engine-models">
                    <button role="menuitemradio" aria-checked={!cur} onClick={() => void pick(a.id, null)}>
                      <span className="grow">Default{a.defaultModel ? ` (${a.defaultModel})` : ""}</span>{!cur && <Check size={14} />}
                    </button>
                    {models.map((m) => (
                      <button key={m} role="menuitemradio" aria-checked={cur === m} onClick={() => void pick(a.id, m)}>
                        <span className="grow">{m}</span>{cur === m && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="sep" />
        <button onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent("sutra:open-settings", { detail: "intelligence" })); }}>
          <span className="grow muted">Manage engines…</span>
        </button>
      </div>
    </Popover>
  );
}
