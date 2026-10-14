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
import { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, ipcMain, nativeImage, screen, session, shell, systemPreferences } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { initDesktopStorage } from "./storage";
import { userPath } from "./proc";
import { MeetingDetector } from "./meetingDetector";
import { detectAgents, runAgent, setEnabledEngines } from "./agents";
import { mcpInstall, mcpRemove, mcpSnippet, mcpStatus, type McpClientId } from "./mcpConnect";
import { cancelSpeechDownload, deleteSpeechModel, downloadSpeechModel, speechStatus, transcribeSpeech } from "./speech/service";
import { initPairing, stopPairing } from "./pairing";
import { macAppCandidates, type Detection, type TrackerUpdate } from "../src/shared/meetingRules";
import { isAgentId, type AgentId, type AgentRequest } from "../src/shared/agentProtocol";

const isMac = process.platform === "darwin";

// Name the app "Sutra" everywhere (menus, userData folder) — in dev Electron would call itself
// "Electron". The Dock label in `npm run dev` still reads "Electron" (it's Electron.app's own bundle
// name); the packaged app is "Sutra".
const legacyUserData = join(app.getPath("appData"), "sutra-frontend");
app.setName("Sutra");
// Windows: notifications and taskbar grouping are keyed by the AppUserModelID (must match electron-builder appId).
if (process.platform === "win32") app.setAppUserModelId("app.sutra.desktop");
// Dev builds used to store data under the package name; keep using it so nothing is orphaned.
if (existsSync(legacyUserData) && !existsSync(join(app.getPath("appData"), "Sutra"))) app.setPath("userData", legacyUserData);

// macOS system-audio loopback for getDisplayMedia goes through ScreenCaptureKit; these Chromium
// features gate it on current Electron builds (unknown feature names are ignored, so this is safe).
if (isMac) app.commandLine.appendSwitch("enable-features", "MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride");

// Dev-only: expose a DevTools Protocol port for headless inspection. Absent in packaged builds.
if (!app.isPackaged) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

// ---- preferences (main-process owned so detection works before any window loads) -------------------

interface Prefs { detectMeetings: boolean; autoStop: boolean; enabledEngines: AgentId[] | null }
const DEFAULT_PREFS: Prefs = { detectMeetings: true, autoStop: true, enabledEngines: null };
const prefsPath = () => join(app.getPath("userData"), "prefs.json");
let prefs: Prefs = { ...DEFAULT_PREFS };
function loadPrefs(): void {
  try { if (existsSync(prefsPath())) prefs = { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(prefsPath(), "utf8")) }; } catch { /* defaults */ }
  prefs.enabledEngines = Array.isArray(prefs.enabledEngines) ? prefs.enabledEngines.filter(isAgentId) : null;
  setEnabledEngines(prefs.enabledEngines);
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
/** The user hid the pill during a recording / note-writing (e.g. while sharing their screen). */
let pillHidden = false;
let doneTimer: NodeJS.Timeout | null = null;

