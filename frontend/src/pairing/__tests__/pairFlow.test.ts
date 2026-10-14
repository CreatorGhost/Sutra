// Scan → pair → reconnect → removed, end to end against a fake Mac (the real acceptPhone handshake),
// plus which provider a phone resolves to before and after pairing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairLink, decodePairLink, type PairOffer } from "../../shared/pairing/protocol";
import type { HostConnection } from "../../shared/pairing/link";
import { hostFixture, network } from "./fixtures";

const settings: Record<string, unknown> = {};
vi.mock("../../local/repo", () => ({
  getSettings: async () => ({ ...settings }),
  putSettings: async (p: Record<string, unknown>) => { Object.assign(settings, p); return { ...settings }; },
}));

const { pairWithOffer, getPairing, markRevoked, forgetPairing } = await import("../state");
const { ConnectionSupervisor, dialPairing } = await import("../connection");
const { PAIRING_KEY, PAIRED_ENGINE_KEY, PAIRED_MODEL_KEY, readPairing, thisDevice } = await import("../model");
const { resolveProvider, isFullTextEngine } = await import("../../providers");

const LAN = "ws://192.168.1.4:47321", LAN2 = "ws://10.0.0.9:47321", RELAY = "wss://relay.example.workers.dev/phone/host-1";

async function macWithCode() {
  const host = await hostFixture();
  const offer: PairOffer = { v: 1, hostId: "host-1", hostName: "Aditya's MacBook", hostKey: host.identity.publicKey, code: "ABCDEFGHJKMN", exp: Date.now() + 60_000,
    routes: [{ kind: "lan", url: LAN }, { kind: "lan", url: LAN2 }, { kind: "relay", url: RELAY }] };
  return { ...host, link: encodePairLink(offer) };
}

beforeEach(() => { for (const k of Object.keys(settings)) delete settings[k]; });

describe("pairing from a scanned code", () => {
  it("pairs over the LAN, saves the pairing, and reconnects later with the stored key", async () => {
    const mac = await macWithCode();
    const hosts: HostConnection[] = [];
    const net = network(mac.auth, [LAN2, RELAY], (h) => { hosts.push(h); h.link.onRequest(async (m) => (m === "host.info" ? { hostName: "Aditya's MacBook", speech: { ready: true } } : null)); });

    const { pairing, link, route } = await pairWithOffer(decodePairLink(mac.link), { open: net.open, device: { deviceName: "Pixel 8", platform: "android" } });
    expect(route.url).toBe(LAN2);                    // the LAN address that answered; the relay wasn't needed
    expect(net.opened).not.toContain(RELAY);
    expect(pairing.hostName).toBe("Aditya's MacBook");
    expect(hosts[0].paired).toBe(true);
    expect(hosts[0].deviceName).toBe("Pixel 8");
    expect(readPairing(settings)).toEqual(pairing);  // stored in the (encrypted) app settings
    expect(pairing.storageKey).toBeTruthy();
    link.close();

    const sup = new ConnectionSupervisor({ load: getPairing, dial: (p) => dialPairing(p, net.open), revoke: markRevoked });
    await sup.start();
    await sup.whenOnline(2_000);
    expect(sup.snapshot().status).toEqual({ state: "online", route: "lan" });
    expect(hosts[1].paired).toBe(false);             // a hello, not a second pairing
    await vi.waitFor(() => expect(sup.snapshot().hostInfo?.speech.ready).toBe(true));

    // The Mac removes the phone: it stops, and the pairing is marked removed (the queue key stays).
    await hosts[1].link.emit("revoked");
    await vi.waitFor(() => expect(sup.snapshot().status.state).toBe("revoked"));
    expect((await getPairing())?.revokedAt).toBeTruthy();
    sup.stop();
  });

  it("marks the pairing removed when the Mac no longer knows this phone", async () => {
    const mac = await macWithCode();
    const net = network(mac.auth, [LAN]);
    (await pairWithOffer(decodePairLink(mac.link), { open: net.open, device: { deviceName: "Pixel", platform: "android" } })).link.close();
    mac.devices.clear();                             // removed in Settings → Phones on the Mac
    const sup = new ConnectionSupervisor({ load: getPairing, dial: (p) => dialPairing(p, net.open), revoke: markRevoked });
    await sup.start();
    await vi.waitFor(() => expect(sup.snapshot().status.state).toBe("revoked"));
    expect((await getPairing())?.revokedAt).toBeTruthy();
    sup.stop();
  });

  it("re-pairing keeps the queue's key, so recordings still waiting stay readable", async () => {
    const first = await macWithCode();
    (await pairWithOffer(decodePairLink(first.link), { open: network(first.auth, [LAN]).open, device: { deviceName: "P", platform: "android" } })).link.close();
    const key = (await getPairing())!.storageKey;
    await markRevoked();
    const again = await macWithCode();
    (await pairWithOffer(decodePairLink(again.link), { open: network(again.auth, [RELAY]).open, device: { deviceName: "P", platform: "android" } })).link.close();
    const p = (await getPairing())!;
    expect(p.storageKey).toBe(key);
    expect(p.revokedAt).toBeNull();
  });

  it("reports a wrong or reused code without saving anything", async () => {
    const mac = await macWithCode();
    const offer = decodePairLink(mac.link);
    const err = await pairWithOffer({ ...offer, code: "ZZZZZZZZZZZZ" }, { open: network(mac.auth, [LAN]).open, device: { deviceName: "P", platform: "android" } }).catch((e) => e);
    expect(err.code).toBe("bad_code");
    expect(settings[PAIRING_KEY]).toBeUndefined();
  });

  it("introduces the phone by its model when the WebView says it", () => {
    expect(thisDevice({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004; wv)" }, "android")).toEqual({ deviceName: "Pixel 8", platform: "android" });
    expect(thisDevice({ userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit" }, "android").deviceName).toBe("Android phone");
  });
});

describe("provider resolution on a phone", () => {
  it("uses the cloud when unpaired, the Mac when paired, and the cloud again once removed", async () => {
    expect(resolveProvider({}).id).toBe("cloud");
    const mac = await macWithCode();
    (await pairWithOffer(decodePairLink(mac.link), { open: network(mac.auth, [LAN]).open, device: { deviceName: "P", platform: "android" } })).link.close();
    const paired = resolveProvider({ ...settings, mode: "ondevice" });
    expect(paired.id).toBe("mac");
    expect(paired.sttId).toBe("local");
    expect(paired.canEmbed).toBe(false);
    expect(isFullTextEngine(paired)).toBe(true);
    // The phone's engine pick picks a different (cached) provider.
    const picked = resolveProvider({ ...settings, [PAIRED_ENGINE_KEY]: "codex", [PAIRED_MODEL_KEY]: "gpt-5" });
    expect(picked).not.toBe(paired);
    expect(resolveProvider({ ...settings })).toBe(paired);
    await markRevoked();
    expect(resolveProvider({ ...settings }).id).toBe("cloud");
    await forgetPairing();
    expect(resolveProvider({ ...settings }).id).toBe("cloud");
  });
});
