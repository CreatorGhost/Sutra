// Hand-written fakes of the Durable Object WebSocket APIs RelayHub uses. Attachments and tags live on
// the sockets, as in the runtime, so a new RelayHub over the same context models a wake from hibernation.
import { decodeRelayFrame, type RelayFrame } from "../../../frontend/src/shared/pairing/relayFrames.ts";
import type { RelayContext, RelaySocket } from "../src/hub.ts";

export class FakeSocket implements RelaySocket {
  sent: (string | Uint8Array)[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  tags: string[] = [];
  private attachment: unknown = null;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closedWith) throw new Error("WebSocket is closed");
    if (typeof data === "string") this.sent.push(data);
    else if (data instanceof ArrayBuffer) this.sent.push(new Uint8Array(data.slice(0)));
    else this.sent.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
  }
  close(code?: number, reason?: string): void {
    if (this.closedWith) throw new Error("WebSocket is already closed");
    if (reason !== undefined && new TextEncoder().encode(reason).length > 123) throw new Error("reason too long");
    this.closedWith = { code, reason };
  }
  serializeAttachment(value: unknown): void { this.attachment = structuredClone(value); }
  deserializeAttachment(): unknown { return structuredClone(this.attachment); }

  /** Everything sent so far, decoded as relay frames (host sockets only). */
  frames(): RelayFrame[] {
    return this.sent.map((d) => {
      if (typeof d === "string") throw new Error(`text sent to host: ${d}`);
      const f = decodeRelayFrame(d);
      if (!f) throw new Error("undecodable frame sent to host");
      return f;
    });
  }
  /** Bytes as the runtime hands them to webSocketMessage. */
  static bytes(data: Uint8Array): ArrayBuffer {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
}

export class FakeContext implements RelayContext<FakeSocket> {
  live: FakeSocket[] = [];
  refused: { ws: FakeSocket; code: number; reason: string }[] = [];
  /** What saveNextStream persisted, like ctx.storage. */
  stored: number | undefined;

  accept(ws: FakeSocket, tags: string[]): void { ws.tags = tags; this.live.push(ws); }
  sockets(tag: string): FakeSocket[] { return this.live.filter((ws) => ws.tags.includes(tag)); }
  refuse(ws: FakeSocket, code: number, reason: string): void { this.refused.push({ ws, code, reason }); }
  saveNextStream(next: number): void { this.stored = next; }
  /** The runtime forgets a socket once its close has been handled. */
  drop(ws: FakeSocket): void { this.live = this.live.filter((s) => s !== ws); }
}
