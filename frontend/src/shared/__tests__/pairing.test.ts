import { describe, expect, it } from "vitest";
import {
  b64u, deriveLinkKey, deriveSessionKeys, FrameCipher, fromB64u, generateIdentity, newStorageKey, openAtRest,
  openPairBox, randomBytes, sealAtRest, sealPairBox, utf8,
} from "../pairing/crypto";
import { acceptPhone, connectPhone, HandshakeFailed, type HostAuth, type LinkSocket } from "../pairing/link";
import {
  decodePairLink, encodePairLink, formatCode, makePairCode, normalizeCode, PAIR_CODE_LENGTH, relayHostUrl, relayPhoneUrl,
  type PairOffer,
} from "../pairing/protocol";
import { closePayload, decodeRelayFrame, encodeRelayFrame, RELAY_OP, readClosePayload } from "../pairing/relayFrames";

/** Two connected in-memory sockets (async delivery, like a real network). */
function socketPair(): [LinkSocket, LinkSocket] {
  const mk = () => ({ msg: [] as ((d: string | Uint8Array) => void)[], close: [] as ((c?: number, r?: string) => void)[], open: true });
  const a = mk(), b = mk();
  const side = (me: ReturnType<typeof mk>, peer: ReturnType<typeof mk>): LinkSocket => ({
    send: (d) => { if (!me.open || !peer.open) return; const copy = typeof d === "string" ? d : d.slice(); setTimeout(() => peer.msg.forEach((h) => h(copy)), 0); },
    close: (c, r) => { if (!me.open) return; me.open = false; peer.open = false; setTimeout(() => { me.close.forEach((h) => h(c, r)); peer.close.forEach((h) => h(c, r)); }, 0); },
    onMessage: (cb) => { me.msg.push(cb); },
    onClose: (cb) => { me.close.push(cb); },
  });
  return [side(a, b), side(b, a)];
}

async function hostFixture(code = "ABCDEFGHJKMN") {
  const identity = await generateIdentity();
  const devices = new Map<string, string>();
  let live = code;
  const auth: HostAuth = {
    hostId: "host-1", hostName: "Test Mac", identity,
    consumeCode: (c) => { if (!live) return "expired"; if (c !== live) return "bad_code"; live = ""; return "ok"; },
    registerDevice: async (d) => { const id = `dev-${devices.size + 1}`; devices.set(id, d.linkKey); return id; },
    linkKeyFor: async (id) => devices.get(id) ?? null,
  };
  return { auth, identity, devices };
}

describe("pairing crypto", () => {
  it("both ends derive the same link key", async () => {
    const mac = await generateIdentity(), phone = await generateIdentity();
    const a = await deriveLinkKey(mac.privateJwk, phone.publicKey, "h", phone.publicKey);
    const b = await deriveLinkKey(phone.privateJwk, mac.publicKey, "h", phone.publicKey);
    expect(a).toBe(b);
    expect(fromB64u(a)).toHaveLength(32);
    expect(await deriveLinkKey(phone.privateJwk, mac.publicKey, "other-host", phone.publicKey)).not.toBe(a);
  });

  it("seals the pairing code so only the Mac can read it", async () => {
    const mac = await generateIdentity(), phone = await generateIdentity(), eve = await generateIdentity();
    const box = await sealPairBox(phone.privateJwk, mac.publicKey, { code: "XYZ" });
    expect(await openPairBox(mac.privateJwk, phone.publicKey, box)).toEqual({ code: "XYZ" });
    await expect(openPairBox(eve.privateJwk, phone.publicKey, box)).rejects.toThrow();
  });

  it("session frames open once, in order, in one direction only", async () => {
    const link = b64u(randomBytes(32)), pn = b64u(randomBytes(16)), hn = b64u(randomBytes(16));
    const phone = new FrameCipher(await deriveSessionKeys(link, pn, hn, "phone"));
    const host = new FrameCipher(await deriveSessionKeys(link, pn, hn, "host"));
    const f1 = await phone.seal(utf8("one"));
    const f2 = await phone.seal(utf8("two"));
    expect(new TextDecoder().decode(await host.open(f1))).toBe("one");
    expect(new TextDecoder().decode(await host.open(f2))).toBe("two");
    await expect(host.open(f1)).rejects.toThrow(/Replayed/);           // replay
    await expect(phone.open(f2)).rejects.toThrow(/direction/);         // reflected back at the sender
    const f3 = await phone.seal(utf8("three"));
    f3[20] ^= 1;
    await expect(host.open(f3)).rejects.toThrow();                     // tampered
  });

  it("encrypts at rest with a random key", async () => {
    const k = newStorageKey();
    const sealed = await sealAtRest(k, utf8("audio"));
    expect(new TextDecoder().decode(await openAtRest(k, sealed))).toBe("audio");
    await expect(openAtRest(newStorageKey(), sealed)).rejects.toThrow();
  });
});

