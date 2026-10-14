/**
 * CaptureController — foreground mic capture with VAD-gated conversation windows.
 *
 * One getUserMedia stream feeds both a MediaRecorder (the audio we upload) and an
 * AnalyserNode-based energy VAD (to find silence gaps that bound a window). Each window is
 * a complete opus blob (ogg or webm container, header included), so the backend can diarize it
 * in one call. Audio lives only in memory and is handed to onWindow; nothing is stored client-side.
 *
 * Encoding is LOW-bitrate Opus (~24 kbps, speech-grade): keeps every window tiny so it can never
 * trip the proxy's 30 MB upload cap (an oversized window used to 413 and lose the audio entirely).
 * Lower fidelity is an accepted trade — diarization/transcription only need intelligible speech.
 */
import { ForegroundMic } from "./foregroundMic";

export type CaptureState = "idle" | "listening" | "speaking" | "cutting" | "paused";

export interface CaptureOptions {
  maxSeconds?: number;     // hard cap per window
  silenceMs?: number;      // trailing silence that closes a window after speech
  minSpeechMs?: number;    // ignore windows with less speech than this
  onWindow: (blob: Blob, index: number, startedAtMs: number) => void;
  onState?: (s: CaptureState) => void;
  onLevel?: (rms: number, speaking: boolean) => void;
  onError?: (msg: string) => void;
}

// Speech-grade Opus bitrate. ~24 kbps stays intelligible for transcription/diarization while keeping
// files tiny (~3 KB/s), so even a maxed-out window is orders of magnitude under the 30 MB upload cap.
export const OPUS_BITS_PER_SECOND = 24000;

export function pickMime(): string {
  // Prefer ogg/opus (smallest, cleanly seekable). Fall back to webm/opus, then any opus-bearing
  // container; bitrate is what actually shrinks the file, but ogg shaves a little container overhead.
  const cands = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const m of cands) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

export class CaptureController {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private tick: ReturnType<typeof setInterval> | null = null;
  private onVisibility: (() => void) | null = null;
  private starting = false;
  private opts: Required<Omit<CaptureOptions, "onState" | "onLevel" | "onError">> & CaptureOptions;
  private mime = "";
  private index = 0;

  private windowStart = 0;
  private windowStartWall = 0;
  private lastVoice = 0;
  private hadSpeech = false;
  private speaking = false;
  private paused = false;
  private cutting = false;
  private buf = new Float32Array(0);

  // adaptive noise-floor VAD: thresholds track ambient level (fall fast / rise slow) so quiet or
  // distant speech still crosses the gate instead of being lost under a fixed threshold.
  private floor = 0.006;
  private readonly FLOOR_MIN = 0.004;
  private readonly FLOOR_MAX = 0.030;
  private readonly HI_MULT = 3.0;
  private readonly LO_MULT = 1.8;
  private readonly PRESENCE_MULT = 1.5;
  private sumRms = 0;
  private nRms = 0;
  private peakRms = 0;

  constructor(opts: CaptureOptions) {
    this.opts = { maxSeconds: 90, silenceMs: 1200, minSpeechMs: 700, ...opts };
  }

  async start() {
    if (this.starting || this.stream) return;   // ignore re-entrant taps (don't stack getUserMedia)
    this.starting = true;
    try {
      this.mime = pickMime();
      const isAndroid = (globalThis as any).Capacitor?.getPlatform?.() === "android";

      // iOS/web need the AudioContext created + resumed INSIDE the user gesture, or iOS leaves it
      // 'suspended' and the analyser only yields silence. Android (Samsung WebView) is the opposite:
      // opening an output AudioContext before the mic makes the audio HAL throw ("encountered an
      // error from the audio device") and then blocks getUserMedia with NotReadableError — so on
      // Android we acquire the mic FIRST and build the context from the live input device.
      if (!isAndroid) await this.openContext();

      // Android: pin the built-in mic BEFORE getUserMedia so Chromium doesn't select a Bluetooth
      // HFP/SCO comms route (a paired watch/carkit) that can't bind -> NotReadableError.
      if (isAndroid) await ForegroundMic.routeToBuiltinMic();
      this.stream = await this.acquireMic();
      void ForegroundMic.start();  // Android: keep mic alive screen-off

      if (!this.ctx) await this.openContext();

      const src = this.ctx!.createMediaStreamSource(this.stream);
      this.analyser = this.ctx!.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.buf = new Float32Array(this.analyser.fftSize);
      this.startRecorder();
      this.windowStart = performance.now();
      this.windowStartWall = Date.now();
      this.lastVoice = this.windowStart;
      this.hadSpeech = false;
      this.setState("listening");
      this.setupVisibility();  // force-cut the current window when the screen/app goes to background
      this.loop();
    } catch (e) {
      this.releasePartial();   // release the mic/context so a retry (or another app) can use it
      throw e;
    } finally {
      this.starting = false;
    }
  }

