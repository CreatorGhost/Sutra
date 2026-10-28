// The emoji tile in front of a meeting (sidebar, Home, meeting header). The emoji comes from what the
// meeting was about (title, summary, tags); the tint is the meeting's project colour, else a stable
// colour per meeting so neighbouring rows don't all look alike.
import { Loader2 } from "lucide-react";

interface TileMeeting {
  id?: number | null;
  title?: string | null;
  subtitle?: string | null;
  summary?: string | null;
  tags?: string[] | null;
  status?: string | null;
}

// First match wins, so the more specific topics come first.
const TOPICS: [RegExp, string][] = [
  [/\b(incident|outage|post-?mortem|bug|debug|hotfix|crash)/, "🐞"],
  [/\b(interview|candidate|hiring|recruit)/, "🧑‍💼"],
  [/\b(stand-?up|daily sync|scrum)\b/, "☀️"],
  [/\bretro(spective)?\b/, "🔁"],
  [/\b(sprint|roadmap|planning|backlog|milestone)/, "🗺️"],
  [/\b(launch|release|ship|demo|go-?live)/, "🚀"],
  [/\b(re)?design|\bux\b|\bui\b|figma|mock-?up|prototype/, "🎨"],
  [/\b(budget|finance|revenue|invoice|pricing|cost|payroll|forecast)/, "📊"],
  [/\b(investor|fundrais|board meeting|pitch)/, "📈"],
  [/\b(sales|deal|prospect|customer|client|account|renewal)/, "💼"],
  [/\b(marketing|campaign|brand|content|social|seo)/, "📣"],
  [/\b(code|engineering|api|backend|frontend|deploy|architecture|pull request|pr review|database)/, "💻"],
  [/\b(strategy|okr|goal|vision|quarterly)/, "🎯"],
  [/\b(research|user test|usability|survey|feedback)/, "🔍"],
  [/\b(brainstorm|idea|ideation)/, "💡"],
  [/\b(lecture|class|course|study|lesson|exam|seminar|tutorial)/, "📚"],
  [/\b(legal|contract|policy|compliance|agreement)/, "⚖️"],
  [/\b(doctor|health|medical|therapy|clinic)/, "🩺"],
  [/\b(travel|trip|visa|flight|hotel)/, "✈️"],
  [/\b(onboarding|welcome|kick-?off|intro(duction)?)\b/, "👋"],
  [/\b(hr|performance review|1:1|one-on-one|1-on-1|feedback session)\b/, "🌱"],
  [/\b(coffee|catch-?up|chat|hang ?out)/, "☕"],
  [/\b(lunch|dinner|breakfast|food)/, "🍽️"],
  [/\b(family|personal|home|house)/, "🏡"],
  [/\b(podcast|voice memo|memo|dictation)/, "🎙️"],
];

export function meetingEmoji(m: TileMeeting): string {
  if (m.status === "failed" && !m.title) return "⚠️";
  const hay = `${m.title ?? ""} ${(m.tags ?? []).join(" ")} ${m.subtitle ?? ""} ${m.summary ?? ""}`.toLowerCase();
  for (const [re, e] of TOPICS) if (re.test(hay)) return e;
  return "💬";
}

export function meetingHue(_m: TileMeeting, projectColor?: string | null): string {
  // Colour means "this project"; a meeting outside one stays neutral grey.
  return projectColor || "var(--text-3)";
}

/** The tile itself. `writing` shows a spinner while the notes are still being written. */
export function MeetingTile({ m, projectColor, size, writing }: { m: TileMeeting; projectColor?: string | null; size?: "md" | "lg"; writing?: boolean }) {
  return (
    <span className={`tile${size ? ` ${size}` : ""}`} style={{ ["--tc" as any]: meetingHue(m, projectColor) }} aria-hidden>
      {writing ? <Loader2 size={size === "lg" ? 22 : 15} className="spin" /> : meetingEmoji(m)}
    </span>
  );
}
