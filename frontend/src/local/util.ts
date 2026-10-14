// Shared helpers (TS port of backend/app/services/util.py + vector helpers for BLOB storage).
const DEVANAGARI = /[ऀ-ॿ]/;
const HINGLISH = new Set(
  ("hai kya nahi haan mera tera kar raha rahe karna chal kaise kab kyun mujhe tumhe aur bhi ka ki ke ko " +
   "mein hum tum aap baat acha thik karunga dunga raha rahi").split(" ")
);

export function detectLang(text: string): "hi" | "en" | "hi-en" {
  if (DEVANAGARI.test(text)) return /[a-zA-Z]/.test(text) ? "hi-en" : "hi";
  const toks = new Set((text.toLowerCase().match(/[a-z]+/g) ?? []));
  let hits = 0;
  for (const t of toks) if (HINGLISH.has(t)) hits++;
  return hits >= 2 ? "hi-en" : "en";
}

export function normName(name: string): string {
  return (name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Display-only mapping for unnamed speakers: raw per-session cluster label ("c1","c2",…) -> a clean
 *  1-indexed "Speaker 1","Speaker 2",… assigned in first-appearance order within the conversation. The
 *  raw cN label stays the database value (and the key for relabel); this only governs what the user/model
 *  see, so raw voiceprint-cluster ids never leak into the transcript UI or generated minutes. Stable and
 *  deterministic for a given turn order. Use the inverse to translate a model's returned "Speaker N" back
 *  to its raw cN label before relabelling. */
export function buildSpeakerDisplay(turns: { session_speaker_label?: string | null }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of turns) {
    const raw = t.session_speaker_label;
    if (raw == null || raw === "") continue;
    if (!map.has(raw)) map.set(raw, `Speaker ${map.size + 1}`);
  }
  return map;
}

/** Stable color-key for a speaker dot in the transcript. Hashes the RAW session_speaker_label
 *  (the cN/letter cluster id — never the display name, so the color survives renaming) to a fixed
 *  palette of 8 calm hues that sit on the dark surface. Deterministic per label; the same speaker
 *  always reads the same color within and across conversations. */
const SPEAKER_PALETTE = [
  "#8b7bff", // accent violet
  "#5ec6c0", // teal
  "#e0a458", // amber
  "#e07ba8", // rose
  "#7bb0ff", // sky
  "#9fcf6b", // lime
  "#c08bff", // orchid
  "#ff9b7b", // coral
];
export function speakerColor(rawLabel: string | null | undefined): string {
  const s = String(rawLabel ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return SPEAKER_PALETTE[Math.abs(h) % SPEAKER_PALETTE.length];
}

export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  // Mismatched dimensions mean corruption (e.g. a wrong-length voiceprint) — don't silently truncate
  // and return a plausible-but-wrong score; treat as "no match" so a bad row can't mis-identify a speaker.
  if (!a || !b || a.length !== b.length || a.length === 0) {
    if (a && b && a.length !== b.length) console.warn("cosine: dimension mismatch", a.length, b.length);
    return 0;
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** L2-normalized mean of a set of vectors (a cluster/enrollment centroid). Returns [] if empty. */
export function meanVector(vs: number[][]): number[] {
  // Use only the dimension of the first valid vector and ignore ragged/empty ones (a failed
  // blobToVec returns []), so one corrupt row can't zero-pad and corrupt the centroid.
  const valid = vs.filter((v) => v && v.length);
  if (!valid.length) return [];
  const dim = valid[0].length;
  const usable = valid.filter((v) => v.length === dim);
  const out = new Array(dim).fill(0);
  for (const v of usable) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= usable.length;
  const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
  return n ? out.map((x) => x / n) : out;
}

/** Float32 vector <-> portable storage value for SQLite.
 *  We store the vector as a base64 TEXT string, NOT a raw BLOB: the native
 *  @capacitor-community/sqlite bridge rejects a bound Uint8Array parameter ("No value for type"),
 *  which silently broke EVERY on-device extraction (the embedding write is the first thing
 *  extraction does). A string binds identically on native + web (sql.js). Column affinity is BLOB
 *  but SQLite stores the text as-is; no migration needed (no embeddings ever persisted on device). */
export function vecToBlob(v: number[] | Float32Array): string {
  const bytes = new Uint8Array(Float32Array.from(v).buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function blobToVec(b: string | Uint8Array | ArrayBuffer | null | undefined): Float32Array {
  if (!b) return new Float32Array(0);
  if (typeof b === "string") {
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }
  const buf = b instanceof Uint8Array ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b;
  if (buf.byteLength % 4 !== 0) { console.warn("blobToVec: misaligned buffer", buf.byteLength); return new Float32Array(0); }
  return new Float32Array(buf);
}
