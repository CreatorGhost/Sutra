import { beforeEach, describe, expect, it } from "vitest";
import {
  RELAY_MAX_PAYLOAD, RELAY_MAX_STREAMS, RELAY_OP, closePayload, encodeRelayFrame, readClosePayload, type RelayOp,
} from "../../../frontend/src/shared/pairing/relayFrames.ts";
import { CLOSE, RelayHub, clampCloseReason, sendableCloseCode } from "../src/hub.ts";
import { FakeContext, FakeSocket } from "./fakes.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

let ctx: FakeContext;
let hub: RelayHub<FakeSocket>;

beforeEach(() => {
  ctx = new FakeContext();
  hub = new RelayHub(ctx, undefined);
});

function connectHost(): FakeSocket {
  const ws = new FakeSocket();
  hub.acceptHost(ws);
  return ws;
}
/** A phone accepted by the relay, and the stream id the host was told about. */
function connectPhone(host: FakeSocket): { ws: FakeSocket; stream: number } {
  const ws = new FakeSocket();
  const before = host.sent.length;
  hub.acceptPhone(ws);
  const open = host.frames().slice(before).find((f) => f.op === RELAY_OP.OPEN);
  if (!open) throw new Error("no OPEN sent");
  return { ws, stream: open.stream };
}
const fromHost = (host: FakeSocket, op: RelayOp, stream: number, payload?: Uint8Array) =>
  hub.onMessage(host, FakeSocket.bytes(encodeRelayFrame(op, stream, payload)));
const lastFrame = (host: FakeSocket) => host.frames().at(-1)!;

describe("phones before a Mac connects", () => {
  it("are accepted and closed with 4004 mac offline", () => {
    const phone = new FakeSocket();
    hub.acceptPhone(phone);
    expect(ctx.refused).toEqual([{ ws: phone, code: 4004, reason: "mac offline" }]);
    expect(ctx.live).toEqual([]);
  });
});

