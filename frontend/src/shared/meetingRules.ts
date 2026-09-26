// Meeting auto-detection — the PURE half. The Electron main process (electron/meetingDetector.ts)
// gathers raw observations from the OS every few seconds (which app is using the microphone, open
// browser tabs, window titles, running processes); everything that turns those into "Google Chrome
// is in a call" lives here so it is deterministic and unit-tested. No Electron, no Node, no DOM.
//
// Signals, strongest first:
//   1. mic consumer  — the OS says app X is recording from the mic right now (Windows registry,
//                      PulseAudio/PipeWire). The most reliable "in a call" signal where available.
//   2. meeting tab   — a browser tab is on a meeting URL (meet.google.com/abc-defg-hij, …).
//   3. process       — a process that only exists during a call (Zoom's CptHost).
//   4. window title  — "Zoom Meeting", "Meet - abc-defg-hij", "… | Microsoft Teams" call windows.
// macOS exposes no mic-consumer API without native code, so there 2–4 carry the detection.

export interface MicConsumer { name?: string; path?: string }
export interface BrowserTab { browser: string; url: string }
export interface WindowInfo { title: string; app?: string }

export interface Observation {
  micConsumers?: MicConsumer[];
  tabs?: BrowserTab[];
  windows?: WindowInfo[];
  /** Executable names or full paths of running processes. */
  processes?: string[];
}

export interface Detection {
  /** The app hosting the call, as people know it: "Google Chrome", "Zoom", "Microsoft Teams". */
  app: string;
  /** The meeting service when known: "Google Meet", "Zoom", "Microsoft Teams", … */
  service?: string;
  /** Path to the app/executable, for the OS icon (best-effort). */
  appPath?: string;
  source: "mic" | "tab" | "process" | "window";
  /** Stable identity for debouncing / dismissal. */
  key: string;
}

// ---- app naming -----------------------------------------------------------------------------------

const BROWSERS = new Set(["Google Chrome", "Microsoft Edge", "Firefox", "Safari", "Arc", "Brave Browser", "Chromium", "Opera", "Vivaldi"]);

/** Executable / bundle / package ids → the product name people recognise. Keys are lowercase. */
const KNOWN_APPS: Record<string, string> = {
  "chrome": "Google Chrome", "google chrome": "Google Chrome", "chrome.exe": "Google Chrome", "google-chrome": "Google Chrome",
  "msedge": "Microsoft Edge", "msedge.exe": "Microsoft Edge", "microsoft edge": "Microsoft Edge",
  "firefox": "Firefox", "firefox.exe": "Firefox", "safari": "Safari", "arc": "Arc", "arc.exe": "Arc",
  "brave": "Brave Browser", "brave.exe": "Brave Browser", "brave browser": "Brave Browser",
  "chromium": "Chromium", "chromium-browser": "Chromium", "opera": "Opera", "opera.exe": "Opera", "vivaldi": "Vivaldi", "vivaldi.exe": "Vivaldi",
  "zoom": "Zoom", "zoom.us": "Zoom", "zoom.exe": "Zoom", "cpthost": "Zoom", "cpthost.exe": "Zoom",
  "teams": "Microsoft Teams", "teams.exe": "Microsoft Teams", "ms-teams": "Microsoft Teams", "ms-teams.exe": "Microsoft Teams",
  "microsoft teams": "Microsoft Teams", "microsoft teams (work or school)": "Microsoft Teams", "msteams": "Microsoft Teams",
  "slack": "Slack", "slack.exe": "Slack", "discord": "Discord", "discord.exe": "Discord",
  "webex": "Webex", "webex.exe": "Webex", "ciscocollabhost": "Webex", "ciscocollabhost.exe": "Webex", "cisco webex meetings": "Webex",
  "facetime": "FaceTime", "whatsapp": "WhatsApp", "whatsapp.exe": "WhatsApp", "skype": "Skype", "skype.exe": "Skype",
  "telegram": "Telegram", "telegram.exe": "Telegram", "signal": "Signal", "signal.exe": "Signal",
  "gotomeeting": "GoTo Meeting", "g2mcomm.exe": "GoTo Meeting", "bluejeans": "BlueJeans", "ringcentral": "RingCentral",
};

