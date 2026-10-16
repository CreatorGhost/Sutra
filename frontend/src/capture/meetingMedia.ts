// Screenshots and audio of a meeting (desktop, when "Take screenshots during meetings" is on), kept
// encrypted by the main process until the user confirms the notes (electron/recordingMedia.ts).
//   • Screen: the display stream recording already opens (for call audio) is sampled every few seconds;
//     a frame is saved only when the screen changed (a new slide, a scrolled page) — compared on a tiny
//     grayscale thumbnail — so a 1-hour meeting is tens of frames, not hundreds.
//   • Audio: mic + call mixed and recorded as Opus in 10 s chunks (~15 MB/hour), appended as they come.
// The pure parts (thumbnail diff, the keep rule) are exported for tests.

export const FRAME_EVERY_MS = 4000;
/** Mean per-pixel change (0..1) on the thumbnail that counts as "the screen changed". */
export const CHANGE_THRESHOLD = 0.035;
/** Even a still screen is re-shot this often, so a long slide still shows up near what was said. */
export const STILL_RESHOT_MS = 5 * 60_000;
export const MAX_FRAMES = 400;
const THUMB_W = 64, THUMB_H = 36;
const MAX_W = 1600, MAX_H = 1000;
const JPEG_QUALITY = 0.72;
const AUDIO_SLICE_MS = 10_000;

/** Mean absolute difference of two equal-size grayscale thumbnails, 0..1. */
export function frameDiff(a: Uint8Array | null, b: Uint8Array): number {
  if (!a || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < b.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (b.length * 255);
}

/** Keep this frame? Always the first; then on a real change, or a still screen after a while. Past the
 *  cap only big changes count, so a very long meeting can't fill the disk. */
export function shouldKeep(diff: number, msSinceLastKept: number, kept: number): boolean {
  if (kept === 0) return true;
  if (kept >= MAX_FRAMES) return diff >= CHANGE_THRESHOLD * 4;
  return diff >= CHANGE_THRESHOLD || (msSinceLastKept >= STILL_RESHOT_MS && diff > 0.002);
}

/** RGBA → grayscale bytes. */
export function toGray(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) out[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  return out;
}

export interface MediaSink {
  frame(sid: number, at: number, bytes: Uint8Array, score: number): Promise<unknown>;
  audio(sid: number, chunk: Uint8Array, mime: string): Promise<unknown>;
}

const AUDIO_MIME = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];

export class MeetingMedia {
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastThumb: Uint8Array | null = null;
  private lastKeptAt = 0;
  private kept = 0;
  private recorder: MediaRecorder | null = null;
  private ctx: AudioContext | null = null;
  private pending: Promise<unknown>[] = [];
  private busy = false;

  constructor(private readonly sid: number, private readonly sink: MediaSink, private readonly onError: (m: string) => void = () => {}) {}

  get frames(): number { return this.kept; }

  /** Take screenshots from another screen from now on; that track is ours to stop.
   *  ponytail: the first screen's track stays open (the capture provider owns it) until the recording ends. */
  private ownTrack: MediaStreamTrack | null = null;
  async useScreen(track: MediaStreamTrack): Promise<void> {
    if (!this.video) { track.stop(); return; }
    this.ownTrack?.stop();
    this.ownTrack = track;
    this.video.srcObject = new MediaStream([track]);
    await this.video.play().catch(() => {});
    setTimeout(() => void this.tick(), 1200);
  }

  /** Start sampling `video` (a screen track) and recording the mixed audio of `audio` streams. */
  async start(video: MediaStreamTrack | null, audio: MediaStream[]): Promise<void> {
    if (video) {
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.srcObject = new MediaStream([video]);
      await el.play().catch(() => {});
      this.video = el;
      this.timer = setInterval(() => void this.tick(), FRAME_EVERY_MS);
      setTimeout(() => void this.tick(), 1200); // the first frame, once the stream has a picture
    }
    this.startAudio(audio);
  }

  private startAudio(streams: MediaStream[]): void {
    const tracks = streams.flatMap((s) => s.getAudioTracks()).filter((t) => t.readyState === "live");
    const mime = AUDIO_MIME.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
    if (!tracks.length || !mime) return;
    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      for (const t of tracks) ctx.createMediaStreamSource(new MediaStream([t])).connect(dest);
      const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
      rec.ondataavailable = (e) => {
        if (!e.data?.size) return;
        this.pending.push(e.data.arrayBuffer().then((b) => this.sink.audio(this.sid, new Uint8Array(b), mime)).catch((err) => this.onError(String(err?.message ?? err))));
      };
      rec.start(AUDIO_SLICE_MS);
      this.ctx = ctx;
      this.recorder = rec;
    } catch (e: any) { this.onError(`Couldn't record the meeting audio: ${e?.message ?? e}`); }
  }

  private async tick(): Promise<void> {
    const v = this.video;
    if (!v || this.busy || !v.videoWidth) return;
    this.busy = true;
    try {
      const thumb = document.createElement("canvas");
      thumb.width = THUMB_W; thumb.height = THUMB_H;
      const tctx = thumb.getContext("2d", { willReadFrequently: true })!;
      tctx.drawImage(v, 0, 0, THUMB_W, THUMB_H);
      const gray = toGray(tctx.getImageData(0, 0, THUMB_W, THUMB_H).data);
      const diff = frameDiff(this.lastThumb, gray);
      const now = Date.now();
      if (!shouldKeep(diff, now - this.lastKeptAt, this.kept)) return;
      const scale = Math.min(1, MAX_W / v.videoWidth, MAX_H / v.videoHeight);
      const c = document.createElement("canvas");
      c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", JPEG_QUALITY));
      if (!blob) return;
      this.lastThumb = gray;
      this.lastKeptAt = now;
      this.kept++;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      this.pending.push(this.sink.frame(this.sid, now, bytes, Math.min(1, diff)).catch((err) => this.onError(String(err?.message ?? err))));
    } finally { this.busy = false; }
  }

  /** Stop and wait until every screenshot and audio chunk is saved. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.video) { this.video.srcObject = null; this.video = null; }
    this.ownTrack?.stop();
    this.ownTrack = null;
    const rec = this.recorder;
    this.recorder = null;
    if (rec && rec.state !== "inactive") {
      await new Promise<void>((r) => { rec.addEventListener("stop", () => r(), { once: true }); rec.stop(); });
    }
    await this.ctx?.close().catch(() => {});
    this.ctx = null;
    await Promise.allSettled(this.pending);
    this.pending = [];
  }
}
