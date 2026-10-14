// What one relay (one Mac) does with its sockets: the Mac's host socket carries every phone as a
// numbered stream (frame format in relayFrames.ts, shared with the Mac). Written against a small
// interface instead of DurableObjectState so tests can drive it without the Workers runtime.
//
// No state lives in memory except the next stream id: everything else is the sockets' tags and
// attachments, which survive hibernation. So the object can sleep between any two messages.
import {
  RELAY_MAX_PAYLOAD, RELAY_MAX_STREAMS, RELAY_OP, closePayload, decodeRelayFrame, encodeRelayFrame, readClosePayload,
} from "../../../frontend/src/shared/pairing/relayFrames.ts";

/** Close codes phones (and the Mac, for its streams) see from the relay itself. */
export const CLOSE = {
  /** No Mac is connected, or it just disconnected — the phone can say "your Mac is offline". */
  MAC_OFFLINE: { code: 4004, reason: "mac offline" },
  /** A newer host connection took over this one. */
  REPLACED: { code: 4009, reason: "replaced" },
  /** RELAY_MAX_STREAMS phones are already connected to this Mac. */
  TOO_MANY: { code: 4029, reason: "too many" },
  /** A message over RELAY_MAX_PAYLOAD. */
  TOO_BIG: { code: 1009, reason: "too big" },
} as const;

/** The parts of a hibernatable WebSocket the hub uses. */
export interface RelaySocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The parts of DurableObjectState the hub uses. */
export interface RelayContext<S extends RelaySocket> {
  /** Accept as a hibernatable socket with these tags. */
  accept(ws: S, tags: string[]): void;
  sockets(tag: string): S[];
  /** Accept and immediately close, so the phone gets a close code it can show (an HTTP error
   *  before the upgrade reaches a browser WebSocket only as an anonymous 1006). */
  refuse(ws: S, code: number, reason: string): void;
  /** Persist the next stream id, so ids aren't reused even after the object is evicted. */
  saveNextStream(next: number): void;
}

type Attachment =
  | { role: "host"; replaced?: true }
  | { role: "phone"; stream: number; closed?: true };

const HOST_TAG = "host";
const PHONE_TAG = "phone";
const streamTag = (stream: number) => `phone:${stream}`;
/** Stream ids run 1 to 2^32 - 1; 0 is the link itself (PING/PONG). */
const MAX_STREAM_ID = 0xffff_ffff;

const encoder = new TextEncoder();
// ignoreBOM keeps a leading BOM in the text, so the phone gets exactly what the Mac sent.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const attachmentOf = (ws: RelaySocket) => ws.deserializeAttachment() as Attachment | null;

/** Codes a server may put in a close frame; 1005/1006/1015 are reserved for "none"/local errors. */
export function sendableCloseCode(code: number): number {
  return code === 1000 || (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999) ? code : 1000;
}

/** Close reasons are capped at 123 UTF-8 bytes; trim by characters so none is split. */
export function clampCloseReason(reason: string): string {
  let r = reason;
  while (encoder.encode(r).length > 123) r = r.slice(0, -1);
  return r;
}

function safeClose(ws: RelaySocket, code: number, reason: string): void {
  try { ws.close(sendableCloseCode(code), clampCloseReason(reason)); } catch { /* already closed */ }
}

function safeSend(ws: RelaySocket, data: string | ArrayBufferView): void {
  // A socket that is closing throws; its close handler does the clean-up.
  try { ws.send(data); } catch { /* closing */ }
}

export class RelayHub<S extends RelaySocket> {
  private nextStream: number;

  /** `storedNext`: what saveNextStream last persisted (undefined for a brand-new relay). */
  constructor(private readonly ctx: RelayContext<S>, storedNext: number | undefined) {
    let next = storedNext ?? 1;
    // Belt and braces: never hand out an id a surviving phone socket already holds.
    for (const ws of ctx.sockets(PHONE_TAG)) {
      const a = attachmentOf(ws);
      if (a?.role === "phone") next = Math.max(next, a.stream + 1);
    }
    this.nextStream = next > MAX_STREAM_ID || next < 1 ? 1 : next;
  }

  /** The current host socket: the one host connection not marked replaced. */
  host(): S | null {
    return this.ctx.sockets(HOST_TAG).find((ws) => { const a = attachmentOf(ws); return a?.role === "host" && !a.replaced; }) ?? null;
  }

  private livePhones(): { ws: S; stream: number }[] {
    const out: { ws: S; stream: number }[] = [];
    for (const ws of this.ctx.sockets(PHONE_TAG)) {
      const a = attachmentOf(ws);
      if (a?.role === "phone" && !a.closed) out.push({ ws, stream: a.stream });
    }
    return out;
  }

  private phone(stream: number): S | null {
    return this.ctx.sockets(streamTag(stream)).find((ws) => { const a = attachmentOf(ws); return a?.role === "phone" && !a.closed; }) ?? null;
  }

