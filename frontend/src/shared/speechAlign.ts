// Local speech pipeline glue: WAV decoding, cutting speech at speaker changes, giving each transcript
// segment a speaker, voiceprint normalization and finding a model's files after extraction. PURE (no
// I/O) — used by the speech utility process and unit-tested directly.

export interface Span { start: number; end: number }
/** One diarizer turn (seconds, speaker = per-window cluster index). */
export interface SpeakerTurn extends Span { speaker: number }

// ---- audio ------------------------------------------------------------------------------------------

/** Decode a PCM WAV (8/16/24/32-bit int or 32-bit float, any channel count) to mono float samples.
 *  Meeting capture sends 16 kHz mono 16-bit; anything else is still accepted. */
export function parseWav(input: ArrayBuffer | Uint8Array): { samples: Float32Array; sampleRate: number } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file.");
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let off = 12;
  while (off + 8 <= bytes.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      let format = dv.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first 2 bytes of the sub-format GUID.
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
      fmt = { format, channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before format.");
      const len = Math.min(size, bytes.byteLength - body);
      return { samples: decodePcm(dv, body, len, fmt), sampleRate: fmt.sampleRate };
    }
    off = body + size + (size & 1);
  }
  throw new Error("WAV has no audio data.");
}

function decodePcm(dv: DataView, start: number, len: number, f: { format: number; channels: number; bits: number }): Float32Array {
  const bps = f.bits / 8;
  const ch = Math.max(1, f.channels);
  const frames = Math.floor(len / (bps * ch));
  const out = new Float32Array(frames);
  const read = (o: number): number => {
    if (f.format === 3 && f.bits === 32) return dv.getFloat32(o, true);
    if (f.format === 3 && f.bits === 64) return dv.getFloat64(o, true);
    switch (f.bits) {
      case 8: return (dv.getUint8(o) - 128) / 128;
      case 16: return dv.getInt16(o, true) / 32768;
      case 24: { const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16); return v / 8388608; }
      case 32: return dv.getInt32(o, true) / 2147483648;
      default: throw new Error(`Unsupported WAV sample size (${f.bits}-bit).`);
    }
  };
  if (f.format !== 1 && f.format !== 3) throw new Error("Only PCM WAV is supported.");
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += read(start + (i * ch + c) * bps);
    out[i] = s / ch;
  }
  return out;
}

/** Linear resampling — only used when a caller sends something other than 16 kHz. */
export function resampleLinear(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !x.length) return x;
  const n = Math.max(1, Math.round((x.length * to) / from));
  const out = new Float32Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const j = Math.floor(p);
    const k = Math.min(j + 1, x.length - 1);
    out[i] = x[j] + (x[k] - x[j]) * (p - j);
  }
  return out;
}

// ---- speakers ---------------------------------------------------------------------------------------

const overlap = (a: Span, b: Span) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Cut each voice-activity span where the diarizer says the speaker changes, so one transcript segment
 *  never straddles two people talking back-to-back without a pause. A cut is only made when both sides
 *  keep at least `minPiece` seconds — shorter slivers are diarizer jitter and would transcribe badly. */
export function splitAtSpeakerChanges(speech: Span[], turns: SpeakerTurn[], minPiece = 0.8): Span[] {
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const sp of speech) {
    const inside = sorted.filter((t) => overlap(t, sp) > 0);
    const cuts: number[] = [];
    for (let i = 1; i < inside.length; i++) {
      if (inside[i].speaker === inside[i - 1].speaker) continue;
      // Gap between the two turns → cut in its middle; overlapping turns → cut where the new one starts.
      const at = inside[i].start >= inside[i - 1].end ? (inside[i - 1].end + inside[i].start) / 2 : inside[i].start;
      cuts.push(at);
    }
    let from = sp.start;
    for (const c of cuts) {
      if (c - from >= minPiece && sp.end - c >= minPiece) { out.push({ start: from, end: c }); from = c; }
    }
    out.push({ start: from, end: sp.end });
  }
  return out;
}

/** The diarizer speaker for each segment: most overlapping speaker time wins; a segment with no
 *  overlap (diarizer dropped a short utterance) takes the nearest turn within `maxGap` seconds, else null. */
export function assignSpeakers(segments: Span[], turns: SpeakerTurn[], maxGap = 1.0): (number | null)[] {
  return segments.map((s) => {
    const bySpeaker = new Map<number, number>();
    for (const t of turns) { const o = overlap(s, t); if (o > 0) bySpeaker.set(t.speaker, (bySpeaker.get(t.speaker) ?? 0) + o); }
    let best: number | null = null, bestO = 0;
    for (const [spk, o] of bySpeaker) if (o > bestO || (o === bestO && best != null && spk < best)) { best = spk; bestO = o; }
    if (best != null) return best;
    let near: number | null = null, gap = maxGap;
    for (const t of turns) {
      const g = t.end <= s.start ? s.start - t.end : t.start >= s.end ? t.start - s.end : 0;
      if (g <= gap) { gap = g; near = t.speaker; }
    }
    return near;
  });
}

