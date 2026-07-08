// ============================================================================
// Sutra — Landing variant 1: "The Thread".
// सूत्र = the thread that strings scattered moments into memory. The hero is a
// bundle of flowing, glowing silk-thread curves drifting through deep space, with
// luminous bead-nodes (captured conversations) strung along the primary strand.
// Indigo→amber gradient, gentle sine drift, subtle pointer parallax.
// ALL CSS is co-located in LandingV1.css, scoped under .lv1.
// ============================================================================
import { Suspense, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Sparkles } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import {
  AudioLines,
  Workflow,
  Sparkles as SparklesIcon,
  ShieldCheck,
  Mic,
  Network,
  MessageCircleQuestion,
  ArrowUpRight,
  type LucideIcon,
} from "lucide-react";
import {
  BRAND,
  PALETTE,
  HEX,
  usePrefersReducedMotion,
  useIsSmallScreen,
} from "./brand";
import "./LandingV1.css";

// Map pillar icon names (from brand.ts) → lucide components, so copy stays in brand.
const PILLAR_ICONS: Record<string, LucideIcon> = {
  AudioLines,
  Workflow,
  Sparkles: SparklesIcon,
  ShieldCheck,
};

// ---------------------------------------------------------------------------
// 3D — a single primary thread + a few accompanying strands, beads on the main one.
// Everything built imperatively in useMemo to dodge bufferAttribute JSX typing.
// ---------------------------------------------------------------------------

// The primary strand's identity, shared by the spine Strand AND the Beads that ride
// it — so the two can never desync. Both derive control points from these constants
// and apply driftControls() with the SAME seed/amp.
const PRIMARY_SEED = 0;
const PRIMARY_SPREAD = 1.5;
const PRIMARY_DRIFT = 0.55;
// A fixed "designed" time used to pose the static (reduced-motion / initial) frame.
const STATIC_TIME = PRIMARY_SEED * 1.7 + 1.2;

/** Control points for one strand. The primary strand is the spine of the brand. */
function makeStrandControls(seed: number, spread: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1); // 0..1
    const x = (t - 0.5) * 13; // run left→right across the view
    const y =
      Math.sin(t * Math.PI * 1.7 + seed * 2.1) * spread +
      Math.cos(seed * 3.3 + i) * 0.35;
    const z = Math.cos(t * Math.PI * 1.3 + seed) * spread * 0.8 - seed * 0.6;
    pts.push(new THREE.Vector3(x, y, z));
  }
  return pts;
}

/** The ONE drift function. Writes the sine-drifted control points into `live`
 *  for a given seed/amp/time. Used by every strand and by the beads, so a bead
 *  evaluated on the curve provably sits on the same line the tube renders. */
function driftControls(
  live: THREE.Vector3[],
  base: THREE.Vector3[],
  time: number,
  seed: number,
  driftAmp: number,
): void {
  for (let i = 0; i < base.length; i++) {
    const b = base[i];
    const ph = i * 0.9 + seed * 2.0;
    live[i].set(
      b.x,
      b.y + Math.sin(time * 0.5 + ph) * driftAmp,
      b.z + Math.cos(time * 0.4 + ph) * driftAmp * 0.7,
    );
  }
}

interface StrandProps {
  seed: number;
  spread: number;
  radius: number;
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
  opacity: number;
  segments: number;
  driftAmp: number;
  reduced: boolean;
}

