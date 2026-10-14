import { afterEach, describe, expect, it, vi } from "vitest";
import { HandshakeFailed, type LinkSocket } from "../../shared/pairing/link";
import type { Route } from "../../shared/pairing/protocol";
import { backoffDelay, ConnectionSupervisor, MAC_NOT_REACHABLE, MAC_REMOVED, type SupervisorDeps } from "../connection";
import type { Pairing } from "../model";
import { dialRoutes, MAC_UNREACHABLE, type OpenSocket } from "../routes";

const lan1: Route = { kind: "lan", url: "ws://192.168.1.4:47321" };
const lan2: Route = { kind: "lan", url: "ws://10.0.0.7:47321" };
const relay: Route = { kind: "relay", url: "wss://relay.example.workers.dev/phone/h1" };

function fakeSocket(url: string, closed: string[]): LinkSocket {
  return { send: () => {}, close: () => { closed.push(url); }, onMessage: () => {}, onClose: () => {} };
}

/** Opens after `delays[url]` ms, or fails when the url has no delay. */
function fakeOpen(delays: Record<string, number>) {
  const opened: string[] = [];
  const closed: string[] = [];
  const open: OpenSocket = (url) => {
    opened.push(url);
    return new Promise((res, rej) => {
      if (delays[url] == null) setTimeout(() => rej(new Error("unreachable")), 1);
      else setTimeout(() => res(fakeSocket(url, closed)), delays[url]);
    });
  };
  return { open, opened, closed };
}

describe("route selection", () => {
  it("tries every LAN address at once and keeps the first to answer", async () => {
    const net = fakeOpen({ [lan1.url]: 40, [lan2.url]: 5, [relay.url]: 1 });
    const r = await dialRoutes([lan1, lan2, relay], async (_s, route) => route.url, net.open);
    expect(r.route).toBe(lan2);
    expect(net.opened).toEqual([lan1.url, lan2.url]); // both dialled together; the relay wasn't needed
    await new Promise((res) => setTimeout(res, 60));
    expect(net.closed).toEqual([lan1.url]);          // the slower one is hung up when it answers
  });

  it("falls back to the relay when no LAN address answers", async () => {
    const net = fakeOpen({ [relay.url]: 1 });
    const r = await dialRoutes([lan1, lan2, relay], async (_s, route) => route.url, net.open);
    expect(r.route).toBe(relay);
    expect(net.opened).toEqual([lan1.url, lan2.url, relay.url]);
  });

  it("moves on when a LAN address belongs to another Mac", async () => {
    const net = fakeOpen({ [lan1.url]: 1, [relay.url]: 1 });
    const r = await dialRoutes([lan1, relay], async (_s, route) => {
      if (route.kind === "lan") throw new HandshakeFailed("host_mismatch", "different Mac");
      return route.url;
    }, net.open);
    expect(r.route).toBe(relay);
    expect(net.closed).toEqual([lan1.url]);
  });

  it("stops at once when the Mac refuses (removed phone, wrong code)", async () => {
    const net = fakeOpen({ [lan1.url]: 1, [relay.url]: 1 });
    const err = await dialRoutes([lan1, relay], async () => { throw new HandshakeFailed("unknown_device", "no"); }, net.open).catch((e) => e);
    expect(err.code).toBe("unknown_device");
    expect(net.opened).toEqual([lan1.url]);
  });

  it("says plainly when nothing answers", async () => {
    const net = fakeOpen({});
    const err = await dialRoutes([lan1, relay], async () => "x", net.open).catch((e) => e);
    expect(err).toBeInstanceOf(HandshakeFailed);
    expect(err.message).toBe(MAC_UNREACHABLE);
  });
});

describe("backoff", () => {
  it("doubles from 1 s to a 60 s cap, jittered in the upper half", () => {
    expect([0, 1, 2, 3].map((n) => backoffDelay(n, () => 1))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(10, () => 1)).toBe(60_000);
    expect(backoffDelay(50, () => 0)).toBe(30_000);
  });
});

class FakeLink {
  isOpen = true;
  infoCalls = 0;
  keepalive = false;
  private events: ((e: string, d: unknown) => void)[] = [];
  private closes: ((r: string) => void)[] = [];
  startKeepalive() { this.keepalive = true; }
  onEvent(h: (e: string, d: unknown) => void) { this.events.push(h); return () => {}; }
  onClose(h: (r: string) => void) { if (!this.isOpen) h("closed"); else this.closes.push(h); }
  info: Record<string, unknown> = { hostName: "Mac", speech: { ready: true } };
  async request(m: string) { if (m !== "host.info") throw new Error(m); this.infoCalls++; return this.info; }
  close() { if (!this.isOpen) return; this.isOpen = false; this.closes.forEach((h) => h("closed")); }
  emit(e: string) { this.events.forEach((h) => h(e, null)); }
}

const pairing = (revokedAt: string | null = null): Pairing => ({
  hostId: "h1", hostName: "Mac", hostKey: "k", routes: [lan1, relay], deviceId: "dev-1", linkKey: "lk",
  identity: { publicKey: "p", privateJwk: {} }, storageKey: "sk", pairedAt: "", revokedAt,
});

function supervisor(dial: SupervisorDeps["dial"], p: Pairing | null = pairing()) {
  const revoke = vi.fn(async () => {});
  const sup = new ConnectionSupervisor({ load: async () => p, dial, revoke, random: () => 0 });
  return { sup, revoke };
}
const online = (link: FakeLink, kind: Route["kind"] = "lan") => async () => ({ conn: { link, deviceId: "dev-1", linkKey: "lk", hostName: "Mac" } as any, route: kind === "lan" ? lan1 : relay });

