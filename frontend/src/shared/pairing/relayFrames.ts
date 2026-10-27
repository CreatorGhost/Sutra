// Framing between the user's Cloudflare relay and the Mac. The Mac keeps ONE outbound WebSocket to the
// relay (`/host/<hostId>`, Authorization: Bearer <host secret>); every phone socket on `/phone/<hostId>`
// becomes a numbered stream on it. Phones see a plain WebSocket and speak the normal link protocol, so
// the relay only ever forwards handshake JSON and sealed frames — it can't read or forge anything.
//
// Frame: op (u8) ‖ stream id (u32 BE) ‖ payload
//   OPEN  relay→Mac   a phone connected (payload: empty)
//   TEXT  both ways   a text message for/from that phone (payload: UTF-8)
//   BIN   both ways   a binary message for/from that phone
//   CLOSE both ways   close that phone's socket (payload: u16 code ‖ UTF-8 reason)
// Plus PING/PONG (stream 0) so either end notices a dead link.
export const RELAY_OP = { OPEN: 1, TEXT: 2, BIN: 3, CLOSE: 4, PING: 5, PONG: 6 } as const;
export type RelayOp = (typeof RELAY_OP)[keyof typeof RELAY_OP];

export interface RelayFrame { op: RelayOp; stream: number; payload: Uint8Array }

/** Max phone sockets one Mac accepts through the relay at once. */
export const RELAY_MAX_STREAMS = 32;
/** Durable Object WebSocket messages are capped at 1 MiB; stay well under it. */
export const RELAY_MAX_PAYLOAD = 900 * 1024;

export function encodeRelayFrame(op: RelayOp, stream: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = op;
  new DataView(out.buffer).setUint32(1, stream >>> 0);
  out.set(payload, 5);
  return out;
}

export function decodeRelayFrame(data: Uint8Array): RelayFrame | null {
  if (data.length < 5) return null;
  const op = data[0] as RelayOp;
  if (op < RELAY_OP.OPEN || op > RELAY_OP.PONG) return null;
  return { op, stream: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1), payload: data.subarray(5) };
}

export function closePayload(code: number, reason: string): Uint8Array {
  const r = new TextEncoder().encode(reason.slice(0, 120));
  const out = new Uint8Array(2 + r.length);
  new DataView(out.buffer).setUint16(0, code);
  out.set(r, 2);
  return out;
}
export function readClosePayload(p: Uint8Array): { code: number; reason: string } {
  if (p.length < 2) return { code: 1000, reason: "" };
  return { code: new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(0), reason: new TextDecoder().decode(p.subarray(2)) };
}
