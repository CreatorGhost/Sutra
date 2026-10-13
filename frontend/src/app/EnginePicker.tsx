// The model picker in the Ask bars, after ViewCode's: a rail of engines (favorites first), a search
// field, and one row per model with its engine underneath. It edits the same settings as Settings →
// Intelligence (ai_engine, ai_model_<id>), so the next answer — and every later AI job — uses the pick.
// Desktop only: phone/web answer through the cloud.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Settings2, Star } from "lucide-react";
import { api } from "../local/sutra";
import { desktop, isMacDesktop, type AgentStatus } from "../desktop/bridge";
import { AGENTS, agentReady, safeModel, type AgentId } from "../shared/agentProtocol";
import { engineChoice } from "../providers";
import { autoEngine } from "./EngineSettings";
import { EngineLogo } from "./engineLogos";
import { FAVORITES_KEY, optionKey, parseFavorites, prettyModel, toggleFavorite, visibleOptions, type ModelOption } from "./modelPicker";

const EVT = "sutra:engine";
const MOD = isMacDesktop ? "⌘" : "Ctrl+";
type Tab = "favorites" | AgentId;

export function EnginePicker() {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    const load = () => { void api.getSettings().then((s) => setSettings(s as Record<string, unknown>)).catch(() => {}); };
    load();
    void desktop.ai.detect().then(setAgents).catch(() => setAgents([]));
    // Keep every picker (meeting Ask bar, Ask Sutra) in step.
    window.addEventListener(EVT, load);
    return () => window.removeEventListener(EVT, load);
  }, []);

  if (!desktop || !agents) return null;
  const choice = engineChoice(settings);
  const ready = agents.filter(agentReady);
  const active = (choice.ai !== "auto" && choice.ai !== "cloud" ? ready.find((a) => a.id === choice.ai) : null) ?? autoEngine(agents);
  const model = active ? safeModel(settings[`ai_model_${active.id}`]) : null;

  const save = async (patch: Record<string, unknown>) => {
    await api.putSettings(patch);
    setSettings((s) => ({ ...s, ...patch }));
    window.dispatchEvent(new Event(EVT));
  };

  return (
    <div className="mp-wrap">
      <button type="button" className="engine-chip" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}
        title="Switch AI engine or model" aria-label={active ? `AI: ${AGENTS[active.id].label}${model ? `, ${prettyModel(model)}` : ""}` : "No AI engine"}>
        {active ? <EngineLogo id={active.id} size={15} /> : <span className="engine-chip-dot" />}
        <span className="engine-chip-name">{active ? (model ? prettyModel(model) : AGENTS[active.id].label) : "No AI engine"}</span>
        <ChevronDown size={14} className="engine-chip-caret" />
      </button>
      {open && (
        <PickerPanel agents={agents} settings={settings} activeId={active?.id ?? null} activeModel={model}
          onClose={() => setOpen(false)}
          onPick={(o) => { setOpen(false); void save({ ai_engine: o.engine, [`ai_model_${o.engine}`]: o.model ?? "" }); }}
          onFavorite={(key) => void save({ [FAVORITES_KEY]: toggleFavorite(parseFavorites(settings[FAVORITES_KEY]), key) })} />
      )}
    </div>
  );
}

