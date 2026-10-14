import { describe, expect, it } from "vitest";
import { b64u } from "../../src/shared/pairing/crypto";
import { PAIR_CODE_TTL_MS, PAIR_MAX_ATTEMPTS, formatCode } from "../../src/shared/pairing/protocol";
import { PairingStore, type SecretBox, type StoreFile } from "../pairing/store";
import { lanAddresses, offerRoutes, OfferBook } from "../pairing/offers";
import { BLOB_TTL_MS, BlobAssembler, MAX_BLOBS_PER_DEVICE } from "../pairing/blobs";
import { RendererExec, type ExecMessage } from "../pairing/rendererExec";

const memFile = (): StoreFile & { text: string | null } => {
  const f = { text: null as string | null, read: () => f.text, write: (t: string) => { f.text = t; } };
  return f;
};
const box = (available = true): SecretBox => ({
  available,
  seal: (s) => "sealed:" + Buffer.from(s).reverse().toString("base64"),
  open: (s) => { if (!s.startsWith("sealed:")) throw new Error("not sealed"); return Buffer.from(s.slice(7), "base64").reverse().toString(); },
});
const device = (n: number) => ({ deviceKey: `key-${n}`, deviceName: `Pixel ${n}`, platform: "android", linkKey: `link-secret-${n}` });

describe("pairing store", () => {
  it("creates an identity once and keeps every secret sealed on disk", async () => {
    const file = memFile();
    const s = await PairingStore.open(file, box());
    s.addDevice(device(1));
    s.setRelay({ url: "https://r.me.workers.dev", hostSecret: "relay-host-secret", enabled: true });
    const raw = file.text!;
    expect(JSON.parse(raw).sealed).toBe(true);
    expect(raw).not.toContain(String(s.identity.privateJwk.d));
    expect(raw).not.toContain("link-secret-1");
    expect(raw).not.toContain("relay-host-secret");

    const again = await PairingStore.open(file, box());
    expect(again.hostId).toBe(s.hostId);
    expect(again.identity).toEqual(s.identity);
    expect(again.devices().map((d) => d.name)).toEqual(["Pixel 1"]);
    expect(again.linkKeyFor(again.devices()[0].id)).toBe("link-secret-1");
    expect(again.relay).toEqual({ url: "https://r.me.workers.dev", hostSecret: "relay-host-secret", enabled: true });
    expect(again.lanEnabled).toBe(true);
  });

  it("stores plain (flagged) without a keychain and seals once one appears", async () => {
    const file = memFile();
    const plain = await PairingStore.open(file, box(false));
    plain.addDevice(device(1));
    expect(JSON.parse(file.text!).sealed).toBe(false);
    expect(file.text).toContain("link-secret-1");

    const upgraded = await PairingStore.open(file, box(true));
    expect(upgraded.hostId).toBe(plain.hostId);
    expect(JSON.parse(file.text!).sealed).toBe(true);
    expect(file.text).not.toContain("link-secret-1");
  });

  it("starts over when the file was sealed under a keychain it can't open", async () => {
    const file = memFile();
    const first = await PairingStore.open(file, box(true));
    const fresh = await PairingStore.open(file, box(false));
    expect(fresh.hostId).not.toBe(first.hostId);
    expect(fresh.devices()).toEqual([]);
  });

  it("re-pairing the same phone reuses its record; remove forgets it; a blank secret clears it", async () => {
    const s = await PairingStore.open(memFile(), box());
    const a = s.addDevice(device(1), 1000);
    const b = s.addDevice({ ...device(1), deviceName: "Pixel (new name)", linkKey: "link-2" }, 2000);
    expect(b).toBe(a);
    expect(s.devices()).toEqual([{ id: a, name: "Pixel (new name)", platform: "android", pairedAt: 2000, lastSeenAt: 2000 }]);
    s.touch(a, 3000);
    expect(s.devices()[0].lastSeenAt).toBe(3000);
    expect(s.devices()[0]).not.toHaveProperty("linkKey");
    expect(s.removeDevice(a)).toBe(true);
    expect(s.linkKeyFor(a)).toBeNull();
    s.setRelay({ url: "r.example.com", hostSecret: "x", enabled: true });
    s.setRelay({ enabled: false });
    expect(s.relay.hostSecret).toBe("x");
    s.setRelay({ hostSecret: "" });
    expect(s.relay.hostSecret).toBeNull();
  });
});

