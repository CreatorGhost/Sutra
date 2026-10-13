// Devanagari → Roman Hinglish ("कल meeting है" → "kal meeting hai"). PURE.
//
// The strongest local Hindi models (Qwen3-ASR, Whisper with language=hi) write Hindi in Devanagari.
// People who chose Roman Hinglish get the same model's output transliterated here, so the script
// choice never forces a weaker model. This is casual WhatsApp-style romanization, not ISO 15919:
// inherent-vowel (schwa) deletion as Hindi is actually spoken ("karte", not "karate"), "aa"/"ee"
// shortened at word end ("kya", "bhi"), nasals as "n". Latin text passes through untouched, so it is
// safe to run on mixed or already-Roman transcripts.

const CONS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "ऩ": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ऱ": "r", "ल": "l", "ळ": "l", "ऴ": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  // Precomposed nukta letters.
  "क़": "q", "ख़": "kh", "ग़": "gh", "ज़": "z", "ड़": "d", "ढ़": "dh", "फ़": "f", "य़": "y",
};
/** Base consonant → its nukta form (for the decomposed "क" + "़" spelling). */
const NUKTA: Record<string, string> = { k: "q", g: "gh", j: "z", ph: "f" };
const VOWELS: Record<string, string> = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ॠ": "ri",
  "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e", "ऎ": "e", "ऒ": "o",
};
const MATRAS: Record<string, string> = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "ॄ": "ri",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e", "ॆ": "e", "ॊ": "o",
};
const VIRAMA = "्", NUKTA_SIGN = "़", ANUSVARA = "ं", CHANDRABINDU = "ँ", VISARGA = "ः";
const DIGITS = "०१२३४५६७८९";

/** One syllable-ish unit: a consonant (with its vowel) or an independent vowel. `v` is the spoken vowel
 *  ("" after a virama or once schwa-deleted); `inherent` marks an unwritten "a" that may be dropped. */
interface Unit { c: string; v: string; inherent: boolean; nasal: boolean; tail: string }

const isDevanagari = (ch: string) => ch >= "ऀ" && ch <= "ॿ";

function parseWord(word: string): Unit[] {
  const units: Unit[] = [];
  const last = () => units[units.length - 1];
  for (const ch of word) {
    if (CONS[ch] != null) {
      // ज्ञ is pronounced "gy" (gyaan), not "jn".
      const prev = last();
      if (ch === "ञ" && prev && prev.c === "j" && prev.v === "" && !prev.inherent) { prev.c = "gy"; prev.v = "a"; prev.inherent = true; continue; }
      units.push({ c: CONS[ch], v: "a", inherent: true, nasal: false, tail: "" });
    } else if (VOWELS[ch] != null) {
      units.push({ c: "", v: VOWELS[ch], inherent: false, nasal: false, tail: "" });
    } else if (MATRAS[ch] != null) {
      const u = last();
      if (u && u.c) { u.v = MATRAS[ch]; u.inherent = false; }
    } else if (ch === VIRAMA) {
      const u = last();
      if (u && u.c) { u.v = ""; u.inherent = false; }
    } else if (ch === NUKTA_SIGN) {
      const u = last();
      if (u && NUKTA[u.c]) u.c = NUKTA[u.c];
    } else if (ch === ANUSVARA || ch === CHANDRABINDU) {
      const u = last();
      if (u) u.nasal = true;
    } else if (ch === VISARGA) {
      const u = last();
      if (u) u.tail += "h";
    }
  }
  return units;
}

/** Hindi schwa deletion (simplified Narasimhan et al.): drop a word-final inherent "a" (unless it
 *  closes a conjunct — "mitra"), then, right to left, drop a medial inherent "a" between a voiced
 *  syllable and a consonant that keeps its vowel (करते → karte, समझना → samajhna, मतलब → matlab). */
function deleteSchwas(u: Unit[]): void {
  const n = u.length;
  if (n > 1) {
    const end = u[n - 1];
    const prev = u[n - 2];
    const conjunct = !!prev.c && prev.v === "" && !prev.inherent;
    if (end.c && end.inherent && !end.nasal && !conjunct) end.v = "";
  }
  for (let i = n - 2; i >= 1; i--) {
    const cur = u[i];
    if (!cur.c || !cur.inherent || cur.nasal || cur.v !== "a") continue;
    const before = u[i - 1];
    const after = u[i + 1];
    if (before.v !== "" && after.c && after.v !== "") cur.v = "";
  }
}

function emitWord(units: Unit[]): string {
  let out = "";
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const isLast = i === units.length - 1;
    let v = u.v;
    // Casual endings: क्या → kya, भी → bhi, तू → tu (independent vowels keep their length: आ → aa).
    if (isLast && u.c) {
      if (v === "aa") v = "a";
      else if (v === "ee") v = "i";
      else if (v === "oo" && !u.nasal) v = "u";
    }
    let nasal = "";
    if (u.nasal) {
      const next = units[i + 1];
      if (isLast && v === "e") v = "ei"; // में → mein, करें → karein
      nasal = next && /^(p|ph|b|bh|m)$/.test(next.c) ? "m" : "n";
    }
    out += u.c + v + nasal + u.tail;
  }
  // च्छ is "cch" in everyday spelling (accha, bachcha → baccha).
  return out.replace(/chchh/g, "cch");
}

/** Transliterate any Devanagari in `text` to Roman Hinglish; everything else is passed through. */
export function toRomanHinglish(text: string): string {
  if (!/[ऀ-ॿ]/.test(text)) return text;
  let out = "";
  let word = "";
  const flush = () => { if (word) { const u = parseWord(word); deleteSchwas(u); out += emitWord(u); word = ""; } };
  for (const ch of text) {
    if (ch === "।" || ch === "॥") { flush(); out += "."; continue; }
    const d = DIGITS.indexOf(ch);
    if (d >= 0) { flush(); out += String(d); continue; }
    if (isDevanagari(ch) || ch === "‍" || ch === "‌") { if (ch !== "‍" && ch !== "‌") word += ch; continue; }
    flush();
    out += ch;
  }
  flush();
  // "." from a danda directly followed by a letter needs a space; collapse doubled spaces.
  return out.replace(/\.(?=[A-Za-z])/g, ". ").replace(/ {2,}/g, " ");
}
