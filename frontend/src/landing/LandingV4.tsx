// ============================================================================
// Sutra — Landing variant 4: "Aurora".
//
// Art direction: LUMINOUS SOFT-FUTURISM. A pale lavender-white world lit by a
// large aurora gradient field (indigo -> violet -> soft pink -> warm amber).
// The centerpiece is a flowing GRADIENT FLUID ORB — a metaball-like blob that
// slowly morphs and glows (drei MeshDistortMaterial + Bloom), the bright,
// optimistic counterpart to the dark variants. Layout floats: frosted glass
// panels hover over the aurora with generous breathing room, soft shadows and
// big rounded forms. Inter at light weights; the H1 is gradient-clipped.
//
// Only this file + LandingV4.css are touched. All CSS scoped under .lv4.
// ============================================================================
import { Suspense, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { MeshDistortMaterial, Float, Environment, Lightformer } from "@react-three/drei";
import * as THREE from "three";
import {
  AudioLines,
  Workflow,
  Sparkles,
  ShieldCheck,
  ArrowRight,
  Mic,
  Network,
  MessageCircleQuestion,
  Check,
  type LucideIcon,
} from "lucide-react";
import {
  BRAND,
  usePrefersReducedMotion,
  useIsSmallScreen,
} from "./brand";
import "./LandingV4.css";

// lucide icon names referenced by BRAND.pillars -> concrete components.
const PILLAR_ICONS: Record<string, LucideIcon> = {
  AudioLines,
  Workflow,
  Sparkles,
  ShieldCheck,
};

// Aurora palette (this variant owns its own colors — light & luminous).
const AUR = {
  indigo: new THREE.Color("#8b7bff"),
  violet: new THREE.Color("#a99bff"),
  pink: new THREE.Color("#ff9fd0"),
  amber: new THREE.Color("#ffc873"),
};

// ---------------------------------------------------------------------------
// The fluid orb: a high-subdivision sphere with MeshDistortMaterial that slowly
// breathes and morphs. Lit so the surface reads as a living aurora gradient,
// with a soft inner glow. Two ghost shells behind it add a frosted halo.
// ---------------------------------------------------------------------------
function FluidOrb({ reduced, small }: { reduced: boolean; small: boolean }) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const matRef = useRef<any>(null!);
  const haloA = useRef<THREE.Mesh>(null!);
  const haloB = useRef<THREE.Mesh>(null!);
  const invalidate = useThree((s) => s.invalidate);

  // tasteful subdivision; lighter on phones
  const detail = small ? 24 : 64;

  const tmp = useMemo(() => new THREE.Color(), []);

  // Flattering static pose for reduced motion. Done in an effect (not render)
  // so render stays pure; frameloop="never" then paints this single frame.
  // We re-invalidate across two rAFs because the material/env refs (under
  // Suspense) and the Environment(frames=1) bake may not be ready on the first
  // paint — without this the orb can render flat or unlit on a "never" loop.
  useEffect(() => {
    if (!reduced) return;
    let raf1 = 0;
    let raf2 = 0;
    const paint = () => {
      if (meshRef.current) {
        meshRef.current.rotation.set(-0.25, 0.6, 0.12);
        meshRef.current.scale.setScalar(1);
      }
      if (matRef.current) {
        matRef.current.distort = 0.34;
        matRef.current.color.copy(AUR.violet).lerp(AUR.pink, 0.4);
        matRef.current.emissive.copy(AUR.indigo).lerp(AUR.amber, 0.18);
      }
      invalidate();
    };
    paint();
    raf1 = requestAnimationFrame(() => {
      paint();
      raf2 = requestAnimationFrame(paint);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [reduced, invalidate]);

  useFrame((state) => {
    if (reduced) return;
    const t = state.clock.elapsedTime;

    if (meshRef.current) {
      meshRef.current.rotation.y = t * 0.12;
      meshRef.current.rotation.x = -0.2 + Math.sin(t * 0.18) * 0.12;
      const s = 1 + Math.sin(t * 0.6) * 0.018;
      meshRef.current.scale.setScalar(s);
    }
    if (matRef.current) {
      // gentle breathing distortion
      matRef.current.distort = 0.32 + Math.sin(t * 0.5) * 0.1;
      matRef.current.distortionSpeed = 0.9;
      // slow aurora hue cycle across the four stops
      const phase = (Math.sin(t * 0.16) + 1) / 2; // 0..1
      if (phase < 0.5) {
        tmp.copy(AUR.indigo).lerp(AUR.violet, phase * 2);
      } else {
        tmp.copy(AUR.violet).lerp(AUR.pink, (phase - 0.5) * 2);
      }
      matRef.current.color.copy(tmp);
      const em = tmp.clone().lerp(AUR.amber, 0.18);
      matRef.current.emissive.copy(em);
    }
    // halos counter-rotate slowly for a parallax shimmer
    if (haloA.current) haloA.current.rotation.z = t * 0.05;
    if (haloB.current) haloB.current.rotation.z = -t * 0.035;
  });

  return (
    <group>
      {/* frosted outer halo shells — soft, additive glow */}
      <mesh ref={haloA} scale={1.42}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial
          color={"#c9bcff"}
          transparent
          opacity={0.1}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={haloB} scale={1.74}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial
          color={"#ffd9a8"}
          transparent
          opacity={0.06}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/* the living orb */}
      <Float
        speed={reduced ? 0 : 1.1}
        rotationIntensity={reduced ? 0 : 0.25}
        floatIntensity={reduced ? 0 : 0.55}
      >
        <mesh ref={meshRef} rotation={[-0.25, 0.6, 0.12]}>
          <sphereGeometry args={[1, detail, detail]} />
          <MeshDistortMaterial
            ref={matRef}
            color={"#a99bff"}
            emissive={"#8b7bff"}
            emissiveIntensity={0.92}
            roughness={0.16}
            metalness={0.1}
            clearcoat={1}
            clearcoatRoughness={0.25}
            distort={0.34}
            speed={reduced ? 0 : 1.4}
          />
        </mesh>
      </Float>
    </group>
  );
}

// Manual + Lightformer lighting (NO remote env preset). Warm/cool key lights
// sculpt the orb so the aurora gradient reads on the surface.
function Lights() {
  return (
    <>
      <ambientLight intensity={0.9} />
      <directionalLight position={[4, 6, 5]} intensity={1.1} color={"#fff4ff"} />
      <pointLight position={[-5, -2, 4]} intensity={28} color={"#ffc873"} />
      <pointLight position={[5, 3, -3]} intensity={22} color={"#8b7bff"} />
      {/* Lightformer children only — provides soft studio reflections, no network */}
      <Environment resolution={128} frames={1}>
        <Lightformer
          form="rect"
          intensity={2.2}
          color={"#d9ceff"}
          position={[0, 3, 3]}
          scale={[8, 4, 1]}
        />
        <Lightformer
          form="rect"
          intensity={1.6}
          color={"#ffd9a8"}
          position={[-4, -2, 2]}
          scale={[6, 4, 1]}
        />
        <Lightformer
          form="ring"
          intensity={1.4}
          color={"#ffaedd"}
          position={[4, -1, 3]}
          scale={[3, 3, 1]}
        />
      </Environment>
    </>
  );
}

function OrbScene({ reduced, small }: { reduced: boolean; small: boolean }) {
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 4.2], fov: 42 }}
      className="lv4-canvas"
      frameloop={reduced ? "never" : "always"}
    >
      <Lights />
      <Suspense fallback={null}>
        <FluidOrb reduced={reduced} small={small} />
      </Suspense>
      {/* NOTE: no postprocessing EffectComposer here on purpose — its bloom pass discards the
          canvas alpha and paints an opaque rectangle (an ugly white box over the aurora). The orb
          stays luminous via strong emissive + the additive glow shell + a CSS halo behind it. */}
    </Canvas>
  );
}