  private allocateStream(): number {
    const taken = new Set(this.livePhones().map((p) => p.stream));
    let id = this.nextStream;
    // Only matters after 4 billion connections wrap the counter.
    while (taken.has(id)) id = id >= MAX_STREAM_ID ? 1 : id + 1;
    this.nextStream = id >= MAX_STREAM_ID ? 1 : id + 1;
    this.ctx.saveNextStream(this.nextStream);
    return id;
  }

  acceptHost(ws: S): void {
    // One Mac per relay: a newer connection (e.g. after a network change left the old one half-open)
    // wins. Marking the old one first means its late messages and close are ignored.
    for (const old of this.ctx.sockets(HOST_TAG)) {
      old.serializeAttachment({ role: "host", replaced: true } satisfies Attachment);
      safeClose(old, CLOSE.REPLACED.code, CLOSE.REPLACED.reason);
    }
    // The phones' streams belonged to the old connection; the new one knows nothing of them.
    this.closeAllPhones();
    this.ctx.accept(ws, [HOST_TAG]);
    ws.serializeAttachment({ role: "host" } satisfies Attachment);
  }

  acceptPhone(ws: S): void {
    const host = this.host();
    if (!host) { this.ctx.refuse(ws, CLOSE.MAC_OFFLINE.code, CLOSE.MAC_OFFLINE.reason); return; }
    if (this.livePhones().length >= RELAY_MAX_STREAMS) { this.ctx.refuse(ws, CLOSE.TOO_MANY.code, CLOSE.TOO_MANY.reason); return; }
    const stream = this.allocateStream();
    this.ctx.accept(ws, [PHONE_TAG, streamTag(stream)]);
    ws.serializeAttachment({ role: "phone", stream } satisfies Attachment);
    safeSend(host, encodeRelayFrame(RELAY_OP.OPEN, stream));
  }

  onMessage(ws: S, message: string | ArrayBuffer): void {
    const a = attachmentOf(ws);
    if (a?.role === "host") {
      // Host frames are binary; text, and anything from a replaced connection, is dropped.
      if (!a.replaced && typeof message !== "string") this.onHostFrame(ws, new Uint8Array(message));
      return;
    }
    if (a?.role !== "phone" || a.closed) return;
    const host = this.host();
    if (!host) { this.endPhone(ws, a.stream, CLOSE.MAC_OFFLINE, false); return; }
    const isText = typeof message === "string";
    const bytes = isText ? encoder.encode(message) : new Uint8Array(message);
    if (bytes.length > RELAY_MAX_PAYLOAD) { this.endPhone(ws, a.stream, CLOSE.TOO_BIG, true); return; }
    safeSend(host, encodeRelayFrame(isText ? RELAY_OP.TEXT : RELAY_OP.BIN, a.stream, bytes));
  }

  private onHostFrame(host: S, data: Uint8Array): void {
    const f = decodeRelayFrame(data);
    if (!f) return;
    switch (f.op) {
      case RELAY_OP.PING:
        safeSend(host, encodeRelayFrame(RELAY_OP.PONG, f.stream, f.payload));
        return;
      case RELAY_OP.TEXT:
      case RELAY_OP.BIN: {
        const phone = this.phone(f.stream);
        if (!phone) return; // the phone left; its CLOSE is already on the way to the Mac
        if (f.payload.length > RELAY_MAX_PAYLOAD) { this.endPhone(phone, f.stream, CLOSE.TOO_BIG, true); return; }
        if (f.op === RELAY_OP.BIN) { safeSend(phone, f.payload); return; }
        let text: string;
        try { text = strictUtf8.decode(f.payload); } catch { return; } // malformed: drop
        safeSend(phone, text);
        return;
      }
      case RELAY_OP.CLOSE: {
        const phone = this.phone(f.stream);
        if (phone) this.endPhone(phone, f.stream, readClosePayload(f.payload), false);
        return;
      }
      default:
        // OPEN only flows relay→Mac, and the relay never pings, so a PONG is unsolicited.
        return;
    }
  }

  /** Close a phone from the relay's side. Marked first, so its later close event isn't echoed. */
  private endPhone(ws: S, stream: number, why: { code: number; reason: string }, tellHost: boolean): void {
    ws.serializeAttachment({ role: "phone", stream, closed: true } satisfies Attachment);
    safeClose(ws, why.code, why.reason);
    const host = tellHost ? this.host() : null;
    if (host) safeSend(host, encodeRelayFrame(RELAY_OP.CLOSE, stream, closePayload(why.code, why.reason)));
  }

  private closeAllPhones(): void {
    for (const p of this.livePhones()) this.endPhone(p.ws, p.stream, CLOSE.MAC_OFFLINE, false);
  }

  onClose(ws: S, code: number, reason: string): void {
    const a = attachmentOf(ws);
    if (a?.role === "host" && !a.replaced) {
      this.closeAllPhones();
    } else if (a?.role === "phone" && !a.closed) {
      ws.serializeAttachment({ role: "phone", stream: a.stream, closed: true } satisfies Attachment);
      const host = this.host();
      if (host) safeSend(host, encodeRelayFrame(RELAY_OP.CLOSE, a.stream, closePayload(code, reason)));
    }
    // No ws.close() here: from compatibility date 2026-04-07 the runtime answers the close itself.
  }
}