function PickerPanel({ agents, settings, activeId, activeModel, onClose, onPick, onFavorite }: {
  agents: AgentStatus[]; settings: Record<string, unknown>; activeId: AgentId | null; activeModel: string | null;
  onClose: () => void; onPick: (o: ModelOption) => void; onFavorite: (key: string) => void;
}) {
  const favorites = parseFavorites(settings[FAVORITES_KEY]);
  const [tab, setTab] = useState<Tab>(() => (favorites.length ? "favorites" : activeId ?? "favorites"));
  const [query, setQuery] = useState("");
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const selectedKey = activeId ? optionKey(activeId, activeModel) : null;

  const rows = useMemo(() => visibleOptions({ agents, settings, tab, query }), [agents, settings, tab, query]);
  const tabAgent = tab === "favorites" ? null : agents.find((a) => a.id === tab) ?? null;
  // Rail: engines that work first, then the rest (dimmed — they explain how to set up).
  const rail = [...agents].sort((a, b) => Number(agentReady(b)) - Number(agentReady(a)));

  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => { setHl(Math.max(0, rows.findIndex((r) => r.key === selectedKey))); }, [tab, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${hl}"]`)?.scrollIntoView({ block: "nearest" }); }, [hl]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const o = rows[Number(e.key) - 1];
      if (o) { e.preventDefault(); onPick(o); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setHl((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHl((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[hl]) onPick(rows[hl]); }
  };

  const openSettings = () => { onClose(); window.dispatchEvent(new CustomEvent("sutra:open-settings", { detail: "intelligence" })); };

  return (
    <div className="mp" ref={ref} role="dialog" aria-label="Select model" onKeyDown={onKey}>
      <nav className="mp-rail" aria-label="Engines">
        <RailButton on={tab === "favorites" && !query} label="Favorites" onClick={() => { setQuery(""); setTab("favorites"); }}>
          <Star size={15} fill="currentColor" />
        </RailButton>
        <div className="mp-rail-sep" />
        {rail.map((a) => (
          <RailButton key={a.id} on={tab === a.id && !query} dim={!agentReady(a)} onClick={() => { setQuery(""); setTab(a.id); }}
            label={`${AGENTS[a.id].label}${agentReady(a) ? "" : a.installed ? " — sign in" : " — not installed"}`}>
            <EngineLogo id={a.id} size={17} />
          </RailButton>
        ))}
        <div className="grow" />
        <RailButton label="Manage engines" onClick={openSettings}><Settings2 size={15} /></RailButton>
      </nav>
      <div className="mp-main">
        <label className="mp-search">
          <Search size={14} />
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models…" aria-label="Search models" spellCheck={false} />
        </label>
        <div className="mp-list" ref={list} role="listbox" aria-label="Models">
          {tabAgent && !agentReady(tabAgent) && !query ? (
            <SetupHint st={tabAgent} onManage={openSettings} />
          ) : rows.length === 0 ? (
            <div className="mp-empty">
              {query ? "No models match." : tab === "favorites" ? <>Star a model to keep it here.</> : "This engine didn't report any models."}
            </div>
          ) : rows.map((o, i) => {
            const fav = favorites.includes(o.key);
            const sel = o.key === selectedKey;
            return (
              <div key={o.key} data-i={i} role="option" aria-selected={sel} tabIndex={-1}
                className={`mp-row${i === hl ? " hl" : ""}${sel ? " sel" : ""}`}
                onMouseMove={() => setHl(i)} onClick={() => onPick(o)}>
                <div className="mp-row-main">
                  <div className="mp-name">
                    {o.name}
                    {o.hint && <span className="mp-hint">{o.hint}</span>}
                  </div>
                  <div className="mp-sub"><EngineLogo id={o.engine} size={12} />{AGENTS[o.engine].label}</div>
                </div>
                {sel && <Check size={14} className="mp-check" />}
                {i < 9 && <kbd className="mp-kbd">{MOD}{i + 1}</kbd>}
                <button type="button" className={`mp-star${fav ? " on" : ""}`} aria-label={fav ? "Remove from favorites" : "Add to favorites"}
                  onClick={(e) => { e.stopPropagation(); onFavorite(o.key); }}>
                  <Star size={14} fill={fav ? "currentColor" : "none"} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RailButton({ on, dim, label, onClick, children }: { on?: boolean; dim?: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`mp-rail-btn${on ? " on" : ""}${dim ? " dim" : ""}`} onClick={onClick} aria-pressed={on} aria-label={label} title={label}>
      {children}
    </button>
  );
}

function SetupHint({ st, onManage }: { st: AgentStatus; onManage: () => void }) {
  const cmd = st.installed ? st.signIn : st.install;
  return (
    <div className="mp-setup">
      <EngineLogo id={st.id} size={22} />
      <div className="mp-setup-title">{AGENTS[st.id].label} {st.installed ? "needs you to sign in" : "isn't installed"}</div>
      <div className="mp-setup-text">{st.installed ? "Run once in a terminal:" : "Install it with:"}</div>
      {cmd && <code className="mp-cmd">{cmd}</code>}
      <button type="button" className="btn sm" onClick={onManage}>Open engine settings</button>
    </div>
  );
}
