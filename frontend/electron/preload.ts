// Electron preload bridge (ticket F2 capture signal + F5 storage channel).
// Runs in an isolated world and exposes ONLY a tiny, FROZEN object on window.sutraDesktop:
//   • isDesktop — the presence marker detectCaptureCapability() uses to choose ElectronCapture over
//     BrowserCapture (and the storage factory uses to choose the desktop adapter).
//   • db — a single typed invoke channel to the main process's `sutra:db` handler, the ONLY surface
//     the renderer's desktop StorageProvider proxy (src/storage/electronStorage.ts) uses to forward
//     q/run/exec/persist. No raw ipcRenderer, no Node APIs, no remote module reaches the page (the
//     security boundary; nodeIntegration is off). The SQLCipher key never crosses this bridge — only
//     SQL + rows do; the key stays in the main process (electron/storage.ts).
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "sutraDesktop",
  Object.freeze({
    isDesktop: true as const,
    db: (op: "q" | "run" | "exec" | "persist", sql: string, params: unknown[]) =>
      ipcRenderer.invoke("sutra:db", op, sql, params),
  }),
);
