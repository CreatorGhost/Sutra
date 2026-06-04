import { useState } from "react";
import { Shield, Cloud, Smartphone, Check, ArrowRight } from "lucide-react";
import { Waveform } from "./Waveform";
import { api } from "../local/sutra";
import { MODE_COPY, LANGS, type Mode, type Lang } from "../providers";

/** First-run onboarding: welcome → privacy → capture mode → language. Sets the
 *  `sutra_onboarded` flag (gate in App) plus the chosen mode + transcript language. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const STEPS = 4;
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<Mode>("hybrid");
  const [lang, setLang] = useState<Lang>("english");
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    try { await api.putSettings({ transcript_lang: lang }); await api.setMode(mode); } catch { /* settings save best-effort */ }
    try { localStorage.setItem("sutra_onboarded", "1"); } catch { /* */ }
    onDone();
  };

  return (
    <div className="onboard">
      <div className="onboard-progress">
        {Array.from({ length: STEPS }).map((_, i) => <span key={i} className={i <= step ? "on" : ""} />)}
      </div>

      <div className="onboard-body" key={step}>
        {step === 0 && (
          <>
            <div className="onboard-art"><div className="wave-wrap"><Waveform active level={0.55} /></div></div>
            <h1>Sutra remembers your conversations</h1>
            <p>Talk naturally. Sutra turns each conversation into searchable memory — summaries, action items, people and decisions, all connected.</p>
          </>
        )}
        {step === 1 && (
          <>
            <div className="onboard-icon"><Shield size={38} /></div>
            <h1>Private by design</h1>
            <p>Your audio is <strong>never stored</strong> — it's processed in the moment and discarded. Everything Sutra remembers lives <strong>encrypted on this device</strong>, not on a server.</p>
          </>
        )}
        {step === 2 && (
          <>
            <h1>How should Sutra process audio?</h1>
            <p className="onboard-sub">You can change this anytime in Settings.</p>
            <div className="onboard-opts">
              {(["hybrid", "ondevice"] as Mode[]).map((m) => {
                const disabled = m === "ondevice"; // Phase 3/4 stub — not selectable yet
                return (
                  <button key={m} className={`onboard-opt ${mode === m ? "sel" : ""}`} disabled={disabled}
                    style={disabled ? { opacity: 0.5 } : undefined} onClick={() => { if (!disabled) setMode(m); }}>
                    <div className="oo-top">{m === "hybrid" ? <Cloud size={18} /> : <Smartphone size={18} />}<strong>{MODE_COPY[m].label}</strong>{disabled ? <span className="chip" style={{ marginLeft: "auto" }}>ships later</span> : (mode === m && <Check size={16} className="oo-check" />)}</div>
                    <div className="oo-desc">{disabled ? "On-device models ship in a later release." : MODE_COPY[m].audio}</div>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <h1>How should we write what you say?</h1>
            <p className="onboard-sub">You speak Hinglish naturally — choose how it's written. Switchable anytime in Settings.</p>
            <div className="onboard-opts">
              {(Object.keys(LANGS) as Lang[]).map((k) => (
                <button key={k} className={`onboard-opt ${lang === k ? "sel" : ""}`} onClick={() => setLang(k)}>
                  <div className="oo-top"><strong>{LANGS[k].label}</strong>{lang === k && <Check size={16} className="oo-check" />}</div>
                  <div className="oo-desc">{LANGS[k].desc}</div>
                  <div className="oo-ex">{LANGS[k].example}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="onboard-foot">
        {step > 0 && <button className="btn ghost block" style={{ marginBottom: 10 }} onClick={() => setStep((s) => s - 1)}>Back</button>}
        {step < STEPS - 1 ? (
          <button className="btn primary block" onClick={() => setStep((s) => s + 1)}>Continue <ArrowRight size={16} /></button>
        ) : (
          <button className="btn primary block" disabled={busy} onClick={finish}>Start using Sutra <Check size={16} /></button>
        )}
      </div>
    </div>
  );
}
