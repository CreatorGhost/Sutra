/**
 * CaptureController — foreground mic capture with VAD-gated conversation windows.
 *
 * One getUserMedia stream feeds both a MediaRecorder (the audio we upload) and an
 * AnalyserNode-based energy VAD (to find silence gaps that bound a window). Each window is
 * a complete webm/opus blob (header included), so the backend can diarize it in one call.
 * Audio lives only in memory and is handed to onWindow; nothing is stored client-side.
 */
import { ForegroundMic } from "./foregroundMic";

export type CaptureState = "idle" | "listening" | "speaking" | "cutting" | "paused";

export interface CaptureOptions {
  maxSeconds?: number;     // hard cap per window
  silenceMs?: number;      // trailing silence that closes a window after speech
  minSpeechMs?: number;    // ignore windows with less speech than this
  onWindow: (blob: Blob, index: number) => void;
  onState?: (s: CaptureState) => void;
  onLevel?: (rms: number, speaking: boolean) => void;
  onError?: (msg: string) => void;
}

export function pickMime(): string {
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const m of cands) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

export class CaptureController {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private raf = 0;
  private starting = false;
  private opts: Required<Omit<CaptureOptions, "onState" | "onLevel" | "onError">> & CaptureOptions;
  private mime = "";
  private index = 0;

  private windowStart = 0;
  private lastVoice = 0;
  private hadSpeech = false;
  private speaking = false;
  private paused = false;
  private cutting = false;
  private buf = new Float32Array(0);

  // hysteresis thresholds on RMS
  private readonly hi = 0.022;
  private readonly lo = 0.012;

  constructor(opts: CaptureOptions) {
    this.opts = { maxSeconds: 150, silenceMs: 1200, minSpeechMs: 700, ...opts };
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
      this.lastVoice = this.windowStart;
      this.hadSpeech = false;
      this.setState("listening");
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
    try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { /* fall through */ }
    throw lastErr;
  }

  private releasePartial() {
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { void this.ctx?.close(); } catch { /* */ }
    this.stream = null; this.ctx = null; this.analyser = null;
    void ForegroundMic.stop();
  }

  private startRecorder() {
    if (!this.stream) return;
    this.chunks = [];
    this.rec = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
    this.rec.onstop = () => this.finalizeWindow();
    try { this.rec.start(); } catch (e: any) { this.opts.onError?.(`recorder: ${e?.message ?? e}`); }
  }

  private finalizeWindow() {
    const blob = new Blob(this.chunks, { type: this.mime || "audio/webm" });
    const speechMs = this.lastVoice - this.windowStart;
    const emit = this.hadSpeech && speechMs >= 0 && blob.size > 1200;
    if (emit) this.opts.onWindow(blob, this.index++);
    // reset window
    this.windowStart = performance.now();
    this.lastVoice = this.windowStart;
    this.hadSpeech = false;
    this.cutting = false;
    if (!this.paused && this.stream) {
      this.startRecorder();
      this.setState("listening");
    }
  }

  private cut() {
    if (this.cutting || !this.rec || this.rec.state === "inactive") return;
    this.cutting = true;
    this.setState("cutting");
    try { this.rec.stop(); } catch { this.cutting = false; }
  }

  private loop = () => {
    if (!this.analyser || this.paused) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const now = performance.now();

    if (this.speaking ? rms > this.lo : rms > this.hi) {
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
        if (this.hadSpeech) this.cut();
        else { this.windowStart = now; this.startRecorderReset(); } // silent window: roll over without uploading
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private startRecorderReset() {
    // discard a long silent window without emitting
    if (this.rec && this.rec.state !== "inactive") {
      this.rec.onstop = () => { this.chunks = []; this.rec!.onstop = () => this.finalizeWindow(); this.startRecorder(); };
      try { this.rec.stop(); } catch { /* ignore */ }
    }
  }

  pause() {
    this.paused = true;
    cancelAnimationFrame(this.raf);
    if (this.rec && this.rec.state !== "inactive") { this.cutting = true; try { this.rec.stop(); } catch { /* */ } }
    this.setState("paused");
  }

  resume() {
    if (!this.stream) return;
    this.paused = false;
    this.windowStart = performance.now();
    this.lastVoice = this.windowStart;
    this.hadSpeech = false;
    this.cutting = false;
    this.startRecorder();
    this.setState("listening");
    this.loop();
  }

  async stop(): Promise<void> {
    this.paused = true;
    cancelAnimationFrame(this.raf);
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
    if (this.hadSpeech && blob.size > 1200) this.opts.onWindow(blob, this.index++);
    this.chunks = [];
  }

  private setState(s: CaptureState) { this.opts.onState?.(s); }
}
