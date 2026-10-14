// A meeting's screenshots and audio, kept only until the user confirms the notes (or 7 days pass).
// Everything is encrypted at rest (AES-256-GCM, one key per install, sealed with the OS keychain via
// safeStorage when it's available) under userData/recordings/<session>/:
//   meta.json                     { createdAt, audioMime, frames: [{ name, at, score }] }
//   shot-<epoch ms>.jpg.enc       one screenshot, taken when the screen changed
//   audio.enc                     the meeting's audio: [len u32][iv 12][tag 16][ciphertext] frames, one per chunk
// Screenshots the AI picks for the notes are copied to recordings/kept/<conversation>/ and live as long as
// the meeting does. Only this process reads or writes these files; the renderer asks over IPC.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FrameInfo { name: string; at: number; score: number }
export interface RecordingStatus { session: number; createdAt: number; frames: number; firstAt: number | null; lastAt: number | null; audioBytes: number; audioMime: string | null }
interface Meta { createdAt: number; audioMime: string | null; frames: FrameInfo[] }

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_AUDIO_CHUNK = 8 * 1024 * 1024;
export const KEEP_UNCONFIRMED_MS = 7 * 24 * 3600 * 1000;
const FRAME_NAME = /^shot-\d{10,16}\.jpg$/;

/** The per-install key, sealed with the keychain when possible. */
export interface KeyBox { available: boolean; seal(b: Buffer): string; open(s: string): Buffer }

export function loadKey(root: string, box: KeyBox): Buffer {
  mkdirSync(root, { recursive: true });
  const file = join(root, "key.json");
  try {
    const k = JSON.parse(readFileSync(file, "utf8"));
    const key = k.sealed ? box.open(k.key) : Buffer.from(k.key, "base64");
    if (key.length === 32) return key;
  } catch { /* new install, or a keychain that can't open it: start over (old media becomes unreadable) */ }
  const key = randomBytes(32);
  writeFileSync(file, JSON.stringify(box.available ? { sealed: true, key: box.seal(key) } : { sealed: false, key: key.toString("base64") }), { mode: 0o600 });
  return key;
}

export class MediaStore {
  constructor(private readonly root: string, private readonly key: Buffer, private readonly now: () => number = Date.now) {}

  private enc(plain: Uint8Array): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  private dec(box: Buffer): Buffer {
    const d = createDecipheriv("aes-256-gcm", this.key, box.subarray(0, 12));
    d.setAuthTag(box.subarray(12, 28));
    return Buffer.concat([d.update(box.subarray(28)), d.final()]);
  }

  private dir(session: unknown, create = false): string {
    const sid = Number(session);
    if (!Number.isInteger(sid) || sid <= 0) throw new Error("bad recording id");
    const d = join(this.root, String(sid));
    if (create) mkdirSync(d, { recursive: true });
    return d;
  }
  private meta(d: string): Meta {
    try { return JSON.parse(readFileSync(join(d, "meta.json"), "utf8")); } catch { return { createdAt: this.now(), audioMime: null, frames: [] }; }
  }
  private saveMeta(d: string, m: Meta) { writeFileSync(join(d, "meta.json"), JSON.stringify(m), { mode: 0o600 }); }

