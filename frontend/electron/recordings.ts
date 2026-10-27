// The running app's media store (electron/recordingMedia.ts): IPC for the renderer, the 7-day sweep,
// and the agent side — screenshots decrypted into an agent's private temp dir for one run.
import { app, ipcMain, safeStorage } from "electron";
import { join } from "node:path";
import { KEEP_UNCONFIRMED_MS, MediaStore, loadKey } from "./recordingMedia";

let store: MediaStore | null = null;
export function media(): MediaStore {
  if (!store) {
    const root = join(app.getPath("userData"), "recordings");
    const key = loadKey(root, {
      get available() { return safeStorage.isEncryptionAvailable(); },
      seal: (b) => safeStorage.encryptString(b.toString("base64")).toString("base64"),
      open: (s) => Buffer.from(safeStorage.decryptString(Buffer.from(s, "base64")), "base64"),
    });
    store = new MediaStore(root, key);
  }
  return store;
}

const u8 = (v: unknown) => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(0));

export function registerRecordingIpc(): void {
  ipcMain.handle("sutra:media:frame", (_e, sid: number, at: number, bytes: Uint8Array, score: number) => media().saveFrame(sid, at, u8(bytes), score));
  ipcMain.handle("sutra:media:audio", (_e, sid: number, chunk: Uint8Array, mime: string) => media().appendAudio(sid, u8(chunk), mime));
  ipcMain.handle("sutra:media:status", (_e, sid: number) => media().status(sid));
  ipcMain.handle("sutra:media:frames", (_e, sid: number) => media().frames(sid));
  ipcMain.handle("sutra:media:readFrame", (_e, sid: number, name: string) => new Uint8Array(media().readFrame(sid, name)));
  ipcMain.handle("sutra:media:readAudio", (_e, sid: number) => {
    const a = media().readAudio(sid);
    return a ? { bytes: new Uint8Array(a.bytes), mime: a.mime } : null;
  });
  ipcMain.handle("sutra:media:keep", (_e, sid: number, name: string, cid: number) => media().keep(sid, name, cid));
  ipcMain.handle("sutra:media:readKept", (_e, cid: number, name: string) => new Uint8Array(media().readKept(cid, name)));
  ipcMain.handle("sutra:media:deleteKept", (_e, cid: number, name?: string) => media().deleteKept(cid, name));
  ipcMain.handle("sutra:media:deleteSession", (_e, sid: number) => media().deleteSession(sid));
  // Unconfirmed recordings are deleted after a week; check at launch and every few hours.
  const sweep = () => { try { media().sweep(KEEP_UNCONFIRMED_MS); } catch { /* best effort */ } };
  sweep();
  setInterval(sweep, 6 * 3600 * 1000).unref?.();
}
