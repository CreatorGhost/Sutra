// The Mac side of phone pairing, in one place: the stored identity + paired phones, the one live
// pairing offer, the LAN server and the relay connection, the live encrypted links, and what each
// phone request does. `ping` and `blob.put` are answered here; everything that needs the app's own
// code (speech, the AI engine, the library) is forwarded to the renderer through RendererExec.
//
// The LAN server only runs while it's allowed AND there is something to listen for (an open offer or
// at least one paired phone). No Electron imports — electron/pairing/index.ts wires this into the app.
import type { NetworkInterfaceInfo } from "node:os";
import { acceptPhone, type HostAuth, type LinkSocket, type SecureLink } from "../../src/shared/pairing/link";
import { encodePairLink, HANDSHAKE_MESSAGES, relayHostUrl, type HostEvent, type Method, type Route } from "../../src/shared/pairing/protocol";
import { fromUtf8 } from "../../src/shared/pairing/crypto";
import { BlobAssembler } from "./blobs";
import { lanAddresses, offerRoutes, OfferBook } from "./offers";
import { startLanServer, type LanServer } from "./lanServer";
import { RelayConnector, type RelayOptions } from "./relayConnector";
import type { RendererExec, ExecDevice } from "./rendererExec";
import type { PairingStore } from "./store";
import type { PairingStatus, PairingUpdate, Via } from "../../src/shared/pairing/hostApi";

export type { PairingStatus, PairingUpdate };

/** Live encrypted links one phone may hold (a reconnect can briefly overlap a dying one). */
export const MAX_LINKS_PER_DEVICE = 4;
/** Live links + handshakes in progress, across every phone and route. */
export const MAX_LINKS_TOTAL = 16;

export interface HostDeps {
  store: PairingStore;
  exec: RendererExec;
  hostName: () => string;
  appVersion: string;
  notify: (u: PairingUpdate) => void;
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  lanPort?: number;
  lanHost?: string;
  relay?: Pick<RelayOptions, "pingMs" | "backoff">;
}

interface Live { link: SecureLink; via: Via }

function validRelayUrl(url: string): boolean {
  if (/\s/.test(url)) return false;
  try { return !!new URL(relayHostUrl(url, "x")).hostname; } catch { return false; }
}