describe("stream lifecycle", () => {
  it("announces a phone with OPEN on a fresh stream id", () => {
    const host = connectHost();
    const a = connectPhone(host);
    const b = connectPhone(host);
    expect(a.stream).toBe(1);
    expect(b.stream).toBe(2);
    expect(host.frames()).toEqual([
      { op: RELAY_OP.OPEN, stream: 1, payload: new Uint8Array(0) },
      { op: RELAY_OP.OPEN, stream: 2, payload: new Uint8Array(0) },
    ]);
  });

  it("forwards phone text as TEXT and phone binary as BIN", () => {
    const host = connectHost();
    const { ws, stream } = connectPhone(host);
    hub.onMessage(ws, '{"t":"hello","name":"Prīya"}');
    expect(lastFrame(host)).toMatchObject({ op: RELAY_OP.TEXT, stream });
    expect(dec.decode(lastFrame(host).payload)).toBe('{"t":"hello","name":"Prīya"}');
    hub.onMessage(ws, FakeSocket.bytes(new Uint8Array([0, 255, 7])));
    expect(lastFrame(host)).toEqual({ op: RELAY_OP.BIN, stream, payload: new Uint8Array([0, 255, 7]) });
  });

  it("delivers host TEXT as a text message and BIN as binary, to that phone only", () => {
    const host = connectHost();
    const a = connectPhone(host);
    const b = connectPhone(host);
    fromHost(host, RELAY_OP.TEXT, a.stream, enc.encode('{"t":"welcome"}'));
    fromHost(host, RELAY_OP.BIN, b.stream, new Uint8Array([1, 2, 3]));
    expect(a.ws.sent).toEqual(['{"t":"welcome"}']);
    expect(b.ws.sent).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it("tells the Mac when a phone closes, with its code and reason", () => {
    const host = connectHost();
    const { ws, stream } = connectPhone(host);
    hub.onClose(ws, 1000, "bye");
    ctx.drop(ws);
    expect(lastFrame(host).op).toBe(RELAY_OP.CLOSE);
    expect(lastFrame(host).stream).toBe(stream);
    expect(readClosePayload(lastFrame(host).payload)).toEqual({ code: 1000, reason: "bye" });
    // Frames for a stream that's gone are dropped, not answered.
    const count = host.sent.length;
    fromHost(host, RELAY_OP.TEXT, stream, enc.encode("late"));
    expect(host.sent.length).toBe(count);
  });

  it("closes a phone on the Mac's CLOSE, without echoing a CLOSE back", () => {
    const host = connectHost();
    const { ws, stream } = connectPhone(host);
    fromHost(host, RELAY_OP.CLOSE, stream, closePayload(4000, "done"));
    expect(ws.closedWith).toEqual({ code: 4000, reason: "done" });
    const count = host.sent.length;
    hub.onClose(ws, 4000, "done"); // the runtime reports the close the relay started
    expect(host.sent.length).toBe(count);
    // Later messages from that phone are ignored too.
    hub.onMessage(ws, "after close");
    expect(host.sent.length).toBe(count);
  });

  it("uses a sendable close code and a short enough reason from the Mac", () => {
    const host = connectHost();
    const a = connectPhone(host);
    const b = connectPhone(host);
    fromHost(host, RELAY_OP.CLOSE, a.stream, closePayload(1006, "x"));
    expect(a.ws.closedWith?.code).toBe(1000);
    fromHost(host, RELAY_OP.CLOSE, b.stream, closePayload(4001, "é".repeat(120)));
    expect(b.ws.closedWith?.code).toBe(4001);
    expect(enc.encode(b.ws.closedWith!.reason!).length).toBeLessThanOrEqual(123);
  });

  it("an empty CLOSE payload closes normally", () => {
    const host = connectHost();
    const { ws, stream } = connectPhone(host);
    fromHost(host, RELAY_OP.CLOSE, stream);
    expect(ws.closedWith).toEqual({ code: 1000, reason: "" });
  });

  it("treats a socket error like a close", () => {
    const host = connectHost();
    const { ws, stream } = connectPhone(host);
    hub.onClose(ws, 1011, "error");
    expect(lastFrame(host)).toMatchObject({ op: RELAY_OP.CLOSE, stream });
    expect(readClosePayload(lastFrame(host).payload).code).toBe(1011);
  });
});

describe("host connection", () => {
  it("answers PING with PONG, echoing the payload, and ignores PONG/OPEN from the Mac", () => {
    const host = connectHost();
    fromHost(host, RELAY_OP.PING, 0, enc.encode("t=1"));
    expect(host.frames()).toEqual([{ op: RELAY_OP.PONG, stream: 0, payload: enc.encode("t=1") }]);
    fromHost(host, RELAY_OP.PONG, 0);
    fromHost(host, RELAY_OP.OPEN, 5);
    expect(host.sent.length).toBe(1);
  });

  it("a new host replaces the old one (4009) and the old one's phones are closed", () => {
    const old = connectHost();
    const phone = connectPhone(old);
    const next = connectHost();
    expect(old.closedWith).toEqual({ code: CLOSE.REPLACED.code, reason: "replaced" });
    expect(phone.ws.closedWith).toEqual({ code: 4004, reason: "mac offline" });
    expect(hub.host()).toBe(next);

    // The replaced socket's late frames and its close must not touch the new host's phones.
    const fresh = connectPhone(next);
    const sentToOld = old.sent.length;
    hub.onMessage(old, FakeSocket.bytes(encodeRelayFrame(RELAY_OP.CLOSE, fresh.stream, closePayload(1000, ""))));
    hub.onMessage(old, FakeSocket.bytes(encodeRelayFrame(RELAY_OP.PING, 0)));
    hub.onClose(old, 4009, "replaced");
    ctx.drop(old);
    expect(fresh.ws.closedWith).toBeNull();
    expect(old.sent.length).toBe(sentToOld);
    expect(hub.host()).toBe(next);
  });

  it("closes every phone with 4004 when the Mac disconnects, and refuses new ones", () => {
    const host = connectHost();
    const a = connectPhone(host);
    const b = connectPhone(host);
    hub.onClose(host, 1006, "");
    ctx.drop(host);
    expect(a.ws.closedWith).toEqual({ code: 4004, reason: "mac offline" });
    expect(b.ws.closedWith).toEqual({ code: 4004, reason: "mac offline" });
    const late = new FakeSocket();
    hub.acceptPhone(late);
    expect(ctx.refused.at(-1)).toMatchObject({ ws: late, code: 4004 });
  });

  it("closes a phone that speaks while no Mac is connected", () => {
    const host = connectHost();
    const { ws } = connectPhone(host);
    // The host socket vanished without its close being delivered (e.g. evicted mid-close).
    ctx.drop(host);
    hub.onMessage(ws, "hello?");
    expect(ws.closedWith).toEqual({ code: 4004, reason: "mac offline" });
  });

  it("survives sending to a host that is already closing", () => {
    const host = connectHost();
    const { ws } = connectPhone(host);
    host.closedWith = { code: 1001 };
    expect(() => hub.onMessage(ws, "hi")).not.toThrow();
    expect(() => hub.onClose(ws, 1000, "")).not.toThrow();
  });
});

describe("limits", () => {
  it("closes a phone with 1009 when it sends more than RELAY_MAX_PAYLOAD, and tells the Mac", () => {
    const host = connectHost();
    const { ws, stream } = connectPhone(host);
    hub.onMessage(ws, FakeSocket.bytes(new Uint8Array(RELAY_MAX_PAYLOAD)));
    expect(lastFrame(host).op).toBe(RELAY_OP.BIN); // exactly the limit is fine
    hub.onMessage(ws, FakeSocket.bytes(new Uint8Array(RELAY_MAX_PAYLOAD + 1)));
    expect(ws.closedWith).toEqual({ code: 1009, reason: "too big" });
    expect(lastFrame(host)).toMatchObject({ op: RELAY_OP.CLOSE, stream });
    expect(readClosePayload(lastFrame(host).payload)).toEqual({ code: 1009, reason: "too big" });
  });

  it("measures phone text in UTF-8 bytes", () => {
    const host = connectHost();
    const { ws } = connectPhone(host);
    hub.onMessage(ws, "€".repeat(Math.floor(RELAY_MAX_PAYLOAD / 3) + 1)); // 3 bytes each
    expect(ws.closedWith?.code).toBe(1009);
  });

  it("closes the stream with 1009 when the Mac sends more than RELAY_MAX_PAYLOAD", () => {
    const host = connectHost();
    const { ws, stream } = connectPhone(host);
    fromHost(host, RELAY_OP.BIN, stream, new Uint8Array(RELAY_MAX_PAYLOAD + 1));
    expect(ws.sent).toEqual([]);
    expect(ws.closedWith).toEqual({ code: 1009, reason: "too big" });
    expect(lastFrame(host)).toMatchObject({ op: RELAY_OP.CLOSE, stream });
  });

  it(`accepts ${RELAY_MAX_STREAMS} phones per Mac and closes the next with 4029`, () => {
    const host = connectHost();
    const phones = Array.from({ length: RELAY_MAX_STREAMS }, () => connectPhone(host));
    const extra = new FakeSocket();
    hub.acceptPhone(extra);
    expect(ctx.refused).toEqual([{ ws: extra, code: 4029, reason: "too many" }]);
    // A slot frees up once a phone leaves.
    hub.onClose(phones[0].ws, 1000, "");
    ctx.drop(phones[0].ws);
    const again = connectPhone(host);
    expect(again.stream).toBe(RELAY_MAX_STREAMS + 1);
  });
});

describe("malformed host frames are dropped", () => {
  it("ignores short frames, unknown ops, text messages, bad UTF-8 and unknown streams", () => {
    const host = connectHost();
    const { ws, stream } = connectPhone(host);
    const sentToHost = host.sent.length;
    hub.onMessage(host, FakeSocket.bytes(new Uint8Array([2, 0, 0])));
    hub.onMessage(host, FakeSocket.bytes(new Uint8Array([0, 0, 0, 0, 1])));
    hub.onMessage(host, FakeSocket.bytes(new Uint8Array([99, 0, 0, 0, 1, 1])));
    hub.onMessage(host, "not a frame");
    fromHost(host, RELAY_OP.TEXT, stream, new Uint8Array([0xc3, 0x28])); // invalid UTF-8
    fromHost(host, RELAY_OP.TEXT, 999, enc.encode("nobody"));
    fromHost(host, RELAY_OP.CLOSE, 999);
    fromHost(host, RELAY_OP.BIN, 0, new Uint8Array([1]));
    expect(ws.sent).toEqual([]);
    expect(ws.closedWith).toBeNull();
    expect(host.sent.length).toBe(sentToHost);
    // ...and the link still works.
    fromHost(host, RELAY_OP.TEXT, stream, enc.encode("ok"));
    expect(ws.sent).toEqual(["ok"]);
  });

  it("ignores sockets with no attachment", () => {
    const stray = new FakeSocket();
    expect(() => hub.onMessage(stray, "x")).not.toThrow();
    expect(() => hub.onClose(stray, 1000, "")).not.toThrow();
  });
});

describe("stream ids across hibernation", () => {
  it("never reuses an id after the object wakes up again", () => {
    const host = connectHost();
    connectPhone(host); // 1
    const two = connectPhone(host); // 2
    hub.onClose(two.ws, 1000, "");
    ctx.drop(two.ws);
    expect(ctx.stored).toBe(3);

    // Evicted and rebuilt: same sockets and attachments, only the persisted counter in hand.
    hub = new RelayHub(ctx, ctx.stored);
    expect(hub.host()).toBe(host);
    expect(connectPhone(host).stream).toBe(3);
  });

  it("skips ids held by surviving sockets even if the stored counter is behind", () => {
    const host = connectHost();
    for (let i = 0; i < 5; i++) connectPhone(host); // 1..5
    hub = new RelayHub(ctx, 2);
    expect(connectPhone(host).stream).toBe(6);
  });

  it("starts at 1 on a brand-new relay and wraps past 2^32 - 1 without reaching 0", () => {
    const host = connectHost();
    expect(connectPhone(host).stream).toBe(1);
    hub = new RelayHub(ctx, 0xffff_ffff);
    expect(connectPhone(host).stream).toBe(0xffff_ffff);
    expect(ctx.stored).toBe(1);
    // 1 is still held by the first phone, so the next free id is 2.
    expect(connectPhone(host).stream).toBe(2);
  });
});

describe("close helpers", () => {
  it("maps reserved close codes to 1000", () => {
    for (const c of [1000, 1001, 1009, 1011, 3000, 4004, 4999]) expect(sendableCloseCode(c)).toBe(c);
    for (const c of [0, 999, 1005, 1006, 1015, 2999, 5000]) expect(sendableCloseCode(c)).toBe(1000);
  });

  it("trims reasons to 123 UTF-8 bytes on a character boundary", () => {
    expect(clampCloseReason("short")).toBe("short");
    const r = clampCloseReason("日".repeat(60));
    expect(enc.encode(r).length).toBe(123);
    expect(r).toBe("日".repeat(41));
  });
});
