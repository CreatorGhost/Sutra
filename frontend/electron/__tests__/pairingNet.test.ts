// End to end over real sockets: the Mac's PairingHost (LAN server via `ws`, relay connector) against a
// real phone side (Node's global WebSocket + connectPhone), and an in-process fake relay that speaks
// the relay framing.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as NodeWs } from "ws";
import { b64u, generateIdentity, type Identity } from "../../src/shared/pairing/crypto";
import { browserSocket, connectPhone, HandshakeFailed, type PhoneConnection } from "../../src/shared/pairing/link";
import { BLOB_CHUNK_BYTES, decodePairLink, relayPhoneUrl, type PairOffer } from "../../src/shared/pairing/protocol";
import { decodeRelayFrame, encodeRelayFrame, readClosePayload, RELAY_OP } from "../../src/shared/pairing/relayFrames";
import { PairingHost, type PairingUpdate } from "../pairing/host";
import { RendererExec, type ExecMessage } from "../pairing/rendererExec";
import { PairingStore, type SecretBox } from "../pairing/store";
import { startLanServer } from "../pairing/lanServer";
import { RelayConnector, type RelayState } from "../pairing/relayConnector";

const plainBox: SecretBox = { available: false, seal: (s) => s, open: (s) => s };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await tick(10); }
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** A Mac with a fake renderer that answers every forwarded request with what it received. */
async function makeHost(opts: { lan?: boolean; relay?: { url: string; secret: string } } = {}) {
  let file: string | null = null;
  const store = await PairingStore.open({ read: () => file, write: (t) => { file = t; } }, plainBox);
  if (opts.lan === false) store.setLan(false);
  if (opts.relay) store.setRelay({ url: opts.relay.url, hostSecret: opts.relay.secret, enabled: true });
  const forwarded: ExecMessage[] = [];
  const exec: RendererExec = new RendererExec((m) => {
    forwarded.push(m);
    setTimeout(() => exec.settle({ reqId: m.reqId, ok: true, result: m.method === "host.info" ? { engines: [], activeEngine: "claude" } : { method: m.method, params: m.params, bytes: m.blob?.byteLength ?? 0 } }), 0);
    return true;
  });
  exec.setReady(true);
  const updates: PairingUpdate[] = [];
  const host = new PairingHost({
    store, exec, hostName: () => "Test Mac", appVersion: "9.9.9", notify: (u) => updates.push(u),
    interfaces: () => ({ en0: [{ address: "127.0.0.1", family: "IPv4", internal: false } as any] }),
    lanPort: 0, lanHost: "127.0.0.1", relay: { pingMs: 60, backoff: () => 50 },
  });
  await host.start();
  cleanups.push(() => host.stop());
  return { host, store, forwarded, updates };
}

async function dial(url: string) {
  const ws = new WebSocket(url);
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("dial failed"))); });
  return browserSocket(ws);
}

async function pairPhone(offer: PairOffer, route: "lan" | "relay", identity: Identity): Promise<PhoneConnection> {
  const r = offer.routes.find((x) => x.kind === route)!;
  return connectPhone(await dial(r.url), { hostId: offer.hostId, hostKey: offer.hostKey, identity, pairing: { code: offer.code, deviceName: "Pixel 9", platform: "android" } });
}

