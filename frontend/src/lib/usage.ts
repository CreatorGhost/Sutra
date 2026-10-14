// Month-to-date usage + plan caps from the PROXY's authed /usage endpoint (not the Tier B server —
// the proxy is where every metered call lands). Read-only; Settings → Account renders this.
import { PROXY_BASE } from "../providers";
import { authHeader, readToken } from "./auth";

export type UsageSnapshot = {
  available: boolean;
  plan?: string;
  plan_name?: string;
  status?: string;
  caps?: { transcribe_seconds_month: number | null; ai_calls_month: number | null };
  by_kind?: Record<string, number>;
  audio_seconds_used?: number;
  ai_calls_used?: number;
  period_start?: string;
  resets_at?: string;
};

/** Fetch the caller's plan + month-to-date usage. Throws (human message) when signed out or the
 *  proxy is unreachable; callers render a quiet fallback. */
export async function fetchUsage(): Promise<UsageSnapshot> {
  if (!readToken()) throw new Error("Not signed in.");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let r: Response;
  try {
    r = await fetch(PROXY_BASE + "/usage", { headers: authHeader(), signal: ctrl.signal });
  } catch {
    throw new Error("Couldn't reach the server to load usage.");
  } finally {
    clearTimeout(t);
  }
  if (!r.ok) throw new Error(`Usage unavailable (${r.status}).`);
  const j: any = await r.json();
  // A legacy proxy returns the demo counters map (no `available` key) — treat as unavailable.
  if (typeof j?.available !== "boolean") return { available: false };
  return j as UsageSnapshot;
}