  private async openContext() {
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (this.ctx.state === "suspended") { try { await this.ctx.resume(); } catch { /* ignore */ } }
  }

  /** getUserMedia with retry. A just-ended call or another recorder can leave the mic briefly busy
   *  (NotReadableError / AbortError); wait for the HAL to release and retry, then fall back to
   *  minimal constraints before giving up. Permission/other errors are not retried. */
  private async acquireMic(): Promise<MediaStream> {
    const isAndroid = (globalThis as any).Capacitor?.getPlatform?.() === "android";
    // On Android, drop the DSP flags: echoCancellation/noiseSuppression/autoGainControl bias
    // Chromium toward the VOICE_COMMUNICATION source (the Bluetooth comms route we must avoid).
    const full: MediaStreamConstraints = {
      audio: isAndroid
        ? { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    };
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await navigator.mediaDevices.getUserMedia(full); }
      catch (e: any) {
        lastErr = e;
        if (e?.name === "NotReadableError" || e?.name === "AbortError") {
          await new Promise((r) => setTimeout(r, 450));
          continue;
        }
        throw e;
      }
    }
    // Last-resort fallback must keep the Android-safe constraints, or it re-enables the DSP flags
    // (echoCancellation/noiseSuppression/autoGainControl) that bias toward the Bluetooth comms route
    // and reproduce the very NotReadableError it's trying to recover from.
    const minimal: MediaStreamConstraints = isAndroid
      ? { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }
      : { audio: true };
    try { return await navigator.mediaDevices.getUserMedia(minimal); } catch { /* fall through */ }
    throw lastErr;
  }

  private releasePartial() {
    this.stopLoop();
    this.teardownVisibility();
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { void this.ctx?.close(); } catch { /* */ }
    this.stream = null; this.ctx = null; this.analyser = null;
    void ForegroundMic.stop();
  }

  private startRecorder() {
    if (!this.stream) return;
    this.chunks = [];
    // Low-bitrate Opus: audioBitsPerSecond caps the encoder so a window stays tiny and can't 413.
    const recOpts: MediaRecorderOptions = { audioBitsPerSecond: OPUS_BITS_PER_SECOND };
    if (this.mime) recOpts.mimeType = this.mime;
    this.rec = new MediaRecorder(this.stream, recOpts);
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
    this.rec.onstop = () => this.finalizeWindow();
    // timeslice (1s): flush partial chunks incrementally so data isn't trapped in one growing
    // in-memory blob if the main VAD logic stalls screen-off. ondataavailable now fires repeatedly
    // with partial chunks; they're accumulated in this.chunks and assembled into one complete
    // webm/opus blob per window at stop (finalizeWindow), so window semantics are unchanged.
    try { this.rec.start(1000); } catch (e: any) { this.opts.onError?.(`recorder: ${e?.message ?? e}`); this.releasePartial(); this.setState("idle"); }
  }

  private finalizeWindow() {
    const blob = new Blob(this.chunks, { type: this.mime || "audio/webm" });
    const emit = this.windowHadContent(blob);
    if (emit) { this.guardSize(blob); this.opts.onWindow(blob, this.index++, this.windowStartWall); }
    // reset window
    this.windowStart = performance.now();
    this.windowStartWall = Date.now();
    this.lastVoice = this.windowStart;
    this.hadSpeech = false;
    this.cutting = false;
    this.sumRms = 0; this.nRms = 0; this.peakRms = 0;
    if (!this.paused && this.stream) {
      this.startRecorder();
      this.setState("listening");
    }
  }

  // Decide whether a closed window holds anything worth uploading. Beyond the explicit speech gate,
  // accept windows whose average/peak energy sits clearly above the adaptive noise floor — this is
  // where quiet or distant speech (that never tripped hadSpeech) is recovered instead of discarded.
  private windowHadContent(blob: Blob): boolean {
    if (blob.size <= 2000) return false;
    if (this.hadSpeech) return true;
    const avg = this.nRms ? this.sumRms / this.nRms : 0;
    return avg > this.floor * this.PRESENCE_MULT || this.peakRms > this.floor * this.HI_MULT * 0.8;
  }

  private cut() {
    if (this.cutting || !this.rec || this.rec.state === "inactive") return;
    this.cutting = true;
    this.setState("cutting");
    try { this.rec.stop(); } catch { this.cutting = false; }
  }

  // When the page is hidden (screen off / app backgrounded) during an active recording, the rAF-
  // free poll keeps running but may be throttled; force-cut the current window now so it gets
  // finalized + uploaded instead of growing unbounded. Only cut when there's speech in the window
  // (cut() already handles the speech-bearing case); a silent window keeps rolling.
  private setupVisibility() {
    if (this.onVisibility || typeof document === "undefined") return;
    this.onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      if (this.paused || this.cutting || !this.hadSpeech) return;
      this.cut();
    };
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private teardownVisibility() {
    if (this.onVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.onVisibility = null;
  }

  // VAD polling runs on setInterval (not requestAnimationFrame): rAF is fully paused while the
  // display is off, which froze the window cut/flush logic screen-off. setInterval keeps firing
  // (throttled, but not paused), so silence detection and maxSeconds rollover still work.
  private loop = () => {
    if (this.tick != null) return; // idempotent: don't stack intervals on re-entry
    this.tick = setInterval(this.poll, 60);
  };

  private poll = () => {
    if (!this.analyser || this.paused) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const now = performance.now();

    // Track the ambient noise floor: fall fast toward quiet so a brief lull re-sensitizes the gate,
    // rise slowly so transient speech doesn't drag the floor up and swallow itself.
    if (rms < this.floor) this.floor = this.floor * 0.90 + rms * 0.10;
    else this.floor = this.floor * 0.995 + rms * 0.005;
    this.floor = Math.min(this.FLOOR_MAX, Math.max(this.FLOOR_MIN, this.floor));
    const hi = this.floor * this.HI_MULT, lo = this.floor * this.LO_MULT;
    this.sumRms += rms; this.nRms++; if (rms > this.peakRms) this.peakRms = rms;

    if (this.speaking ? rms > lo : rms > hi) {
      this.speaking = true;
      this.lastVoice = now;
      if (!this.hadSpeech) { this.hadSpeech = true; this.setState("speaking"); }
    } else {
      this.speaking = false;
    }
    this.opts.onLevel?.(rms, this.speaking);

    const elapsed = now - this.windowStart;
    const silence = now - this.lastVoice;
    if (!this.cutting) {
      if (this.hadSpeech && silence >= this.opts.silenceMs && (this.lastVoice - this.windowStart) >= this.opts.minSpeechMs) {
        this.cut();
      } else if (elapsed >= this.opts.maxSeconds * 1000) {
        // Hard cap reached: always cut and let windowHadContent decide — never hard-discard, since a
        // maxed-out "silent" window can still hold quiet/distant speech below the speech gate.
        this.cut();
      }
    }
  };

  private stopLoop() {
    if (this.tick != null) { clearInterval(this.tick); this.tick = null; }
  }

  pause() {
    this.paused = true;
    this.stopLoop();
    if (this.rec && this.rec.state !== "inactive") { this.cutting = true; try { this.rec.stop(); } catch { /* */ } }
    this.setState("paused");
  }

  resume() {
    if (!this.stream) return;
    this.paused = false;
    this.windowStart = performance.now();
    this.windowStartWall = Date.now();
    this.lastVoice = this.windowStart;
    this.hadSpeech = false;
    this.cutting = false;
    this.sumRms = 0; this.nRms = 0; this.peakRms = 0;
    this.startRecorder();
    this.setState("listening");
    this.loop();
  }

  async stop(): Promise<void> {
    this.paused = true;
    this.stopLoop();
    this.teardownVisibility();
    if (this.rec && this.rec.state !== "inactive") {
      this.cutting = true;
      await new Promise<void>((resolve) => {
        this.rec!.onstop = () => { this.finalizeWindowFinal(); resolve(); };
        try { this.rec!.stop(); } catch { resolve(); }
      });
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.stream = null; this.ctx = null; this.analyser = null; this.rec = null;
    void ForegroundMic.stop();  // Android: release the foreground service
    this.setState("idle");
  }

  private finalizeWindowFinal() {
    const blob = new Blob(this.chunks, { type: this.mime || "audio/webm" });
    if (this.windowHadContent(blob)) { this.guardSize(blob); this.opts.onWindow(blob, this.index++, this.windowStartWall); }
    this.chunks = [];
  }

  // Size safety net. At ~24 kbps Opus the duration cap (maxSeconds) keeps a window far under the
  // proxy's 30 MB limit, so this should never fire. If a window ever approaches the cap we must NOT
  // silently lose it (the original 413 bug) and we must NOT byte-split an Opus/OGG container (that
  // yields undecodable files): surface it loudly and still emit so the audio gets a chance to upload.
  private readonly SIZE_WARN_BYTES = 28 * 1024 * 1024;  // ~28 MB, just under the 30 MB cap
  private guardSize(blob: Blob) {
    if (blob.size < this.SIZE_WARN_BYTES) return;
    const mb = (blob.size / (1024 * 1024)).toFixed(1);
    const msg = `audio window ${this.index} is ${mb} MB — near the 30 MB upload cap; it may be rejected. Lower maxSeconds.`;
    console.warn(`[capture] ${msg}`);
    this.opts.onError?.(msg);
  }

  private setState(s: CaptureState) { this.opts.onState?.(s); }
}
