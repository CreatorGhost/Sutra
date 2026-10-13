import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Copy, FileText, Loader2, RotateCcw, Share, Trash2 } from "lucide-react";
import { api } from "../../local/sutra";
import { minutesToMarkdown, type Minutes as MinutesData } from "../../local/minutes";
import { notifyDataChanged } from "../events";
import { longDate } from "../format";
import { friendlyError } from "../ui";
import { actionMeta, minutesView } from "./minutesModel";

const fileSafe = (s: string) => s.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "meeting";

/** Minutes of Meeting as a notes style. Detected meetings get them automatically; anything else can
 *  generate them on demand. Regenerate / Copy / Share / Clear sit under the minutes. */
export function MinutesNotes({ cid, minutes, meetingTitle, isMeeting, toast }: {
  cid: number; minutes: MinutesData | null; meetingTitle: string; isMeeting: boolean; toast: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const view = minutesView(minutes, meetingTitle);

  const generate = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.generateMinutes(cid);
      if (!r.ok) setErr(r.reason === "empty" ? "There's no transcript to write minutes from yet." : "Couldn't write the minutes — check your connection and try again.");
      else notifyDataChanged();
    } catch (e) { setErr(friendlyError(e)); }
    finally { setBusy(false); }
  };
  const copy = async () => toast((await api.copyMinutes(cid)).ok ? "Minutes copied" : "Couldn't copy");
  // Phones get the share sheet; desktop/web save a Markdown file (the facade's web fallback only copies).
  const share = async () => {
    if (Capacitor.isNativePlatform()) { await api.shareMinutes(cid); return; }
    const md = minutesToMarkdown(meetingTitle, minutes);
    if (md) await api.exportText(`${fileSafe(meetingTitle)}-minutes.md`, md);
  };
  const clear = async () => {
    if (!window.confirm("Clear these minutes? You can generate them again any time.")) return;
    await api.clearMinutes(cid);
    notifyDataChanged();
  };

  if (!view || view.empty) {
    return (
      <div className="notice">
        <FileText size={16} style={{ marginTop: 2, flex: "0 0 auto" }} />
        <div className="grow">
          <div style={{ fontWeight: 600 }}>{busy ? "Writing the minutes…" : "No minutes yet"}</div>
          <div className="muted">{err ?? (isMeeting
            ? "Formal minutes — attendees, agenda, decisions and action items with owners — written from the transcript."
            : "Was this a meeting? Write shareable minutes from the transcript.")}</div>
        </div>
        <button className="btn" onClick={() => void generate()} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <FileText size={14} />} Generate
        </button>
      </div>
    );
  }

  return (
    <>
      {view.title && <p className="muted" style={{ margin: "0 0 18px", fontWeight: 600 }}>{view.title}</p>}
      {view.summary && <section className="sec"><h2>Summary</h2><p>{view.summary}</p></section>}
      {view.attendees.length > 0 && (
        <section className="sec"><h2>Attendees</h2><div className="chips">{view.attendees.map((a) => <span key={a} className="tag">{a}</span>)}</div></section>
      )}
      {view.sections.map((s) => (
        <section key={s.key} className="sec"><h2>{s.heading}</h2><ul className="bullets">{s.items.map((x, i) => <li key={i}>{x}</li>)}</ul></section>
      ))}
      {view.actions.length > 0 && (
        <section className="sec">
          <h2>Action items</h2>
          <ul className="bullets">
            {view.actions.map((a, i) => (
              <li key={i}>{a.task}{actionMeta(a) && <span className="act-meta"> — {actionMeta(a)}</span>}</li>
            ))}
          </ul>
        </section>
      )}
      {view.nextSteps.length > 0 && <section className="sec"><h2>Next steps</h2><ul className="bullets">{view.nextSteps.map((x, i) => <li key={i}>{x}</li>)}</ul></section>}
      {err && <div className="notice err"><div className="grow">{err}</div></div>}
      <div className="min-actions">
        <button className="btn" onClick={() => void generate()} disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : <RotateCcw size={14} />} {busy ? "Regenerating…" : "Regenerate"}</button>
        <button className="btn" onClick={() => void copy()}><Copy size={14} /> Copy</button>
        <button className="btn" onClick={() => void share()}><Share size={14} /> Share</button>
        <button className="icon-btn ghost sm" onClick={() => void clear()} aria-label="Clear minutes" title="Clear minutes"><Trash2 size={15} /></button>
        {view.generatedAt && <span className="faint">Written {longDate(view.generatedAt)}</span>}
      </div>
    </>
  );
}
