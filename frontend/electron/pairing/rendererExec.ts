// Phone requests that need the app's own code (speech, the AI engine, the library) run in the main
// window's RENDERER, where the providers and the database layer live. Main forwards them over
// `sutra:pair:exec` and the renderer answers on `sutra:pair:result`. Pure: `post` delivers a message
// and says whether there was a renderer to deliver it to.
import type { ExecDevice, ExecMessage, ExecResult } from "../../src/shared/pairing/hostApi";

export type { ExecDevice, ExecMessage, ExecResult };

export const EXEC_TIMEOUT_MS = 10 * 60_000;
const NOT_RUNNING = "Sutra isn't fully running on your Mac right now. Open Sutra on your Mac and try again.";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class RendererExec {
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready = false;

  constructor(private readonly post: (m: ExecMessage) => boolean, private readonly timeoutMs = EXEC_TIMEOUT_MS) {}

  /** The renderer announces it can serve requests (and stops being able to on reload/crash). */
  setReady(on: boolean): void {
    this.ready = on;
    if (!on) this.failAll("Sutra on your Mac restarted while working on this. Try again.");
  }

  call(method: string, params: unknown, device: ExecDevice, blob?: Uint8Array): Promise<unknown> {
    if (!this.ready) return Promise.reject(new Error(NOT_RUNNING));
    const reqId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error("Your Mac took too long to finish this.")); }, this.timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      const msg: ExecMessage = { reqId, method, params, device };
      if (blob) msg.blob = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
      let delivered = false;
      try { delivered = this.post(msg); } catch { /* window going away */ }
      if (!delivered) { clearTimeout(timer); this.pending.delete(reqId); reject(new Error(NOT_RUNNING)); }
    });
  }

  settle(r: ExecResult): void {
    const p = this.pending.get(Number(r?.reqId));
    if (!p) return;
    this.pending.delete(Number(r.reqId));
    clearTimeout(p.timer);
    if (r.ok) p.resolve(r.result ?? null);
    else p.reject(new Error(String(r.error || "Something went wrong on your Mac.").slice(0, 2000)));
  }

  failAll(message: string): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
  }
}
