// Action items → Apple Reminders, meeting events → Apple Calendar (macOS, through Apple Events; macOS asks
// once per app). The items travel as one JSON argument, never spliced into the script, so text from a
// meeting can't become script.
import { execFile } from "node:child_process";

export interface AppleItem { title: string; notes?: string; at?: string | null }

const JXA = `function run(argv) {
  const req = JSON.parse(argv[0]);
  if (req.kind === "reminders") {
    const app = Application("Reminders"), list = app.defaultList();
    for (const it of req.items) {
      const r = app.Reminder({ name: it.title, body: it.notes || "" });
      list.reminders.push(r);
      if (it.at) r.dueDate = new Date(it.at);
    }
  } else {
    const app = Application("Calendar");
    const cal = app.calendars().find((c) => c.writable());
    if (!cal) throw new Error("No calendar you can add to.");
    for (const it of req.items) {
      const s = new Date(it.at), e = new Date(s.getTime() + 30 * 60000);
      cal.events.push(app.Event({ summary: it.title, startDate: s, endDate: e, description: it.notes || "" }));
    }
  }
  return String(req.items.length);
}`;

/** Checked here (the renderer is not trusted with the shape): ≤50 items, bounded text, real dates. */
export function cleanItems(kind: unknown, items: unknown): { kind: "reminders" | "calendar"; items: AppleItem[] } {
  if (kind !== "reminders" && kind !== "calendar") throw new Error("Unknown app.");
  if (!Array.isArray(items) || !items.length || items.length > 50) throw new Error("Nothing to add.");
  const date = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);
  const out = items.map((i: any) => ({
    title: String(i?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    notes: String(i?.notes ?? "").slice(0, 2000),
    at: date(i?.at),
  })).filter((i) => i.title && (kind === "reminders" || i.at));
  if (!out.length) throw new Error(kind === "calendar" ? "No events with a date." : "Nothing to add.");
  return { kind, items: out };
}

export function addToApple(kind: unknown, items: unknown): Promise<number> {
  const req = cleanItems(kind, items);
  return new Promise((resolve, reject) => execFile("osascript", ["-l", "JavaScript", "-e", JXA, JSON.stringify(req)], { timeout: 30_000 }, (err, out, stderr) => {
    if (err) {
      const msg = String(stderr || err.message);
      reject(new Error(/-1743|not authori[sz]ed|not allowed/i.test(msg)
        ? `Sutra isn't allowed to use ${req.kind === "reminders" ? "Reminders" : "Calendar"} — allow it in System Settings → Privacy & Security → Automation.`
        : msg.slice(0, 300)));
    } else resolve(Number(out.trim()) || req.items.length);
  }));
}