export class PairingHost {
  private readonly offers = new OfferBook();
  private readonly blobs = new BlobAssembler();
  private readonly relay: RelayConnector;
  private readonly links = new Map<string, Live[]>();
  private lan: LanServer | null = null;
  private lanError: string | null = null;
  private lanChain: Promise<void> = Promise.resolve();
  private handshakes = 0;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly d: HostDeps) {
    this.relay = new RelayConnector({ ...d.relay, onSocket: (s) => this.accept(s, "relay"), onState: () => this.changed() });
  }

  async start(): Promise<void> {
    this.applyRelay();
    await this.reconcileLan();
    this.sweeper = setInterval(() => this.blobs.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offers.cancel();
    this.relay.stop();
    for (const list of this.links.values()) for (const l of list) l.link.close("Mac quit");
    this.links.clear();
    await this.reconcileLan();
  }

  status(): PairingStatus {
    const { store } = this.d;
    const offer = this.offers.current();
    const relay = store.relay;
    return {
      hostId: store.hostId,
      hostName: this.d.hostName(),
      sealed: store.sealed,
      lan: { enabled: store.lanEnabled, listening: !!this.lan, port: this.lan?.port ?? null, addresses: lanAddresses(this.d.interfaces()), error: this.lanError },
      relay: { url: relay.url, hasSecret: !!relay.hostSecret, enabled: relay.enabled, state: this.relay.state },
      devices: store.devices().map((dev) => {
        const live = this.links.get(dev.id) ?? [];
        return { ...dev, connected: live.length > 0, via: [...new Set(live.map((l) => l.via))] };
      }),
      offer: offer ? { link: encodePairLink(offer), exp: offer.exp, routes: offer.routes } : null,
    };
  }

  private changed(extra?: Partial<PairingUpdate>): void {
    if (this.stopped) return;
    try { this.d.notify({ ...this.status(), ...extra }); } catch { /* window gone */ }
  }

  // ---- offers ----

  /** A fresh pairing offer (replacing any open one), listing every route a phone could use. */
  async newOffer(): Promise<PairingStatus> {
    const { store } = this.d;
    if (store.lanEnabled) await this.ensureLan();
    const relay = store.relay;
    const routes = offerRoutes({
      addresses: lanAddresses(this.d.interfaces()),
      port: store.lanEnabled ? this.lan?.port ?? null : null,
      relayBase: relay.enabled && relay.url && relay.hostSecret ? relay.url : null,
      hostId: store.hostId,
    });
    if (!routes.length) {
      throw new Error(store.lanEnabled
        ? (this.lanError ?? "This Mac isn't on a network right now. Connect to Wi-Fi, or set up your relay under Reach from anywhere.")
        : "Turn on “Allow phones on this Wi-Fi”, or set up your relay under Reach from anywhere, first.");
    }
    const offer = this.offers.create({ hostId: store.hostId, hostName: this.d.hostName(), hostKey: store.identity.publicKey }, routes);
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = setTimeout(() => { this.offerTimer = null; void this.reconcileLan(); }, Math.max(0, offer.exp - Date.now()) + 50);
    await this.reconcileLan();
    return this.status();
  }

  cancelOffer(): void {
    if (this.offerTimer) { clearTimeout(this.offerTimer); this.offerTimer = null; }
    this.offers.cancel();
    void this.reconcileLan();
  }

  // ---- settings ----

  async removeDevice(id: string): Promise<boolean> {
    const live = this.links.get(id) ?? [];
    this.links.delete(id);
    // Tell the phone first so it can show "removed on your Mac", then hang up.
    await Promise.all(live.map((l) => l.link.emit("revoked").catch(() => {}).then(() => l.link.close("revoked"))));
    this.blobs.dropOwner(id);
    const removed = this.d.store.removeDevice(id);
    await this.reconcileLan();
    return removed;
  }

  setRelay(patch: { url?: string; hostSecret?: string; enabled?: boolean }): PairingStatus {
    const url = patch.url?.trim();
    if (url && !validRelayUrl(url)) throw new Error("That doesn't look like a relay address. It should look like https://sutra-relay.you.workers.dev");
    this.d.store.setRelay(patch);
    this.applyRelay();
    this.changed();
    return this.status();
  }

  async setLan(on: boolean): Promise<PairingStatus> {
    this.d.store.setLan(on);
    await this.reconcileLan();
    return this.status();
  }

  /** Tell every connected phone something about this Mac changed (engines, speech model). */
  broadcast(e: HostEvent, data: unknown = null): void {
    for (const list of this.links.values()) for (const l of list) void l.link.emit(e, data).catch(() => {});
  }

  private applyRelay(): void {
    const r = this.d.store.relay;
    this.relay.configure(r.enabled && r.url && r.hostSecret ? { url: r.url, hostId: this.d.store.hostId, hostSecret: r.hostSecret } : null);
  }

  // ---- LAN server lifecycle ----

  private wantLan(): boolean {
    return !this.stopped && this.d.store.lanEnabled && (!!this.offers.current() || this.d.store.devices().length > 0);
  }

  private async openLan(): Promise<void> {
    if (this.lan || this.stopped) return;
    try {
      this.lan = await startLanServer((s) => this.accept(s, "lan"), { port: this.d.lanPort, host: this.d.lanHost });
      this.lanError = null;
    } catch (e: any) {
      this.lanError = `Couldn't open the local pairing port (${String(e?.code ?? e?.message ?? e)}).`;
    }
  }

  private ensureLan(): Promise<void> { return this.serialLan(() => this.openLan()); }

  private reconcileLan(): Promise<void> {
    return this.serialLan(async () => {
      if (this.wantLan()) await this.openLan();
      else if (this.lan) { const s = this.lan; this.lan = null; await s.close(); }
    }).then(() => this.changed());
  }

  private serialLan(fn: () => Promise<void>): Promise<void> {
    this.lanChain = this.lanChain.then(fn, fn);
    return this.lanChain;
  }

  // ---- connections ----

  private liveCount(): number {
    let n = this.handshakes;
    for (const list of this.links.values()) n += list.length;
    return n;
  }

  private auth(): HostAuth {
    const { store } = this.d;
    return {
      hostId: store.hostId,
      hostName: this.d.hostName(),
      identity: store.identity,
      consumeCode: (code) => this.offers.consume(code),
      registerDevice: async (dev) => store.addDevice(dev),
      linkKeyFor: async (id) => store.linkKeyFor(id),
    };
  }

  /** A new socket from the LAN server or a relay stream: handshake, then serve it. */
  accept(sock: LinkSocket, via: Via): void {
    if (this.stopped || this.liveCount() >= MAX_LINKS_TOTAL) { sock.close(1013, "busy"); return; }
    this.handshakes++;
    acceptPhone(sock, this.auth())
      .then((conn) => {
        const { link, deviceId } = conn;
        // Removed (or Sutra quitting) while this handshake was in flight.
        if (this.stopped || !this.d.store.device(deviceId)) {
          void link.emit("revoked").catch(() => {}).then(() => link.close("revoked"));
          return;
        }
        const list = this.links.get(deviceId) ?? [];
        // A phone that reconnects often leaves a dying link behind; drop the oldest beyond the cap.
        while (list.length >= MAX_LINKS_PER_DEVICE) list.shift()!.link.close("replaced");
        const live: Live = { link, via };
        list.push(live);
        this.links.set(deviceId, list);
        this.d.store.touch(deviceId);
        link.onRequest((m, p) => this.handle(deviceId, m, p));
        link.onClose(() => {
          const cur = this.links.get(deviceId);
          if (cur) {
            const rest = cur.filter((l) => l !== live);
            if (rest.length) this.links.set(deviceId, rest); else this.links.delete(deviceId);
          }
          this.d.store.touch(deviceId);
          this.changed();
        });
        if (conn.paired) {
          if (this.offerTimer) { clearTimeout(this.offerTimer); this.offerTimer = null; }
          void this.reconcileLan();
          this.changed({ paired: { id: deviceId, name: conn.deviceName ?? "Phone" } });
        } else {
          this.changed();
        }
      })
      .catch(() => { /* wrong code, unknown phone, timeout — the phone was told; nothing to log */ })
      .finally(() => { this.handshakes--; });
  }

  private async handle(deviceId: string, m: Method, p: unknown): Promise<unknown> {
    const dev = this.d.store.device(deviceId);
    if (!dev) throw new Error(HANDSHAKE_MESSAGES.unknown_device);
    const who: ExecDevice = { id: dev.id, name: dev.name, platform: dev.platform };
    const q = (p ?? {}) as Record<string, unknown>;
    switch (m) {
      case "ping":
        return { t: Date.now() };
      case "blob.put":
        return this.blobs.put(deviceId, p);
      case "host.info": {
        const r = (await this.d.exec.call("host.info", {}, who)) as Record<string, unknown>;
        return { ...r, hostName: this.d.hostName(), appVersion: this.d.appVersion };
      }
      case "stt.transcribe": {
        const audio = typeof q.blobId === "string" ? this.blobs.take(deviceId, q.blobId) : null;
        if (!audio) throw new Error("That recording didn't finish uploading to your Mac. Send it again.");
        return this.d.exec.call("stt.transcribe", { mime: String(q.mime ?? ""), filename: String(q.filename ?? "audio"), opts: q.opts ?? {} }, who, audio);
      }
      case "meetings.put": {
        // Small meetings travel inline; long ones as an uploaded blob of the bundle's JSON.
        let bundle = q.bundle;
        if (bundle === undefined && typeof q.blobId === "string") {
          const raw = this.blobs.take(deviceId, q.blobId);
          if (!raw) throw new Error("That meeting didn't finish uploading to your Mac. Send it again.");
          try { bundle = JSON.parse(fromUtf8(raw)); } catch { throw new Error("That meeting arrived damaged. Send it again."); }
        }
        return this.d.exec.call("meetings.put", { bundle }, who);
      }
      case "ai.call":
        return this.d.exec.call("ai.call", p, who);
    }
    throw new Error("Unknown request.");
  }
}
