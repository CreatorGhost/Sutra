// Electron preload bridge. Runs in an isolated world and exposes ONE frozen object,
// window.sutraDesktop, to the renderer — typed invoke/send channels only; no raw ipcRenderer, no Node
// APIs. The SQLCipher key never crosses this bridge (only SQL + rows do). The renderer-side types live
// in src/desktop/bridge.ts.
import { contextBridge, ipcRenderer } from "electron";

type Unsub = () => void;
function listen<T>(channel: string, cb: (v: T) => void): Unsub {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

contextBridge.exposeInMainWorld(
  "sutraDesktop",
  Object.freeze({
    isDesktop: true as const,
    platform: process.platform,
    db: (op: "q" | "run" | "exec" | "persist", sql: string, params: unknown[]) =>
      ipcRenderer.invoke("sutra:db", op, sql, params),
    detection: Object.freeze({
      get: () => ipcRenderer.invoke("sutra:detection:get"),
      onChange: (cb: (s: unknown) => void) => listen("sutra:detection", cb),
    }),
    recorder: Object.freeze({
      publish: (snapshot: unknown) => ipcRenderer.send("sutra:recorder:state", snapshot),
    }),
    pill: Object.freeze({
      onState: (cb: (s: unknown) => void) => listen("sutra:pill:state", cb),
      action: (type: "record" | "stop" | "dismiss" | "open") => ipcRenderer.send("sutra:pill:action", { type }),
      resize: (width: number) => ipcRenderer.send("sutra:pill:resize", width),
    }),
    prefs: Object.freeze({
      get: () => ipcRenderer.invoke("sutra:prefs:get"),
      set: (patch: unknown) => ipcRenderer.invoke("sutra:prefs:set", patch),
    }),
    permissions: Object.freeze({
      get: () => ipcRenderer.invoke("sutra:permissions:get"),
      request: (kind: "microphone" | "screen") => ipcRenderer.invoke("sutra:permissions:request", kind),
    }),
    icon: (appName: string) => ipcRenderer.invoke("sutra:icon", appName),
    ai: Object.freeze({
      detect: () => ipcRenderer.invoke("sutra:ai:detect"),
      run: (id: string, req: unknown) => ipcRenderer.invoke("sutra:ai:run", id, req),
    }),
    stt: Object.freeze({
      status: () => ipcRenderer.invoke("sutra:stt:status"),
      download: (id: string) => ipcRenderer.invoke("sutra:stt:download", id),
      cancel: () => ipcRenderer.invoke("sutra:stt:cancel"),
      remove: (id: string) => ipcRenderer.invoke("sutra:stt:delete", id),
      transcribe: (wav: ArrayBuffer, opts: unknown) => ipcRenderer.invoke("sutra:stt:transcribe", wav, opts),
      onProgress: (cb: (p: unknown) => void) => listen("sutra:stt:progress", cb),
    }),
    onNavigate: (cb: (path: string) => void) => listen("sutra:navigate", cb),
  }),
);