const iconCache = new Map<string, string>();
async function appIcon(path?: string): Promise<string | undefined> {
  if (!path) return undefined;
  if (iconCache.has(path)) return iconCache.get(path);
  try {
    // macOS 26 apps (Chrome, Zoom…) ship icons getFileIcon can't read — it returns a blank placeholder.
    // Quick Look renders the real icon, as Finder shows it.
    // Follow links first (/Applications/Safari.app points into the system Cryptex), or Quick Look shows a file icon.
    const real = await realpath(path).catch(() => path);
    let img = isMac ? await nativeImage.createThumbnailFromPath(real, { width: 64, height: 64 }).catch(() => null) : null;
    if (!img || img.isEmpty()) img = await app.getFileIcon(real, { size: "normal" });
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
      : {
          // Windows/Linux: hide the title bar and let the OS draw only its window buttons over the top-right
          // corner (the sidebar and pane tops are drag regions), matching the frameless macOS look.
          autoHideMenuBar: true,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: "#00000000", symbolColor: "#a2a2aa", height: 44 },
        }),
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
  // Keep the pill out of screen shares and recordings, so a call never sees "Recording".
  win.setContentProtection(true);
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
  if (pillHidden && recorder.status !== "idle") return { ...base, mode: "hidden" };
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
  // Hidden only for what was on screen then: a new recording or the end of note-writing shows it again.
  if (snap.status === "idle" || (snap.status === "starting" && prev !== "starting")) pillHidden = false;
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
      : { label: detection.active ? `Record ${detection.active.app} call` : "Start recording", click: () => startRecording() },
    ...(pillHidden && recorder.status !== "idle" ? [{ label: "Show recording pill", click: () => { pillHidden = false; pushPill(); } }] : []),
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
  if ("enabledEngines" in patch) {
    patch = { ...patch, enabledEngines: Array.isArray(patch.enabledEngines) ? patch.enabledEngines.filter(isAgentId) : null };
    setEnabledEngines(patch.enabledEngines ?? null);
  }
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
      case "hide": pillHidden = true; pushPill(); break;
      case "open": {
        const cid = doneFlash?.conversationId ?? recorder.conversationId;
        doneFlash = null;
        showMain(recorder.status === "idle" && cid ? `/m/${cid}` : "/live");
        pushPill();
        break;
      }
    }
  });
  // Real app logos by name (Google Chrome, WhatsApp, Zoom…) for places that only know the app name.
  ipcMain.handle("sutra:icon", async (_e, name: string) => {
    if (typeof name !== "string" || !name || name.length > 80) return null;
    if (detection.active?.app === name && detection.active.icon) return detection.active.icon;
    if (!isMac) return null;
    const p = macAppCandidates(name).find((c) => existsSync(c));
    return (await appIcon(p)) ?? null;
  });

  // The user's AI agent CLIs (Claude Code, Codex, Cursor, Gemini, Grok, Droid, Command Code) as the text engine.
  ipcMain.handle("sutra:ai:detect", (_e, refresh?: boolean) => detectAgents(refresh === true));
  ipcMain.handle("sutra:ai:run", (_e, id: AgentId, req: AgentRequest) => {
    if (!isAgentId(id)) throw new Error("unknown AI engine");
    const schema = req?.schema && typeof req.schema === "object" ? req.schema : undefined;
    return runAgent(id, { system: String(req?.system ?? ""), user: String(req?.user ?? ""), schema, model: typeof req?.model === "string" ? req.model : null });
  });

  // On-device speech: transcription + speaker separation (electron/speech/*, runs in a utility process).
  ipcMain.handle("sutra:stt:status", () => speechStatus());
  ipcMain.handle("sutra:stt:download", (e, id: string) =>
    downloadSpeechModel(String(id), (p) => { if (!e.sender.isDestroyed()) e.sender.send("sutra:stt:progress", p); }));
  ipcMain.handle("sutra:stt:cancel", () => cancelSpeechDownload());
  ipcMain.handle("sutra:stt:delete", (_e, id: string) => deleteSpeechModel(String(id)));
  ipcMain.handle("sutra:stt:transcribe", (_e, wav: ArrayBuffer, opts: { model?: unknown; language?: unknown; speakers?: unknown }) =>
    transcribeSpeech(wav, { model: String(opts?.model ?? ""), language: typeof opts?.language === "string" ? opts.language : null, speakers: opts?.speakers !== false }));

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

// ---- settings: AI-tool connections (sutra:mcp:*) + backup files (sutra:backup:*) ------------------------
// Registered at load (ipcMain works before `ready`). The pairing token comes from the renderer, which
// owns it in the local DB; it's only used to write the configs the user asked for.

function registerMcpAndBackupIpc(): void {
  const tok = (t: unknown) => String(t ?? "");
  ipcMain.handle("sutra:mcp:status", (_e, token: string) => mcpStatus(tok(token)));
  ipcMain.handle("sutra:mcp:snippet", (_e, id: McpClientId | "other", token: string, url?: string) => mcpSnippet(id, tok(token), url));
  ipcMain.handle("sutra:mcp:install", (_e, id: McpClientId, token: string, url?: string) => mcpInstall(id, tok(token), url));
  ipcMain.handle("sutra:mcp:remove", (_e, id: McpClientId) => mcpRemove(id));
  ipcMain.handle("sutra:mcp:reveal", (_e, path: string) => { if (existsSync(String(path))) shell.showItemInFolder(String(path)); });

  // The backup is plaintext (it's the decrypted DB), so it's written 0600 to a place the user picks.
  ipcMain.handle("sutra:backup:save", async (e, json: string, filename: string) => {
    const owner = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts = { defaultPath: join(app.getPath("documents"), String(filename || "sutra-backup.json")), filters: [{ name: "Sutra backup", extensions: ["json"] }] };
    const r = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, String(json), { mode: 0o600 });
    return r.filePath;
  });
}
registerMcpAndBackupIpc();

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
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media" || permission === "notifications"));
    loadPrefs();
    void userPath(); // resolve the login-shell PATH once, up front, so Record never waits on it
    const dbError = initDesktopStorage();
    if (dbError) dialog.showErrorBox("Sutra can't open its database", dbError);
    if (isMac && !app.isPackaged) {
      const icon = join(__dirname, "../../public/icon-512.png");
      if (existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon));
    }
    registerIpc();
    // Phones paired in Settings → Phones send audio and AI jobs here (electron/pairing/*).
    initPairing(() => mainWin);
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
    void stopPairing();
  });
  app.on("window-all-closed", () => {
    // Windows are hidden, not closed, until quit — nothing to do here.
  });
}
