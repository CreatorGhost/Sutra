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
      action: (type: "record" | "stop" | "dismiss" | "open" | "hide") => ipcRenderer.send("sutra:pill:action", { type }),
      resize: (width: number) => ipcRenderer.send("sutra:pill:resize", width),
      hover: (on: boolean) => ipcRenderer.send("sutra:pill:hover", on === true),
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
      detect: (refresh?: boolean) => ipcRenderer.invoke("sutra:ai:detect", refresh === true),
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
    mcp: Object.freeze({
      status: (token: string) => ipcRenderer.invoke("sutra:mcp:status", token),
      snippet: (id: string, token: string, url?: string) => ipcRenderer.invoke("sutra:mcp:snippet", id, token, url),
      install: (id: string, token: string, url?: string) => ipcRenderer.invoke("sutra:mcp:install", id, token, url),
      remove: (id: string) => ipcRenderer.invoke("sutra:mcp:remove", id),
      reveal: (path: string) => ipcRenderer.invoke("sutra:mcp:reveal", path),
    }),
    pairing: Object.freeze({
      status: () => ipcRenderer.invoke("sutra:pair:status"),
      newOffer: () => ipcRenderer.invoke("sutra:pair:newOffer"),
      cancelOffer: () => ipcRenderer.invoke("sutra:pair:cancelOffer"),
      removeDevice: (id: string) => ipcRenderer.invoke("sutra:pair:removeDevice", id),
      setRelay: (p: unknown) => ipcRenderer.invoke("sutra:pair:setRelay", p),
      setLan: (on: boolean) => ipcRenderer.invoke("sutra:pair:setLan", on === true),
      onChange: (cb: (u: unknown) => void) => listen("sutra:pair:changed", cb),
      // The host side of phone requests (src/app/pairing/hostExecutor.ts).
      serve: (cb: (req: unknown) => void) => {
        const off = listen("sutra:pair:exec", cb);
        ipcRenderer.send("sutra:pair:ready");
        return off;
      },
      result: (r: unknown) => ipcRenderer.send("sutra:pair:result", r),
      hostChanged: () => ipcRenderer.send("sutra:pair:hostChanged"),
      // One-click relay on the user's own Cloudflare account (electron/pairing/relaySetup.ts).
      relay: Object.freeze({
        state: () => ipcRenderer.invoke("sutra:relay:state"),
        start: (o?: { rotateSecret?: boolean }) => ipcRenderer.invoke("sutra:relay:start", { rotateSecret: o?.rotateSecret === true }),
        chooseAccount: (id: string) => ipcRenderer.invoke("sutra:relay:chooseAccount", String(id)),
        continueSetup: () => ipcRenderer.invoke("sutra:relay:continue"),
        remove: (o?: { localOnly?: boolean }) => ipcRenderer.invoke("sutra:relay:remove", { localOnly: o?.localOnly === true }),
        cancel: () => ipcRenderer.invoke("sutra:relay:cancel"),
        onChange: (cb: (s: unknown) => void) => listen("sutra:relay:changed", cb),
      }),
    }),
    // A meeting's screenshots + audio until the notes are confirmed (electron/recordings.ts).
    media: Object.freeze({
      frame: (sid: number, at: number, bytes: Uint8Array, score: number) => ipcRenderer.invoke("sutra:media:frame", sid, at, bytes, score),
      audio: (sid: number, chunk: Uint8Array, mime: string) => ipcRenderer.invoke("sutra:media:audio", sid, chunk, mime),
      status: (sid: number) => ipcRenderer.invoke("sutra:media:status", sid),
      frames: (sid: number) => ipcRenderer.invoke("sutra:media:frames", sid),
      readFrame: (sid: number, name: string) => ipcRenderer.invoke("sutra:media:readFrame", sid, name),
      readAudio: (sid: number) => ipcRenderer.invoke("sutra:media:readAudio", sid),
      keep: (sid: number, name: string, cid: number) => ipcRenderer.invoke("sutra:media:keep", sid, name, cid),
      readKept: (cid: number, name: string) => ipcRenderer.invoke("sutra:media:readKept", cid, name),
      deleteKept: (cid: number, name?: string) => ipcRenderer.invoke("sutra:media:deleteKept", cid, name),
      deleteSession: (sid: number) => ipcRenderer.invoke("sutra:media:deleteSession", sid),
    }),
    // Code folders linked to projects (electron/projectFolders.ts).
    folders: Object.freeze({
      pick: () => ipcRenderer.invoke("sutra:folders:pick"),
      forget: (path: string) => ipcRenderer.invoke("sutra:folders:forget", String(path)),
      scan: (path: string) => ipcRenderer.invoke("sutra:folders:scan", String(path)),
      writeAgents: (path: string, content: string) => ipcRenderer.invoke("sutra:folders:writeAgents", String(path), String(content)),
      reveal: (path: string, rel?: string) => ipcRenderer.invoke("sutra:folders:reveal", String(path), rel == null ? undefined : String(rel)),
    }),
    backup: Object.freeze({
      save: (json: string, filename: string) => ipcRenderer.invoke("sutra:backup:save", json, filename),
    }),
    onNavigate: (cb: (path: string) => void) => listen("sutra:navigate", cb),
  }),
);
