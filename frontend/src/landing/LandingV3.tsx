// ============================================================================
// Sutra — Landing variant 3 · "Field Notes"
// A warm, light, editorial journal spread. Cream paper, ink, amber. Fraunces
// headlines, marginalia in mono, a pull-quote, pillars as a numbered ledger.
// The 3D is restrained and analog: a slowly folding, warm-lit clay/wax form —
// like ink blooming into paper, the single "thread" caught mid-motion.
// All visual rules live in LandingV3.css, scoped under .lv3.
// ============================================================================
import { Suspense, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
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
import { BRAND, usePrefersReducedMotion, useIsSmallScreen } from "./brand";
import "./LandingV3.css";

const ICONS: Record<string, LucideIcon> = { AudioLines, Workflow, Sparkles, ShieldCheck };
const ROMAN = ["I", "II", "III", "IV"];
const TAGS = ["Capture", "Weave", "Recall", "Privacy"];

// ---- warm palette in three.js terms ----
const C_INK = new THREE.Color("#241f17");
const C_AMBER = new THREE.Color("#d68a26");
const C_AMBER_HI = new THREE.Color("#f0b755");
const C_PAPER = new THREE.Color("#f5efe2");

// ----------------------------------------------------------------------------
// ClayForm — a soft organic mass that slowly folds & breathes, like a drop of
// ink blooming in water or a wax form being turned. Built imperatively so we
// can displace vertices with layered trig "noise" each frame. Warm-lit only.
// ----------------------------------------------------------------------------
// A single quiet thread with a few amber beads strung along it — literally the page's own
// definition of सूत्र ("a thread; the line on which beads are strung"). Fine and editorial,
// the warm/light counterpart to V1's dramatic dark bundle. `detail` is accepted but unused
// (the thread is a fixed, lightweight tube — no per-frame geometry rebuild).
function ClayForm({ reduced }: { reduced: boolean; detail?: number }) {
  const group = useRef<THREE.Group>(null!);
  const beadRefs = useRef<(THREE.Mesh | null)[]>([]);

  // One graceful curve running top→bottom with a gentle S-sway and depth.
  const curve = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const n = 7;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      pts.push(
        new THREE.Vector3(
          Math.sin(t * Math.PI * 1.6) * 1.02,
          (t - 0.5) * 4.5,
          Math.cos(t * Math.PI * 1.15) * 0.62,
        ),
      );
    }
    return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
  }, []);

  // Thin matte tube (the thread) + fixed bead positions along its arc length.
  const tube = useMemo(() => new THREE.TubeGeometry(curve, 170, 0.05, 12, false), [curve]);
  const beadPositions = useMemo(
    () => [0.14, 0.37, 0.6, 0.82].map((u) => curve.getPointAt(u)),
    [curve],
  );
  useEffect(() => () => tube.dispose(), [tube]);

  useFrame(({ clock }) => {
    if (reduced || !group.current) return;
    const t = clock.elapsedTime;
    // a quiet sway — never a full barrel roll
    group.current.rotation.y = Math.sin(t * 0.16) * 0.26;
    group.current.rotation.z = Math.sin(t * 0.11) * 0.05;
    for (let i = 0; i < beadRefs.current.length; i++) {
      const m = beadRefs.current[i];
      if (m) m.scale.setScalar(1 + Math.sin(t * 1.25 + i * 1.5) * 0.12);
    }
  });

  return (
    <group ref={group} rotation={[0.05, 0.5, 0.05]}>
      {/* the thread — a fine warm-ink line drawn on the paper */}
      <mesh geometry={tube}>
        <meshStandardMaterial
          color={C_INK}
          roughness={0.55}
          metalness={0.04}
          emissive={C_AMBER}
          emissiveIntensity={0.1}
        />
      </mesh>
      {/* beads strung on the line — small, warm, gently lit */}
      {beadPositions.map((p, i) => (
        <mesh key={i} position={p} ref={(el) => { beadRefs.current[i] = el; }}>
          <sphereGeometry args={[0.12, 28, 28]} />
          <meshStandardMaterial
            color={C_AMBER}
            roughness={0.3}
            metalness={0.1}
            emissive={C_AMBER}
            emissiveIntensity={0.55}
          />
        </mesh>
      ))}
    </group>
  );
}

