// ============================================================================
// Sutra · landing-pro V2 — "Whitelight"  (light · Apple product page · ivory)
//
// A calm, whitespace-heavy product story told as a sequence of FULL-VIEWPORT
// "feature films" — one idea, huge type, very few words per screen — set over a
// single soft pastel AUDIO RIBBON on ivory white. The ribbon is ONE continuous
// world scrubbed by whole-page scroll; it MORPHS through the product:
//   talk      wavy voice      a loose sine ribbon, breathing
//   transcribe  straight lines   the ribbon flattens into clean parallel rows
//   distill   folded slab      the rows compress + fold into a tight summary bar
//   recall    fanned cards     the slab fans out into a spray of source cards
//   private   recede + dim     the ribbon softens and sinks for the close
//
// LIGHT-VARIANT RULES (see LandingV4): NO @react-three/postprocessing (bloom
// discards canvas alpha → white box). Opaque <color> bg + emissive materials +
// additive halo sprites + drei <Environment> with <Lightformer> children only.
//
// Only this file + ProV2.css are touched. Palette comes through `vars`.
// ============================================================================
import { Suspense, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import * as THREE from "three";
import { ArrowRight } from "lucide-react";
import { BRAND, usePrefersReducedMotion, useIsSmallScreen } from "../landing/brand";
import ScrollStage, { Reveal, useScrolledPast, type StageApi } from "./ScrollStage";
import { ProFooter } from "./primitives";
import "./ProV2.css";

const VARS: CSSProperties = {
  ["--pg-bg" as any]: "#f6f5f1",
  ["--pg-bg-2" as any]: "#efece5",
  ["--pg-ink" as any]: "#14121e",
  ["--pg-ink-2" as any]: "#4a4658",
  ["--pg-ink-3" as any]: "#8a8598",
  ["--pg-accent" as any]: "#6f5cf0",
  ["--pg-accent-2" as any]: "#8b7bff",
  ["--pg-on-accent" as any]: "#ffffff",
  ["--pg-glow" as any]: "rgba(111,92,240,0.22)",
  ["--pg-line" as any]: "rgba(20,18,30,0.10)",
  ["--pg-card" as any]: "rgba(20,18,30,0.025)",
  ["--pg-card-border" as any]: "rgba(20,18,30,0.09)",
};

// ---- math helpers ---------------------------------------------------------
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Triangular ramp: 0 at edges, 1 at `mid`. Used to spotlight a beat as it passes. */
const band = (p: number, lo: number, mid: number, hi: number) =>
  p < mid ? smooth((p - lo) / (mid - lo)) : smooth((hi - p) / (hi - mid));

// ---- soft round sprite for the additive halo ------------------------------
function useHaloTexture() {
  return useMemo(() => {
    const s = 96;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.4, "rgba(180,168,255,0.45)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
}

// ---------------------------------------------------------------------------
// The audio ribbon. A grid of ROWS, each a flat strip of points/quads, that we
// reshape every frame by scrubbing four morph "phases" off the scroll signal.
// We build the whole sheet as ONE InstancedMesh of small rounded plates (one
// per sample per row) — cheap, and reads as a soft ribbon under the studio env.
// ---------------------------------------------------------------------------
function Ribbon({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced, progressRef } = api;
  const ROWS = small ? 5 : 7;
  const COLS = small ? 34 : 54;
  const COUNT = ROWS * COLS;

  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const groupRef = useRef<THREE.Group>(null!);
  const haloRef = useRef<THREE.Sprite>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const invalidate = useThree((s) => s.invalidate);
  const haloTex = useHaloTexture();

  // pastel palette across the sheet
  const COLORS = useMemo(
    () => [new THREE.Color("#8b7bff"), new THREE.Color("#a99bff"), new THREE.Color("#ff9fd0"), new THREE.Color("#ffc873")],
    [],
  );

  // static per-instance metadata (row/col, base color, phase) — built once
  const meta = useMemo(() => {
    const row = new Int16Array(COUNT);
    const col = new Int16Array(COUNT);
    const phase = new Float32Array(COUNT);
    const u = new Float32Array(COUNT); // 0..1 across COLS
    const v = new Float32Array(COUNT); // -1..1 across ROWS (centered)
    let i = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        row[i] = r;
        col[i] = c;
        u[i] = COLS > 1 ? c / (COLS - 1) : 0;
        v[i] = ROWS > 1 ? (r / (ROWS - 1)) * 2 - 1 : 0;
        phase[i] = c * 0.45 + r * 0.9;
        i++;
      }
    }
    return { row, col, phase, u, v };
  }, [ROWS, COLS, COUNT]);

  // per-instance colours, once (warm/cool gradient along the ribbon)
  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    const tmp = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      const t = meta.u[i];
      // blend cool→warm across the length, biased violet
      if (t < 0.6) tmp.copy(COLORS[0]).lerp(COLORS[1], t / 0.6);
      else tmp.copy(COLORS[1]).lerp(COLORS[2], (t - 0.6) / 0.4);
      m.setColorAt(i, tmp);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [COUNT, meta, COLORS]);

  // ---- shape of the ribbon at scroll p, time t -------------------------------
  // p bands (aligned to the foreground films, see render order below):
  //   0.00–0.16  HERO            wavy voice
  //   0.16–0.32  "Just talk"     wavy voice (livelier)
  //   0.32–0.48  "Writes itself" straight transcript lines
  //   0.48–0.64  "Distilled"     folded summary slab
  //   0.64–0.80  "Ask later"     fanned source cards
  //   0.80–1.00  "Audio gone"    recede + dim
  const SPAN_X = small ? 7.2 : 9.4;
  const ROW_GAP = small ? 0.62 : 0.56;

  const render = (p: number, t: number) => {
    const m = meshRef.current;
    if (!m) return;

    // phase weights (smooth crossfades between the four target shapes + recede)
    const wWave = 1 - smooth((p - 0.18) / 0.16); // 1 early, 0 by transcript
    const wLines = band(p, 0.18, 0.40, 0.56); // peaks at transcript
    const wSlab = band(p, 0.40, 0.56, 0.74); // peaks at distill
    const wFan = band(p, 0.56, 0.72, 0.92); // peaks at recall
    const recede = smooth((p - 0.8) / 0.2); // 1 at the close

    const breathe = reduced ? 0 : Math.sin(t * 0.7) * 0.06;

    for (let i = 0; i < COUNT; i++) {
      const u = meta.u[i];
      const v = meta.v[i];
      const ph = meta.phase[i];
      const x0 = (u - 0.5) * SPAN_X;

      // --- WAVE: loose sine ribbon, rows stacked, gentle travelling wave ---
      const waveY =
        Math.sin(u * Math.PI * 3.0 + t * 0.9 + v * 0.6) * (0.55 + breathe) +
        Math.sin(u * Math.PI * 6.0 - t * 0.5) * 0.16;
      const wx = x0;
      const wy = waveY + v * ROW_GAP * 1.4;
      const wz = v * 0.5 + Math.cos(u * Math.PI * 2 + t * 0.4) * 0.25;

      // --- LINES: flat, clean parallel rows (transcript) ---
      const lx = x0;
      const ly = v * ROW_GAP;
      const lz = 0;

      // --- SLAB: rows compress toward center + fold (summary bar) ---
      const fold = Math.sin(u * Math.PI) * 0.5; // bow the bar
      const sx = x0 * 0.62;
      const sy = v * ROW_GAP * 0.34 + fold * 0.18;
      const sz = -Math.sin(u * Math.PI) * 0.8 + v * 0.1;

      // --- FAN: spray of cards — each row becomes a card splayed at an angle ---
      const fanAng = v * 0.5; // row → rotation around y
      const spread = 2.6;
      const fx = Math.sin(fanAng) * spread + (u - 0.5) * 3.0 * Math.cos(fanAng);
      const fy = v * 0.5 + Math.sin(u * Math.PI) * 0.18;
      const fz = Math.cos(fanAng) * spread - (u - 0.5) * 3.0 * Math.sin(fanAng) - 1.2;

      // weighted blend of the four targets (weights are crossfaded, near-normalized)
      const wSum = wWave + wLines + wSlab + wFan + 1e-4;
      let x = (wx * wWave + lx * wLines + sx * wSlab + fx * wFan) / wSum;
      let y = (wy * wWave + ly * wLines + sy * wSlab + fy * wFan) / wSum;
      let z = (wz * wWave + lz * wLines + sz * wSlab + fz * wFan) / wSum;

      // recede: sink + drift apart + shrink for the calm close
      y -= recede * (1.6 + v * 0.4);
      z -= recede * 1.2;

      // plate scale: a touch bigger on the active beat; small as cards
      const base = small ? 0.085 : 0.072;
      const scl =
        base *
        (1 - recede * 0.4) *
        (1 + wFan * 0.5 + wSlab * 0.15) *
        (reduced ? 1 : 1 + Math.sin(t * 1.6 + ph) * 0.06 * wWave);

      dummy.position.set(x, y, z);
      // gently orient plates along the local flow so the ribbon reads as a sheet
      dummy.rotation.set(
        wWave * Math.cos(u * Math.PI * 3 + t * 0.9) * 0.5,
        wFan * (v * 0.5) + recede * 0.4,
        wWave * 0.15 + wFan * 0.2,
      );
      dummy.scale.set(scl * (1 + wFan * 1.1), scl * (1 + wFan * 1.6), scl);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
    (m.material as THREE.MeshStandardMaterial).opacity = 1 - recede * 0.55;

    // whole-ribbon drift + the close tilt
    if (groupRef.current) {
      groupRef.current.rotation.y = (reduced ? -0.12 : Math.sin(t * 0.08) * 0.06) - p * 0.18;
      groupRef.current.rotation.x = -0.05 + Math.sin(p * Math.PI) * 0.06 + recede * 0.12;
      groupRef.current.position.y = recede * 0.6;
    }
    // additive halo behind the ribbon — brightest mid-journey, fades at close
    if (haloRef.current) {
      const hi = (0.35 + 0.65 * smooth(p / 0.5)) * (1 - recede * 0.8);
      (haloRef.current.material as THREE.SpriteMaterial).opacity = 0.5 * hi;
      haloRef.current.scale.setScalar(lerp(small ? 7 : 10, small ? 9 : 13, smooth(p)));
    }
  };

  // camera rig — eases from a 3/4 establishing shot toward a flatter "product"
  // framing through the spec section, then pulls back for the close.
  const { camera } = useThree();
  const lookTarget = useMemo(() => new THREE.Vector3(), []);
  const moveCamera = (p: number) => {
    const recede = smooth((p - 0.8) / 0.2);
    const cz = lerp(8.4, 6.6, smooth(p / 0.6));
    camera.position.set(
      Math.sin(p * Math.PI * 0.6) * 0.7,
      lerp(0.9, 0.2, smooth(p / 0.6)) + recede * 1.8,
      lerp(cz, 9.5, recede),
    );
    lookTarget.set(0, recede * 1.2, 0);
    camera.lookAt(lookTarget);
  };

  useFrame((state) => {
    if (reduced) return;
    render(progressRef.current, state.clock.elapsedTime);
    moveCamera(progressRef.current);
  });

  // reduced motion: paint one representative "transcript lines" frame across 2 rAFs
  useEffect(() => {
    if (!reduced) return;
    let r1 = 0,
      r2 = 0;
    const paint = () => {
      render(0.26, 0);
      moveCamera(0.26);
      invalidate();
    };
    paint();
    r1 = requestAnimationFrame(() => {
      paint();
      r2 = requestAnimationFrame(paint);
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  return (
    <group ref={groupRef}>
      <sprite ref={haloRef} position={[0, 0, -3]} scale={10}>
        <spriteMaterial
          map={haloTex}
          transparent
          opacity={0.4}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </sprite>

      <instancedMesh ref={meshRef} args={[undefined as any, undefined as any, COUNT]}>
        {/* small rounded plate — reads as a soft ribbon sample */}
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial
          transparent
          opacity={1}
          roughness={0.32}
          metalness={0.12}
          emissive={"#6f5cf0"}
          emissiveIntensity={0.32}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </instancedMesh>
    </group>
  );
}

// Manual + Lightformer lighting (NO remote env preset, NO postprocessing).
// Soft studio rectangles sculpt the pastel ribbon on the ivory ground.
function Lights() {
  return (
    <>
      <ambientLight intensity={0.95} />
      <directionalLight position={[3, 5, 4]} intensity={1.0} color={"#fff7ff"} />
      <pointLight position={[-5, -1, 4]} intensity={20} color={"#ffd9a8"} />
      <pointLight position={[5, 2, -2]} intensity={16} color={"#8b7bff"} />
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={2.0} color={"#e7e1ff"} position={[0, 3, 3]} scale={[10, 4, 1]} />
        <Lightformer form="rect" intensity={1.4} color={"#ffe6c9"} position={[-5, -2, 2]} scale={[6, 5, 1]} />
        <Lightformer form="ring" intensity={1.2} color={"#ffc6e6"} position={[5, -1, 3]} scale={[3, 3, 1]} />
      </Environment>
    </>
  );
}

function Scene({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced } = api;
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.9, 8.4], fov: 44 }}
      frameloop={reduced ? "never" : "always"}
    >
      {/* opaque ivory ground — LIGHT variant must NOT use alpha+bloom */}
      <color attach="background" args={["#f6f5f1"]} />
      <fog attach="fog" args={["#f6f5f1", 10, 24]} />
      <Lights />
      <Suspense fallback={null}>
        <Ribbon api={api} small={small} />
      </Suspense>
    </Canvas>
  );
}

// ---------------------------------------------------------------------------
// Foreground: a sequence of full-viewport "feature films". One idea per screen.
// ---------------------------------------------------------------------------

/** A bespoke inline nav — anchors map to this variant's own film sections. */
function WhiteNav({ rootRef }: { rootRef: StageApi["rootRef"] }) {
  const scrolled = useScrolledPast(rootRef, 48);
  return (
    <nav className={`pg-nav ${scrolled ? "is-scrolled" : ""}`} aria-label="Primary">
      <a href="#top" className="pg-brand" aria-label="Sutra home">
        <span className="pg-brand-dot" aria-hidden="true" />
        <span className="pg-brand-name">{BRAND.name}</span>
        <span className="pg-brand-sa" aria-hidden="true">सूत्र</span>
      </a>
      <div className="pg-nav-links">
        <a href="#how" className="pg-nav-link">How</a>
        <a href="#features" className="pg-nav-link">What you get</a>
        <a href="#privacy" className="pg-nav-link">Privacy</a>
        <a href="#start" className="pg-nav-cta">
          {BRAND.ctaPrimary}
          <ArrowRight size={15} aria-hidden="true" />
        </a>
      </div>
    </nav>
  );
}

/** A single full-screen film beat. `align` shifts the lockup; `id` anchors nav. */
function Film({
  id,
  index,
  eyebrow,
  title,
  line,
  align = "center",
}: {
  id?: string;
  index?: string;
  eyebrow?: string;
  title: ReactNode;
  line: string;
  align?: "center" | "left";
}) {
  return (
    <section className={`pv2-film pv2-film--${align}`} id={id}>
      <div className="pg-wrap pv2-film-inner">
        {index && (
          <Reveal className="pv2-index" delay={0}>
            {index}
          </Reveal>
        )}
        {eyebrow && (
          <Reveal className="pg-eyebrow pv2-eyebrow" delay={0.04}>
            {eyebrow}
          </Reveal>
        )}
        <Reveal as="h2" className="pv2-film-title" delay={0.08}>
          {title}
        </Reveal>
        <Reveal as="p" className="pv2-film-line" delay={0.16}>
          {line}
        </Reveal>
      </div>
    </section>
  );
}

// The Apple-style restrained spec list.
const SPECS: { k: string; v: ReactNode }[] = [
  { k: "Languages", v: <>English · Hindi · Hinglish</> },
  { k: "Storage", v: <>On-device, encrypted</> },
  { k: "Audio", v: <>Never stored</> },
  { k: "Offline", v: <>Search, browse, recall</> },
  { k: "Speakers", v: <>Recognised by voice</> },
];

export default function ProV2() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();

  return (
    <ScrollStage
      theme="light"
      className="pv2"
      vars={VARS}
      reduced={reduced}
      scene={(api) => <Scene api={api} small={small} />}
    >
      {(api) => (
        <>
          <WhiteNav rootRef={api.rootRef} />

          {/* 1 · HERO -------------------------------------------------------- */}
          <section className="pv2-film pv2-hero" id="top">
            <div className="pg-wrap pv2-film-inner">
              <Reveal className="pg-eyebrow pv2-eyebrow" delay={0}>
                {BRAND.meaning}
              </Reveal>
              <Reveal as="h1" className="pv2-hero-title" delay={0.08}>
                Sutra
              </Reveal>
              <Reveal as="p" className="pv2-hero-line" delay={0.16}>
                Talk. It remembers the rest.
              </Reveal>
              <Reveal className="pg-cta-row pg-cta-center pv2-hero-cta" delay={0.24}>
                <a href="#start" className="pg-btn pg-btn-primary">
                  {BRAND.ctaPrimary} <ArrowRight size={18} />
                </a>
                <a href="#how" className="pg-btn pg-btn-ghost">{BRAND.ctaSecondary}</a>
              </Reveal>
            </div>
            <div className="pg-scroll-hint" aria-hidden="true"><i />Scroll</div>
          </section>

          {/* 2 · JUST TALK --------------------------------------------------- */}
          <Film
            id="how"
            index="01"
            eyebrow="Capture"
            title={<>Just talk.</>}
            line="Leave it running and speak naturally — English, Hindi, or both."
          />

          {/* 3 · WRITES ITSELF DOWN ----------------------------------------- */}
          <Film
            index="02"
            eyebrow="Transcribe"
            title={<>It writes itself down.</>}
            line="Every word, every speaker, sorted out for you."
            align="left"
          />

          {/* 4 · THE POINT, DISTILLED --------------------------------------- */}
          <Film
            id="features"
            index="03"
            eyebrow="Distil"
            title={
              <>
                The point,
                <br />
                <span className="pg-grad">distilled.</span>
              </>
            }
            line="Summaries, decisions and action items, pulled out automatically."
          />

          {/* 5 · ASK, MONTHS LATER ------------------------------------------ */}
          <Film
            index="04"
            eyebrow="Recall"
            title={<>Ask, months later.</>}
            line="A grounded answer from your own words — with the sources."
            align="left"
          />

          {/* 6 · YOUR AUDIO? GONE ------------------------------------------- */}
          <Film
            id="privacy"
            index="05"
            eyebrow="Private by design"
            title={<>Your audio? Gone.</>}
            line="Processed in the moment, never stored. Memory stays encrypted on your device."
          />

          {/* 7 · TECH-SPEC STRIP -------------------------------------------- */}
          <section className="pv2-spec" aria-label="Specifications">
            <div className="pg-wrap pv2-spec-inner">
              <Reveal className="pg-eyebrow pv2-eyebrow" delay={0}>
                The essentials
              </Reveal>
              <Reveal as="h2" className="pv2-spec-title" delay={0.05}>
                Everything it does. Nothing it keeps.
              </Reveal>
              <dl className="pv2-spec-list">
                {SPECS.map((s, i) => (
                  <Reveal as="div" className="pv2-spec-row" delay={0.04 + i * 0.04} key={s.k}>
                    <dt className="pv2-spec-k">{s.k}</dt>
                    <dd className="pv2-spec-v">{s.v}</dd>
                  </Reveal>
                ))}
              </dl>
            </div>
          </section>

          {/* 8 · CTA -------------------------------------------------------- */}
          <section className="pv2-close">
            <div className="pg-wrap pv2-film-inner">
              <Reveal as="h2" className="pv2-close-title" delay={0}>
                Stop trying to remember.
                <br />
                <span className="pg-grad">Just start talking.</span>
              </Reveal>
              <Reveal className="pg-cta-row pg-cta-center pv2-hero-cta" delay={0.08}>
                <a href="#start" className="pg-btn pg-btn-primary">
                  {BRAND.ctaPrimary} <ArrowRight size={18} />
                </a>
              </Reveal>
            </div>
          </section>

          <ProFooter to="/pro/2" />
        </>
      )}
    </ScrollStage>
  );
}