  saveFrame(session: unknown, at: unknown, bytes: Uint8Array, score: unknown): FrameInfo {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_FRAME_BYTES) throw new Error("bad screenshot");
    const d = this.dir(session, true);
    const t = Math.round(Number(at)) || this.now();
    const m = this.meta(d);
    let name = `shot-${t}.jpg`;
    for (let n = t + 1; m.frames.some((f) => f.name === name); n++) name = `shot-${n}.jpg`;
    writeFileSync(join(d, `${name}.enc`), this.enc(bytes), { mode: 0o600 });
    const info = { name, at: t, score: Math.max(0, Math.min(1, Number(score) || 0)) };
    m.frames.push(info);
    this.saveMeta(d, m);
    return info;
  }

  appendAudio(session: unknown, chunk: Uint8Array, mime: unknown): number {
    if (!(chunk instanceof Uint8Array) || !chunk.length || chunk.length > MAX_AUDIO_CHUNK) throw new Error("bad audio chunk");
    const d = this.dir(session, true);
    const m = this.meta(d);
    if (!m.audioMime && typeof mime === "string" && /^audio\/[\w.+-]+(;\s*codecs=[\w.+-]+)?$/.test(mime)) { m.audioMime = mime; this.saveMeta(d, m); }
    else if (!existsSync(join(d, "meta.json"))) this.saveMeta(d, m);
    const box = this.enc(chunk);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(box.length);
    appendFileSync(join(d, "audio.enc"), Buffer.concat([len, box]), { mode: 0o600 });
    return chunk.length;
  }

  frames(session: unknown): FrameInfo[] {
    const d = this.dir(session);
    return existsSync(d) ? this.meta(d).frames.filter((f) => existsSync(join(d, `${f.name}.enc`))) : [];
  }

  status(session: unknown): RecordingStatus | null {
    const d = this.dir(session);
    if (!existsSync(d)) return null;
    const m = this.meta(d);
    const frames = this.frames(session);
    let audioBytes = 0;
    try { audioBytes = statSync(join(d, "audio.enc")).size; } catch { /* no audio */ }
    if (!frames.length && !audioBytes) return null;
    return { session: Number(session), createdAt: m.createdAt, frames: frames.length, firstAt: frames[0]?.at ?? null, lastAt: frames.at(-1)?.at ?? null, audioBytes, audioMime: m.audioMime };
  }

  readFrame(session: unknown, name: unknown): Buffer {
    if (typeof name !== "string" || !FRAME_NAME.test(name)) throw new Error("bad screenshot name");
    return this.dec(readFileSync(join(this.dir(session), `${name}.enc`)));
  }

  readAudio(session: unknown): { bytes: Buffer; mime: string | null } | null {
    const d = this.dir(session);
    const file = join(d, "audio.enc");
    if (!existsSync(file)) return null;
    const all = readFileSync(file);
    const parts: Buffer[] = [];
    for (let off = 0; off + 4 <= all.length;) {
      const len = all.readUInt32BE(off);
      if (off + 4 + len > all.length) break; // a chunk cut short by a crash: stop there
      parts.push(this.dec(all.subarray(off + 4, off + 4 + len)));
      off += 4 + len;
    }
    return { bytes: Buffer.concat(parts), mime: this.meta(d).audioMime };
  }

  /** Decrypt chosen screenshots into `dir` (an agent's private temp dir) as <label>.jpg. */
  exportFrames(session: unknown, items: { name: string; label: string }[], dir: string): string[] {
    const out: string[] = [];
    for (const it of items.slice(0, 40)) {
      if (!/^[A-Za-z0-9_-]{1,16}$/.test(String(it?.label))) continue;
      const p = join(dir, `${it.label}.jpg`);
      writeFileSync(p, this.readFrame(session, it.name), { mode: 0o600 });
      out.push(p);
    }
    return out;
  }

  /** Copy a screenshot into the meeting's kept set (it outlives the recording). */
  keep(session: unknown, name: unknown, conversation: unknown): string {
    if (typeof name !== "string" || !FRAME_NAME.test(name)) throw new Error("bad screenshot name");
    const cid = Number(conversation);
    if (!Number.isInteger(cid) || cid <= 0) throw new Error("bad meeting id");
    const kd = join(this.root, "kept", String(cid));
    mkdirSync(kd, { recursive: true });
    copyFileSync(join(this.dir(session), `${name}.enc`), join(kd, `${name}.enc`));
    return name;
  }

  readKept(conversation: unknown, name: unknown): Buffer {
    const cid = Number(conversation);
    if (!Number.isInteger(cid) || cid <= 0 || typeof name !== "string" || !FRAME_NAME.test(name)) throw new Error("bad screenshot");
    return this.dec(readFileSync(join(this.root, "kept", String(cid), `${name}.enc`)));
  }

  deleteKept(conversation: unknown, name?: unknown): void {
    const cid = Number(conversation);
    if (!Number.isInteger(cid) || cid <= 0) return;
    const kd = join(this.root, "kept", String(cid));
    if (typeof name === "string" && FRAME_NAME.test(name)) rmSync(join(kd, `${name}.enc`), { force: true });
    else rmSync(kd, { recursive: true, force: true });
  }

  deleteSession(session: unknown): void { rmSync(this.dir(session), { recursive: true, force: true }); }

  /** Delete recordings nobody confirmed within `maxAgeMs` (kept screenshots stay). */
  sweep(maxAgeMs = KEEP_UNCONFIRMED_MS): number[] {
    const gone: number[] = [];
    let names: string[] = [];
    try { names = readdirSync(this.root); } catch { return gone; }
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue;
      const created = this.meta(join(this.root, n)).createdAt;
      if (this.now() - created > maxAgeMs) { this.deleteSession(Number(n)); gone.push(Number(n)); }
    }
    return gone;
  }
}
