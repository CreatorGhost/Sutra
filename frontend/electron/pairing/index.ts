// Phone pairing in the running app: the store under userData (sealed with safeStorage), the
// `sutra:pair:*` IPC behind desktop.pairing in the renderer, and the main window's renderer as the place
// forwarded phone requests run (it announces itself with `sutra:pair:ready`).
import { app, ipcMain, net, safeStorage, shell, type BrowserWindow, type WebContents } from "electron";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { PairingHost, type PairingUpdate } from "./host";
import { RendererExec, type ExecResult } from "./rendererExec";
import { PairingStore, type SecretBox, type StoreFile } from "./store";
import { RelaySetup } from "./relaySetup";
import { prepareWrangler } from "./wrangler";
import { classifyProbeError, classifyProbeStatus, parseDeployedRelay, type ProbeOutcome } from "../../src/shared/pairing/relaySetup";

/** One request with a hard timeout, through Chromium's network stack (system proxy + certificates). */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await net.fetch(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

async function probeRelay(url: string, hostId: string, secret: string): Promise<ProbeOutcome> {
  try {
    const r = await fetchWithTimeout(`${url.replace(/\/+$/, "")}/host/${encodeURIComponent(hostId)}`, { headers: { authorization: `Bearer ${secret}` }, cache: "no-store" }, 15_000);
    return classifyProbeStatus(r.status);
  } catch (e: any) {
    return classifyProbeError(String(e?.cause?.code ?? e?.code ?? e?.message ?? e));
  }
}

function jsonFile(path: string): StoreFile {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : null),
    write: (text) => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, path);
      try { chmodSync(path, 0o600); } catch { /* Windows: ACLs, not modes */ }
    },
  };
}

const keychain: SecretBox = {
  get available() { return safeStorage.isEncryptionAvailable(); },
  seal: (s) => safeStorage.encryptString(s).toString("base64"),
  open: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
};

/** "Aditya's MacBook" → what phones show for this computer. */
const hostDisplayName = () => hostname().replace(/\.(local|lan|home)$/i, "") || "Sutra";

let ready: Promise<PairingHost> | null = null;