describe("LAN pairing, end to end", () => {
  it("only listens while there's something to listen for", async () => {
    const { host } = await makeHost();
    expect(host.status().lan.listening).toBe(false);
    const st = await host.newOffer();
    expect(st.lan.listening).toBe(true);
    expect(st.offer!.routes).toEqual([{ kind: "lan", url: `ws://127.0.0.1:${st.lan.port}` }]);
    host.cancelOffer();
    await until(() => !host.status().lan.listening);
  });

  it("pairs, serves every request, reconnects, and is revoked", async () => {
    const { host, store, forwarded, updates } = await makeHost();
    const offer = decodePairLink((await host.newOffer()).offer!.link);
    expect(offer.hostName).toBe("Test Mac");
    const phoneId = await generateIdentity();
    const phone = await pairPhone(offer, "lan", phoneId);
    await until(() => updates.some((u) => u.paired));
    expect(updates.find((u) => u.paired)!.paired).toEqual({ id: phone.deviceId, name: "Pixel 9" });
    expect(host.status().offer).toBeNull();
    expect(host.status().devices).toMatchObject([{ id: phone.deviceId, name: "Pixel 9", connected: true, via: ["lan"] }]);

    expect(await phone.link.request("ping", {})).toHaveProperty("t");
    expect(await phone.link.request("host.info", {})).toEqual({ engines: [], activeEngine: "claude", hostName: "Test Mac", appVersion: "9.9.9" });

    // A 400 KiB "recording" in chunks, then transcribe it.
    const audio = new Uint8Array(400 * 1024).map((_, i) => i % 251);
    for (let seq = 0, off = 0; off < audio.length; seq++, off += BLOB_CHUNK_BYTES) {
      const part = audio.subarray(off, off + BLOB_CHUNK_BYTES);
      await phone.link.request("blob.put", { id: "win-1", seq, last: off + BLOB_CHUNK_BYTES >= audio.length, data: b64u(part) });
    }
    const tr: any = await phone.link.request("stt.transcribe", { blobId: "win-1", mime: "audio/webm", filename: "w.webm", opts: { language: "english" } });
    expect(tr).toEqual({ method: "stt.transcribe", params: { mime: "audio/webm", filename: "w.webm", opts: { language: "english" } }, bytes: audio.length });
    const sent = forwarded.find((m) => m.method === "stt.transcribe")!;
    expect(new Uint8Array(sent.blob!)).toEqual(audio);
    expect(sent.device).toEqual({ id: phone.deviceId, name: "Pixel 9", platform: "android" });
    await expect(phone.link.request("stt.transcribe", { blobId: "win-1", mime: "", filename: "" })).rejects.toThrow(/didn't finish uploading/);

    const ai: any = await phone.link.request("ai.call", { fn: "chat", args: [{}, "sys", "user"] });
    expect(ai.params).toEqual({ fn: "chat", args: [{}, "sys", "user"] });
    const bundle = new TextEncoder().encode(JSON.stringify({ v: 1, uid: "u1" }));
    await phone.link.request("blob.put", { id: "meeting", seq: 0, last: true, data: b64u(bundle) });
    expect(((await phone.link.request("meetings.put", { blobId: "meeting" })) as any).params).toEqual({ bundle: { v: 1, uid: "u1" } });

    const events: string[] = [];
    phone.link.onEvent((e) => events.push(e));
    host.broadcast("host.changed");
    await until(() => events.includes("host.changed"));

    // Reconnect with the stored key (no code).
    phone.link.close();
    await until(() => !host.status().devices[0].connected);
    const again = await connectPhone(await dial(offer.routes[0].url), { hostId: offer.hostId, hostKey: offer.hostKey, identity: phoneId, deviceId: phone.deviceId, linkKey: phone.linkKey });
    await until(() => host.status().devices[0]?.connected === true);
    again.link.onEvent((e) => events.push(e));
    const closed = new Promise((r) => again.link.onClose(r));
    expect(await host.removeDevice(phone.deviceId)).toBe(true);
    await closed;
    await until(() => events.includes("revoked")); // sent just before the hang-up
    expect(store.devices()).toEqual([]);
    await until(() => !host.status().lan.listening); // nothing left to listen for
  });

  it("refuses a wrong code and counts it against the offer", async () => {
    const { host } = await makeHost();
    const offer = decodePairLink((await host.newOffer()).offer!.link);
    const err = await pairPhone({ ...offer, code: "WRONGWRONG22" }, "lan", await generateIdentity()).catch((e) => e);
    expect(err).toBeInstanceOf(HandshakeFailed);
    expect(err.code).toBe("bad_code");
    expect(host.status().offer).not.toBeNull(); // one wrong try doesn't burn it
    expect(host.status().devices).toEqual([]);
  });

  it("falls back to a free port when the default one is taken", async () => {
    const first = await startLanServer(() => {}, { port: 0, host: "127.0.0.1" });
    cleanups.push(() => first.close());
    const second = await startLanServer(() => {}, { port: first.port, host: "127.0.0.1" });
    cleanups.push(() => second.close());
    expect(second.port).not.toBe(first.port);
    expect(second.port).toBeGreaterThan(0);
  });
});

/** A relay in miniature: `/host/<id>` (Bearer secret) carries every `/phone/<id>` socket as a stream. */
async function fakeRelay(secret: string) {
  const server: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const r = { hostDials: 0, pings: 0, answerPings: true, host: null as NodeWs | null, phones: new Map<number, NodeWs>(), url: "" };
  let next = 1;
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/host/")) {
      r.hostDials++;
      if (req.headers.authorization !== `Bearer ${secret}`) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        r.host = ws;
        ws.on("message", (data) => {
          const f = decodeRelayFrame(new Uint8Array(data as Buffer))!;
          const phone = r.phones.get(f.stream);
          if (f.op === RELAY_OP.PING) { r.pings++; if (r.answerPings) ws.send(encodeRelayFrame(RELAY_OP.PONG, 0)); }
          else if (f.op === RELAY_OP.TEXT) phone?.send(new TextDecoder().decode(f.payload));
          else if (f.op === RELAY_OP.BIN) phone?.send(f.payload);
          else if (f.op === RELAY_OP.CLOSE) { const c = readClosePayload(f.payload); r.phones.delete(f.stream); phone?.close(c.code, c.reason); }
        });
      });
    } else if (req.url?.startsWith("/phone/")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const id = next++;
        r.phones.set(id, ws);
        r.host?.send(encodeRelayFrame(RELAY_OP.OPEN, id));
        ws.on("message", (data, isBinary) => r.host?.send(encodeRelayFrame(isBinary ? RELAY_OP.BIN : RELAY_OP.TEXT, id, new Uint8Array(data as Buffer))));
        ws.on("close", () => { if (r.phones.delete(id)) r.host?.send(encodeRelayFrame(RELAY_OP.CLOSE, id, new Uint8Array([3, 232]))); });
      });
    } else socket.destroy();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  r.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise<void>((res) => { for (const c of wss.clients) c.terminate(); server.close(() => res()); }));
  return r;
}

