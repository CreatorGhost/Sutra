// PURE date/time helpers for the notes UI.

/** Parse SQLite `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC) or ISO strings. */
export function parseTs(ts?: string | null): Date | null {
  if (!ts) return null;
  const s = String(ts);
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Sep 22" (this year) / "Sep 22, 2025" (other years). */
export function shortDate(ts?: string | null, now = new Date()): string {
  const d = parseTs(ts);
  if (!d) return "";
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

/** "Mon, Sep 22 · 3:05 PM" */
export function longDate(ts?: string | null): string {
  const d = parseTs(ts);
  if (!d) return "";
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** mm:ss or h:mm:ss */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "42 min" / "1 h 5 min" from two timestamps. */
export function duration(from?: string | null, to?: string | null): string {
  const a = parseTs(from), b = parseTs(to);
  if (!a || !b) return "";
  const min = Math.round((b.getTime() - a.getTime()) / 60000);
  if (min < 1) return "< 1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Sidebar section for a date: Today · This week · This month · "August 2026". */
export function periodLabel(ts: string | null | undefined, now = new Date()): string {
  const d = parseTs(ts);
  if (!d) return "Earlier";
  const today = startOfDay(now);
  if (d >= today) return "Today";
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7)); // Monday
  if (d >= weekStart) return "This week";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "This month";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** Group items (already sorted newest first) into ordered sections. */
export function groupByPeriod<T>(items: T[], ts: (x: T) => string | null | undefined, now = new Date()): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const it of items) {
    const label = periodLabel(ts(it), now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(it);
    else out.push({ label, items: [it] });
  }
  return out;
}

/** Seconds offset inside a recording → "12:04". */
export function offsetLabel(startedAt?: string | null, absStart?: string | null): string {
  const a = parseTs(startedAt), b = parseTs(absStart);
  if (!a || !b) return "";
  return clock(b.getTime() - a.getTime());
}