/** Store-app package family prefixes (Windows "packaged" mic consumers). */
const PACKAGE_APPS: [RegExp, string][] = [
  [/^MSTeams_/i, "Microsoft Teams"], [/^MicrosoftTeams/i, "Microsoft Teams"], [/WhatsAppDesktop/i, "WhatsApp"],
  [/SkypeApp/i, "Skype"], [/Zoom/i, "Zoom"], [/Discord/i, "Discord"], [/Slack/i, "Slack"],
];

/** Apps that use the mic but are never "a call": ourselves, OS services, meters, dictation. */
const IGNORED = /(^|[\\/])(sutra|electron|coreaudiod|siri|dictation|pavucontrol|pulseaudio|pipewire|wireplumber|speech|voice ?memos|obs|audacity)(\.exe|\.app)?$/i;

/** Names that can host calls when they hold the mic (anything else is ignored as a mic consumer). */
const CALL_CAPABLE = new Set([...BROWSERS, "Zoom", "Microsoft Teams", "Slack", "Discord", "Webex", "FaceTime", "WhatsApp", "Skype", "Telegram", "Signal", "GoTo Meeting", "BlueJeans", "RingCentral"]);

/** Friendly app name from an executable path, a macOS bundle path, a Windows registry key, or a name. */
export function appName(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  // macOS bundle: …/Google Chrome.app/Contents/MacOS/Google Chrome → "Google Chrome"
  const bundle = s.match(/([^/]+)\.app(?:\/|$)/);
  if (bundle) return KNOWN_APPS[bundle[1].toLowerCase()] ?? bundle[1];
  for (const [re, name] of PACKAGE_APPS) if (re.test(s) && !/[\\/#]/.test(s)) return name;
  const base = s.split(/[\\/#]/).pop() ?? s;
  const known = KNOWN_APPS[base.toLowerCase()] ?? KNOWN_APPS[base.toLowerCase().replace(/\.exe$/, "")];
  if (known) return known;
  return base.replace(/\.exe$/i, "");
}

/** macOS: the .app bundle path for an executable path (for the icon); null elsewhere. */
export function bundlePath(execPath: string): string | null {
  const m = String(execPath ?? "").match(/^(.*?\.app)(?:\/|$)/);
  return m ? m[1] : null;
}

export const isBrowser = (name: string) => BROWSERS.has(name);

// ---- service rules ------------------------------------------------------------------------------

const URL_RULES: [RegExp, string][] = [
  [/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#]|$)/i, "Google Meet"],
  [/^https:\/\/([\w-]+\.)?zoom\.(us|com)\/wc\//i, "Zoom"],
  [/^https:\/\/app\.zoom\.us\/wc\//i, "Zoom"],
  [/^https:\/\/teams\.(microsoft|live)\.com\/.*(meetup-join|light-meetings|pre-join-calling|\/meet\/|calling|meetingjoin)/i, "Microsoft Teams"],
  [/^https:\/\/app\.slack\.com\/huddle\//i, "Slack Huddle"],
  [/^https:\/\/([\w-]+\.)?webex\.com\/(meet|wbxmjs|webappng)/i, "Webex"],
  [/^https:\/\/whereby\.com\/[\w-]+\/?(?:[?#]|$)/i, "Whereby"],
  [/^https:\/\/meet\.jit\.si\/[^/?#]+/i, "Jitsi Meet"],
  [/^https:\/\/around\.co\/r\//i, "Around"],
  [/^https:\/\/([\w-]+\.)?gather\.town\/app\//i, "Gather"],
];

const TITLE_RULES: [RegExp, string, string | null][] = [
  // [pattern, service, app when the title alone implies it (null → the window's own app / a browser)]
  [/^Zoom (Meeting|Webinar)\b/i, "Zoom", "Zoom"],
  [/^Meet\s*[-–—:]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}\b/i, "Google Meet", null],
  [/^Meet\s*[-–—]\s*\S/i, "Google Meet", null],
  [/\b(Meeting|Call)\b.*\|\s*Microsoft Teams/i, "Microsoft Teams", "Microsoft Teams"],
  [/^Microsoft Teams\s*[-–|]\s*.*\b(Meeting|Call)\b/i, "Microsoft Teams", "Microsoft Teams"],
  [/\bHuddle\b/i, "Slack Huddle", "Slack"],
  [/^(Cisco )?Webex( Meetings?)?\b.*(Meeting|Personal Room)/i, "Webex", "Webex"],
];

const PROCESS_RULES: [RegExp, string, string][] = [
  // Zoom spawns CptHost only while a meeting is in progress (macOS + Windows).
  [/(^|[\\/])CptHost(\.exe)?$/i, "Zoom", "Zoom"],
];

export function serviceForUrl(url: string): string | null {
  for (const [re, svc] of URL_RULES) if (re.test(url)) return svc;
  return null;
}

const key = (app: string, service?: string) => `${app}|${service ?? ""}`;

/** Decide whether a call is in progress from one round of observations. PURE. */
export function detectMeeting(obs: Observation): Detection | null {
  const tabs = obs.tabs ?? [];
  const tabHit = tabs.map((t) => ({ t, svc: serviceForUrl(t.url) })).find((x) => x.svc);

  // 1) mic consumers — the app actually holding the mic
  for (const c of obs.micConsumers ?? []) {
    const raw = c.path || c.name || "";
    if (!raw || IGNORED.test(raw) || IGNORED.test(c.name ?? "")) continue;
    const app = appName(c.name && !c.path ? c.name : raw);
    if (!CALL_CAPABLE.has(app)) continue;
    const svc = isBrowser(app) ? (tabHit && tabHit.t.browser === app ? tabHit.svc! : undefined) : app;
    return { app, service: svc, appPath: c.path, source: "mic", key: key(app, svc) };
  }

  // 2) a meeting URL open in a browser
  if (tabHit) return { app: tabHit.t.browser, service: tabHit.svc!, source: "tab", key: key(tabHit.t.browser, tabHit.svc!) };

  // 3) call-only processes
  for (const p of obs.processes ?? []) {
    for (const [re, svc, app] of PROCESS_RULES) {
      if (re.test(p)) return { app, service: svc, source: "process", key: key(app, svc) };
    }
  }

  // 4) window titles
  for (const w of obs.windows ?? []) {
    for (const [re, svc, fixedApp] of TITLE_RULES) {
      if (!re.test(w.title)) continue;
      const app = fixedApp ?? (w.app ? appName(w.app) : "Browser");
      return { app, service: svc, source: "window", key: key(app, svc) };
    }
  }
  return null;
}

// ---- debounce / dismissal state machine -----------------------------------------------------------

export interface TrackerUpdate {
  /** The call currently considered active (after debouncing), or null. */
  active: Detection | null;
  /** Whether the pill should offer to record (active and not dismissed). */
  visible: boolean;
  /** Set on the tick a previously-active call ends. */
  ended?: Detection;
  changed: boolean;
}

/**
 * Debounces raw per-tick detections so a flickering signal doesn't flash the pill: a call must be seen
 * `raiseAfter` consecutive ticks to become active and missed `clearAfter` consecutive ticks to end.
 * Dismissing hides the prompt for THIS call only — it re-arms once that call ends.
 */
export class DetectionTracker {
  private active: Detection | null = null;
  private pending: Detection | null = null;
  private hits = 0;
  private misses = 0;
  private dismissedKey: string | null = null;

  constructor(private readonly raiseAfter = 2, private readonly clearAfter = 3) {}

  update(det: Detection | null): TrackerUpdate {
    let changed = false;
    let ended: Detection | undefined;
    if (det) {
      this.misses = 0;
      if (this.active && this.active.key === det.key) {
        this.active = det; // refresh details (e.g. appPath) without a state change
      } else {
        if (this.pending?.key === det.key) this.hits++;
        else { this.pending = det; this.hits = 1; }
        if (this.hits >= this.raiseAfter) {
          if (this.active) ended = this.active;
          this.active = det;
          this.pending = null;
          this.hits = 0;
          changed = true;
        }
      }
    } else {
      this.pending = null;
      this.hits = 0;
      if (this.active && ++this.misses >= this.clearAfter) {
        ended = this.active;
        this.active = null;
        this.misses = 0;
        changed = true;
      }
    }
    if (ended && ended.key === this.dismissedKey) this.dismissedKey = null;
    return { active: this.active, visible: this.visible, ended, changed };
  }

  /** Hide the prompt for the current call (re-arms when it ends). */
  dismiss(): void {
    if (this.active) this.dismissedKey = this.active.key;
  }

  get visible(): boolean {
    return !!this.active && this.active.key !== this.dismissedKey;
  }

  get current(): Detection | null {
    return this.active;
  }
}

// ---- platform output parsers (pure; the detector feeds them raw command output) -------------------

/**
 * Windows: parse `reg query HKCU\…\CapabilityAccessManager\ConsentStore\microphone /s`. An app is using
 * the mic right now when its key has LastUsedTimeStart > 0 and LastUsedTimeStop == 0. NonPackaged keys
 * encode the exe path with '#' for '\'; packaged (Store) apps use their package family name.
 */
export function parseWindowsMicRegistry(text: string): MicConsumer[] {
  const out: MicConsumer[] = [];
  let keyName: string | null = null;
  let start = 0n, stop = -1n;
  const flush = () => {
    if (keyName && start > 0n && stop === 0n) {
      const leaf = keyName.split("\\").pop() ?? "";
      const isPath = leaf.includes("#");
      const path = isPath ? leaf.replace(/#/g, "\\") : undefined;
      out.push({ name: appName(isPath ? path! : leaf), path });
    }
    start = 0n; stop = -1n;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) { flush(); keyName = line.trim(); continue; }
    const m = line.match(/^\s*(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)/i);
    if (!m) continue;
    const v = BigInt("0x" + m[2]);
    if (m[1].toLowerCase() === "lastusedtimestart") start = v; else stop = v;
  }
  flush();
  // The parent "NonPackaged" key itself has no values; leaves only. Dedupe by name.
  const seen = new Set<string>();
  return out.filter((c) => c.name && !/^(NonPackaged|microphone)$/i.test(c.name) && !seen.has(c.name!) && (seen.add(c.name!), true));
}

/** Linux: parse `pactl list source-outputs` — every block is an app currently recording. */
export function parsePactlSourceOutputs(text: string): MicConsumer[] {
  const out: MicConsumer[] = [];
  for (const block of text.split(/\n(?=Source Output #)/)) {
    if (!/Source Output #/.test(block)) continue;
    if (/Corked:\s*yes/i.test(block)) continue; // paused stream
    const prop = (k: string) => block.match(new RegExp(`${k.replace(/\./g, "\\.")}\\s*=\\s*"([^"]*)"`))?.[1];
    const binary = prop("application.process.binary");
    const name = prop("application.name") || binary;
    if (!name) continue;
    if (/pavucontrol|pulseaudio|pipewire|peak detect/i.test(`${name} ${prop("application.id") ?? ""} ${prop("media.name") ?? ""}`)) continue;
    out.push({ name: appName(binary || name), path: binary });
  }
  return out;
}

/** Extract every http(s) URL from AppleScript/osascript list output ("url1, url2, url3"). */
export function parseUrlList(text: string): string[] {
  return (String(text ?? "").match(/https?:\/\/[^\s,]+/g) ?? []);
}