describe("relay connector", () => {
  it("stops retrying on a wrong secret", async () => {
    const relay = await fakeRelay("right");
    const states: RelayState[] = [];
    const c = new RelayConnector({ onSocket: () => {}, onState: (s) => states.push(s), backoff: () => 20 });
    cleanups.push(() => c.stop());
    c.configure({ url: relay.url, hostId: "h1", hostSecret: "wrong" });
    await until(() => c.state === "auth_failed");
    await tick(150);
    expect(relay.hostDials).toBe(1);
    expect(states).toEqual(["connecting", "auth_failed"]);
    c.configure({ url: relay.url, hostId: "h1", hostSecret: "right" });
    await until(() => c.state === "online");
  });

  it("pairs and talks through the relay, with the LAN off", async () => {
    const relay = await fakeRelay("s3cret");
    const { host } = await makeHost({ lan: false, relay: { url: relay.url, secret: "s3cret" } });
    await until(() => host.status().relay.state === "online");
    const st = await host.newOffer();
    expect(st.lan.listening).toBe(false);
    expect(st.offer!.routes).toEqual([{ kind: "relay", url: relayPhoneUrl(relay.url, st.hostId) }]);

    const phone = await pairPhone(decodePairLink(st.offer!.link), "relay", await generateIdentity());
    expect(await phone.link.request("ping", {})).toHaveProperty("t");
    const big = new Uint8Array(BLOB_CHUNK_BYTES).fill(7);
    expect(await phone.link.request("blob.put", { id: "w", seq: 0, last: true, data: b64u(big) })).toEqual({ received: big.length });
    expect(((await phone.link.request("stt.transcribe", { blobId: "w", mime: "audio/wav", filename: "a.wav" })) as any).bytes).toBe(big.length);
    await until(() => host.status().devices[0]?.via[0] === "relay");

    phone.link.close(); // phone hangs up → relay sends CLOSE for its stream
    await until(() => host.status().devices[0]?.connected === false);
  });

  it("drops a relay link whose pings go unanswered, then reconnects", async () => {
    const relay = await fakeRelay("s");
    const c = new RelayConnector({ onSocket: () => {}, onState: () => {}, pingMs: 30, backoff: () => 20 });
    cleanups.push(() => c.stop());
    c.configure({ url: relay.url, hostId: "h", hostSecret: "s" });
    await until(() => c.state === "online");
    await until(() => relay.pings >= 2);
    relay.answerPings = false;
    await until(() => c.state === "offline");
    relay.answerPings = true;
    await until(() => c.state === "online");
    expect(relay.hostDials).toBe(2);
  });
});
