import { useEffect, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import { api } from "../local/sutra";
import { LANGS, type Lang } from "../providers";
import { desktop, type DesktopPrefs } from "../desktop/bridge";
import { applyTheme, readTheme, type ThemeChoice } from "./theme";
import { notifyDataChanged } from "./events";
import { Switch } from "./ui";
import { Intelligence } from "./Intelligence";

/** Everything configurable, on one sheet. Pipeline settings live in the on-device DB; desktop-only
 *  detection prefs live in the main process (so detection works before any window has loaded). */
export function SettingsSheet({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [meName, setMeName] = useState("");
  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  const [perms, setPerms] = useState<{ microphone: string; screen: string } | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);

  useEffect(() => {
    void api.getSettings().then(setSettings);
    void api.listPeople().then((ps: any[]) => setMeName(ps.find((p) => p.is_me)?.canonical_name ?? ""));
    navigator.mediaDevices?.enumerateDevices?.().then((ds) => setMics(ds.filter((d) => d.kind === "audioinput"))).catch(() => {});
    if (desktop) {
      void desktop.prefs.get().then(setPrefs);
      void desktop.permissions.get().then(setPerms);
    }
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const put = async (patch: Record<string, unknown>) => { setSettings(await api.putSettings(patch)); };
  const putPrefs = async (patch: Partial<DesktopPrefs>) => { if (desktop) setPrefs(await desktop.prefs.set(patch)); };
  const saveName = async () => {
    const n = meName.trim();
    const ps = (await api.listPeople()) as any[];
    const me = ps.find((p) => p.is_me);
    if (!n || me?.canonical_name === n) return;
    const fd = new FormData();
    fd.set("name", n);
    fd.set("is_me", "true");
    await api.enroll(fd);
    notifyDataChanged();
  };
  const chooseTheme = (t: ThemeChoice) => { setTheme(t); applyTheme(t, true); };

  const lang = ((settings?.["transcript_lang"] as Lang) || "english") as Lang;
  const output = settings?.["audio_output"] === "speakers" ? "speakers" : "headphones";

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="sheet-head">
          <h2>Settings</h2>
          <button className="icon-btn ghost sm" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="set-group">
          <div className="set-label">You</div>
          <div className="set-card">
            <div className="set-row">
              <div className="grow"><div className="t">Your name</div><div className="d">Used for your lines in transcripts and action items.</div></div>
              <input type="text" value={meName} onChange={(e) => setMeName(e.target.value)} onBlur={() => void saveName()} placeholder="Me" aria-label="Your name" />
            </div>
          </div>
        </div>

        <div className="set-group">
          <div className="set-label">Recording</div>
          <div className="set-card">
            <div className="set-row">
              <div className="grow"><div className="t">Microphone</div></div>
              <select value={String(settings?.["mic_device_id"] ?? "")} onChange={(e) => void put({ mic_device_id: e.target.value })} aria-label="Microphone">
                <option value="">System default</option>
                {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label || "Microphone"}</option>)}
              </select>
            </div>
            <div className="set-row">
              <div className="grow"><div className="t">Listening on</div><div className="d">Speakers turns on echo cancellation so the call isn't recorded twice.</div></div>
              <div className="mini-seg">
                <button aria-pressed={output === "headphones"} onClick={() => void put({ audio_output: "headphones" })}>Headphones</button>
                <button aria-pressed={output === "speakers"} onClick={() => void put({ audio_output: "speakers" })}>Speakers</button>
              </div>
            </div>
            <div className="set-row">
              <div className="grow"><div className="t">Transcript language</div><div className="d">{LANGS[lang]?.desc}</div></div>
              <select value={lang} onChange={(e) => void put({ transcript_lang: e.target.value })} aria-label="Transcript language">
                {(Object.keys(LANGS) as Lang[]).map((k) => <option key={k} value={k}>{LANGS[k].label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="set-group">
          <div className="set-label" style={{ marginBottom: 12 }}>Intelligence</div>
          {settings && <Intelligence settings={settings} onChange={(p) => put({ ...p, setup_engines: true })} />}
        </div>

        {desktop && prefs && (
          <div className="set-group">
            <div className="set-label">Meetings</div>
            <div className="set-card">
              <div className="set-row">
                <div className="grow"><div className="t">Detect meetings</div><div className="d">Show a Record button at the top of the screen when a call starts.</div></div>
                <Switch checked={prefs.detectMeetings} onChange={(v) => void putPrefs({ detectMeetings: v })} label="Detect meetings" />
              </div>
              <div className="set-row">
                <div className="grow"><div className="t">Stop when the call ends</div><div className="d">Finish the recording and write notes automatically.</div></div>
                <Switch checked={prefs.autoStop} onChange={(v) => void putPrefs({ autoStop: v })} label="Stop when the call ends" />
              </div>
              {perms && desktop.platform === "darwin" && (
                <>
                  <PermRow label="Microphone" status={perms.microphone} onGrant={() => void desktop!.permissions.request("microphone").then(() => desktop!.permissions.get().then(setPerms))} />
                  <PermRow label="Screen & system audio" hint="Needed to hear the other people on the call and to spot meeting windows." status={perms.screen} onGrant={() => void desktop!.permissions.request("screen")} />
                </>
              )}
            </div>
          </div>
        )}

        <div className="set-group">
          <div className="set-label">Appearance</div>
          <div className="set-card">
            <div className="set-row">
              <div className="grow"><div className="t">Theme</div></div>
              <div className="mini-seg">
                {(["system", "dark", "light"] as ThemeChoice[]).map((t) => (
                  <button key={t} aria-pressed={theme === t} onClick={() => chooseTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <p className="faint" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, margin: "20px 2px 0" }}>
          <ShieldCheck size={14} /> Audio is transcribed in-flight and never stored. Notes live on this device.
        </p>
      </div>
    </div>
  );
}

function PermRow({ label, hint, status, onGrant }: { label: string; hint?: string; status: string; onGrant: () => void }) {
  const ok = status === "granted";
  return (
    <div className="set-row">
      <div className="grow"><div className="t">{label}</div>{hint && <div className="d">{hint}</div>}</div>
      {ok ? <span className="muted" style={{ fontSize: 13 }}>Allowed</span> : <button className="btn" onClick={onGrant}>Allow…</button>}
    </div>
  );
}
