// Electron preload bridge (ticket F2 — contextIsolation-safe meeting-capture signal).
// Runs in an isolated world and exposes ONLY a tiny, FROZEN presence marker on window.sutraDesktop.
// Its mere presence is the signal detectCaptureCapability() uses to choose ElectronCapture over
// BrowserCapture. No Node APIs, no ipcRenderer, no remote module is handed to the page (the security
// boundary; nodeIntegration is off). The loopback track itself is delivered through the main
// process's setDisplayMediaRequestHandler — no IPC plumbing is needed here.
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld(
  "sutraDesktop",
  Object.freeze({ isDesktop: true as const }),
);
