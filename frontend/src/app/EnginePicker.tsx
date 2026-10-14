// The model picker in the Ask bars, after ViewCode's: a rail of engines (favorites first), a search
// field, and one row per model with its engine underneath. It edits the same settings as Settings →
// Intelligence (ai_engine, ai_model_<id>), so the next answer — and every later AI job — uses the pick.
// On a phone paired with a Mac it lists the Mac's engines and saves the pick on the phone
// (paired_ai_engine / paired_ai_model); the Mac's own setting is left alone. Elsewhere phone/web
// answer through the cloud, and there's no picker.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Settings2, Star } from "lucide-react";
import { api } from "../local/sutra";
import { desktop, isMacDesktop, type AgentStatus } from "../desktop/bridge";
import { AGENTS, agentReady, safeModel, type AgentId } from "../shared/agentProtocol";
import { engineChoice } from "../providers";
import { autoEngine, ContextSwitch } from "./EngineSettings";
import { EngineLogo } from "./engineLogos";
import { agentsFromHost, carryContext, FAVORITES_KEY, listedModel, modelContext, modelName, optionKey, parseFavorites, toggleFavorite, visibleOptions, type ModelOption } from "./modelPicker";
import { pickContext, withContext, type ContextOption } from "../shared/engineProbes";
import { PAIRED_ENGINE_KEY, PAIRED_MODEL_KEY, pairedAiChoice } from "../pairing/model";
import { useMac } from "../pairing/runtime";

/** Fired when the engine pick changes, so every picker re-reads it. */
export const ENGINE_EVENT = "sutra:engine";
const EVT = ENGINE_EVENT;
const MOD = isMacDesktop ? "⌘" : "Ctrl+";
type Tab = "favorites" | AgentId;

/** What the picker shows and where a pick is saved. */
interface EngineSource {
  agents: AgentStatus[];
  /** For the option list: favorites, and ai_model_<id> for the current pick. */
  settings: Record<string, unknown>;
  active: AgentStatus | null;
  model: string | null;
  /** The engines run on the paired Mac (set up there, not here). */
  remote: boolean;
  pick(o: ModelOption): void;
  /** Set the active model's context window (Cursor: 300K / 1M). */
  context(value: string): void;
  favorite(key: string): void;
}

/** The id to save for a picked row: within the same engine, the context window carries over. */
const pickedModel = (agents: AgentStatus[], o: ModelOption, activeId: AgentId | null, current: string | null) => {
  const st = agents.find((a) => a.id === o.engine);
  return !o.model ? "" : st && o.engine === activeId ? carryContext(st, current, o.model) : o.model;
};

