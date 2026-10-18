// What a meeting's screenshots added (desktop, "Take screenshots during meetings"):
//   • RecordingBanner — the recording still on this Mac (screenshots + audio): play the audio, look at the
//     screenshots again (e.g. after switching to an engine that can see), or confirm the notes, which
//     deletes the recording (kept screenshots stay);
//   • OnScreen — the screenshots the AI kept for the notes, each captioned and timed;
//   • ShotViewer — one screenshot full size (from On screen, a citation, or the transcript), with a jump to
//     that moment in the transcript.
import { useCallback, useEffect, useState } from "react";
import { Camera, Check, Eye, EyeOff, Loader2, Play, RotateCw, ScrollText, X } from "lucide-react";
import { api } from "../../local/sutra";
import type { MeetingImage } from "../../local/repo";
import { desktop } from "../../desktop/bridge";

type Visual = Awaited<ReturnType<typeof api.meetingVisual>>;

export function useMeetingVisual(cid: number, version: number) {
  const [v, setV] = useState<Visual | null>(null);
  const reload = useCallback(async () => { setV(desktop?.media ? await api.meetingVisual(cid).catch(() => null) : null); }, [cid]);
  useEffect(() => { setV(null); void reload(); }, [reload, version]);
  return { v, reload };
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/** ~32 kbit/s Opus: a size → duration estimate for the banner. */
const audioMinutes = (bytes: number) => Math.max(1, Math.round((bytes * 8) / 32_000 / 60));

export function RecordingBanner({ cid, v, startedAt, onChanged, toast }: {
  cid: number; v: Visual | null; startedAt: string | null; onChanged: () => void; toast: (m: string) => void;
}) {
  const [busy, setBusy] = useState<null | "confirm" | "relook" | "drop">(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  const rec = v?.recording;
  if (!rec || !v?.session) return null;

  const visual = v.visual;
  const daysLeft = Math.max(0, Math.ceil((rec.createdAt + 7 * 86400_000 - Date.now()) / 86400_000));
  const what = [rec.frames ? `${rec.frames} screenshot${rec.frames === 1 ? "" : "s"}` : null, rec.audioBytes ? `~${audioMinutes(rec.audioBytes)} min of audio` : null].filter(Boolean).join(" and ");
  const confirm = async () => {
    if (!window.confirm("Keep these notes and delete the recording? The screenshots kept in the notes stay; the audio and the other screenshots are deleted.")) return;
    setBusy("confirm");
    try { await api.confirmRecording(cid); toast("Recording deleted — the notes stay"); onChanged(); }
    catch (e: any) { toast(String(e?.message ?? e)); }
    finally { setBusy(null); }
  };
  const relook = async () => {
    setBusy("relook");
    try { await api.relookAtScreen(cid); toast("Notes rewritten with what was on screen"); onChanged(); }
    catch (e: any) { toast(String(e?.message ?? e)); }
    finally { setBusy(null); }
  };
  const drop = async () => {
    setBusy("drop");
    try { await api.notesWithoutScreen(cid); toast("Notes rewritten from the transcript only"); onChanged(); }
    catch (e: any) { toast(String(e?.message ?? e)); }
    finally { setBusy(null); }
  };
  const play = async () => {
    const url = await api.recordingAudio(v.session!).catch(() => null);
    if (!url) { toast("No audio in this recording"); return; }
    setAudioUrl(url);
  };

  return (
    <div className="rec-banner">
      <div className="rec-banner-main">
        <Camera size={16} />
        <div className="grow">
          <div className="t">
            {visual?.error ? "The notes come from the transcript only"
              : visual ? `Notes written with ${visual.frames_seen} of ${visual.frames_total} screenshots`
              : "Recording kept on this Mac"}
          </div>
          <div className="d">
            {visual?.error ? `${visual.error} ` : ""}
            This Mac still has {what || "the recording"}, encrypted. It's deleted when you confirm the notes, or in {daysLeft} day{daysLeft === 1 ? "" : "s"}.
          </div>
        </div>
      </div>
      {audioUrl && <audio src={audioUrl} autoPlay controls className="rec-audio" />}
      <div className="rec-banner-actions">
        {rec.audioBytes > 0 && !audioUrl && <button className="btn sm" onClick={() => void play()}><Play size={14} /> Play recording</button>}
        {rec.frames > 0 && (
          <button className="btn sm" disabled={busy !== null} onClick={() => void relook()} title="Have your AI engine look at the screenshots again and rewrite the notes">
            {busy === "relook" ? <Loader2 size={14} className="spin" /> : visual?.error ? <Eye size={14} /> : <RotateCw size={14} />} {visual?.error ? "Look at the screenshots" : "Look again"}
          </button>
        )}
        {visual && !visual.error && (
          <button className="btn sm" disabled={busy !== null} onClick={() => void drop()} title="Wrong screen, or nothing useful on it? Rewrite the notes from the transcript alone">
            {busy === "drop" ? <Loader2 size={14} className="spin" /> : <EyeOff size={14} />} Notes without screenshots
          </button>
        )}
        <button className="btn sm primary" disabled={busy !== null} onClick={() => void confirm()}>
          {busy === "confirm" ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Keep notes, delete recording
        </button>
      </div>
    </div>
  );
}

/** Offset of a screenshot from the meeting's start (ms), or null. */
export function shotOffset(img: MeetingImage, startedAt: string | null): number | null {
  const t0 = startedAt ? Date.parse(String(startedAt).includes("T") ? startedAt : String(startedAt).replace(" ", "T") + "Z") : NaN;
  return img.at && Number.isFinite(t0) ? Math.max(0, img.at - t0) : null;
}
export const shotTime = (img: MeetingImage, startedAt: string | null) => { const o = shotOffset(img, startedAt); return o == null ? null : mmss(o); };

export function OnScreen({ cid, images, startedAt, onChanged, onOpen }: {
  cid: number; images: MeetingImage[]; startedAt: string | null; onChanged: () => void; onOpen: (img: MeetingImage) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = images.map((i) => i.name).join(",");
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    void (async () => {
      const out: Record<string, string> = {};
      for (const img of images) {
        const u = await api.keptImage(cid, img.name).catch(() => null);
        if (u) { out[img.name] = u; made.push(u); }
      }
      if (alive) setUrls(out);
    })();
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [cid, key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!images.length) return null;

  return (
    <section className="sec on-screen">
      <div className="sec-head"><h2>On screen</h2><span className="faint">{images.length} kept from the recording</span></div>
      <div className="shots">
        {images.map((img) => (
          <figure key={img.id} id={`shot-${img.id}`} className="shot">
            <button className="shot-img" onClick={() => onOpen(img)} aria-label={`Open screenshot${img.caption ? `: ${img.caption}` : ""}`}>
              {urls[img.name] ? <img src={urls[img.name]} alt={img.caption ?? "Screenshot"} /> : <span className="shot-ph"><Loader2 size={16} className="spin" /></span>}
            </button>
            <figcaption>
              {shotTime(img, startedAt) && <span className="shot-time">{shotTime(img, startedAt)}</span>}
              <span className="shot-cap">{img.caption}</span>
              <button className="icon-btn ghost sm" aria-label="Remove from the notes" title="Remove from the notes"
                onClick={() => void api.removeMeetingImage(cid, img).then(onChanged)}><X size={13} /></button>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

/** One screenshot full size: when it was taken, what it shows, and a jump to that moment in the transcript. */
export function ShotViewer({ cid, img, startedAt, onClose, onTranscript }: {
  cid: number; img: MeetingImage; startedAt: string | null; onClose: () => void; onTranscript: (seconds: number) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null, alive = true;
    void api.keptImage(cid, img.name).then((u) => { made = u; if (alive) setUrl(u); else URL.revokeObjectURL(u); }).catch(() => {});
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [cid, img.name]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const off = shotOffset(img, startedAt);
  return (
    <div className="lightbox" role="dialog" aria-label="Screenshot" onClick={onClose}>
      {url ? <img src={url} alt={img.caption ?? "Screenshot"} /> : <Loader2 size={20} className="spin" />}
      <div className="lightbox-cap">
        {off != null && <b>{mmss(off)} · </b>}{img.caption}
        {off != null && (
          <button className="btn sm lightbox-jump" onClick={(e) => { e.stopPropagation(); onTranscript(Math.floor(off / 1000)); }}>
            <ScrollText size={14} /> Show in transcript
          </button>
        )}
      </div>
    </div>
  );
}
