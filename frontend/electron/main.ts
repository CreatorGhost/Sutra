// Electron main process for the Sutra desktop app.
//
//   • Main window  — the notes app (the shared React renderer). Closing it HIDES it so meeting
//                    detection and an in-progress recording keep running; quit from the tray / ⌘Q.
//   • Pill window  — a small always-on-top capsule at the top-centre of the screen (Aside-style):
//                    "Google Chrome in call · ● Record ×" when a call is detected, a live timer + level
//                    while recording, then "Notes ready". Non-activating, visible on all Spaces.
//   • Detector     — electron/meetingDetector.ts polls the OS for an active call.
//   • Recording    — capture always runs in the MAIN window's renderer (it owns the DB + pipeline). The
//                    pill/tray start it with executeJavaScript(…, userGesture=true) because
//                    getDisplayMedia (system-audio loopback) requires a user activation.
//
// Security: contextIsolation ON, nodeIntegration OFF, sandbox ON; the renderer only sees the frozen
// preload bridge (electron/preload.ts).
import { app, BrowserWindow, Menu, Tray, desktopCapturer, ipcMain, nativeImage, screen, session, shell, systemPreferences } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initDesktopStorage } from "./storage";
import { MeetingDetector } from "./meetingDetector";
import type { Detection, TrackerUpdate } from "../src/shared/meetingRules";

const isMac = process.platform === "darwin";

// macOS system-audio loopback for getDisplayMedia goes through ScreenCaptureKit; these Chromium
// features gate it on current Electron builds (unknown feature names are ignored, so this is safe).
if (isMac) app.commandLine.appendSwitch("enable-features", "MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride");

// Dev-only: expose a DevTools Protocol port for headless inspection. Absent in packaged builds.
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

// ---- preferences (main-process owned so detection works before any window loads) -------------------

interface Prefs { detectMeetings: boolean; autoStop: boolean; }
const DEFAULT_PREFS: Prefs = { detectMeetings: true, autoStop: true };
const prefsPath = () => join(app.getPath("userData"), "prefs.json");
let prefs: Prefs = { ...DEFAULT_PREFS };
function loadPrefs(): void {
  try { if (existsSync(prefsPath())) prefs = { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(prefsPath(), "utf8")) }; } catch { /* defaults */ }
}
function savePrefs(): void {
  try { writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2)); } catch { /* best-effort */ }
}

// ---- shared state ------------------------------------------------------------------------------------

/** What the renderer's recorder publishes (src/app/recorder.tsx → RecorderSnapshot). */
interface RecorderSnapshot {
  status: "idle" | "starting" | "recording" | "processing";
  startedAt?: number | null;
  app?: string | null;
  level?: number;
  conversationId?: number | null;
  error?: string | null;
}

let mainWin: BrowserWindow | null = null;
let pillWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let quitAfterStop = false;
let recorder: RecorderSnapshot = { status: "idle" };
let detection: { active: (Detection & { icon?: string }) | null; visible: boolean } = { active: null, visible: false };
/** The call that was live when the current recording started — auto-stop fires when THAT call ends. */
let recordingCallKey: string | null = null;
/** "Notes ready" flash after a recording finishes. */
let doneFlash: { conversationId: number | null; until: number } | null = null;
let doneTimer: NodeJS.Timeout | null = null;

const iconCache = new Map<string, string>();
async function appIcon(path?: string): Promise<string | undefined> {
  if (!path) return undefined;
  if (iconCache.has(path)) return iconCache.get(path);
  try {
    const img = await app.getFileIcon(path, { size: "normal" });
    const url = img.isEmpty() ? "" : img.toDataURL();
    iconCache.set(path, url);
    return url || undefined;
  } catch {
    return undefined;
  }
}

function rendererUrl(view?: string): { url?: string; file?: string; query?: Record<string, string> } {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) return { url: view ? `${devUrl}?view=${view}` : devUrl };
  return { file: join(__dirname, "../renderer/index.html"), query: view ? { view } : undefined };
}
function load(win: BrowserWindow, view?: string): void {
  const r = rendererUrl(view);
  if (r.url) void win.loadURL(r.url);
  else void win.loadFile(r.file!, r.query ? { query: r.query } : undefined);
}

function harden(win: BrowserWindow): void {
  win.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith("file://");
    if (!allowed) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

// ---- main window ---------------------------------------------------------------------------------

function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: "Sutra",
    backgroundColor: isMac ? "#00000000" : "#111113",
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 20 }, vibrancy: "sidebar" as const, visualEffectState: "active" as const }
      : { autoHideMenuBar: true }),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // capture + uploads keep running while the window is hidden
    },
  });
  mainWin = win;
  harden(win);
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault(); // keep the renderer (recorder + pipeline) alive; detection keeps running
    win.hide();
  });
  win.on("closed", () => { mainWin = null; });

  // System-audio loopback for meeting capture: getDisplayMedia in the renderer is fulfilled with the
  // whole-system LOOPBACK audio and no picker. Electron requires a video source, which the renderer
  // drops immediately (audio only, never persisted).
  const ses = win.webContents.session;
  if (typeof ses.setDisplayMediaRequestHandler === "function") {
    ses.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => callback(sources[0] ? { video: sources[0], audio: "loopback" } : {}))
          .catch(() => callback({}));
      },
      { useSystemPicker: false },
    );
  }
  load(win);
}

