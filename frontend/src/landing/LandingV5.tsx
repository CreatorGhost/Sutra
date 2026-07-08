// ============================================================================
// Sutra — Landing variant 5: "Swiss".
//
// Art direction: Swiss International Style / Vignelli / museum identity. Stark
// monochrome — near-black ground (#0c0c0d), bone text (#f2f2f2), true neutral.
// Exactly ONE hairline indigo (#6f5cf0) accent. The TYPE is the design: an
// enormous Space Grotesk headline on a strict 12-column grid with quiet hairline
// rules and huge whitespace. Copy is gallery-label terse — declarative, precise.
//
// 3D is PUNCTUATION, not the stage: a single small, slowly-rotating monochrome
// torus-knot — matte form, hairline edge (the "thread", सूत्र) — sitting in one
// reserved grid cell. Minimal lighting, no bloom — the opposite of a full-bleed hero.
//
// Only this file + LandingV5.css are touched. All CSS scoped under .lv5.
// ============================================================================
import { Suspense, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  AudioLines,
  Workflow,
  Sparkles,
  ShieldCheck,
  ArrowRight,
  Lock,
  type LucideIcon,
} from "lucide-react";
import {
  BRAND,
  usePrefersReducedMotion,
  useIsSmallScreen,
} from "./brand";
import "./LandingV5.css";

// lucide icon names referenced by BRAND.pillars -> concrete components.
const PILLAR_ICONS: Record<string, LucideIcon> = {
  AudioLines,
  Workflow,
  Sparkles,
  ShieldCheck,
};

