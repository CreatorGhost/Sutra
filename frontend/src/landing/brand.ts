// ============================================================================
// Sutra — landing-page brand contract. SHARED, READ-ONLY for variant authors.
// One source of truth for marketing copy, palette (as JS hex for Three.js, since
// WebGL materials can't read CSS vars), and the reduced-motion hook. Variant files
// (LandingV1..V5) import from here; they must NOT edit this file.
// ============================================================================
import { useEffect, useState } from "react";

/** What Sutra is — the messaging every variant draws from. Keep claims honest:
 *  audio is processed in-flight and never stored; memory is the user's. */
export const BRAND = {
  name: "Sutra",
  // सूत्र (Sanskrit): "thread" — the thread that strings scattered moments into memory.
  meaning: "Sanskrit: सूत्र — the thread that connects",
  // A few headline options; variants may pick the one that fits their composition.
  headlines: [
    "Your conversations, remembered.",
    "Talk. Sutra remembers the rest.",
    "Ambient memory for everything you say.",
    "Never lose a conversation again.",
  ],
  // Supporting subhead.
  sub:
    "Sutra listens while you talk, then turns every conversation into searchable memory — " +
    "summaries, action items, the people, and the decisions, all woven into one connected graph.",
  // Short, punchy variant for tight hero layouts.
  subShort: "Summaries, action items, people and decisions — woven into one connected, searchable memory.",
  ctaPrimary: "Start remembering",
  ctaSecondary: "See how it works",
  // The four product pillars. `icon` names map to lucide-react (already a dependency).
  pillars: [
    {
      icon: "AudioLines",
      title: "Just talk",
      desc: "Ambient capture runs in the background. Speak naturally in English, Hindi or both — Sutra keeps up.",
    },
    {
      icon: "Workflow",
      title: "Connected memory",
      desc: "People, topics, decisions and commitments are linked into a living knowledge graph you can explore.",
    },
    {
      icon: "Sparkles",
      title: "Ask your memory",
      desc: "Ask anything about your past conversations and get a grounded answer, with the sources cited.",
    },
    {
      icon: "ShieldCheck",
      title: "Private by design",
      desc: "Audio is never stored — processed in the moment, then gone. Your memory stays encrypted on your device.",
    },
  ],
  // A one-line privacy promise for badges / footers.
  privacyLine: "Audio is never stored. Your memory is yours.",
  footerTagline: "Sutra — ambient memory. Transcripts and memory only, never audio.",
} as const;

// ---- Palette as JS hex (mirrors the dark theme in index.css). Three.js needs numbers/hex strings,
// not CSS custom properties. Keep these in sync with :root in index.css. ----
export const PALETTE = {
  bg: "#0a0912",
  surface: "#14121e",
  surface2: "#1b1830",
  surface3: "#241f3a",
  border: "#272340",
  text: "#f1eff8",
  accent: "#8b7bff", // indigo/violet primary (AI / memory)
  accent2: "#a99bff",
  accentDeep: "#6f5cf0",
  amber: "#ffb23e", // warm secondary (scheduled / reminders)
  amber2: "#ffc873",
  ok: "#3ddc97",
} as const;

/** Numeric forms for Three.js color args where a 0x number reads cleaner. */
export const HEX = {
  bg: 0x0a0912,
  accent: 0x8b7bff,
  accent2: 0xa99bff,
  accentDeep: 0x6f5cf0,
  amber: 0xffb23e,
  amber2: 0xffc873,
  surface2: 0x1b1830,
} as const;

/** Live `prefers-reduced-motion` flag. Variants MUST gate 3D animation on this:
 *  when true, render a single static frame (frameloop="never") or a CSS poster — no loops. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mql.matches);
    mql.addEventListener?.("change", on);
    return () => mql.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** Coarse device check so variants can shed particle/poly budget on phones. */
export function useIsSmallScreen(breakpoint = 720): boolean {
  const [small, setSmall] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );
  useEffect(() => {
    const on = () => setSmall(window.innerWidth < breakpoint);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [breakpoint]);
  return small;
}
