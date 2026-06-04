import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { api } from "../local/sutra";

// One stable id so re-scheduling replaces (not stacks) the daily recap notification.
const RECAP_NOTIF_ID = 7011;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseHM(t?: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "08:00"));
  return {
    hour: m ? Math.max(0, Math.min(23, Number(m[1]))) : 8,
    minute: m ? Math.max(0, Math.min(59, Number(m[2]))) : 0,
  };
}

/**
 * Schedule (or refresh) the daily on-device recap notification.
 *
 * Honest limitation: a recap is an LLM call, and Capacitor can't run that reliably in the background
 * while the app is killed. So the NOTIFICATION fires daily on-device (AlarmManager via
 * @capacitor/local-notifications, repeats:true), but its CONTENT is generated when the app is open:
 * we best-effort build today's rollup on foreground and use it as the notification body. Tapping the
 * notification opens the app, where the freshest recap is shown. Email stays optional/opt-in (SMTP).
 * No-op on web (local notifications are native-only).
 */
export async function initDailyRecap(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  let cfg: any = {};
  try { cfg = (await api.getSettings()) || {}; } catch { /* settings unavailable */ }
  if (cfg.recap_enabled === false) { await cancelDailyRecap(); return; }

  try {
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== "granted") return;
  } catch { return; }

  let body = "Open Sutra to see today's highlights.";
  try {
    const r = await api.runRecap(today());      // builds + stores today's rollup (one LLM call)
    const s = r?.rollup?.summary;
    if (s) body = String(s).slice(0, 160);
  } catch { /* no memories yet / offline — keep the generic prompt */ }

  try {
    await LocalNotifications.schedule({
      notifications: [{
        id: RECAP_NOTIF_ID,
        title: "Your daily recap",
        body,
        schedule: { on: parseHM(cfg.recap_time), repeats: true, allowWhileIdle: true },
      }],
    });
  } catch { /* scheduling best-effort; never block app start */ }
}

export async function cancelDailyRecap(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try { await LocalNotifications.cancel({ notifications: [{ id: RECAP_NOTIF_ID }] }); } catch { /* */ }
}

/** Re-apply the schedule after the user changes recap settings (enabled/time). */
export async function rescheduleDailyRecap(): Promise<void> {
  await initDailyRecap();
}
