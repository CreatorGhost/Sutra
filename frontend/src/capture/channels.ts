// PURE PCM helpers for per-channel meeting transcription. The capture engine produces interleaved
// stereo (ch0 = your mic, ch1 = the meeting's system audio). Instead of asking the STT provider to split
// channels (the default OpenAI path silently ignores that), each channel is transcribed on its own as
// a small mono 16 kHz WAV — so "Me" vs everyone-else attribution works with every provider, and a
// channel with no speech (you were muted / nobody else talked) costs nothing because it's skipped.
// No DOM, no Web Audio, no storage — numbers in, numbers out.

/** Target rate for STT uploads: speech models run at 16 kHz, so 48 kHz only triples the upload. */
export const STT_SAMPLE_RATE = 16000;

/** Extract one channel from interleaved stereo Int16 PCM. */
export function deinterleave(pcm: Int16Array, channel: 0 | 1): Int16Array {
  const frames = pcm.length >> 1;
  const out = new Int16Array(frames);
  for (let i = 0, j = channel; i < frames; i++, j += 2) out[i] = pcm[j];
  return out;
}

/** Downsample mono Int16 by an integer factor with a box (averaging) filter — cheap anti-aliasing
 *  that is plenty for speech. Non-integer ratios fall back to nearest-sample picking. */
export function downsample(mono: Int16Array, fromRate: number, toRate: number = STT_SAMPLE_RATE): Int16Array {
  if (toRate >= fromRate) return mono;
  const ratio = fromRate / toRate;
  const n = Math.floor(mono.length / ratio);
  const out = new Int16Array(n);
  if (Number.isInteger(ratio)) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const base = i * ratio;
      for (let k = 0; k < ratio; k++) sum += mono[base + k];
      out[i] = Math.round(sum / ratio);
    }
  } else {
    for (let i = 0; i < n; i++) out[i] = mono[Math.floor(i * ratio)];
  }
  return out;
}

/** RMS of Int16 samples, normalised to [0, 1]. */
export function rms(samples: Int16Array, start = 0, end = samples.length): number {
  const len = end - start;
  if (len <= 0) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) { const v = samples[i] / 32768; sum += v * v; }
  return Math.sqrt(sum / len);
}

/** Seconds of "voiced" audio: 20 ms frames whose RMS clears `threshold`. A crude but robust gate for
 *  "is there anything to transcribe on this channel?" (avoids paying STT for silence / room tone). */
export function voicedSeconds(mono: Int16Array, sampleRate: number, threshold = 0.012): number {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  let voiced = 0;
  for (let i = 0; i + frame <= mono.length; i += frame) if (rms(mono, i, i + frame) >= threshold) voiced++;
  return (voiced * frame) / sampleRate;
}

/** Minimum voiced speech (seconds) before a channel is worth a transcription call. */
export const MIN_VOICED_SECONDS = 0.6;
