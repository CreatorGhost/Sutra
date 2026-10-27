// A speech-model download keeps going in the main process wherever you are in the app. This small card
// follows it from any page; the × only hides the card (cancel lives in Settings → Intelligence), and a
// click opens that section.
import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { desktop, type SttProgress } from "../desktop/bridge";
import { findSpeechModel } from "../shared/speechModels";

export function DownloadChip({ onDone }: { onDone: (msg: string) => void }) {
  const [p, setP] = useState<SttProgress | null>(null);
  const [hidden, setHidden] = useState<string | null>(null); // id of the download the user dismissed
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (!desktop) return;
    void desktop.stt.status().then((s) => { if (s.downloading) setP((cur) => cur ?? s.downloading); }).catch(() => {});
    return desktop.stt.onProgress((x) => {
      const name = findSpeechModel(x.id)?.label ?? "Speech model";
      if (x.done) { setP(null); done.current(`${name} is ready`); }
      else if (x.error) { setP(null); if (!/cancel/i.test(x.error)) done.current(`${name} didn't download — try again in Settings`); }
      else setP(x);
    });
  }, []);

  if (!p || hidden === p.id) return null;
  const pct = Math.min(100, Math.round((p.received / Math.max(1, p.total)) * 100));
  const name = findSpeechModel(p.id)?.label ?? "Speech model";
  const open = () => window.dispatchEvent(new CustomEvent("sutra:open-settings", { detail: "intelligence" }));

  return (
    <div className="dl-chip" role="status" aria-label={`Downloading ${name}, ${pct}%`}>
      <button type="button" className="dl-main" onClick={open} title="Open Settings → Intelligence">
        <Download size={14} className="dl-icon" />
        <span className="dl-text">
          <span className="dl-name">{p.phase === "extract" ? `Unpacking ${name}` : `Downloading ${name}`}</span>
          <span className="dl-bar"><i style={{ width: `${pct}%` }} /></span>
        </span>
        <span className="dl-pct">{pct}%</span>
      </button>
      <button type="button" className="dl-x" onClick={() => setHidden(p.id)} aria-label="Hide (keeps downloading)" title="Hide — keeps downloading">
        <X size={13} />
      </button>
    </div>
  );
}