describe("pairing protocol", () => {
  const offer: PairOffer = { v: 1, hostId: "h1", hostName: "Aditya's MacBook — ✓", hostKey: "k", code: "ABCDEFGHJKMN", exp: Date.now() + 60_000,
    routes: [{ kind: "lan", url: "ws://192.168.1.4:47321" }, { kind: "relay", url: "wss://r.example.workers.dev/phone/h1" }] };

  it("round-trips a pairing link, including non-ASCII names", () => {
    expect(decodePairLink("  " + encodePairLink(offer) + "\n")).toEqual(offer);
  });
  it("rejects expired, foreign and route-less links with friendly messages", () => {
    expect(() => decodePairLink(encodePairLink({ ...offer, exp: 1 }))).toThrow(/expired/);
    expect(() => decodePairLink("https://example.com")).toThrow(/isn't a Sutra pairing code/);
    expect(() => decodePairLink(encodePairLink({ ...offer, routes: [{ kind: "lan", url: "file:///x" }] as any }))).toThrow(/reach/);
  });
  it("makes uniform, readable codes", () => {
    const code = makePairCode(randomBytes);
    expect(code).toMatch(new RegExp(`^[2-9A-HJ-NP-Z]{${PAIR_CODE_LENGTH}}$`));
    expect(normalizeCode(formatCode(code).toLowerCase())).toBe(code);
    expect(formatCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
  });
  it("builds relay URLs from a workers.dev base", () => {
    expect(relayPhoneUrl("https://sutra-relay.me.workers.dev/", "h 1")).toBe("wss://sutra-relay.me.workers.dev/phone/h%201");
    expect(relayHostUrl("sutra-relay.me.workers.dev", "h1")).toBe("wss://sutra-relay.me.workers.dev/host/h1");
  });
});

describe("secure link", () => {
  it("pairs, serves requests both ways, then reconnects with hello", async () => {
    const { auth, identity: mac } = await hostFixture();
    const phoneId = await generateIdentity();

    const [p1, h1] = socketPair();
    const hostSide = acceptPhone(h1, auth);
    const phone = await connectPhone(p1, { hostId: "host-1", hostKey: mac.publicKey, identity: phoneId, pairing: { code: "abcd-efgh-jkmn", deviceName: "Pixel", platform: "android" } });
    const host = await hostSide;
    expect(host.paired).toBe(true);
    expect(phone.deviceId).toBe(host.deviceId);
    expect(phone.hostName).toBe("Test Mac");

    host.link.onRequest(async (m, p) => (m === "ping" ? { t: 42 } : { echo: p }));
    expect(await phone.link.request("ping", {})).toEqual({ t: 42 });
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => phone.link.request("ai.call", { fn: "chat", args: [i] })));
    expect(many.map((r: any) => r.echo.args[0])).toEqual(Array.from({ length: 20 }, (_, i) => i));

    const events: string[] = [];
    phone.link.onEvent((e) => events.push(e));
    await host.link.emit("host.changed");
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toEqual(["host.changed"]);
    phone.link.close();

    // Second connection: no code, just the stored link key.
    const [p2, h2] = socketPair();
    const hostSide2 = acceptPhone(h2, auth);
    const again = await connectPhone(p2, { hostId: "host-1", hostKey: mac.publicKey, identity: phoneId, deviceId: phone.deviceId, linkKey: phone.linkKey });
    const host2 = await hostSide2;
    expect(host2.paired).toBe(false);
    host2.link.onRequest(async () => { throw new Error("engine offline"); });
    await expect(again.link.request("host.info", {})).rejects.toThrow("engine offline");
  });

  it("refuses a wrong code, a reused code and an unknown device", async () => {
    const { auth, identity: mac } = await hostFixture();
    const phoneId = await generateIdentity();
    const attempt = async (o: Partial<Parameters<typeof connectPhone>[1]>) => {
      const [p, h] = socketPair();
      const hs = acceptPhone(h, auth).catch((e) => e);
      const r = await connectPhone(p, { hostId: "host-1", hostKey: mac.publicKey, identity: phoneId, ...o }).catch((e) => e);
      await hs;
      return r;
    };
    const wrong = await attempt({ pairing: { code: "ZZZZZZZZZZZZ", deviceName: "x", platform: "android" } });
    expect(wrong).toBeInstanceOf(HandshakeFailed);
    expect(wrong.code).toBe("bad_code");
    const ok = await attempt({ pairing: { code: "ABCDEFGHJKMN", deviceName: "x", platform: "android" } });
    expect(ok.deviceId).toBeTruthy();
    const reused = await attempt({ pairing: { code: "ABCDEFGHJKMN", deviceName: "x", platform: "android" } });
    expect(reused.code).toBe("expired");
    const stranger = await attempt({ deviceId: "dev-99", linkKey: b64u(randomBytes(32)) });
    expect(stranger.code).toBe("unknown_device");
  });

  it("a phone that knows the device id but not the key can't talk", async () => {
    const { auth, identity: mac } = await hostFixture();
    const phoneId = await generateIdentity();
    const [p1, h1] = socketPair();
    const hs = acceptPhone(h1, auth);
    const real = await connectPhone(p1, { hostId: "host-1", hostKey: mac.publicKey, identity: phoneId, pairing: { code: "ABCDEFGHJKMN", deviceName: "x", platform: "android" } });
    await hs;
    real.link.close();

    const [p2, h2] = socketPair();
    const hs2 = acceptPhone(h2, auth);
    const fake = await connectPhone(p2, { hostId: "host-1", hostKey: mac.publicKey, identity: phoneId, deviceId: real.deviceId, linkKey: b64u(randomBytes(32)) });
    const host = await hs2;
    host.link.onRequest(async () => "secret");
    await expect(fake.link.request("ping", {}, 500)).rejects.toThrow();
    expect(host.link.isOpen).toBe(false); // the Mac drops a link whose frames don't open
  });
});

describe("relay frames", () => {
  it("round-trips frames and close payloads", () => {
    const f = decodeRelayFrame(encodeRelayFrame(RELAY_OP.BIN, 0xfffffffe, new Uint8Array([1, 2, 3])))!;
    expect(f.op).toBe(RELAY_OP.BIN);
    expect(f.stream).toBe(0xfffffffe);
    expect([...f.payload]).toEqual([1, 2, 3]);
    expect(readClosePayload(closePayload(4001, "bye"))).toEqual({ code: 4001, reason: "bye" });
    expect(decodeRelayFrame(new Uint8Array([9, 0, 0, 0, 1]))).toBeNull();
    expect(decodeRelayFrame(new Uint8Array([1, 0]))).toBeNull();
  });
});
