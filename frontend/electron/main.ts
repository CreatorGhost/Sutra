// Electron main process for the Sutra desktop shell (ticket F1 — scaffold only).
// Loads the EXISTING frontend/src renderer verbatim (same index.html / #root / App) so the UI is
// shared, not forked. Security: contextIsolation ON, nodeIntegration OFF — the renderer talks to the
// main process only through the minimal preload bridge (electron/preload.ts).
//
// The system-audio loopback handler (setDisplayMediaRequestHandler) is registered here as the F2
// landing point; for F1 it just resolves the request so the wiring compiles and is testable.
import { app, BrowserWindow, session } from "electron";
import { join } from "node:path";
import { initDesktopStorage } from "./storage";

// Auto-update (ticket F7). electron-updater pulls signed releases from the electron-builder `publish`
// provider and prompts to install on next launch. Gated behind app.isPackaged so it is INERT in dev
// (`npm run dev`) — checkForUpdatesAndNotify would otherwise throw on the missing app-update.yml — and
// active only inside a packaged build. Loaded lazily so dev never touches the native updater.
async function initAutoUpdate(): Promise<void> {
  if (!app.isPackaged) return; // inert in dev
  try {
    const { autoUpdater } = await import("electron-updater");
    await autoUpdater.checkForUpdatesAndNotify();
  } catch {
    // Best-effort: a missing update feed / offline launch must never block the app.
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 540,
    backgroundColor: "#0a0912",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Harden: keep the app on its own renderer. Block in-window navigation to external origins and
  // open any window.open()/external link in the OS browser instead of a node-less child window.
  win.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith("file://");
    if (!allowed) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // System-audio loopback for meeting capture (ticket F2). When the renderer calls getDisplayMedia,
  // this handler fulfils the request with a whole-system LOOPBACK audio source (Core Audio tap /
  // WASAPI / PipeWire) and NO screen-picker dialog (useSystemPicker:false). The renderer's
  // ElectronCapture then merges that system track with the mic into two channels. video:false would
  // be ideal but Electron requires a video constraint for display-media; the renderer drops the
  // video track and keeps audio only (audio is never persisted).
  const ses = win.webContents.session;
  if (typeof ses.setDisplayMediaRequestHandler === "function") {
    ses.setDisplayMediaRequestHandler(
      (_request, callback) => {
        // 'loopback' = capture the system audio output stream directly (pre-output-device, so
        // headphones/speakers are irrelevant — see spec §3).
        callback({ audio: "loopback" });
      },
      { useSystemPicker: false },
    );
  }

  // electron-vite exposes the renderer dev-server URL here in `dev`; it's unset in a packaged build.
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  // Harden: refuse permission requests the desktop app doesn't need (geolocation, etc.).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media");
  });

  // Open the encrypted desktop DB (better-sqlite3 + safeStorage key) and register the `sutra:db` IPC
  // handler the renderer's StorageProvider proxy forwards q/run/exec/persist to (ticket F5).
  initDesktopStorage();

  createWindow();

  // Check for updates after the window is up (inert in dev; active in a packaged build).
  void initAutoUpdate();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
