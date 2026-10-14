// Recordings waiting on the phone for the Mac. When paired, the recorder never depends on the Mac being
// reachable: each ~90 s window is sealed with the pairing's storage key and written to app-private
// storage FIRST, and a single worker sends windows to the Mac in order, deleting each one the moment
// it's transcribed — audio is kept only until it's transcribed. When a closed recording has nothing
// left to send, the notes are written (through the Mac) and the finished meeting, without audio, is
// copied to the Mac.
//
//   sutra-queue/<sessionId>/session.json   { closed, processed, synced, syncAttempts }
//   sutra-queue/<sessionId>/<window>.bin   sealed audio
//   sutra-queue/<sessionId>/<window>.json  { filename, mime, windowStartMs, attempts, error, failed }
import { Directory, Filesystem } from "@capacitor/filesystem";
import { b64u, fromB64u, fromUtf8, openAtRest, sealAtRest, utf8 } from "../shared/pairing/crypto";

/** The little filesystem the queue needs (Capacitor on the phone, in-memory in tests). */
export interface QueueFs {
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  /** Entry names in a directory; [] when it doesn't exist. */
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
}

export interface OutboxDeps {
  fs: QueueFs;
  storageKey(): Promise<string | null>;
  /** True while the Mac is connected and its speech engine is ready. */
  ready(): boolean;
  ingest(sessionId: number, blob: Blob, windowIndex: number, filename: string, windowStartMs: number): Promise<any>;
  process(sessionId: number): Promise<any>;
  /** A session's conversations, and whether each has its notes (only those are copied to the Mac). */
  conversations(sessionId: number): Promise<{ id: number; finished: boolean }[]>;
  sync(conversationId: number): Promise<void>;
  retryDelayMs?: number;
}

export type OutboxEvent =
  | { t: "ingested"; sessionId: number; windowIndex: number; result: any }
  | { t: "processed"; sessionId: number; result: any }
  | { t: "failed"; sessionId: number; windowIndex: number; error: string }
  | { t: "changed" };

export interface QueueStats {
  /** Recordings not yet turned into notes. */
  recordings: number;
  /** Audio windows still waiting for the Mac. */
  windows: number;
  /** Windows the Mac couldn't transcribe after several tries (kept until retried or discarded). */
  failed: number;
}

export const MAX_ATTEMPTS = 3;
const ROOT = "sutra-queue";

interface WindowMeta { index: number; filename: string; mime: string; windowStartMs: number; attempts: number; error: string | null; failed: boolean }
interface SessionMeta { closed: boolean; processed: boolean; synced: number[]; syncAttempts: Record<string, number> }
const NEW_SESSION: SessionMeta = { closed: false, processed: false, synced: [], syncAttempts: {} };