describe("connection supervisor", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("learns the Mac's current routes (a relay set up after pairing) and saves them", async () => {
    const link = new FakeLink();
    const fresh: Route[] = [lan2, { kind: "relay", url: "wss://sutra-relay.me.workers.dev/phone/h1" }];
    link.info = { hostName: "Mac", speech: { ready: true }, routes: [...fresh, { kind: "lan", url: "http://bad" }] };
    const saveRoutes = vi.fn(async () => {});
    const sup = new ConnectionSupervisor({ load: async () => pairing(), dial: online(link), revoke: async () => {}, saveRoutes, random: () => 0 });
    await sup.start();
    await vi.waitFor(() => expect(saveRoutes).toHaveBeenCalledWith(fresh));
    expect(sup.snapshot().pairing?.routes).toEqual(fresh);
    // Nothing new on the next refresh: nothing saved again.
    link.emit("host.changed");
    await vi.waitFor(() => expect(link.infoCalls).toBe(2));
    expect(saveRoutes).toHaveBeenCalledTimes(1);
    sup.stop();
  });

  it("keeps the paired routes when an older Mac sends none", async () => {
    const link = new FakeLink();
    const saveRoutes = vi.fn(async () => {});
    const sup = new ConnectionSupervisor({ load: async () => pairing(), dial: online(link), revoke: async () => {}, saveRoutes, random: () => 0 });
    await sup.start();
    await vi.waitFor(() => expect(link.infoCalls).toBe(1));
    expect(saveRoutes).not.toHaveBeenCalled();
    expect(sup.snapshot().pairing?.routes).toEqual([lan1, relay]);
    sup.stop();
  });

  it("redials with backoff while the Mac is away, and kick() skips the wait", async () => {
    vi.useFakeTimers();
    const dial = vi.fn(async () => { throw new Error("down"); });
    const { sup } = supervisor(dial);
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dial).toHaveBeenCalledTimes(1);
    expect(sup.snapshot().status).toMatchObject({ state: "offline" });
    await vi.advanceTimersByTimeAsync(499);
    expect(dial).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);   // 0.5 s
    expect(dial).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); // 1 s
    expect(dial).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000); // the next wait is 2 s — not yet
    expect(dial).toHaveBeenCalledTimes(3);
    sup.kick();                              // app resumed / network back
    await vi.advanceTimersByTimeAsync(0);
    expect(dial).toHaveBeenCalledTimes(4);
    sup.stop();
  });

  it("goes online over the route that worked, caches host.info, refreshes it on host.changed", async () => {
    const link = new FakeLink();
    const { sup } = supervisor(online(link, "relay"));
    await sup.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(sup.snapshot().status).toEqual({ state: "online", route: "relay" });
    expect(link.keepalive).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(sup.snapshot().hostInfo?.hostName).toBe("Mac");
    link.emit("host.changed");
    await new Promise((r) => setTimeout(r, 0));
    expect(link.infoCalls).toBe(2);
    expect(await sup.whenOnline()).toBe(link);
    sup.stop();
  });

  it("redials soon after the link drops", async () => {
    vi.useFakeTimers();
    const links: FakeLink[] = [];
    const dial = vi.fn(async () => { const l = new FakeLink(); links.push(l); return online(l)(); });
    const { sup } = supervisor(dial);
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    links[0].close();
    expect(sup.snapshot().status.state).toBe("offline");
    await vi.advanceTimersByTimeAsync(1000);
    expect(dial).toHaveBeenCalledTimes(2);
    expect(sup.snapshot().status.state).toBe("online");
    sup.stop();
  });

  it("stops for good when the Mac doesn't know this phone any more", async () => {
    vi.useFakeTimers();
    const dial = vi.fn(async () => { throw new HandshakeFailed("unknown_device", "forgotten"); });
    const { sup, revoke } = supervisor(dial);
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.snapshot().status.state).toBe("revoked");
    expect(sup.snapshot().pairing?.revokedAt).toBeTruthy();
    expect(revoke).toHaveBeenCalledTimes(1);
    sup.kick();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dial).toHaveBeenCalledTimes(1);
    await expect(sup.whenOnline()).rejects.toThrow(MAC_REMOVED);
  });

  it("does the same when the Mac says it removed this phone", async () => {
    vi.useFakeTimers();
    const link = new FakeLink();
    const dial = vi.fn(online(link));
    const { sup, revoke } = supervisor(dial);
    await sup.start();
    await vi.advanceTimersByTimeAsync(0);
    link.emit("revoked");
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.snapshot().status.state).toBe("revoked");
    expect(link.isOpen).toBe(false);
    expect(revoke).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it("doesn't dial a removed or missing pairing", async () => {
    const dial = vi.fn(async () => { throw new Error("no"); });
    const a = supervisor(dial, pairing("2026-01-01"));
    await a.sup.start();
    expect(a.sup.snapshot().status.state).toBe("revoked");
    const b = supervisor(dial, null);
    await b.sup.start();
    expect(b.sup.snapshot().status.state).toBe("unpaired");
    await expect(b.sup.whenOnline()).rejects.toThrow(/isn't paired/);
    expect(dial).not.toHaveBeenCalled();
  });

  it("whenOnline waits for the Mac, then gives up with a friendly error", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const link = new FakeLink();
    const dial = vi.fn(() => new Promise<any>((res) => { release = () => res(online(link)()); }));
    const { sup } = supervisor(dial);
    await sup.start();
    const waiting = sup.whenOnline(5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    release();
    await expect(waiting).resolves.toBe(link);

    link.close();
    dial.mockImplementation(async () => { throw new Error("down"); });
    const late = sup.whenOnline(3_000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await late).message).toBe(MAC_NOT_REACHABLE);
    sup.stop();
  });
});