describe("pairing offers", () => {
  const host = { hostId: "h", hostName: "Mac", hostKey: "k" };

  it("one live offer; the right code (in any spelling) burns it", () => {
    const book = new OfferBook();
    book.create(host, []);
    const second = book.create(host, []);
    expect(book.current()).toBe(second);
    expect(book.consume("WRONGWRONG22")).toBe("bad_code"); // "O" is never in a code
    expect(book.consume(formatCode(second.code).toLowerCase())).toBe("ok");
    expect(book.current()).toBeNull();
    expect(book.consume(second.code)).toBe("expired");
  });

  it("burns the offer after too many wrong codes", () => {
    const book = new OfferBook();
    const o = book.create(host, []);
    for (let i = 1; i < PAIR_MAX_ATTEMPTS; i++) expect(book.consume("")).toBe("bad_code");
    expect(book.consume("")).toBe("expired");
    expect(book.consume(o.code)).toBe("expired");
  });

  it("expires on its own and can be cancelled", () => {
    let t = 1_000_000;
    const book = new OfferBook(() => t);
    const o = book.create(host, []);
    expect(o.exp).toBe(t + PAIR_CODE_TTL_MS);
    t += PAIR_CODE_TTL_MS;
    expect(book.current()).toBeNull();
    expect(book.consume(o.code)).toBe("expired");
    book.create(host, []);
    book.cancel();
    expect(book.current()).toBeNull();
  });

  it("lists every reachable IPv4 address on the running port, then the relay", () => {
    const addrs = lanAddresses({
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as any],
      en0: [{ address: "192.168.1.4", family: "IPv4", internal: false } as any, { address: "fe80::1", family: "IPv6", internal: false } as any],
      en1: [{ address: "169.254.3.3", family: "IPv4", internal: false } as any, { address: "10.0.0.7", family: "IPv4", internal: false } as any],
    });
    expect(addrs).toEqual(["192.168.1.4", "10.0.0.7"]);
    expect(offerRoutes({ addresses: addrs, port: 47321, relayBase: "https://r.me.workers.dev", hostId: "h1" })).toEqual([
      { kind: "lan", url: "ws://192.168.1.4:47321" },
      { kind: "lan", url: "ws://10.0.0.7:47321" },
      { kind: "relay", url: "wss://r.me.workers.dev/phone/h1" },
    ]);
    expect(offerRoutes({ addresses: addrs, port: null, relayBase: null, hostId: "h1" })).toEqual([]);
  });
});

describe("blob assembly", () => {
  const chunk = (id: string, seq: number, bytes: number[], last = false) => ({ id, seq, last, data: b64u(new Uint8Array(bytes)) });

  it("assembles in-order chunks and hands the blob over once", () => {
    const b = new BlobAssembler();
    expect(b.put("dev", chunk("w1", 0, [1, 2]))).toEqual({ received: 2 });
    expect(b.take("dev", "w1")).toBeNull(); // not finished
    expect(b.put("dev", chunk("w1", 1, [3], true))).toEqual({ received: 3 });
    expect(b.take("other-phone", "w1")).toBeNull();
    expect([...b.take("dev", "w1")!]).toEqual([1, 2, 3]);
    expect(b.take("dev", "w1")).toBeNull();
  });

  it("rejects gaps, repeats, junk and oversize uploads; seq 0 restarts", () => {
    const b = new BlobAssembler(Date.now, 4);
    b.put("dev", chunk("w", 0, [1]));
    expect(() => b.put("dev", chunk("w", 2, [1]))).toThrow(/out of order/);
    expect(() => b.put("dev", chunk("w", 0, [9]))).not.toThrow(); // restart
    expect(() => b.put("dev", { id: "../x", seq: 0, last: true, data: "" })).toThrow(/id/);
    expect(() => b.put("dev", { id: "w", seq: -1, data: "" })).toThrow(/number/);
    expect(() => b.put("dev", chunk("big", 0, [1, 2, 3, 4, 5]))).toThrow(/too large/);
    b.put("dev", chunk("done", 0, [1], true));
    expect(() => b.put("dev", chunk("done", 1, [1]))).toThrow(/out of order/);
  });

  it("caps uploads per phone and drops stale ones", () => {
    let t = 0;
    const b = new BlobAssembler(() => t);
    for (let i = 0; i < MAX_BLOBS_PER_DEVICE; i++) b.put("dev", chunk(`w${i}`, 0, [i]));
    expect(() => b.put("dev", chunk("one-more", 0, [1]))).toThrow(/Too many/);
    b.put("dev2", chunk("x", 0, [1], true));
    t += BLOB_TTL_MS + 1;
    b.put("dev", chunk("fresh", 0, [1], true));
    expect(b.take("dev2", "x")).toBeNull();
    b.dropOwner("dev");
    expect(b.take("dev", "fresh")).toBeNull();
  });
});

describe("renderer exec", () => {
  const who = { id: "d", name: "Pixel", platform: "android" };

  it("forwards to the renderer and settles by request id", async () => {
    const sent: ExecMessage[] = [];
    const ex = new RendererExec((m) => { sent.push(m); return true; });
    ex.setReady(true);
    const a = ex.call("ai.call", { fn: "chat" }, who);
    const b = ex.call("stt.transcribe", {}, who, new Uint8Array([1, 2, 3]).subarray(1));
    expect([...new Uint8Array(sent[1].blob!)]).toEqual([2, 3]);
    ex.settle({ reqId: sent[1].reqId, ok: false, error: "no model" });
    ex.settle({ reqId: sent[0].reqId, ok: true, result: { text: "hi" } });
    await expect(a).resolves.toEqual({ text: "hi" });
    await expect(b).rejects.toThrow("no model");
  });

  it("answers clearly when there's no renderer, it reloads, or it never answers", async () => {
    const notReady = new RendererExec(() => true);
    await expect(notReady.call("host.info", {}, who)).rejects.toThrow(/isn't fully running/);
    const gone = new RendererExec(() => false);
    gone.setReady(true);
    await expect(gone.call("host.info", {}, who)).rejects.toThrow(/isn't fully running/);
    const reload = new RendererExec(() => true);
    reload.setReady(true);
    const p = reload.call("ai.call", {}, who);
    reload.setReady(false);
    await expect(p).rejects.toThrow(/restarted/);
    const slow = new RendererExec(() => true, 20);
    slow.setReady(true);
    await expect(slow.call("ai.call", {}, who)).rejects.toThrow(/too long/);
  });
});
