// Electron preload bridge (ticket F1 — minimal, contextIsolation-safe).
// Runs in an isolated world and exposes ONLY a tiny, frozen surface on window.sutraDesktop. Its mere
// presence is the signal detectCaptureCapability() uses to choose ElectronCapture over BrowserCapture.
// No Node APIs, no ipcRenderer, no remote module leak to the page — the real capture IPC channels are
// added in F2. Keeping this surface tiny is the security boundary (nodeIntegration is off).
import { contextBridge } from "electron";

const api = Object.freeze({
  /** Identifies the desktop shell to the shared renderer. */
  isDesktop: true as const,
  platform: process.platform,
  // TODO(F2): startMeetingCapture / stopMeetingCapture IPC methods (system loopback + mic).
});

contextBridge.exposeInMainWorld("sutraDesktop", api);
