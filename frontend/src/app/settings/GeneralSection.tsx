import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../../local/sutra";
import { LANGS, type Lang } from "../../providers";
import { desktop, type DesktopPrefs } from "../../desktop/bridge";
import { applyTheme, readTheme, type ThemeChoice } from "../theme";
import { notifyDataChanged } from "../events";
import { Group, Row, SwitchRow, type SectionProps } from "./kit";

/** You, recording, meeting detection (desktop) and appearance — the original sheet's rows. */
export function GeneralSection({ settings, put }: SectionProps) {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [meName, setMeName] = useState("");
  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  const [perms, setPerms] = useState<{ microphone: string; screen: string } | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);

  useEffect(() => {
    void api.listPeople().then((ps: any[]) => setMeName(ps.find((p) => p.is_me)?.canonical_name ?? ""));
    navigator.mediaDevices?.enumerateDevices?.().then((ds) => setMics(ds.filter((d) => d.kind === "audioinput"))).catch(() => {});
    if (desktop) {
      void desktop.prefs.get().then(setPrefs);
      void desktop.permissions.get().then(setPerms);
    }
  }, []);

  const putPrefs = async (patch: Partial<DesktopPrefs>) => { if (desktop) setPrefs(await desktop.prefs.set(patch)); };
  // Rename the existing "me" row in place; only enroll when there's no "me" yet.
  const saveName = async () => {
    const n = meName.trim();
    const me = ((await api.listPeople()) as any[]).find((p) => p.is_me);
    if (!n || me?.canonical_name === n) return;
    if (me) await api.renamePerson(me.id, n);
    else {
      const fd = new FormData();
      fd.set("name", n);
      fd.set("is_me", "true");
      await api.enroll(fd);
    }
    notifyDataChanged();
  };
  const chooseTheme = (t: ThemeChoice) => { setTheme(t); applyTheme(t, true); };

  const lang = ((settings["transcript_lang"] as Lang) || "english") as Lang;
  const output = settings["audio_output"] === "speakers" ? "speakers" : "headphones";

  return (
    <>
      <Group label="You">
        <Row title="Your name" desc="Used for your lines in transcripts and action items.">
          <input type="text" value={meName} onChange={(e) => setMeName(e.target.value)} onBlur={() => void saveName()}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} placeholder="Me" aria-label="Your name" />
        </Row>
      </Group>

      <Group label="Recording">
        <Row title="Microphone">
          <select value={String(settings["mic_device_id"] ?? "")} onChange={(e) => void put({ mic_device_id: e.target.value })} aria-label="Microphone">
            <option value="">System default</option>
            {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label || "Microphone"}</option>)}
          </select>
        </Row>
        <Row title="Listening on" desc="On speakers your mic also hears the call; Sutra drops those copies from the transcript either way. Speakers also turns on the mic's echo cancellation.">
          <div className="mini-seg">
            <button aria-pressed={output === "headphones"} onClick={() => void put({ audio_output: "headphones" })}>Headphones</button>
            <button aria-pressed={output === "speakers"} onClick={() => void put({ audio_output: "speakers" })}>Speakers</button>
          </div>
        </Row>
        <Row title="Transcript language" desc={LANGS[lang]?.desc}>
          <select value={lang} onChange={(e) => void put({ transcript_lang: e.target.value })} aria-label="Transcript language">
            {(Object.keys(LANGS) as Lang[]).map((k) => <option key={k} value={k}>{LANGS[k].label}</option>)}
          </select>
        </Row>
      </Group>

      {desktop && prefs && (
        <Group label="Meetings">
          <SwitchRow title="Detect meetings" desc="Show a Record button at the top of the screen when a call starts."
            checked={prefs.detectMeetings} onChange={(v) => void putPrefs({ detectMeetings: v })} />
          <SwitchRow title="Stop when the call ends" desc="Finish the recording and write notes automatically."
            checked={prefs.autoStop} onChange={(v) => void putPrefs({ autoStop: v })} />
          <SwitchRow title="Take screenshots during meetings"
            desc="Sutra saves the screen when it changes (a new slide, code, a doc) and keeps the audio, encrypted on this Mac. Your AI engine sees them with the transcript to write better notes and keeps the screenshots that matter. The rest is deleted when you confirm the notes, or after 7 days."
            checked={!!prefs.captureScreen} onChange={(v) => void putPrefs({ captureScreen: v })} />
          {perms && desktop.platform === "darwin" && (
            <>
              <PermRow label="Microphone" status={perms.microphone} onGrant={() => void desktop!.permissions.request("microphone").then(() => desktop!.permissions.get().then(setPerms))} />
              <PermRow label="Screen & system audio" hint="Needed to hear the other people on the call and to spot meeting windows." status={perms.screen} onGrant={() => void desktop!.permissions.request("screen")} />
            </>
          )}
        </Group>
      )}

      <Group label="Appearance">
        <Row title="Theme">
          <div className="mini-seg">
            {(["system", "dark", "light"] as ThemeChoice[]).map((t) => (
              <button key={t} aria-pressed={theme === t} onClick={() => chooseTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
        </Row>
      </Group>

      <p className="faint" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, margin: "20px 2px 0" }}>
        <ShieldCheck size={14} /> Audio is transcribed in-flight and never stored. Notes live on this device.
      </p>
    </>
  );
}

function PermRow({ label, hint, status, onGrant }: { label: string; hint?: string; status: string; onGrant: () => void }) {
  return (
    <Row title={label} desc={hint}>
      {status === "granted" ? <span className="muted" style={{ fontSize: 13 }}>Allowed</span> : <button className="btn" onClick={onGrant}>Allow…</button>}
    </Row>
  );
}
