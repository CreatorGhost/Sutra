import { useEffect, useState } from "react";
import { AudioLines } from "lucide-react";
import { api } from "../local/sutra";
import { desktop } from "../desktop/bridge";
import { useRecorder } from "./recorder";
import { notifyDataChanged } from "./events";
import { Intelligence } from "./Intelligence";

/** Nothing selected: a calm welcome, plus a one-time "what should we call you?" so notes say
 *  "Aditya: …" instead of "Me: …". */
export function Home() {
  const { start } = useRecorder();
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState("");

  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    api.listPeople().then((ps: any[]) => setMe(ps.find((p) => p.is_me)?.canonical_name ?? null)).catch(() => setMe(null));
    void api.getSettings().then(setSettings);
  }, []);
  const put = async (patch: Record<string, unknown>) => setSettings(await api.putSettings(patch));

  // First run on desktop: ask where transcription and notes should run before anything else.
  if (desktop && settings && !settings["setup_engines"]) {
    return (
      <div className="scroll">
        <div className="setup">
          <div className="hero-mark"><AudioLines size={24} /></div>
          <p className="hero-title">Choose how Sutra thinks</p>
          <p className="hero-text">Transcribe on this computer with Whisper or in the cloud, and write notes with Sutra cloud or the AI agent you already use. You can change this any time in Settings.</p>
          <Intelligence settings={settings} onChange={put} />
          <div style={{ display: "flex", justifyContent: "center", marginTop: 24 }}>
            <button className="btn primary" onClick={() => void put({ setup_engines: true })}>Continue</button>
          </div>
        </div>
      </div>
    );
  }

  const saveName = async () => {
    const n = name.trim();
    if (!n) return;
    const fd = new FormData();
    fd.set("name", n);
    fd.set("is_me", "true");
    await api.enroll(fd);
    setMe(n);
    notifyDataChanged();
  };

  return (
    <div className="center">
      <div>
        <div className="hero-mark"><AudioLines size={24} /></div>
        <p className="hero-title">{me ? `Hi ${me.split(" ")[0]}` : "Your meetings, remembered"}</p>
        <p className="hero-text">
          {desktop
            ? "Join a call and Sutra notices — a Record button appears at the top of your screen. Notes, decisions and action items are written the moment you stop."
            : "Start recording and Sutra writes the notes — summary, decisions and action items — the moment you stop."}
        </p>
        {me === null ? (
          <form onSubmit={(e) => { e.preventDefault(); void saveName(); }} style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <input className="search" style={{ maxWidth: 220, color: "var(--text)", outline: 0 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" aria-label="Your name" />
            <button className="btn primary" disabled={!name.trim()}>Save</button>
          </form>
        ) : (
          <button className="btn" onClick={() => void start()}>Start recording</button>
        )}
      </div>
    </div>
  );
}
