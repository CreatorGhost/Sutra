import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AudioLines, Check, Laptop, Sparkles } from "lucide-react";
import { useMac } from "../pairing/runtime";
import { PairControls } from "./settings/MacSection";
import { api } from "../local/sutra";
import { desktop, type AgentStatus } from "../desktop/bridge";
import { isAgentId } from "../shared/agentProtocol";
import { useRecorder } from "./recorder";
import { notifyDataChanged } from "./events";
import { EngineSettings, autoEngine } from "./EngineSettings";
import { SpeechSettings } from "./SpeechSettings";
import { friendlyError } from "./ui";

/** Nothing selected: a calm welcome, plus a one-time "what should we call you?" so notes say
 *  "Aditya: …" instead of "Me: …". */
export function Home() {
  const { start, state: rec } = useRecorder();
  const nav = useNavigate();
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState("");

  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  useEffect(() => {
    // The owner's real name — skip a placeholder "Me" row (older builds could create one).
    api.listPeople().then((ps: any[]) => setMe(ps.find((p) => p.is_me && !/^me$/i.test(String(p.canonical_name).trim()))?.canonical_name ?? null)).catch((e) => { setMe(null); setDbError(friendlyError(e)); });
    void api.getSettings().then(setSettings);
  }, []);
  const put = async (patch: Record<string, unknown>) => setSettings(await api.putSettings(patch));

  if (dbError) {
    return (
      <div className="center">
        <div className="notice err" style={{ maxWidth: 560, textAlign: "left" }}>
          <div className="grow"><div style={{ fontWeight: 600, marginBottom: 4 }}>Sutra can't open its database</div><div className="muted">{dbError}</div></div>
        </div>
      </div>
    );
  }

  // First run on desktop: pick the AI you already use, then where transcription runs.
  if (desktop && settings && !settings["setup_engines"]) return <EngineSetup settings={settings} put={put} />;

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
        ) : rec.status === "recording" || rec.status === "starting" ? (
          <button className="btn" onClick={() => nav("/live")}><span className="live-dot" /> Recording{rec.app ? ` · ${rec.app}` : ""} — open</button>
        ) : (
          <button className="btn" onClick={() => void start()}>Start recording</button>
        )}
      </div>
    </div>
  );
}

/** The phone's first screen: pair with Sutra on the Mac (scan its code, or paste the link). The phone
 *  records; the Mac transcribes and writes the notes, reached through the user's own relay. Skippable. */
export function PhoneSetup({ put }: { put: (patch: Record<string, unknown>) => Promise<void> }) {
  const mac = useMac();
  const [paired, setPaired] = useState<string | null>(null);
  const done = () => void put({ setup_pairing: true });
  const name = paired ?? (mac.pairing && !mac.pairing.revokedAt ? mac.pairing.hostName : null);
  return (
    <div className="scroll">
      <div className="setup phone-setup">
        <div className="hero-mark">{name ? <Check size={24} /> : <Laptop size={24} />}</div>
        {name ? (
          <>
            <p className="hero-title">Connected to {name}</p>
            <p className="hero-text">Record here — your Mac transcribes it and writes the notes, from any network. Every meeting shows up on both.</p>
            <div className="setup-actions"><button className="btn primary" onClick={done}>Start using Sutra</button></div>
          </>
        ) : (
          <>
            <p className="hero-title">Connect to your Mac</p>
            <p className="hero-text">Sutra on your phone records. Your Mac transcribes and writes the notes with its own AI, over an encrypted link that works from anywhere.</p>
            <ol className="phone-steps">
              <li>On your Mac, open Sutra → <b>Settings → Phones</b>.</li>
              <li>Click <b>Pair a phone</b> (connect Cloudflare first if it asks).</li>
              <li>Scan the code it shows.</li>
            </ol>
            <PairControls large onPaired={setPaired} />
            <button className="set-disclosure phone-skip" onClick={done}>Skip for now</button>
          </>
        )}
      </div>
    </div>
  );
}

/** First-run setup, two steps: "Which AI do you use?" (detected agent CLIs) → "Transcription". Skip
 *  keeps the defaults (the first ready engine, cloud transcription); both stay in Settings. */
function EngineSetup({ settings, put }: { settings: Record<string, unknown>; put: (patch: Record<string, unknown>) => Promise<void> }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [detected, setDetected] = useState<AgentStatus[] | null>(null);
  const [choosing, setChoosing] = useState(false);
  const done = () => void put({ setup_engines: true });
  // Continuing without touching the list keeps the engine Sutra picked for them — make it explicit.
  const next = async () => {
    const pick = autoEngine(detected);
    if (!isAgentId(settings["ai_engine"]) && pick) await put({ ai_engine: pick.id });
    setStep(2);
  };
  return (
    <div className="scroll">
      <div className="setup">
        <div className="setup-steps" aria-label={`Step ${step} of 2`}><i className={step === 1 ? "on" : ""} /><i className={step === 2 ? "on" : ""} /></div>
        <div className="hero-mark">{step === 1 ? <Sparkles size={24} /> : <AudioLines size={24} />}</div>
        {step === 1 ? (
          <>
            <p className="hero-title">Which AI do you use?</p>
            <p className="hero-text">Sutra writes your notes and answers with the AI you already pay for. No API keys, nothing extra to buy.</p>
            <EngineSettings settings={settings} onChange={put} variant="setup" onStatus={setDetected} onChoosing={setChoosing} onSkip={done} />
            {!choosing && <div className="setup-actions">
              <button className="btn" onClick={done}>Skip for now</button>
              <button className="btn primary" onClick={() => void next()}>Continue</button>
            </div>}
          </>
        ) : (
          <>
            <p className="hero-title">Transcription</p>
            <p className="hero-text">Choose where speech becomes text. You can change this any time in Settings.</p>
            <SpeechSettings settings={settings} onChange={put} />
            <div className="setup-actions">
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" onClick={done}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