/** Cloud voiceprints are 192-d ECAPA vectors. Local ones live in a different embedding space, so they must
 *  never be compared with cloud ones: `cosine()` returns 0 on a dimension mismatch, and a local model that
 *  happens to be 192-d gets one zero appended (cosine among local vectors is unchanged). */
export const CLOUD_VOICEPRINT_DIM = 192;

export function normalizeEmbedding(v: ArrayLike<number>): number[] | null {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  if (!v.length || !(n > 0) || !Number.isFinite(n)) return null;
  const s = 1 / Math.sqrt(n);
  const out = Array.from(v, (x) => x * s);
  if (out.length === CLOUD_VOICEPRINT_DIM) out.push(0);
  return out;
}

/** Turns shorter than this get no voiceprint — a sub-second slice gives an unreliable embedding, and
 *  clustering already lets short turns inherit a neighbour's speaker. */
export const MIN_EMBED_SECONDS = 1.0;

// ---- model files ------------------------------------------------------------------------------------

/** Which runtime config a model needs (see speechModels.ts). */
export type SherpaFamily = "qwen3-asr" | "whisper" | "transducer" | "omnilingual" | "speakers";

/** Absolute (or model-dir-relative) paths for one model, as stored in its manifest.json. */
export type ModelFiles = Record<string, string>;

const norm = (p: string) => p.replace(/\\/g, "/");
const base = (p: string) => norm(p).split("/").pop()!.toLowerCase();
const dir = (p: string) => { const s = norm(p); const i = s.lastIndexOf("/"); return i < 0 ? "" : s.slice(0, i); };

/** Pick the best .onnx whose name contains `token` — int8 first (smaller, faster on CPU), never the
 *  external-weights sidecars. */
function pickOnnx(files: string[], token: RegExp, avoid?: RegExp): string | null {
  const c = files.filter((f) => /\.onnx$/i.test(f) && token.test(base(f)) && !(avoid && avoid.test(base(f))));
  if (!c.length) return null;
  c.sort((a, b) => Number(/int8/i.test(base(b))) - Number(/int8/i.test(base(a))) || a.length - b.length);
  return c[0];
}
const pickFile = (files: string[], name: RegExp) => files.filter((f) => name.test(base(f))).sort((a, b) => a.length - b.length)[0] ?? null;

/** Find a model's files inside its extracted folder, the way they are laid out in the sherpa-onnx release
 *  archives (names differ between releases — "turbo-encoder.int8.onnx", "encoder.int8.onnx" — so this
 *  matches by role instead of hardcoding paths). Throws a readable error when something is missing. */
export function detectModelFiles(family: SherpaFamily, files: string[]): ModelFiles {
  const need = (what: string, v: string | null): string => { if (!v) throw new Error(`The downloaded model is missing its ${what} file.`); return v; };
  switch (family) {
    case "qwen3-asr": {
      const vocab = files.filter((f) => base(f) === "vocab.json").map(dir).find((d) => files.some((f) => dir(f) === d && base(f) === "merges.txt"));
      return {
        convFrontend: need("front-end", pickOnnx(files, /conv_frontend/)),
        encoder: need("encoder", pickOnnx(files, /encoder/)),
        decoder: need("decoder", pickOnnx(files, /decoder/)),
        tokenizer: need("tokenizer", vocab ?? null),
      };
    }
    case "whisper":
      return {
        encoder: need("encoder", pickOnnx(files, /encoder/)),
        decoder: need("decoder", pickOnnx(files, /decoder/)),
        tokens: need("tokens", pickFile(files, /tokens\.txt$/)),
      };
    case "transducer":
      return {
        encoder: need("encoder", pickOnnx(files, /encoder/)),
        decoder: need("decoder", pickOnnx(files, /decoder/)),
        joiner: need("joiner", pickOnnx(files, /joiner/)),
        tokens: need("tokens", pickFile(files, /^tokens\.txt$/)),
      };
    case "omnilingual":
      return {
        model: need("model", pickOnnx(files, /^model/)),
        tokens: need("tokens", pickFile(files, /tokens\.txt$/)),
      };
    case "speakers":
      return {
        vad: need("voice-activity", pickOnnx(files, /silero_vad/)),
        segmentation: need("speaker-segmentation", pickOnnx(files.filter((f) => /segmentation/i.test(norm(f))), /^model/)),
        embedding: need("speaker-embedding", pickOnnx(files, /speaker|voxceleb|eres2net|campplus|titanet|resnet|ecapa/, /silero|segmentation/)),
      };
  }
}