const dirOf = (sid: number) => `${ROOT}/${sid}`;
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export class Outbox {
  private running: Promise<void> | null = null;
  private again = false;
  private lock: Promise<unknown> = Promise.resolve();
  private live = new Set<number>();
  private listeners = new Set<(e: OutboxEvent) => void>();

  constructor(private readonly deps: OutboxDeps) {}

  subscribe(fn: (e: OutboxEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** A recording started: its queue stays open (recovery won't close it) until closeSession. */
  begin(sessionId: number): void { this.live.add(sessionId); }

  /** Seal one window and write it to disk — before anything else happens to it. */
  async enqueue(sessionId: number, windowIndex: number, blob: Blob, meta: { filename: string; windowStartMs: number }): Promise<void> {
    const key = await this.deps.storageKey();
    if (!key) throw new Error("This phone isn't paired with a Mac.");
    const sealed = await sealAtRest(key, new Uint8Array(await blob.arrayBuffer()));
    const w: WindowMeta = { index: windowIndex, filename: meta.filename, mime: blob.type, windowStartMs: meta.windowStartMs, attempts: 0, error: null, failed: false };
    await this.locked(async () => {
      if (!(await this.readSession(sessionId))) await this.writeJson(`${dirOf(sessionId)}/session.json`, NEW_SESSION);
      await this.deps.fs.write(`${dirOf(sessionId)}/${windowIndex}.bin`, sealed);
      await this.writeJson(`${dirOf(sessionId)}/${windowIndex}.json`, w);
    });
    this.emit({ t: "changed" });
    void this.drain();
  }

  /** The recording stopped: once its windows are sent, write its notes. (Nothing was queued for a
   *  recording too quiet to produce a window — there's nothing to do then.) */
  async closeSession(sessionId: number): Promise<void> {
    this.live.delete(sessionId);
    if (!(await this.readSession(sessionId))) return;
    await this.patchSession(sessionId, { closed: true });
    this.emit({ t: "changed" });
    void this.drain();
  }

  /** App start: recordings cut short (app killed mid-recording) are closed so they still get notes.
   *  Returns the sessions it closed. */
  async recover(): Promise<number[]> {
    const closed: number[] = [];
    for (const sid of await this.sessionIds()) {
      if (this.live.has(sid)) continue;
      const s = await this.readSession(sid);
      if (!s || !s.closed) { await this.patchSession(sid, { closed: true }); closed.push(sid); }
    }
    if (closed.length) this.emit({ t: "changed" });
    return closed;
  }

  /** Still waiting for the Mac (audio to send, or notes not written yet). */
  async isWaiting(sessionId: number): Promise<boolean> {
    const s = await this.readSession(sessionId);
    if (!s) return false;
    return !s.processed || (await this.windows(sessionId)).some((w) => !w.failed);
  }

  async stats(): Promise<QueueStats> {
    const out: QueueStats = { recordings: 0, windows: 0, failed: 0 };
    for (const sid of await this.sessionIds()) {
      const s = await this.readSession(sid);
      const ws = await this.windows(sid);
      const waiting = ws.filter((w) => !w.failed).length;
      out.windows += waiting;
      out.failed += ws.length - waiting;
      if (waiting || (s && !s.processed)) out.recordings++;
    }
    return out;
  }

  /** Give windows that failed another go. */
  async retryFailed(): Promise<void> {
    await this.forFailed((sid, w) => this.locked(() => this.writeJson(`${dirOf(sid)}/${w.index}.json`, { ...w, attempts: 0, error: null, failed: false })));
    void this.drain();
  }

  /** Delete windows the Mac couldn't transcribe (their audio is gone for good). */
  async discardFailed(): Promise<void> {
    await this.forFailed((sid, w) => this.removeWindow(sid, w.index));
    void this.drain();
  }

  /** Forget everything waiting (unpairing). */
  async clear(): Promise<void> {
    // Callers drop the Mac first, so a running worker stops at its next step; let it, then wipe.
    if (this.running) await this.running;
    await this.locked(() => this.deps.fs.removeDir(ROOT));
    this.emit({ t: "changed" });
  }

  /** Send what's waiting. One worker: a call while it runs makes it go round once more, and the
   *  returned promise settles when the worker is idle. */
  drain(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await this.runOnce(); } while (this.again && this.deps.ready());
      } catch (e) {
        console.warn("[outbox] drain stopped", msg(e));
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  // ---- worker ----

  private async runOnce(): Promise<void> {
    if (!this.deps.ready()) return;
    const key = await this.deps.storageKey();
    if (!key) return;
    for (const sid of await this.sessionIds()) {
      if (!(await this.drainSession(sid, key))) return; // lost the Mac — the next connect resumes
    }
  }

  /** False when the Mac went away (stop everything); true otherwise. */
  private async drainSession(sid: number, key: string): Promise<boolean> {
    for (const w of await this.windows(sid)) {
      if (w.failed) continue;
      if (!(await this.sendWindow(sid, w, key))) return false;
    }
    const s = await this.readSession(sid);
    if (!s?.closed || (await this.windows(sid)).some((w) => !w.failed)) return true;

    if (!s.processed) {
      if (!this.deps.ready()) return false;
      let result: any;
      try { result = await this.deps.process(sid); }
      catch (e) { if (!this.deps.ready()) return false; console.warn("[outbox] processing failed", sid, msg(e)); return true; }
      // Notes are written conversation by conversation; if the Mac dropped half-way, redo the rest later.
      if (!this.deps.ready()) return false;
      await this.patchSession(sid, { processed: true });
      this.emit({ t: "processed", sessionId: sid, result });
    }

    const convs = await this.deps.conversations(sid);
    for (const c of convs) {
      const cur = (await this.readSession(sid)) ?? NEW_SESSION;
      if (!c.finished || cur.synced.includes(c.id) || (cur.syncAttempts[c.id] ?? 0) >= MAX_ATTEMPTS) continue;
      if (!this.deps.ready()) return false;
      try {
        await this.deps.sync(c.id);
        await this.patchSession(sid, (m) => ({ synced: [...m.synced, c.id] }));
      } catch (e) {
        if (!this.deps.ready()) return false;
        console.warn("[outbox] copying a meeting to the Mac failed", c.id, msg(e));
        await this.patchSession(sid, (m) => ({ syncAttempts: { ...m.syncAttempts, [c.id]: (m.syncAttempts[c.id] ?? 0) + 1 } }));
      }
    }
    // Done when every conversation is on the Mac (or gave up) and no audio is left. A conversation
    // whose notes failed keeps the (audio-free) entry, so it's copied once the user retries it.
    const end = (await this.readSession(sid)) ?? NEW_SESSION;
    const settled = convs.every((c) => end.synced.includes(c.id) || (end.syncAttempts[c.id] ?? 0) >= MAX_ATTEMPTS);
    if (settled && !(await this.windows(sid)).length) {
      await this.locked(() => this.deps.fs.removeDir(dirOf(sid)));
      this.emit({ t: "changed" });
    }
    return true;
  }

  private async sendWindow(sid: number, w: WindowMeta, key: string): Promise<boolean> {
    for (;;) {
      if (!this.deps.ready()) return false;
      try {
        const audio = await openAtRest(key, await this.deps.fs.read(`${dirOf(sid)}/${w.index}.bin`));
        const result = await this.deps.ingest(sid, new Blob([audio as Uint8Array<ArrayBuffer>], { type: w.mime }), w.index, w.filename, w.windowStartMs);
        // Transcribed: the audio goes now, and the session needs (re)processing.
        await this.locked(async () => {
          await this.removeWindowUnlocked(sid, w.index);
          await this.patchSessionUnlocked(sid, { processed: false });
        });
        this.emit({ t: "ingested", sessionId: sid, windowIndex: w.index, result });
        this.emit({ t: "changed" });
        return true;
      } catch (e) {
        if (!this.deps.ready()) return false; // the Mac went away mid-request: not this window's fault
        w.attempts++;
        w.error = msg(e);
        w.failed = w.attempts >= MAX_ATTEMPTS;
        await this.locked(() => this.writeJson(`${dirOf(sid)}/${w.index}.json`, w));
        if (w.failed) {
          this.emit({ t: "failed", sessionId: sid, windowIndex: w.index, error: w.error });
          this.emit({ t: "changed" });
          return true;
        }
        await new Promise((r) => setTimeout(r, (this.deps.retryDelayMs ?? 2_000) * w.attempts));
      }
    }
  }

  // ---- storage ----

  private emit(e: OutboxEvent): void {
    for (const fn of [...this.listeners]) { try { fn(e); } catch { /* listener bug */ } }
  }

  /** Serialize metadata read-modify-writes (the recorder and the worker touch the same files). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private async sessionIds(): Promise<number[]> {
    return (await this.deps.fs.list(ROOT)).map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  }

  private async windows(sid: number): Promise<WindowMeta[]> {
    const names = (await this.deps.fs.list(dirOf(sid))).filter((n) => /^\d+\.json$/.test(n));
    const metas = await Promise.all(names.map((n) => this.readJson<WindowMeta>(`${dirOf(sid)}/${n}`)));
    return metas.filter((m): m is WindowMeta => !!m).sort((a, b) => a.index - b.index);
  }

  private readSession(sid: number): Promise<SessionMeta | null> {
    return this.readJson<SessionMeta>(`${dirOf(sid)}/session.json`);
  }

  private patchSession(sid: number, patch: Partial<SessionMeta> | ((m: SessionMeta) => Partial<SessionMeta>)): Promise<void> {
    return this.locked(() => this.patchSessionUnlocked(sid, patch));
  }

  private async patchSessionUnlocked(sid: number, patch: Partial<SessionMeta> | ((m: SessionMeta) => Partial<SessionMeta>)): Promise<void> {
    const cur = (await this.readSession(sid)) ?? NEW_SESSION;
    await this.writeJson(`${dirOf(sid)}/session.json`, { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) });
  }

  private removeWindow(sid: number, index: number): Promise<void> {
    return this.locked(() => this.removeWindowUnlocked(sid, index));
  }

  private async removeWindowUnlocked(sid: number, index: number): Promise<void> {
    await this.deps.fs.remove(`${dirOf(sid)}/${index}.bin`);
    await this.deps.fs.remove(`${dirOf(sid)}/${index}.json`);
  }

  private async forFailed(fn: (sid: number, w: WindowMeta) => Promise<void>): Promise<void> {
    for (const sid of await this.sessionIds()) {
      for (const w of await this.windows(sid)) if (w.failed) await fn(sid, w);
    }
    this.emit({ t: "changed" });
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try { return JSON.parse(fromUtf8(await this.deps.fs.read(path))) as T; } catch { return null; }
  }

  private writeJson(path: string, value: unknown): Promise<void> {
    return this.deps.fs.write(path, utf8(JSON.stringify(value)));
  }
}

// ---- Capacitor storage (app-private, excluded from backups) ----

const toB64 = (b: Uint8Array) => { const s = b64u(b).replace(/-/g, "+").replace(/_/g, "/"); return s + "===".slice((s.length + 3) % 4); };

export const capacitorQueueFs: QueueFs = {
  async write(path, data) {
    await Filesystem.writeFile({ path, data: toB64(data), directory: Directory.Data, recursive: true });
  },
  async read(path) {
    const r = await Filesystem.readFile({ path, directory: Directory.Data });
    return typeof r.data === "string" ? fromB64u(r.data) : new Uint8Array(await r.data.arrayBuffer());
  },
  async list(dir) {
    try { return (await Filesystem.readdir({ path: dir, directory: Directory.Data })).files.map((f) => f.name); }
    catch { return []; }
  },
  async remove(path) {
    try { await Filesystem.deleteFile({ path, directory: Directory.Data }); } catch { /* already gone */ }
  },
  async removeDir(dir) {
    try { await Filesystem.rmdir({ path: dir, directory: Directory.Data, recursive: true }); } catch { /* already gone */ }
  },
};