// A few slow motes drifting up, like dust in a sunbeam over the form.
function Motes({ reduced, count }: { reduced: boolean; count: number }) {
  const pts = useRef<THREE.Points>(null!);
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 4.6;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 4.2;
      arr[i * 3 + 2] = (Math.random() - 0.5) * 2.4;
    }
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    return g;
  }, [count]);

  useFrame((_, dt) => {
    if (reduced || !pts.current) return;
    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      let y = pos.getY(i) + dt * 0.12;
      if (y > 2.1) y = -2.1;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    pts.current.rotation.y += dt * 0.02;
  });

  return (
    <points ref={pts} geometry={geom}>
      <pointsMaterial
        size={0.045}
        color={C_AMBER_HI}
        transparent
        opacity={0.55}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

function HeroScene({ reduced, small }: { reduced: boolean; small: boolean }) {
  return (
    <Canvas
      dpr={[1, small ? 1.5 : 2]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 5.1], fov: 42 }}
      frameloop={reduced ? "never" : "always"}
      style={{ width: "100%", height: "100%" }}
    >
      <Suspense fallback={null}>
        {/* manual warm lighting — soft, analog, never neon */}
        <ambientLight intensity={0.55} color={C_PAPER} />
        <directionalLight position={[3.5, 4, 3]} intensity={1.5} color={C_AMBER_HI} />
        <directionalLight position={[-3, -1.5, 1]} intensity={0.5} color={"#7c6a52"} />
        <pointLight position={[-2, 2.5, 2.5]} intensity={18} distance={9} color={C_AMBER} />

        <ClayForm reduced={reduced} detail={small ? 7 : 12} />
        {!small && <Motes reduced={reduced} count={36} />}

        {/* env reflections from hand-placed lightformers (no preset, network-free) */}
        <Environment resolution={128} frames={1}>
          <Lightformer
            form="rect"
            intensity={2.4}
            color="#ffdca0"
            position={[2.5, 3, 2]}
            scale={[5, 5, 1]}
          />
          <Lightformer
            form="circle"
            intensity={1.1}
            color="#caa46a"
            position={[-3, -2, 1]}
            scale={[4, 4, 1]}
          />
          <Lightformer
            form="rect"
            intensity={0.6}
            color="#f5efe2"
            position={[0, 0, -4]}
            scale={[8, 8, 1]}
          />
        </Environment>

        {/* No EffectComposer: its bloom pass discards canvas alpha and would paint an opaque
            rectangle over the cream page. The form reads via emissive + warm lights instead. */}
      </Suspense>
    </Canvas>
  );
}