function useEngineSource(): EngineSource | null {
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const mac = useMac();

  useEffect(() => {
    const load = () => { void api.getSettings().then((s) => setSettings(s as Record<string, unknown>)).catch(() => {}); };
    load();
    if (desktop) void desktop.ai.detect().then(setAgents).catch(() => setAgents([]));
    // Keep every picker (meeting Ask bar, Ask Sutra) in step.
    window.addEventListener(EVT, load);
    return () => window.removeEventListener(EVT, load);
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    await api.putSettings(patch);
    setSettings((s) => ({ ...s, ...patch }));
    window.dispatchEvent(new Event(EVT));
  };
  const favorite = (key: string) => void save({ [FAVORITES_KEY]: toggleFavorite(parseFavorites(settings[FAVORITES_KEY]), key) });

  if (desktop) {
    if (!agents) return null;
    const choice = engineChoice(settings);
    const ready = agents.filter(agentReady);
    const active = (choice.ai !== "auto" && choice.ai !== "cloud" ? ready.find((a) => a.id === choice.ai) : null) ?? autoEngine(agents);
    const model = active ? safeModel(settings[`ai_model_${active.id}`]) : null;
    return {
      agents, settings, active, model, remote: false, favorite,
      pick: (o) => void save({ ai_engine: o.engine, [`ai_model_${o.engine}`]: pickedModel(agents, o, active?.id ?? null, model) }),
      context: (v) => { if (active && model) void save({ [`ai_model_${active.id}`]: withContext(model, v) }); },
    };
  }

  const info = mac.hostInfo;
  if (!mac.pairing || mac.status.state === "revoked" || !info) return null;
  const remoteAgents = agentsFromHost(info.engines);
  // The phone's own pick, else whatever the Mac uses.
  const own = pairedAiChoice(settings);
  const active = remoteAgents.find((a) => a.id === (own.engine ?? info.activeEngine) && agentReady(a)) ?? autoEngine(remoteAgents);
  const model = !active ? null : own.engine ? own.model : active.id === info.activeEngine ? safeModel(info.activeModel) : null;
  return {
    agents: remoteAgents, active, model, remote: true, favorite,
    settings: { [FAVORITES_KEY]: settings[FAVORITES_KEY], ...(active && model ? { [`ai_model_${active.id}`]: model } : {}) },
    pick: (o) => void save({ [PAIRED_ENGINE_KEY]: o.engine, [PAIRED_MODEL_KEY]: pickedModel(remoteAgents, o, active?.id ?? null, model) || null }),
    context: (v) => { if (active && model) void save({ [PAIRED_ENGINE_KEY]: active.id, [PAIRED_MODEL_KEY]: withContext(model, v) }); },
  };
}

export function EnginePicker() {
  const src = useEngineSource();
  const [open, setOpen] = useState(false);
  if (!src) return null;
  const { agents, settings, active, model } = src;
  // The chip names a non-default context window ("Opus 4.6 · 1M"); 300K is the default and goes unsaid.
  const ctx = active ? modelContext(active, model) : { choices: [], value: null };
  const ctxLabel = ctx.value && ctx.value !== pickContext(ctx.choices, null) ? ctx.choices.find((c) => c.value === ctx.value)?.label : null;
  const chipName = active ? (model ? modelName(active, model) + (ctxLabel ? ` · ${ctxLabel}` : "") : AGENTS[active.id].label) : "No AI engine";

  return (
    <div className="mp-wrap">
      <button type="button" className="engine-chip" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open}
        title="Switch AI engine or model" aria-label={active ? `AI: ${AGENTS[active.id].label}${model ? `, ${chipName}` : ""}` : "No AI engine"}>
        {active ? <EngineLogo id={active.id} size={15} /> : <span className="engine-chip-dot" />}
        <span className="engine-chip-name">{chipName}</span>
        <ChevronDown size={14} className="engine-chip-caret" />
      </button>
      {open && (
        <PickerPanel agents={agents} settings={settings} activeId={active?.id ?? null} activeModel={active ? listedModel(active, model) : model} remote={src.remote}
          context={ctx.choices.length > 1 && model && active ? { name: modelName(active, model), ...ctx } : null} onContext={src.context}
          onClose={() => setOpen(false)}
          onPick={(o) => { setOpen(false); src.pick(o); }}
          onFavorite={src.favorite} />
      )}
    </div>
  );
}

function PickerPanel({ agents, settings, activeId, activeModel, remote, context, onContext, onClose, onPick, onFavorite }: {
  agents: AgentStatus[]; settings: Record<string, unknown>; activeId: AgentId | null; activeModel: string | null; remote: boolean;
  context: { name: string; choices: ContextOption[]; value: string | null } | null; onContext: (v: string) => void;
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

  const openSettings = () => { onClose(); window.dispatchEvent(new CustomEvent("sutra:open-settings", { detail: remote ? "mac" : "intelligence" })); };

  return (
    <div className="mp" ref={ref} role="dialog" aria-label="Select model" onKeyDown={onKey}>
      <nav className="mp-rail" aria-label="Engines">
        <RailButton on={tab === "favorites" && !query} label="Favorites" onClick={() => { setQuery(""); setTab("favorites"); }}>
          <Star size={15} fill="currentColor" />
        </RailButton>
        <div className="mp-rail-sep" />
        {rail.map((a) => (
          <RailButton key={a.id} on={tab === a.id && !query} dim={!agentReady(a)} onClick={() => { setQuery(""); setTab(a.id); }}
            label={`${AGENTS[a.id].label}${agentReady(a) ? "" : remote ? " — set up on your Mac" : a.installed ? " — sign in" : " — not installed"}`}>
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
            <SetupHint st={tabAgent} remote={remote} onManage={openSettings} />
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
                {i < 9 && !remote && <kbd className="mp-kbd">{MOD}{i + 1}</kbd>}
                <button type="button" className={`mp-star${fav ? " on" : ""}`} aria-label={fav ? "Remove from favorites" : "Add to favorites"}
                  onClick={(e) => { e.stopPropagation(); onFavorite(o.key); }}>
                  <Star size={14} fill={fav ? "currentColor" : "none"} />
                </button>
              </div>
            );
          })}
        </div>
        {context && (
          <div className="mp-ctx">
            <span className="mp-ctx-label" title={context.name}>Context · {context.name}</span>
            <ContextSwitch choices={context.choices} value={context.value} onPick={onContext} />
          </div>
        )}
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

function SetupHint({ st, remote, onManage }: { st: AgentStatus; remote: boolean; onManage: () => void }) {
  if (remote) {
    return (
      <div className="mp-setup">
        <EngineLogo id={st.id} size={22} />
        <div className="mp-setup-title">{AGENTS[st.id].label} isn't ready on your Mac</div>
        <div className="mp-setup-text">Set it up in Sutra on your Mac, under Settings → Intelligence.</div>
      </div>
    );
  }
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
