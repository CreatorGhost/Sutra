// Paired phones, the Mac's pairing identity and the reach-from-anywhere settings — MAIN process.
//
// Kept in <userData>/pairing.json (0600). The private material — the identity's private key, every
// phone's link key and the relay's host secret — is sealed with the OS keychain (Electron safeStorage)
// when it's available, and stored plain, flagged `sealed: false`, when it isn't (some Linux desktops).
// A file sealed under a keychain we can no longer open is started over: phones simply pair again.
// Pure apart from the injected file + secret box, so it's unit-tested without Electron.
import { b64u, generateIdentity, randomBytes, type Identity } from "../../src/shared/pairing/crypto";

/** Seals short secrets for storage (safeStorage in the app). */
export interface SecretBox { readonly available: boolean; seal(plain: string): string; open(sealed: string): string }
/** Where the JSON lives (an atomic 0600 write in the app). */
export interface StoreFile { read(): string | null; write(text: string): void }

export interface PairedDevice {
  id: string;
  name: string;
  platform: string;
  deviceKey: string;
  linkKey: string;
  pairedAt: number;
  lastSeenAt: number | null;
}
/** What the UI may see about a phone (no keys). */
export type DeviceSummary = Pick<PairedDevice, "id" | "name" | "platform" | "pairedAt" | "lastSeenAt">;
export interface RelaySettings { url: string; hostSecret: string | null; enabled: boolean }

interface Disk {
  v: 1;
  sealed: boolean;
  hostId: string;
  identity: { publicKey: string; privateJwk: string };
  devices: PairedDevice[];
  relay: RelaySettings;
  lanEnabled: boolean;
}

/** More than anyone needs; keeps a runaway pairing loop from growing the file forever. */
export const MAX_PAIRED_DEVICES = 32;

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class PairingStore {
  private constructor(
    private readonly file: StoreFile,
    private readonly box: SecretBox,
    readonly hostId: string,
    readonly identity: Identity,
    private list: PairedDevice[],
    private relaySettings: RelaySettings,
    private lan: boolean,
  ) {}

  /** Load the store, or create a fresh identity when there is none (or it can't be opened). */
  static async open(file: StoreFile, box: SecretBox): Promise<PairingStore> {
    const loaded = PairingStore.parse(file.read(), box);
    if (loaded) {
      const s = new PairingStore(file, box, loaded.hostId, loaded.identity, loaded.devices, loaded.relay, loaded.lanEnabled);
      if (box.available && !loaded.wasSealed) s.save(); // the keychain became available: seal what's there
      return s;
    }
    const s = new PairingStore(file, box, b64u(randomBytes(16)), await generateIdentity(), [], { url: "", hostSecret: null, enabled: false }, true);
    s.save();
    return s;
  }

  private static parse(text: string | null, box: SecretBox) {
    if (!text) return null;
    try {
      const d = JSON.parse(text) as Disk;
      if (d?.v !== 1 || typeof d.hostId !== "string" || !d.identity?.publicKey) return null;
      if (d.sealed && !box.available) return null;
      const open = (v: string) => (d.sealed ? box.open(v) : v);
      const identity: Identity = { publicKey: d.identity.publicKey, privateJwk: JSON.parse(open(d.identity.privateJwk)) };
      const devices: PairedDevice[] = (Array.isArray(d.devices) ? d.devices : []).filter((x) => x && typeof x.id === "string" && typeof x.linkKey === "string").map((x) => ({
        id: x.id, name: str(x.name, 80) || "Phone", platform: str(x.platform, 40), deviceKey: str(x.deviceKey), linkKey: open(x.linkKey),
        pairedAt: num(x.pairedAt) ?? 0, lastSeenAt: num(x.lastSeenAt),
      }));
      const secret = typeof d.relay?.hostSecret === "string" && d.relay.hostSecret ? open(d.relay.hostSecret) : null;
      return {
        wasSealed: !!d.sealed, hostId: d.hostId, identity, devices,
        relay: { url: str(d.relay?.url, 500), hostSecret: secret, enabled: d.relay?.enabled === true },
        lanEnabled: d.lanEnabled !== false,
      };
    } catch {
      return null; // unreadable, or sealed under a keychain we can no longer open
    }
  }

  private save(): void {
    const sealed = this.box.available;
    const seal = (v: string) => (sealed ? this.box.seal(v) : v);
    const disk: Disk = {
      v: 1, sealed, hostId: this.hostId,
      identity: { publicKey: this.identity.publicKey, privateJwk: seal(JSON.stringify(this.identity.privateJwk)) },
      devices: this.list.map((d) => ({ ...d, linkKey: seal(d.linkKey) })),
      relay: { ...this.relaySettings, hostSecret: this.relaySettings.hostSecret ? seal(this.relaySettings.hostSecret) : null },
      lanEnabled: this.lan,
    };
    this.file.write(JSON.stringify(disk, null, 2));
  }

  /** Whether secrets on disk are protected by the OS keychain. */
  get sealed(): boolean { return this.box.available; }

  devices(): DeviceSummary[] {
    return this.list.map(({ id, name, platform, pairedAt, lastSeenAt }) => ({ id, name, platform, pairedAt, lastSeenAt }));
  }
  device(id: string): PairedDevice | null { return this.list.find((d) => d.id === id) ?? null; }
  linkKeyFor(id: string): string | null { return this.device(id)?.linkKey ?? null; }

  /** Remember a newly paired phone. Pairing the same phone (same key) again reuses its record. */
  addDevice(d: { deviceKey: string; deviceName: string; platform: string; linkKey: string }, now = Date.now()): string {
    const same = this.list.find((x) => x.deviceKey === d.deviceKey);
    const id = same?.id ?? b64u(randomBytes(12));
    const rec: PairedDevice = { id, name: d.deviceName.slice(0, 80) || "Phone", platform: d.platform.slice(0, 40), deviceKey: d.deviceKey, linkKey: d.linkKey, pairedAt: now, lastSeenAt: now };
    this.list = [...this.list.filter((x) => x.id !== id), rec];
    if (this.list.length > MAX_PAIRED_DEVICES) {
      // Forget the phone that has been silent the longest.
      const oldest = [...this.list].sort((a, b) => (a.lastSeenAt ?? a.pairedAt) - (b.lastSeenAt ?? b.pairedAt))[0];
      this.list = this.list.filter((x) => x !== oldest);
    }
    this.save();
    return id;
  }

  touch(id: string, now = Date.now()): void {
    const d = this.device(id);
    if (!d) return;
    d.lastSeenAt = now;
    this.save();
  }

  removeDevice(id: string): boolean {
    const before = this.list.length;
    this.list = this.list.filter((d) => d.id !== id);
    if (this.list.length === before) return false;
    this.save();
    return true;
  }

  get relay(): RelaySettings { return { ...this.relaySettings }; }
  /** `hostSecret` undefined keeps the stored one; "" clears it. */
  setRelay(patch: { url?: string; hostSecret?: string; enabled?: boolean }): RelaySettings {
    const r = this.relaySettings;
    this.relaySettings = {
      url: patch.url !== undefined ? patch.url.trim().slice(0, 500) : r.url,
      hostSecret: patch.hostSecret !== undefined ? (patch.hostSecret.trim() || null) : r.hostSecret,
      enabled: patch.enabled ?? r.enabled,
    };
    this.save();
    return this.relay;
  }

  get lanEnabled(): boolean { return this.lan; }
  setLan(on: boolean): void { this.lan = on; this.save(); }
}