/** Start pairing and register its IPC. Call once, after `app.whenReady()`. */
export function initPairing(getWin: () => BrowserWindow | null): void {
  if (ready) return;
  let renderer: WebContents | null = null;
  const exec = new RendererExec((m) => {
    if (!renderer || renderer.isDestroyed()) return false;
    renderer.send("sutra:pair:exec", m);
    return true;
  });
  const push = (u: PairingUpdate) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send("sutra:pair:changed", u);
  };
  let setup: RelaySetup | null = null;
  const pushSetup = () => {
    const w = getWin();
    if (setup && w && !w.isDestroyed()) w.webContents.send("sutra:relay:changed", setup.state);
  };
  ready = (async () => {
    const userData = app.getPath("userData");
    const store = await PairingStore.open(jsonFile(join(userData, "pairing.json")), keychain);
    // ponytail: phones connect only through the relay ("Reach from anywhere"); the same-Wi-Fi server stays
    // in host.ts but is switched off here. Turn it back on by deleting this line (and the Settings toggle).
    if (store.lanEnabled) store.setLan(false);
    const host = new PairingHost({
      store, exec, hostName: hostDisplayName, appVersion: app.getVersion(), interfaces: networkInterfaces,
      notify: (u) => { if (u.relay.state === "online") setup?.relayConnected(); push(u); },
    });
    const deployed = jsonFile(join(userData, "relay-deploy.json"));
    setup = new RelaySetup({
      prepare: (onProgress, workerName) => prepareWrangler({
        cacheDir: join(userData, "tools"), workerName, onProgress,
        fetchBytes: async (url) => {
          const r = await fetchWithTimeout(url, {}, 5 * 60_000);
          if (!r.ok) throw new Error(`nodejs.org answered ${r.status}`);
          return new Uint8Array(await r.arrayBuffer());
        },
      }),
      probe: (url, secret) => probeRelay(url, store.hostId, secret),
      cfApi: async (token, method, path, body) => {
        const r = await fetchWithTimeout(`https://api.cloudflare.com/client/v4${path}`, {
          method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }, 15_000);
        return { status: r.status, json: await r.json().catch(() => null) };
      },
      relay: () => store.relay,
      saveRelay: (p) => { host.setRelay(p); },
      readDeployed: () => parseDeployedRelay(deployed.read()),
      writeDeployed: (d) => deployed.write(d ? JSON.stringify(d, null, 2) : "{}"),
      openExternal: (url) => { if (/^https:\/\/[a-z0-9.-]*cloudflare\.com\//i.test(url)) void shell.openExternal(url); },
      onState: () => pushSetup(),
    });
    await host.start();
    return host;
  })();
  ready.catch((e) => console.error("[sutra] phone pairing unavailable:", String(e?.message ?? e)));
  const host = () => ready!;
  const fromMain = (wc: WebContents) => getWin()?.webContents === wc;

  ipcMain.handle("sutra:pair:status", async () => (await host()).status());
  ipcMain.handle("sutra:pair:newOffer", async () => (await host()).newOffer());
  ipcMain.handle("sutra:pair:cancelOffer", async () => { (await host()).cancelOffer(); });
  ipcMain.handle("sutra:pair:removeDevice", async (_e, id: unknown) => (await host()).removeDevice(String(id)));
  ipcMain.handle("sutra:pair:setRelay", async (_e, p: { url?: unknown; hostSecret?: unknown; enabled?: unknown }) =>
    (await host()).setRelay({
      url: typeof p?.url === "string" ? p.url : undefined,
      hostSecret: typeof p?.hostSecret === "string" ? p.hostSecret : undefined,
      enabled: typeof p?.enabled === "boolean" ? p.enabled : undefined,
    }));
  ipcMain.handle("sutra:pair:setLan", async (_e, on: unknown) => (await host()).setLan(on === true));

  // One-click "Reach from anywhere" (relaySetup.ts). Each answers with the state; changes are pushed.
  const relay = async () => { await host(); return setup!; };
  ipcMain.handle("sutra:relay:state", async () => (await relay()).state);
  ipcMain.handle("sutra:relay:start", async (_e, o: { rotateSecret?: unknown }) => { const r = await relay(); r.start({ rotateSecret: o?.rotateSecret === true }); return r.state; });
  ipcMain.handle("sutra:relay:chooseAccount", async (_e, id: unknown) => { const r = await relay(); r.chooseAccount(String(id)); return r.state; });
  ipcMain.handle("sutra:relay:continue", async () => { const r = await relay(); r.continueSetup(); return r.state; });
  ipcMain.handle("sutra:relay:remove", async (_e, o: { localOnly?: unknown }) => { const r = await relay(); r.remove({ localOnly: o?.localOnly === true }); return r.state; });
  ipcMain.handle("sutra:relay:cancel", async () => { const r = await relay(); r.cancel(); return r.state; });

  // The main window's renderer serves forwarded requests until it reloads or goes away.
  ipcMain.on("sutra:pair:ready", (e) => {
    if (!fromMain(e.sender) || renderer === e.sender) return;
    const wc = e.sender;
    renderer = wc;
    exec.setReady(true);
    const gone = () => { if (renderer === wc) { renderer = null; exec.setReady(false); } };
    wc.once("did-start-loading", gone);
    wc.once("render-process-gone", gone);
    wc.once("destroyed", gone);
  });
  ipcMain.on("sutra:pair:result", (e, r: ExecResult) => { if (e.sender === renderer) exec.settle(r); });
  ipcMain.on("sutra:pair:hostChanged", (e) => { if (fromMain(e.sender)) void host().then((h) => h.broadcast("host.changed")); });
}

/** Close the LAN server and the relay connection (on quit). */
export async function stopPairing(): Promise<void> {
  if (!ready) return;
  try { await (await ready).stop(); } catch { /* never block quitting */ }
}