// ---------------------------------------------------------------------------

const STEPS = [
  {
    n: "01",
    word: "Talk",
    Icon: Mic,
    title: "Just speak. Sutra is already listening.",
    body:
      "Leave it running and have your conversation — English, Hindi or Hinglish. No commands, no note-taking, no friction.",
  },
  {
    n: "02",
    word: "Weave",
    Icon: Network,
    title: "The audio is dropped. The meaning is woven in.",
    body:
      "Each conversation becomes summaries, action items, people and decisions — linked into one living knowledge graph.",
  },
  {
    n: "03",
    word: "Ask",
    Icon: MessageCircleQuestion,
    title: "Ask your memory anything. Get a cited answer.",
    body:
      "Months later, just ask. Sutra answers from your own words and shows you exactly where each fact came from.",
  },
];

export default function LandingV4() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();

  return (
    <div className="landing-root lv4">
      {/* ambient aurora field — pure CSS, sits behind everything */}
      <div className="lv4-aurora" aria-hidden="true">
        <span className="lv4-blob lv4-blob-1" />
        <span className="lv4-blob lv4-blob-2" />
        <span className="lv4-blob lv4-blob-3" />
        <span className="lv4-grain" />
      </div>

      {/* ---------------------------------------------------------- top bar */}
      <header className="lv4-topbar">
        <Link to="/landing/4" className="lv4-wordmark" aria-label="Sutra home">
          <span className="lv4-mark" aria-hidden="true" />
          <span className="lv4-wordmark-name">{BRAND.name}</span>
          <span className="lv4-meaning" aria-hidden="true">सूत्र</span>
        </Link>
        <a href="#start" className="lv4-pill-cta">
          {BRAND.ctaPrimary}
          <ArrowRight size={15} aria-hidden="true" />
        </a>
      </header>

      {/* ------------------------------------------------------------- hero */}
      <section className="lv4-hero">
        <div className="lv4-orb-wrap" aria-hidden="true">
          <OrbScene reduced={reduced} small={small} />
        </div>

        <div className="lv4-hero-inner">
          <p className="lv4-eyebrow">
            <Sparkles size={14} aria-hidden="true" />
            Ambient memory · {BRAND.meaning}
          </p>

          <h1 className="lv4-h1">
            <span className="lv4-h1-glow" aria-hidden="true" />
            Remember everything.
            <span className="lv4-h1-grad"> Effortlessly.</span>
          </h1>

          <p className="lv4-lead">
            Just talk. Sutra listens, then quietly weaves every conversation into
            searchable memory — the summaries, the people, the decisions, all on
            one bright thread you can ask anything.
          </p>

          <div className="lv4-cta-row">
            <a href="#start" className="lv4-btn-primary">
              {BRAND.ctaPrimary}
              <ArrowRight size={18} aria-hidden="true" />
            </a>
            <a href="#how" className="lv4-btn-ghost">
              {BRAND.ctaSecondary}
            </a>
          </div>

          <p className="lv4-trust">
            <ShieldCheck size={15} aria-hidden="true" />
            {BRAND.privacyLine}
          </p>
        </div>

        <a href="#pillars" className="lv4-scroll-hint" aria-hidden="true" tabIndex={-1}>
          <span />
        </a>
      </section>

      {/* ---------------------------------------------------------- pillars */}
      <section className="lv4-section" id="pillars" aria-labelledby="lv4-pillars-title">
        <div className="lv4-section-head">
          <p className="lv4-kicker">Why it feels effortless</p>
          <h2 className="lv4-h2" id="lv4-pillars-title">
            A memory that keeps up with you — and asks nothing in return.
          </h2>
        </div>

        <div className="lv4-glass-grid">
          {BRAND.pillars.map((p, i) => {
            const Icon = PILLAR_ICONS[p.icon] ?? Sparkles;
            return (
              <article className={`lv4-glass lv4-glass-${i + 1}`} key={p.title}>
                <span className="lv4-glass-icon" aria-hidden="true">
                  <Icon size={22} strokeWidth={1.6} />
                </span>
                <h3 className="lv4-glass-title">{p.title}</h3>
                <p className="lv4-glass-desc">{p.desc}</p>
              </article>
            );
          })}
        </div>
      </section>

      {/* ----------------------------------------------------- how it works */}
      <section className="lv4-how" id="how" aria-labelledby="lv4-how-title">
        <div className="lv4-section-head">
          <p className="lv4-kicker">How it works</p>
          <h2 className="lv4-h2" id="lv4-how-title">
            Talk, weave, ask — three light steps, one bright thread.
          </h2>
          <p className="lv4-how-sub">
            Your voice goes in, the audio is discarded in the moment, and what
            stays behind is connected, searchable memory you fully own.
          </p>
        </div>

        <ol className="lv4-flow">
          {STEPS.map((s, i) => (
            <li className="lv4-flow-item" key={s.n}>
              <article className="lv4-flow-card">
                <span className="lv4-flow-num" aria-hidden="true">{s.n}</span>
                <span className="lv4-flow-icon" aria-hidden="true">
                  <s.Icon size={20} strokeWidth={1.6} />
                </span>
                <h3 className="lv4-flow-word">{s.word}</h3>
                <p className="lv4-flow-title">{s.title}</p>
                <p className="lv4-flow-body">{s.body}</p>
              </article>
              {i < STEPS.length - 1 && (
                <span className="lv4-flow-link" aria-hidden="true">
                  <ArrowRight size={18} />
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>

      {/* -------------------------------------------------------- closing CTA */}
      <section className="lv4-closing" id="start" aria-labelledby="lv4-cta-title">
        <div className="lv4-closing-panel">
          <p className="lv4-kicker">Start your thread</p>
          <h2 className="lv4-closing-title" id="lv4-cta-title">
            Stop trying to remember.
            <span className="lv4-h1-grad"> Just start talking.</span>
          </h2>
          <p className="lv4-closing-lead">
            Sutra turns everything you say into a thread you can follow back —
            for as long as you want it, and never a single second of audio.
          </p>

          <div className="lv4-cta-row lv4-cta-center">
            <a href="#start" className="lv4-btn-primary">
              {BRAND.ctaPrimary}
              <ArrowRight size={18} aria-hidden="true" />
            </a>
            <a href="#how" className="lv4-btn-ghost">
              {BRAND.ctaSecondary}
            </a>
          </div>

          <ul className="lv4-assurances" aria-label="What you get">
            <li><Check size={14} aria-hidden="true" />Audio never stored</li>
            <li><Check size={14} aria-hidden="true" />Encrypted on your device</li>
            <li><Check size={14} aria-hidden="true" />English · Hindi · Hinglish</li>
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------------------- footer */}
      <footer className="lv4-footer">
        <div className="lv4-footer-inner">
          <div className="lv4-footer-brand">
            <span className="lv4-wordmark">
              <span className="lv4-mark" aria-hidden="true" />
              <span className="lv4-wordmark-name">{BRAND.name}</span>
            </span>
            <p className="lv4-footer-tag">{BRAND.footerTagline}</p>
            <p className="lv4-footer-priv">
              <ShieldCheck size={13} aria-hidden="true" />
              {BRAND.privacyLine}
            </p>
          </div>
          <nav className="lv4-footer-links" aria-label="Footer">
            <span className="lv4-footer-col">Sutra</span>
            <a href="#pillars">Features</a>
            <a href="#how">How it works</a>
            <a href="#start">Get the app</a>
          </nav>
        </div>
        <p className="lv4-footer-rule">{BRAND.meaning}</p>
      </footer>
    </div>
  );
}