// ----------------------------------------------------------------------------
export default function LandingV3() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();

  return (
    <div className="landing-root lv3">
      <div className="grain" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />

      {/* ---------------- MASTHEAD ---------------- */}
      <header className="masthead">
        <div className="wrap masthead-inner">
          <div className="mast-left">
            <Link to="/" className="wordmark">
              Sutra<span className="devnag">सूत्र</span>
            </Link>
            <span className="mast-meaning">The thread that connects</span>
          </div>
          <nav className="mast-nav" aria-label="Primary">
            <a href="#ledger">The work</a>
            <a href="#method">How it reads</a>
            <a href="#privacy">On privacy</a>
            <span className="mast-issue" aria-hidden="true">
              No. 01 · Field Notes
            </span>
          </nav>
        </div>
      </header>

      <main className="wrap">
        {/* ---------------- HERO ---------------- */}
        <section className="hero" id="top">
          <div className="hero-copy">
            <p className="hero-foliop">An ambient notebook for everything you say</p>

            <h1 className="headline">
              A quiet thread through <em>everything you say.</em>
            </h1>

            <p className="hero-lead">
              <span className="dropcap">Y</span>ou just talk. Sutra listens in the background, then
              quietly gathers each conversation into searchable memory — the summary, the people, the
              decisions, the things you said you'd do. Later, you simply ask.
            </p>

            <p className="hero-langs">
              Reads <b>English</b>, <b>Hindi</b> &amp; <b>Hinglish</b> — the way you actually speak.
            </p>

            <p className="hero-margin-note" aria-hidden="true">
              <span className="hmn-rule" />
              <em>sūtra</em>, n. — a thread; the line on which beads are strung.
            </p>

            <div className="hero-cta">
              <Link to="/" className="btn-ink">
                {BRAND.ctaPrimary}
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
              <a href="#method" className="btn-text">
                {BRAND.ctaSecondary}
              </a>
            </div>
          </div>

          <div className="hero-art">
            <div className="canvas-frame" aria-hidden="true">
              <HeroScene reduced={reduced} small={small} />
            </div>
            <p className="art-caption">
              <b>Fig. 1</b> — a single thread, caught mid-fold. Spoken words, blooming into memory.
            </p>
          </div>
        </section>

        <hr className="hero-rule" />

        {/* ---------------- PILLARS (numbered ledger) ---------------- */}
        <section className="ledger" id="ledger">
          <div className="section-head">
            <div>
              <p className="section-kicker">What it does · in four notes</p>
              <h2 className="section-title">Talk freely. It keeps the thread for you.</h2>
            </div>
            <p className="section-aside">
              No buttons to remember, no notes to file. The work happens quietly, in the margins.
            </p>
          </div>

          <ol className="pillar-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {BRAND.pillars.map((p, i) => {
              const Icon = ICONS[p.icon] ?? Sparkles;
              return (
                <li className="pillar" key={p.title}>
                  <span className="pillar-no" aria-hidden="true">
                    {ROMAN[i]}
                  </span>
                  <div className="pillar-body">
                    <h3 className="pillar-title">
                      <Icon size={20} strokeWidth={1.6} aria-hidden="true" />
                      {p.title}
                    </h3>
                    <p className="pillar-desc">{p.desc}</p>
                  </div>
                  <span className="pillar-tag">{TAGS[i]}</span>
                </li>
              );
            })}
          </ol>
        </section>

        {/* ---------------- PULL-QUOTE ---------------- */}
        <section className="pullquote">
          <div className="pullquote-grid">
            <p className="pullquote-margin">On memory</p>
            <div>
              <blockquote className="pull">
                "The conversation ends. The <span>thread</span> doesn't. Everything worth keeping is
                already woven in — waiting for the moment you think to ask."
              </blockquote>
              <span className="pull-attr">— The premise of Sutra</span>
            </div>
          </div>
        </section>

        {/* ---------------- HOW IT WORKS ---------------- */}
        <section className="method" id="method">
          <div className="section-head">
            <div>
              <p className="section-kicker">How it reads · three movements</p>
              <h2 className="section-title">Talk, then weave, then ask.</h2>
            </div>
          </div>

          <div className="method-steps">
            <div className="step">
              <p className="step-mark">Movement I</p>
              <h3 className="step-name">You talk</h3>
              <p className="step-desc">
                Speak naturally — a meeting, a call, a passing thought. Sutra listens in the moment
                and lets the audio go. Nothing is kept but meaning.
              </p>
            </div>
            <div className="step">
              <p className="step-mark">Movement II</p>
              <h3 className="step-name">It weaves</h3>
              <p className="step-desc">
                People, topics, decisions and the things you promised are drawn together into one
                connected thread — a living graph of what was said and why.
              </p>
            </div>
            <div className="step">
              <p className="step-mark">Movement III</p>
              <h3 className="step-name">You ask</h3>
              <p className="step-desc">
                Months later, ask it anything. Get a grounded answer in plain words, with the exact
                conversations it came from cited beneath.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------- CLOSING CTA ---------------- */}
        <section className="closing" id="privacy">
          <p className="closing-mark" aria-hidden="true">
            ❦
          </p>
          <h2>
            Begin a thread you'll <em>never lose.</em>
          </h2>
          <p className="closing-sub">{BRAND.privacyLine} Memory stays encrypted, on your device.</p>
          <div className="hero-cta">
            <Link to="/" className="btn-ink">
              {BRAND.ctaPrimary}
              <ArrowRight size={17} aria-hidden="true" />
            </Link>
            <a href="#top" className="btn-text">
              Back to the top
            </a>
          </div>
        </section>
      </main>

      {/* ---------------- COLOPHON / FOOTER ---------------- */}
      <footer className="colophon">
        <div className="wrap colophon-inner">
          <div className="colophon-mark">
            <span className="colophon-word">
              Sutra<span style={{ color: "var(--amber-deep)", fontWeight: 500 }}> सूत्र</span>
            </span>
            <p className="colophon-tag">{BRAND.footerTagline}</p>
          </div>
          <p className="colophon-privacy">
            <Lock size={13} strokeWidth={2} aria-hidden="true" />
            {BRAND.privacyLine}
          </p>
        </div>
      </footer>
    </div>
  );
}
