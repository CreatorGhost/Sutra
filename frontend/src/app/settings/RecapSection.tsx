import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../../local/sutra";
import { desktop } from "../../desktop/bridge";
import { parseRecapTime, recapCanNotify, recapDay, recapEnabled, rescheduleRecap } from "../integrations";
import { friendlyError } from "../ui";
import { Group, Row, SwitchRow, type SectionProps } from "./kit";

type Rollup = { day: string; summary: string | null; highlights: string; open_actions: string };
const parse = <T,>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
const fmtDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

/** A short daily summary of what you talked about, as a notification at a time you pick. */
export function RecapSection({ settings, put, toast }: SectionProps) {
  const [rollups, setRollups] = useState<Rollup[] | null>(null);
  const [building, setBuilding] = useState(false);
  const enabled = recapEnabled(settings);
  const time = String(settings["recap_time"] || "08:00");
  const [timeDraft, setTimeDraft] = useState(time);
  useEffect(() => setTimeDraft(time), [time]);

  const reload = async () => setRollups((await api.rollups()) as Rollup[]);
  useEffect(() => { void reload(); }, []);

  const save = async (patch: Record<string, unknown>) => { await put(patch); void rescheduleRecap().catch(() => {}); };
  const build = async () => {
    setBuilding(true);
    try { await api.runRecap(recapDay(parseRecapTime(time))); await reload(); }
    catch (e) { toast(friendlyError(e)); }
    finally { setBuilding(false); }
  };

  const latest = rollups?.[0];
  const highlights = latest ? parse<string[]>(latest.highlights, []) : [];
  const actions = latest ? parse<{ text: string; owner?: string | null }[]>(latest.open_actions, []) : [];

  return (
    <>
      {recapCanNotify() && (
        <Group hint={enabled && desktop ? "A morning recap covers the day before; a later one covers the same day. Days without meetings stay quiet." : undefined}>
          <SwitchRow title="Daily recap" desc="A notification with the highlights of your meetings and what's still open."
            checked={enabled} onChange={(v) => void save({ recap_enabled: v })} />
          {enabled && (
            <Row title="Time">
              <input type="time" value={timeDraft} aria-label="Recap time" onChange={(e) => setTimeDraft(e.target.value)}
                onBlur={() => { if (timeDraft && timeDraft !== time) void save({ recap_time: timeDraft }); }} />
            </Row>
          )}
        </Group>
      )}

      <Group label="Latest recap">
        {latest ? (
          <div className="set-row stack">
            <div className="d">{fmtDay(latest.day)}</div>
            <div className="recap-text">{latest.summary}</div>
            {highlights.length > 0 && <ul className="recap-list">{highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>}
            {actions.length > 0 && (
              <div className="d">Still open: {actions.map((a) => (a.owner ? `${a.text} (${a.owner})` : a.text)).join(" · ")}</div>
            )}
          </div>
        ) : (
          <div className="set-empty">{rollups ? "No recap yet." : "…"}</div>
        )}
        <Row title={latest ? "Build it again" : "Build one now"} desc="Uses your meetings from the recap's day.">
          <button className="btn sm" onClick={() => void build()} disabled={building}><RefreshCw size={14} /> {building ? "Building…" : "Build"}</button>
        </Row>
      </Group>
    </>
  );
}