/** One glowing silk tube following a Catmull-Rom curve; control points sine-drift. */
function Strand({
  seed,
  spread,
  radius,
  color,
  emissive,
  emissiveIntensity,
  opacity,
  segments,
  driftAmp,
  reduced,
}: StrandProps) {
  const meshRef = useRef<THREE.Mesh>(null!);

  // Base control points + a live curve we re-evaluate each frame for the drift.
  const { base, curve } = useMemo(() => {
    const base = makeStrandControls(seed, spread);
    const curve = new THREE.CatmullRomCurve3(
      base.map((p) => p.clone()),
      false,
      "catmullrom",
      0.5,
    );
    return { base, curve };
  }, [seed, spread]);

  // Seed a flattering static pose (used as-is when reduced; advanced by useFrame otherwise).
  const buildGeometry = useMemo(() => {
    return (time: number) => {
      driftControls(curve.points, base, time, seed, driftAmp);
      curve.updateArcLengths();
      return new THREE.TubeGeometry(curve, segments, radius, 8, false);
    };
  }, [base, curve, seed, driftAmp, radius, segments]);

  // Initial geometry at a designed static time so the reduced-motion frame looks intentional.
  const initialGeom = useMemo(
    () => buildGeometry(seed * 1.7 + 1.2),
    [buildGeometry, seed],
  );

  useFrame(({ clock }) => {
    if (reduced || !meshRef.current) return;
    const next = buildGeometry(clock.elapsedTime);
    const old = meshRef.current.geometry;
    meshRef.current.geometry = next;
    old.dispose();
  });

  return (
    <mesh ref={meshRef} geometry={initialGeom}>
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={emissiveIntensity}
        roughness={0.32}
        metalness={0.15}
        transparent
        opacity={opacity}
      />
    </mesh>
  );
}

interface BeadsProps {
  count: number;
  reduced: boolean;
}

