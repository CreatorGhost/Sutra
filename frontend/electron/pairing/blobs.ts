// Audio (and other large payloads) a phone uploads in chunks with `blob.put`, assembled in MEMORY only —
// raw audio is never written to disk on the Mac. Chunks of one blob must arrive in order from seq 0;
// a finished blob waits for the request that uses it (stt.transcribe) and is dropped when taken, or
// after BLOB_TTL_MS without activity.
import { fromB64u } from "../../src/shared/pairing/crypto";
import { MAX_BLOB_BYTES } from "../../src/shared/pairing/protocol";

export const BLOB_TTL_MS = 10 * 60_000;
/** Blobs one phone may have open at once (the phone uploads one window at a time; a few spare). */
export const MAX_BLOBS_PER_DEVICE = 4;

interface Upload { chunks: Uint8Array[]; bytes: number; nextSeq: number; done: boolean; touched: number }

export class BlobAssembler {
  private blobs = new Map<string, Upload>();

  constructor(private readonly now: () => number = Date.now, private readonly maxBytes = MAX_BLOB_BYTES) {}

  private key = (owner: string, id: string) => `${owner}\n${id}`;

  /** One chunk of `blob.put`. Throws a phone-readable message on anything out of order or too big. */
  put(owner: string, p: unknown): { received: number } {
    this.sweep();
    const { id, seq, last, data } = (p ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) throw new Error("Bad upload id.");
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) throw new Error("Bad upload chunk number.");
    if (typeof data !== "string") throw new Error("Bad upload chunk.");
    const k = this.key(owner, id);
    let b = this.blobs.get(k);
    if (seq === 0) {
      // A fresh upload (or a retry from the start) replaces whatever was there.
      this.blobs.delete(k);
      if (this.countFor(owner) >= MAX_BLOBS_PER_DEVICE) throw new Error("Too many uploads in progress.");
      b = { chunks: [], bytes: 0, nextSeq: 0, done: false, touched: this.now() };
      this.blobs.set(k, b);
    }
    if (!b || b.done || seq !== b.nextSeq) throw new Error("Upload chunk out of order — start the upload again.");
    let bytes: Uint8Array;
    try { bytes = fromB64u(data); } catch { throw new Error("Bad upload chunk."); }
    if (b.bytes + bytes.length > this.maxBytes) {
      this.blobs.delete(k);
      throw new Error("That recording is too large to send in one piece.");
    }
    b.chunks.push(bytes);
    b.bytes += bytes.length;
    b.nextSeq++;
    b.done = last === true;
    b.touched = this.now();
    return { received: b.bytes };
  }

  /** A finished blob, removed from memory; null when unknown, unfinished or expired. */
  take(owner: string, id: string): Uint8Array | null {
    this.sweep();
    const k = this.key(owner, id);
    const b = this.blobs.get(k);
    if (!b?.done) return null;
    this.blobs.delete(k);
    const out = new Uint8Array(b.bytes);
    let o = 0;
    for (const c of b.chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /** Forget everything a phone uploaded (it was removed). */
  dropOwner(owner: string): void {
    for (const k of [...this.blobs.keys()]) if (k.startsWith(`${owner}\n`)) this.blobs.delete(k);
  }

  sweep(): void {
    const cutoff = this.now() - BLOB_TTL_MS;
    for (const [k, b] of this.blobs) if (b.touched < cutoff) this.blobs.delete(k);
  }

  private countFor(owner: string): number {
    let n = 0;
    for (const k of this.blobs.keys()) if (k.startsWith(`${owner}\n`)) n++;
    return n;
  }
}