function showMain(path?: string): void {
  if (!mainWin) createMainWindow();
  const w = mainWin!;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  if (path) w.webContents.send("sutra:navigate", path);
}

// ---- pill window ---------------------------------------------------------------------------------

const PILL_H = 64; // capsule (44) + room for its soft shadow
let pillWidth = 360;

function createPillWindow(): void {
  const win = new BrowserWindow({
    width: pillWidth,
    height: PILL_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: !isMac ? false : true,
    ...(isMac ? { type: "panel" as const } : {}),
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  pillWin = win;
  harden(win);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on("closed", () => { pillWin = null; });
  win.webContents.on("did-finish-load", () => pushPill());
  load(win, "pill");
}

function placePill(): void {
  if (!pillWin) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  const x = Math.round(wa.x + (wa.width - pillWidth) / 2);
  pillWin.setBounds({ x, y: wa.y + 6, width: pillWidth, height: PILL_H });
}

type PillMode = "hidden" | "detected" | "recording" | "processing" | "done";
function pillState(): { mode: PillMode; app?: string | null; service?: string; icon?: string; recorder: RecorderSnapshot; conversationId?: number | null } {
  const base = { recorder, app: detection.active?.app ?? recorder.app, service: detection.active?.service, icon: detection.active?.icon };
  if (recorder.status === "recording" || recorder.status === "starting") return { ...base, mode: "recording", app: recorder.app ?? base.app };
  if (recorder.status === "processing") return { ...base, mode: "processing", app: recorder.app ?? base.app };
  if (doneFlash && doneFlash.until > Date.now()) return { ...base, mode: "done", conversationId: doneFlash.conversationId };
  if (prefs.detectMeetings && detection.visible && detection.active) return { ...base, mode: "detected" };
  return { ...base, mode: "hidden" };
}

function pushPill(): void {
  const st = pillState();
  mainWin?.webContents.send("sutra:detection", { active: detection.active, visible: detection.visible && prefs.detectMeetings });
  refreshTray();
  if (!pillWin) return;
  pillWin.webContents.send("sutra:pill:state", st);
  if (st.mode === "hidden") {
    if (pillWin.isVisible()) pillWin.hide();
  } else if (!pillWin.isVisible()) {
    placePill();
    pillWin.showInactive();
  }
}

// ---- recorder control ------------------------------------------------------------------------------

function recorderCall(method: "start" | "stop", arg?: unknown): void {
  if (!mainWin) createMainWindow();
  const w = mainWin!;
  const js = `window.__sutraRecorder && window.__sutraRecorder.${method}(${arg === undefined ? "" : JSON.stringify(arg)})`;
  const exec = () => void w.webContents.executeJavaScript(js, true).catch(() => {});
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", () => setTimeout(exec, 300));
  else exec();
}

function startRecording(): void {
  recordingCallKey = detection.active?.key ?? null;
  recorderCall("start", { app: detection.active?.app ?? null });
}
function stopRecording(): void {
  recorderCall("stop");
}

function onRecorderState(snap: RecorderSnapshot): void {
  const prev = recorder.status;
  recorder = snap;
  if (prev === "processing" && snap.status === "idle" && !snap.error) {
    doneFlash = { conversationId: snap.conversationId ?? null, until: Date.now() + 9000 };
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => { doneFlash = null; pushPill(); }, 9100);
  }
  if (snap.status === "idle") recordingCallKey = null;
  pushPill();
  if (quitAfterStop && snap.status === "idle") { quitting = true; app.quit(); }
}

async function onDetection(up: TrackerUpdate): Promise<void> {
  const active = up.active ? { ...up.active, icon: await appIcon(up.active.appPath) } : null;
  detection = { active, visible: up.visible };
  // The call we were recording has ended → stop and write the notes.
  if (up.ended && prefs.autoStop && recorder.status === "recording" && recordingCallKey && up.ended.key === recordingCallKey) {
    stopRecording();
  }
  pushPill();
}

// ---- tray --------------------------------------------------------------------------------------------

function trayImage(): Electron.NativeImage {
  // macOS: a black "Template" image the menu bar recolours for light/dark; elsewhere a white glyph.
  // Electron picks up the @2x variant next to each file automatically on HiDPI screens.
  const name = isMac ? "trayTemplate.png" : "tray-light.png";
  for (const dir of [join(__dirname, "../renderer"), join(__dirname, "../../public")]) {
    const p = join(dir, name);
    if (existsSync(p)) return nativeImage.createFromPath(p);
  }
  return nativeImage.createEmpty();
}

function refreshTray(): void {
  if (!tray) return;
  const rec = recorder.status === "recording" || recorder.status === "starting";
  tray.setToolTip(rec ? "Sutra — recording" : detection.active ? `Sutra — ${detection.active.app} in call` : "Sutra");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Sutra", click: () => showMain() },
    { type: "separator" },
    rec
      ? { label: "Stop recording", click: () => stopRecording() }
      : { label: detection.active ? `Record ${detection.active.app} call` : "Start recording", enabled: recorder.status === "idle", click: () => startRecording() },
    { type: "separator" },
    { label: "Detect meetings automatically", type: "checkbox", checked: prefs.detectMeetings, click: (i) => setPrefs({ detectMeetings: i.checked }) },
    { label: "Stop when the call ends", type: "checkbox", checked: prefs.autoStop, click: (i) => setPrefs({ autoStop: i.checked }) },
    { type: "separator" },
    { label: "Quit Sutra", role: "quit" },
  ]));
}