/** Luminous bead-nodes strung along the PRIMARY strand (each = a captured conversation). */
function Beads({ count, reduced }: BeadsProps) {
  // Re-derive the SAME primary control points so beads sit on the spine. Identical
  // seed/spread to the primary Strand, and we drift with the shared driftControls().
  const { base, curve } = useMemo(() => {
    const base = makeStrandControls(PRIMARY_SEED, PRIMARY_SPREAD);
    const curve = new THREE.CatmullRomCurve3(
      base.map((p) => p.clone()),
      false,
      "catmullrom",
      0.5,
    );
    return { base, curve };
  }, []);

  // Parameter positions for the beads, evenly spaced along the curve's arc length.
  const positions = useMemo(
    () => Array.from({ length: count }, (_, i) => (i + 0.5) / count),
    [count],
  );

  // Indigo→amber gradient along the strand (left indigo → right amber).
  const colors = useMemo(
    () =>
      positions.map((t) => {
        const c = new THREE.Color(HEX.accent2);
        c.lerp(new THREE.Color(HEX.amber), Math.pow(t, 1.35));
        return c;
      }),
    [positions],
  );

  const beadRefs = useRef<(THREE.Mesh | null)[]>([]);

  // Snap a bead to its arc-length point on the (already-drifted) curve + a small
  // pulse. Single owner of bead transforms — no competing Float bob, so a bead
  // can never drift off the strand it's threaded on.
  const placeBeads = (time: number) => {
    curve.updateArcLengths();
    for (let i = 0; i < positions.length; i++) {
      const m = beadRefs.current[i];
      if (!m) continue;
      curve.getPointAt(Math.min(0.999, positions[i]), m.position);
      m.scale.setScalar(1 + Math.sin(time * 1.4 + i * 1.3) * 0.1);
    }
  };

  useFrame(({ clock }) => {
    if (reduced) return;
    const time = clock.elapsedTime;
    // March the spine with the SAME drift as the primary Strand so beads ride it.
    driftControls(curve.points, base, time, PRIMARY_SEED, PRIMARY_DRIFT);
    placeBeads(time);
  });

  // Static positions for the reduced/initial frame — the strand's designed static pose.
  const staticPoints = useMemo(() => {
    driftControls(curve.points, base, STATIC_TIME, PRIMARY_SEED, PRIMARY_DRIFT);
    curve.updateArcLengths();
    return positions.map((t) =>
      curve.getPointAt(Math.min(0.999, t), new THREE.Vector3()),
    );
  }, [base, curve, positions]);

  return (
    <group>
      {staticPoints.map((p, i) => (
        <mesh
          key={i}
          ref={(el) => {
            beadRefs.current[i] = el;
          }}
          position={p}
        >
          <sphereGeometry args={[0.17, 24, 24]} />
          <meshStandardMaterial
            color={colors[i]}
            emissive={colors[i]}
            emissiveIntensity={1.9}
            roughness={0.25}
            metalness={0.1}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

interface ThreadBundleProps {
  reduced: boolean;
  small: boolean;
}

/** The whole woven bundle: one bright primary strand + companions + beads. Gentle
 *  group rotation; pointer parallax lerps the rotation toward the cursor. */
function ThreadBundle({ reduced, small }: ThreadBundleProps) {
  const groupRef = useRef<THREE.Group>(null!);
  const { pointer } = useThree();

  const accent = useMemo(() => new THREE.Color(HEX.accent), []);
  const accentDeep = useMemo(() => new THREE.Color(HEX.accentDeep), []);
  const accent2 = useMemo(() => new THREE.Color(HEX.accent2), []);
  const amber = useMemo(() => new THREE.Color(HEX.amber), []);

  // Companion strands — fewer on phones to shed budget.
  const companions = small ? 3 : 5;
  const beadCount = small ? 7 : 10;
  const tubeSegments = small ? 70 : 120;

  useFrame(({ clock }, dt) => {
    if (reduced || !groupRef.current) return;
    const g = groupRef.current;
    const k = Math.min(1, dt * 1.6); // frame-rate-independent damping
    // Bounded silk sway (NOT an unbounded barrel-roll) + pointer parallax, blended.
    const swayZ = 0.06 + Math.sin(clock.elapsedTime * 0.18) * 0.05;
    const tx = 0.04 + pointer.y * 0.16;
    const ty = -0.12 + pointer.x * 0.24;
    g.rotation.x += (tx - g.rotation.x) * k;
    g.rotation.y += (ty - g.rotation.y) * k;
    g.rotation.z += (swayZ - g.rotation.z) * k;
  });

  return (
    <group ref={groupRef} rotation={[0.04, -0.12, 0.06]}>
      {/* Primary spine — brightest, indigo core. Params come from the shared
          PRIMARY_* constants so the Beads provably ride this exact strand. */}
      <Strand
        seed={PRIMARY_SEED}
        spread={PRIMARY_SPREAD}
        radius={0.05}
        color={accent2}
        emissive={accent}
        emissiveIntensity={1.5}
        opacity={0.96}
        segments={tubeSegments}
        driftAmp={PRIMARY_DRIFT}
        reduced={reduced}
      />
      {/* Companion strands — dimmer, varied, weaving around the spine. */}
      {Array.from({ length: companions }).map((_, i) => {
        const seed = i + 1;
        const toAmber = i / Math.max(1, companions - 1);
        const col = accent2.clone().lerp(amber, Math.pow(toAmber, 1.6) * 0.55);
        const emis = accentDeep.clone().lerp(amber, Math.pow(toAmber, 1.8) * 0.6);
        return (
          <Strand
            key={seed}
            seed={seed * 1.37}
            spread={1.1 + (i % 3) * 0.5}
            radius={0.018 + (i % 2) * 0.01}
            color={col}
            emissive={emis}
            emissiveIntensity={0.9}
            opacity={0.5 - i * 0.05}
            segments={tubeSegments}
            driftAmp={0.42 + (i % 3) * 0.12}
            reduced={reduced}
          />
        );
      })}
      {/* Bead-nodes on the spine. */}
      <Beads count={beadCount} reduced={reduced} />
    </group>
  );
}

interface SceneProps {
  reduced: boolean;
  small: boolean;
}

function Scene({ reduced, small }: SceneProps) {
  return (
    <>
      {/* Manual lighting — NO remote environment assets. */}
      <ambientLight intensity={0.35} color={PALETTE.accent2} />
      <directionalLight position={[4, 6, 8]} intensity={1.1} color={PALETTE.accent2} />
      <pointLight position={[-6, -2, 2]} intensity={28} color={PALETTE.accentDeep} distance={22} />
      <pointLight position={[7, 1, -1]} intensity={20} color={PALETTE.amber} distance={20} />

      <Suspense fallback={null}>
        <ThreadBundle reduced={reduced} small={small} />
        <Sparkles
          count={small ? 40 : 90}
          scale={[16, 9, 8]}
          size={1.6}
          speed={reduced ? 0 : 0.32}
          opacity={0.5}
          color={PALETTE.accent2}
        />
      </Suspense>

      <EffectComposer multisampling={small ? 0 : 4}>
        <Bloom
          intensity={small ? 0.7 : 0.95}
          luminanceThreshold={0.32}
          luminanceSmoothing={0.85}
          mipmapBlur
          radius={0.7}
        />
      </EffectComposer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const HOW_STEPS = [
  {
    n: "01",
    Icon: Mic,
    kicker: "Talk",
    title: "Speak naturally. Sutra listens in the background.",
    body:
      "A meeting, a hallway chat, a voice note to yourself — in English, Hindi, or Hinglish. " +
      "Audio is processed in the moment and discarded. Nothing is recorded or kept.",
  },
  {
    n: "02",
    Icon: Network,
    kicker: "Weave",
    title: "Every moment is woven into one connected memory.",
    body:
      "Sutra extracts the summary, the action items, the people and the decisions — then strings " +
      "them onto a living knowledge graph, so scattered conversations become one continuous thread.",
  },
  {
    n: "03",
    Icon: MessageCircleQuestion,
    kicker: "Ask",
    title: "Ask your memory anything. Get a grounded answer.",
    body:
      "“What did I promise Priya last week?” “What did we decide about pricing?” Sutra answers from " +
      "your own conversations and cites exactly where each fact came from.",
  },
];

export default function LandingV1() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();

  const headline = BRAND.headlines[1]; // "Talk. Sutra remembers the rest."

  return (
    <div className="landing-root lv1">
      {/* ---- Top bar ---- */}
      <header className="lv1-topbar">
        <div className="l-container lv1-topbar-inner">
          <Link to="/landing/1" className="lv1-wordmark" aria-label="Sutra home">
            <span className="lv1-mark" aria-hidden="true">
              <span className="lv1-mark-thread" />
              <span className="lv1-mark-bead" />
            </span>
            <span className="lv1-wordmark-text">Sutra</span>
          </Link>
          <nav className="lv1-topnav" aria-label="Primary">
            <a className="lv1-toplink" href="#how">How it works</a>
            <a className="lv1-toplink" href="#privacy">Privacy</a>
            <a className="btn primary lv1-topcta" href="#start">
              {BRAND.ctaPrimary}
            </a>
          </nav>
        </div>
      </header>

      {/* ---- Hero ---- */}
      <section className="lv1-hero">
        <div className="l-canvas lv1-canvas-wrap" aria-hidden="true">
          <Canvas
            dpr={[1, 2]}
            gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
            camera={{ position: [0, 0, small ? 11 : 9], fov: small ? 58 : 50 }}
            frameloop={reduced ? "never" : "always"}
          >
            <Scene reduced={reduced} small={small} />
          </Canvas>
          {/* readability scrims — vignette + bottom fade so copy always sits on a calm field */}
          <div className="lv1-hero-vignette" />
          <div className="lv1-hero-fade" />
        </div>

        <div className="l-container l-fg lv1-hero-fg">
          <p className="l-eyebrow lv1-eyebrow">
            <span className="lv1-deva" aria-hidden="true">सूत्र</span>
            {BRAND.meaning}
          </p>
          <h1 className="l-hero-title lv1-title">{headline}</h1>
          <p className="l-lead lv1-lead">{BRAND.subShort}</p>

          <div className="l-cta-row lv1-cta-row">
            <a className="btn primary l-btn-lg lv1-cta-primary" href="#start">
              {BRAND.ctaPrimary}
            </a>
            <a className="btn ghost l-btn-lg lv1-cta-ghost" href="#how">
              {BRAND.ctaSecondary}
            </a>
          </div>

          <p className="lv1-privacy-chip">
            <ShieldCheck size={15} aria-hidden="true" />
            {BRAND.privacyLine}
          </p>
        </div>

        <a className="lv1-scroll-cue" href="#pillars" aria-label="Scroll to features">
          <span className="lv1-scroll-line" aria-hidden="true" />
        </a>
      </section>

      {/* ---- Pillars ---- */}
      <section className="l-section lv1-pillars" id="pillars">
        <div className="l-container">
          <div className="lv1-section-head">
            <p className="l-eyebrow">Why Sutra</p>
            <h2 className="l-h2">One thread through everything you say.</h2>
          </div>
          <ul className="lv1-pillar-grid">
            {BRAND.pillars.map((p, i) => {
              const Icon = PILLAR_ICONS[p.icon] ?? SparklesIcon;
              return (
                <li className="lv1-pillar" key={p.title}>
                  <span className="lv1-pillar-idx" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="lv1-pillar-ico" aria-hidden="true">
                    <Icon size={22} strokeWidth={1.6} />
                  </span>
                  <h3 className="lv1-pillar-title">{p.title}</h3>
                  <p className="lv1-pillar-desc">{p.desc}</p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* ---- How it works ---- */}
      <section className="l-section lv1-how" id="how">
        <div className="l-container">
          <div className="lv1-section-head">
            <p className="l-eyebrow">How it works</p>
            <h2 className="l-h2">Talk. Weave. Ask.</h2>
            <p className="l-lead lv1-how-lead">
              Three beats, one continuous thread — from the moment you speak to the moment you
              ask.
            </p>
          </div>

          <ol className="lv1-steps">
            {/* the connective thread spine behind the steps */}
            <span className="lv1-steps-spine" aria-hidden="true" />
            {HOW_STEPS.map((s) => (
              <li className="lv1-step" key={s.n}>
                <div className="lv1-step-marker" aria-hidden="true">
                  <span className="lv1-step-bead" />
                </div>
                <div className="lv1-step-body">
                  <p className="lv1-step-kicker">
                    <span className="lv1-step-n">{s.n}</span>
                    <s.Icon size={16} aria-hidden="true" />
                    {s.kicker}
                  </p>
                  <h3 className="lv1-step-title">{s.title}</h3>
                  <p className="lv1-step-text">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---- Closing CTA band ---- */}
      <section className="l-section lv1-closing" id="start">
        <div className="l-container lv1-closing-inner">
          <p className="lv1-deva-lg" aria-hidden="true">सूत्र</p>
          <h2 className="l-h2 lv1-closing-title">
            Start pulling the thread through your conversations.
          </h2>
          <p className="l-lead lv1-closing-lead" id="privacy">
            {BRAND.sub}
          </p>
          <div className="l-cta-row lv1-closing-cta">
            <a className="btn primary l-btn-lg lv1-cta-primary" href="#start">
              {BRAND.ctaPrimary}
              <ArrowUpRight size={18} aria-hidden="true" />
            </a>
            <span className="lv1-closing-note">
              <ShieldCheck size={14} aria-hidden="true" />
              {BRAND.privacyLine}
            </span>
          </div>
        </div>
      </section>

      {/* ---- Footer ---- */}
      <footer className="lv1-footer">
        <div className="l-container lv1-footer-inner">
          <div className="lv1-footer-brand">
            <span className="lv1-wordmark">
              <span className="lv1-mark" aria-hidden="true">
                <span className="lv1-mark-thread" />
                <span className="lv1-mark-bead" />
              </span>
              <span className="lv1-wordmark-text">Sutra</span>
            </span>
            <p className="lv1-footer-tag">{BRAND.footerTagline}</p>
          </div>
          <nav className="lv1-footer-links" aria-label="Footer">
            <a href="#privacy">Privacy</a>
            <a href="#how">How it works</a>
            <a href="#start">Get the app</a>
          </nav>
        </div>
        <div className="l-container lv1-footer-base">
          <p className="lv1-footer-fine">{BRAND.privacyLine}</p>
          <p className="lv1-footer-fine">© {new Date().getFullYear()} Sutra</p>
        </div>
      </footer>
    </div>
  );
}
