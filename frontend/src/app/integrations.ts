// App-lifetime background integrations, started once from App via useIntegrations():
//   • the outbound MCP bridge (lib/mcpBridge.ts) — dials the local MCP server when "Share with AI
//     tools" is on, so Claude Code / Codex / Cursor / Gemini can read memory;
//   • the daily recap — phone: an OS-scheduled local notification (lib/recapScheduler.ts);
//     desktop: a system notification at the chosen time while the app is running (this file);
//   • desktop: serving paired phones (pairing/hostExecutor.ts) — their audio and AI jobs run here.
import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { api } from "../local/sutra";
import { desktop } from "../desktop/bridge";
import { initMcpBridge } from "../lib/mcpBridge";
import { initDailyRecap, rescheduleDailyRecap } from "../lib/recapScheduler";
import { startHostExecutor } from "./pairing/hostExecutor";
import { AGENT_IDS } from "../shared/agentProtocol";
import { upgradeModelId } from "../shared/engineProbes";

/** Whether the daily recap is on. The phone scheduler has always treated "unset" as on; on desktop
 *  it's opt-in (a surprise notification from a notes app is unwelcome). */
export function recapEnabled(settings: Record<string, unknown>): boolean {
  return Capacitor.isNativePlatform() ? settings["recap_enabled"] !== false : settings["recap_enabled"] === true;
}

/** Where a recap can actually reach the user as a notification. */
export const recapCanNotify = (): boolean => Capacitor.isNativePlatform() || !!desktop;

export function parseRecapTime(t: unknown): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "08:00"));
  return { hour: m ? Math.min(23, Number(m[1])) : 8, minute: m ? Math.min(59, Number(m[2])) : 0 };
}

/** The day a recap at this time should cover: a morning recap looks back at yesterday. */
export function recapDay(at: { hour: number }, now = new Date()): string {
  const d = at.hour < 12 ? new Date(now.getTime() - 86400000) : now;
  return d.toISOString().slice(0, 10);
}

const NOTIFIED_KEY = "sutra_recap_notified";
const CATCH_UP_MS = 3 * 3600 * 1000; // opened a little late: still worth it; hours late: skip today

function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function readNotified(): string | null { try { return localStorage.getItem(NOTIFIED_KEY); } catch { return null; } }
function markNotified(day: string): void { try { localStorage.setItem(NOTIFIED_KEY, day); } catch { /* per-device convenience */ } }

/** One desktop tick: if the recap is due today and hasn't gone out, build it and notify. */
export async function desktopRecapTick(now = new Date()): Promise<void> {
  const s = await api.getSettings();
  if (!recapEnabled(s)) return;
  const at = parseRecapTime(s["recap_time"]);
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), at.hour, at.minute);
  const today = localDay(now);
  if (now < due || readNotified() === today) return;
  markNotified(today); // first, so a slow model call can't double-fire on the next tick
  if (now.getTime() - due.getTime() > CATCH_UP_MS) return;
  const r = await api.runRecap(recapDay(at, now));
  if (!r.rollup.highlights.length) return; // nothing happened — no notification
  if (typeof Notification === "undefined") return;
  const n = new Notification("Your daily recap", { body: String(r.rollup.summary).slice(0, 240), silent: false });
  n.onclick = () => { try { window.focus(); } catch { /* best-effort */ } };
}

let desktopTimer: ReturnType<typeof setInterval> | null = null;

/** Re-apply the recap schedule after its settings change (desktop re-reads settings every tick). */
export async function rescheduleRecap(): Promise<void> {
  if (Capacitor.isNativePlatform()) await rescheduleDailyRecap();
}

let modelsChecked = false;
/** Desktop, once per launch: rewrite saved engine models to the exact ids the engines list now, so the
 *  picker doesn't show a stale duplicate (a bare "…opus-5" saved where an engine lists "…opus-5[context=300k]").
 *  Cursor lists bare ids, and a saved "…[context=1m]" there is the user's context choice: kept as is.
 *  Calls already resolve stale ids on their own; this just tidies Settings. */
export async function upgradeSavedModels(): Promise<void> {
  if (!desktop || modelsChecked) return;
  modelsChecked = true;
  const [settings, agents] = await Promise.all([api.getSettings(), desktop.ai.detect()]);
  const patch: Record<string, unknown> = {};
  for (const id of AGENT_IDS) {
    const saved = settings[`ai_model_${id}`];
    const offered = agents.find((a) => a.id === id)?.models ?? [];
    if (typeof saved !== "string" || !saved || !offered.length) continue;
    const next = upgradeModelId(saved, offered);
    if (next !== saved) patch[`ai_model_${id}`] = next;
  }
  if (Object.keys(patch).length) await api.putSettings(patch);
}

/** Start everything once. Idempotent (StrictMode double-mounts): the bridge and timers are singletons. */
export function useIntegrations(): void {
  useEffect(() => {
    void initMcpBridge().catch(() => {});
    void initDailyRecap().catch(() => {}); // native only; no-op elsewhere
    startHostExecutor(); // desktop only; idempotent
    void upgradeSavedModels().catch(() => {});
    if (desktop && !desktopTimer) {
      desktopTimer = setInterval(() => { void desktopRecapTick().catch(() => {}); }, 60000);
      void desktopRecapTick().catch(() => {});
    }
  }, []);
}