// ---- detector + prefs ------------------------------------------------------------------------------

const detector = new MeetingDetector({ onChange: (up) => void onDetection(up) });

function setPrefs(patch: Partial<Prefs>): Prefs {
  prefs = { ...prefs, ...patch };
  savePrefs();
  if (prefs.detectMeetings) detector.start();
  else { detector.stop(); detection = { active: null, visible: false }; }
  pushPill();
  return prefs;
}

// ---- IPC ---------------------------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle("sutra:prefs:get", () => prefs);
  ipcMain.handle("sutra:prefs:set", (_e, patch: Partial<Prefs>) => setPrefs(patch ?? {}));
  ipcMain.handle("sutra:detection:get", () => ({ active: detection.active, visible: detection.visible && prefs.detectMeetings }));
  ipcMain.on("sutra:recorder:state", (_e, snap: RecorderSnapshot) => onRecorderState(snap ?? { status: "idle" }));
  ipcMain.on("sutra:pill:resize", (_e, width: number) => {
    const w = Math.max(200, Math.min(640, Math.round(Number(width) || 360)));
    if (w === pillWidth) return;
    pillWidth = w;
    if (pillWin?.isVisible()) placePill();
  });
  ipcMain.on("sutra:pill:action", (_e, a: { type: string }) => {
    switch (a?.type) {
      case "record": startRecording(); break;
      case "stop": stopRecording(); break;
      case "dismiss": detector.dismiss(); break;
      case "open": {
        const cid = doneFlash?.conversationId ?? recorder.conversationId;
        doneFlash = null;
        showMain(recorder.status === "idle" && cid ? `/m/${cid}` : "/live");
        pushPill();
        break;
      }
    }
  });
  ipcMain.handle("sutra:permissions:get", () => ({
    microphone: isMac || process.platform === "win32" ? systemPreferences.getMediaAccessStatus("microphone") : "granted",
    screen: isMac ? systemPreferences.getMediaAccessStatus("screen") : "granted",
  }));
  ipcMain.handle("sutra:permissions:request", async (_e, kind: "microphone" | "screen") => {
    if (!isMac) return true;
    if (kind === "microphone") return systemPreferences.askForMediaAccess("microphone");
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    return false;
  });
}

// ---- lifecycle -----------------------------------------------------------------------------------------

async function initAutoUpdate(): Promise<void> {
  if (!app.isPackaged) return; // inert in dev (no app-update.yml)
  try {
    const { autoUpdater } = await import("electron-updater");
    await autoUpdater.checkForUpdatesAndNotify();
  } catch {
    /* offline / no feed — never block the app */
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMain());

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
    loadPrefs();
    initDesktopStorage();
    registerIpc();
    createMainWindow();
    createPillWindow();
    tray = new Tray(trayImage());
    tray.on("click", () => { if (!isMac) showMain(); });
    refreshTray();
    if (prefs.detectMeetings) detector.start();
    screen.on("display-metrics-changed", () => placePill());
    void initAutoUpdate();

    app.on("activate", () => showMain());
  });

  // Quitting mid-recording: stop first so the last window is transcribed and the notes get written
  // (the turns are already saved, so a later launch would recover anyway — this just avoids the wait).
  app.on("before-quit", (e) => {
    const busy = recorder.status === "recording" || recorder.status === "starting" || recorder.status === "processing";
    if (!quitting && busy && !quitAfterStop) {
      e.preventDefault();
      quitAfterStop = true;
      if (recorder.status !== "processing") stopRecording();
      setTimeout(() => { quitting = true; app.quit(); }, 60000); // never hang the quit forever
      return;
    }
    quitting = true;
    detector.stop();
  });
  app.on("window-all-closed", () => {
    // Windows are hidden, not closed, until quit — nothing to do here.
  });
}
