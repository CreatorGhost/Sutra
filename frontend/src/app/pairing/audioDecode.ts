// Audio from a paired phone (webm/opus, m4a/aac or wav — whatever it recorded) → the 16 kHz mono
// 16-bit WAV the on-device speech engine takes. Decoding is the browser's own (Web Audio); mixing,
// resampling and conversion are plain math, unit-tested. In memory only — nothing touches disk.
import { STT_SAMPLE_RATE } from "../../capture/channels";
import { pcm16ToWav } from "../../capture/wav";

export interface DecodedAudio { sampleRate: number; channels: Float32Array[] }

/** Average every channel into one. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/** Any rate → `to`. Downsampling averages each output sample's span of input (cheap anti-aliasing,
 *  plenty for speech); upsampling interpolates linearly. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !x.length) return x;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(x.length / ratio));
  if (ratio > 1) {
    for (let i = 0; i < out.length; i++) {
      const a = Math.floor(i * ratio), b = Math.min(x.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let k = a; k < b; k++) sum += x[k];
      out[i] = sum / (b - a);
    }
  } else {
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio, j = Math.floor(pos), f = pos - j;
      out[i] = x[j] * (1 - f) + x[Math.min(j + 1, x.length - 1)] * f;
    }
  }
  return out;
}

/** Float samples in [-1, 1] → 16-bit PCM (clipped). */
export function toInt16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, x[i])) * 32767);
  return out;
}

export function speechWav(d: DecodedAudio): Blob {
  const pcm = toInt16(resample(mixToMono(d.channels), d.sampleRate, STT_SAMPLE_RATE));
  return new Blob([pcm16ToWav(pcm, STT_SAMPLE_RATE, 1)], { type: "audio/wav" });
}

/** Decode with Web Audio. An offline context at 16 kHz already resamples while decoding. */
export async function decodeAudio(bytes: ArrayBuffer): Promise<DecodedAudio> {
  if (typeof OfflineAudioContext === "undefined") throw new Error("This computer can't decode phone audio.");
  const ctx = new OfflineAudioContext(1, 1, STT_SAMPLE_RATE);
  let buf: AudioBuffer;
  // decodeAudioData detaches the buffer it's given, so hand it a copy.
  try { buf = await ctx.decodeAudioData(bytes.slice(0)); }
  catch { throw new Error("Your Mac couldn't read this recording's audio format."); }
  return { sampleRate: buf.sampleRate, channels: Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)) };
}

export async function toSpeechWav(bytes: ArrayBuffer, decode: (b: ArrayBuffer) => Promise<DecodedAudio> = decodeAudio): Promise<Blob> {
  const d = await decode(bytes);
  if (!d.channels.length || !d.channels[0].length) throw new Error("That recording has no audio in it.");
  return speechWav(d);
}
