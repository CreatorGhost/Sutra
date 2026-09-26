// Meeting auto-detection — the platform I/O half (main process only). Every few seconds it gathers
// cheap observations from the OS and hands them to the PURE rules in src/shared/meetingRules.ts.
//
//   Windows : mic consumers from the privacy consent store (registry) + window titles + tasklist
//   Linux   : mic consumers from PulseAudio/PipeWire (pactl) + window titles (X11 only) + ps
//   macOS   : meeting tabs in running browsers (AppleScript; asks for Automation permission once per
//             browser) + window titles (once Screen Recording is granted, which loopback capture needs
//             anyway) + ps (Zoom's CptHost). macOS has no mic-consumer API without native code.
//
// Nothing here records audio; it only reads app/window/tab NAMES, and nothing it reads is stored.
import { desktopCapturer, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import {
  DetectionTracker,
  appName,
  bundlePath,
  detectMeeting,
  parsePactlSourceOutputs,
  parseUrlList,
  parseWindowsMicRegistry,
  type BrowserTab,
  type Detection,
  type Observation,
  type TrackerUpdate,
} from "../src/shared/meetingRules";

const run = (cmd: string, args: string[], timeout = 2500) =>
  new Promise<string>((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });

// ---- macOS browser tabs ---------------------------------------------------------------------------

/** Scriptable browsers: [app name as AppleScript knows it, bundle marker seen in `ps` paths]. */
const MAC_BROWSERS: [string, string][] = [
  ["Google Chrome", "/Google Chrome.app/"], ["Arc", "/Arc.app/"], ["Microsoft Edge", "/Microsoft Edge.app/"],
  ["Brave Browser", "/Brave Browser.app/"], ["Chromium", "/Chromium.app/"], ["Vivaldi", "/Vivaldi.app/"], ["Safari", "/Safari.app/"],
];
/** Browsers whose Automation permission was denied — never ask again this run. */
const deniedBrowsers = new Set<string>();

async function macTabs(processes: string[]): Promise<BrowserTab[]> {
  const tabs: BrowserTab[] = [];
  for (const [browser, marker] of MAC_BROWSERS) {
    // Only query browsers that are ALREADY running — `tell application` would otherwise launch them.
    if (deniedBrowsers.has(browser) || !processes.some((p) => p.includes(marker))) continue;
    const script = `tell application "${browser}" to get URL of every tab of every window`;
    const out = await new Promise<string>((resolve) => {
      execFile("osascript", ["-e", script], { timeout: 2500 }, (err, stdout, stderr) => {
        if (err && /-1743|not allowed|Not authorized/i.test(String(stderr) + String(err.message))) deniedBrowsers.add(browser);
        resolve(err ? "" : String(stdout));
      });
    });
    for (const url of parseUrlList(out)) tabs.push({ browser, url });
  }
  return tabs;
}

// ---- window titles --------------------------------------------------------------------------------

async function windowTitles(): Promise<{ title: string }[]> {
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") return [];
  if (process.platform === "linux" && process.env["XDG_SESSION_TYPE"] === "wayland") return []; // would open the portal picker
  try {
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    return sources.map((s) => ({ title: s.name }));
  } catch {
    return [];
  }
}

// ---- per-platform observation ---------------------------------------------------------------------

async function observe(): Promise<Observation> {
  if (process.platform === "win32") {
    const [reg, titles, tasks] = await Promise.all([
      run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone", "/s"]),
      windowTitles(),
      run("tasklist", ["/fo", "csv", "/nh"]),
    ]);
    const processes = tasks.split(/\r?\n/).map((l) => l.split(",")[0]?.replace(/"/g, "") ?? "").filter(Boolean);
    return { micConsumers: parseWindowsMicRegistry(reg), windows: titles, processes };
  }
  if (process.platform === "linux") {
    const [pactl, titles, ps] = await Promise.all([run("pactl", ["list", "source-outputs"]), windowTitles(), run("ps", ["-eo", "comm="])]);
    return { micConsumers: parsePactlSourceOutputs(pactl), windows: titles, processes: ps.split("\n").map((s) => s.trim()).filter(Boolean) };
  }
  // macOS
  const ps = await run("ps", ["-Axo", "comm="]);
  const processes = ps.split("\n").map((s) => s.trim()).filter(Boolean);
  const [tabs, titles] = await Promise.all([macTabs(processes), windowTitles()]);
  return { tabs, windows: titles, processes };
}

/** Best-effort path to the app's bundle/executable so the pill can show its real icon. */
function resolveAppPath(det: Detection, processes: string[] = []): string | undefined {
  if (det.appPath) return process.platform === "darwin" ? (bundlePath(det.appPath) ?? det.appPath) : det.appPath;
  if (process.platform !== "darwin") return undefined;
  const hit = processes.find((p) => bundlePath(p) && appName(p) === det.app);
  return hit ? bundlePath(hit) ?? undefined : undefined;
}

// ---- the loop -------------------------------------------------------------------------------------

export interface MeetingDetectorOptions {
  intervalMs?: number;
  onChange: (update: TrackerUpdate) => void;
}

export class MeetingDetector {
  private readonly tracker = new DetectionTracker(2, 3);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly intervalMs: number;

  constructor(private readonly opts: MeetingDetectorOptions) {
    this.intervalMs = opts.intervalMs ?? 3000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer != null;
  }

  dismiss(): void {
    this.tracker.dismiss();
    this.opts.onChange({ active: this.tracker.current, visible: this.tracker.visible, changed: true });
  }

  get state(): { active: Detection | null; visible: boolean } {
    return { active: this.tracker.current, visible: this.tracker.visible };
  }

  private async tick(): Promise<void> {
    if (this.busy) return; // a slow probe must never stack up
    this.busy = true;
    try {
      const obs = await observe();
      const det = detectMeeting(obs);
      if (det) det.appPath = resolveAppPath(det, obs.processes);
      const up = this.tracker.update(det);
      if (up.changed) this.opts.onChange(up);
    } catch {
      /* detection is best-effort; try again next tick */
    } finally {
      this.busy = false;
    }
  }
}