// ---------------------------------------------------------------------------
// The thread. A single monochrome torus-knot: a matte mid-grey form traced by a
// crisp bone hairline edge, over the near-black ground — one looped, continuous
// line: सूत्र. It rotates slowly. No color, no bloom: discipline over decoration.
// ---------------------------------------------------------------------------
function ThreadKnot({ reduced, detail }: { reduced: boolean; detail: number }) {
  const group = useRef<THREE.Group>(null!);

  // Build the geometry once. A (2,3) torus-knot reads as a single woven loop — सूत्र.
  // High tubular detail for a smooth tube; LOW radial detail (6) so the thin matte
  // fill keeps a faceted, drawn quality instead of a glossy blob.
  const geo = useMemo(
    () => new THREE.TorusKnotGeometry(1, 0.26, detail, 6, 2, 3),
    [detail],
  );
  // Edge outline only (no internal triangulation) — a crisp hairline that traces
  // the loop's silhouette: a single drawn thread, not a noisy wire cage.
  const edges = useMemo(() => new THREE.EdgesGeometry(geo, 22), [geo]);

  // A flattering static pose for the reduced-motion / first frame.
  const pose = useMemo(() => new THREE.Euler(0.5, -0.7, 0.18), []);

  // Dispose GPU buffers on unmount / regeneration — no leak across resizes.
  useEffect(() => () => { geo.dispose(); edges.dispose(); }, [geo, edges]);

  useFrame((_, dt) => {
    if (reduced || !group.current) return;
    group.current.rotation.y += dt * 0.16;
    group.current.rotation.x += dt * 0.045;
  });

  return (
    <group ref={group} rotation={pose} scale={1.18}>
      {/* matte mid-grey fill — minimal lighting reads the form, no gloss, no bloom */}
      <mesh geometry={geo}>
        <meshStandardMaterial
          color={0x6e6e77}
          roughness={1}
          metalness={0}
          flatShading
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
      {/* hairline bone edge — the drawn thread itself */}
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={0xffffff} transparent opacity={1} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

function KnotScene({ reduced, small }: { reduced: boolean; small: boolean }) {
  // shed polys on small screens
  const detail = small ? 120 : 220;
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 4.1], fov: 42 }}
      frameloop={reduced ? "never" : "always"}
    >
      {/* minimal, monochrome lighting — just enough to read the matte fill */}
      <ambientLight intensity={0.55} />
      <directionalLight position={[3, 4, 5]} intensity={1.15} color={0xffffff} />
      <directionalLight position={[-4, -2, -3]} intensity={0.45} color={0xffffff} />
      <Suspense fallback={null}>
        <ThreadKnot reduced={reduced} detail={detail} />
      </Suspense>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function LandingV5() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();

  // Talk -> weave -> Ask. Gallery-label terse.
  const steps = [
    { verb: "Talk", body: "Speak naturally. Ambient capture runs in the background. English, Hindi, Hinglish." },
    { verb: "Weave", body: "People, decisions and commitments are linked into one connected knowledge graph." },
    { verb: "Ask", body: "Question your past. Get a grounded answer, with the exact sources cited." },
  ];

  return (
    <div className="landing-root lv5">
      {/* ============================ TOP BAR ============================ */}
      <header className="topbar">
        <div className="wrap topbar-inner">
          <Link to="/" className="wordmark" aria-label="Sutra home">
            <span className="glyph">/</span>
            <span>Sutra</span>
          </Link>
          <nav className="topnav" aria-label="Primary">
            <a className="nav-link" href="#pillars">System</a>
            <a className="nav-link" href="#how">Method</a>
            <Link className="nav-cta" to="/app">{BRAND.ctaPrimary}</Link>
          </nav>
        </div>
      </header>

      <main>
        {/* ============================ HERO ============================ */}
        <section className="hero">
          <div className="wrap">
            {/* gallery wall-text meta row */}
            <div className="grid12 hero-meta">
              <div className="m-left">
                <p className="label">
                  <span className="accent-tick" />&nbsp;&nbsp;Sutra — Ambient Memory
                </p>
              </div>
              <div className="m-right">
                <p className="label">No. 05 / Index</p>
                <p className="label">EN · HI · Hinglish</p>
              </div>
            </div>

            {/* a quiet measured rule with column registration ticks — museum wall-measure */}
            <div className="rule rule--ticks" role="presentation" />

            {/* the headline dominates — type IS the design */}
            <div className="grid12 hero-grid">
              <div className="hero-head">
                <h1 className="mega">
                  <span className="ln rise d1">Everything</span>
                  <span className="ln rise d2">you said.</span>
                  <span className="ln rise d3">
                    <span className="findable">Findable.</span>
                  </span>
                </h1>
              </div>
            </div>

            {/* 3D punctuation — single small object in its own cell */}
            <div className="hero-object" aria-hidden="true">
              <div className="canvas-wrap">
                <KnotScene reduced={reduced} small={small} />
              </div>
              <p className="obj-cap label">सूत्र — the thread</p>
            </div>

            <hr className="rule" style={{ marginTop: "clamp(28px, 6vh, 64px)" }} />

            {/* sub + CTAs aligned to the grid */}
            <div className="grid12 hero-foot">
              <p className="hero-sub">
                You talk. Sutra listens, then weaves every conversation into searchable
                memory — <strong>summaries, people, decisions</strong>, one connected graph.
                <br />
                <strong>Audio is never stored.</strong>
              </p>
              <div className="hero-actions">
                <Link className="btn-solid" to="/app">
                  {BRAND.ctaPrimary}
                  <ArrowRight className="arr" size={18} strokeWidth={2} aria-hidden="true" />
                </Link>
                <a className="btn-link" href="#how">{BRAND.ctaSecondary}</a>
              </div>
            </div>
          </div>
        </section>

        {/* ============================ PILLARS ============================ */}
        <section className="pillars" id="pillars">
          <div className="wrap">
            <div className="grid12 section-head">
              <p className="sh-index label label--accent">01 — System</p>
              <h2 className="sh-title">Four parts. One thread.</h2>
              <p className="sh-note label">The whole of it</p>
            </div>

            <div className="pillar-grid">
              {BRAND.pillars.map((p, i) => {
                const Icon = PILLAR_ICONS[p.icon] ?? Sparkles;
                return (
                  <div className="pillar-row" key={p.title}>
                    <div className="p-num">{String(i + 1).padStart(2, "0")}</div>
                    <h3 className="p-title">
                      <Icon size={22} strokeWidth={1.5} aria-hidden="true" />
                      {p.title}
                    </h3>
                    <p className="p-desc">{p.desc}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ============================ HOW IT WORKS ============================ */}
        <section className="how" id="how">
          <div className="wrap">
            <div className="grid12 section-head">
              <p className="sh-index label label--accent">02 — Method</p>
              <h2 className="sh-title">Talk, weave, ask.</h2>
              <p className="sh-note label">Three moves</p>
            </div>

            <div className="how-grid">
              {steps.map((s, i) => (
                <div className="step" key={s.verb}>
                  <p className="s-num">Step {String(i + 1).padStart(2, "0")}</p>
                  <h3 className="s-verb">{s.verb}</h3>
                  <p className="s-body">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ CLOSING CTA ============================ */}
        <section className="close">
          <div className="wrap">
            <div className="grid12 close-grid">
              <div className="close-head">
                <p className="label label--accent" style={{ marginBottom: "clamp(20px,4vh,36px)" }}>
                  03 — Begin
                </p>
                <h2>
                  Start the thread<span className="dot">.</span>
                </h2>
              </div>
              <div className="close-actions">
                <Link className="btn-solid" to="/app">
                  {BRAND.ctaPrimary}
                  <ArrowRight className="arr" size={18} strokeWidth={2} aria-hidden="true" />
                </Link>
                <span className="close-privacy">
                  <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
                  {BRAND.privacyLine}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ============================ FOOTER ============================ */}
        <footer className="foot">
          <div className="wrap grid12 foot-grid">
            <div className="foot-mark">
              <span className="fw">Sutra</span>
              <span className="fm-meaning">{BRAND.meaning}</span>
            </div>
            <p className="foot-tag">{BRAND.footerTagline}</p>
            <div className="foot-priv">
              <p className="label">{BRAND.privacyLine}</p>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
