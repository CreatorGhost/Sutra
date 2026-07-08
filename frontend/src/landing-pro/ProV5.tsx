// ============================================================================
// Sutra · landing-pro V5 — "Dawn"  (dark → light · indigo night → warm gold)
//
// A CHAPTERED POEM, not a feature page. One continuous 3D world — the camera
// TRAVELS along a long winding सूत्र thread — scrubbed by whole-page scroll, and
// the sky lerps night → dawn as you descend the page. The BODY is three acts:
//
//   HERO   (night)         the thread glows away into fog, stars overhead
//   I · The dark (night)   the problem, spoken as verse — memory slips away
//   II · The thread (dawn  what Sutra does, knots passing as the camera glides
//        breaking)         forward; the sun begins to lift over the horizon
//   III · The light (full  what you get back — your own words, traced, encrypted
//        dawn)
//   FINALE (sunrise)       the thread ahead WEAVES into a woven cluster; CTA
//
// The CANVAS background + fog lerp night→dawn by progress; EffectComposer+Bloom
// gives the thread its glow (background stays opaque). DOM text is light, so the
// bright dawn end gets dark CSS scrims (ProV5.css) to hold contrast.
//
// Only this file + ProV5.css are touched. Palette comes through `vars`.
// ============================================================================
import { Suspense, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import {
  ArrowRight,
  Lock,
  MicOff,
  Quote,
  Sunrise,
} from "lucide-react";
import { BRAND, usePrefersReducedMotion, useIsSmallScreen } from "../landing/brand";
import ScrollStage, { Reveal, type StageApi } from "./ScrollStage";
import { ProNav, ProFooter } from "./primitives";
import "./ProV5.css";

const VARS: CSSProperties = {
  ["--pg-bg" as any]: "#0a0820",
  ["--pg-bg-2" as any]: "#0e0b26",
  ["--pg-ink" as any]: "#f6efe6",
  ["--pg-ink-2" as any]: "#c9c2d8",
  ["--pg-ink-3" as any]: "#8b84a3",
  ["--pg-accent" as any]: "#ffc36e",
  ["--pg-accent-2" as any]: "#ffd9a0",
  ["--pg-on-accent" as any]: "#1a1330",
  ["--pg-glow" as any]: "rgba(255,195,110,0.42)",
  ["--pg-line" as any]: "rgba(255,240,220,0.10)",
  ["--pg-card" as any]: "rgba(255,245,230,0.05)",
  ["--pg-card-border" as any]: "rgba(255,240,220,0.12)",
};

// ---- math helpers ---------------------------------------------------------
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// night → dawn key colours (mid-tone dawn, never white, so light text reads)
const NIGHT = "#0a0820";
const DAWN = "#e8a06a";

// ---- the meandering thread (a CatmullRom curve the camera flies along) -----
// Gently winding, generally heading into -z so the rising sun stays ahead.
const CURVE_POINTS = [
  new THREE.Vector3(0.0, 0.0, 6.0),
  new THREE.Vector3(-1.7, 0.5, 3.0),
  new THREE.Vector3(1.4, -0.4, 0.0),
  new THREE.Vector3(-1.3, 0.6, -3.2),
  new THREE.Vector3(1.8, -0.2, -6.6),
  new THREE.Vector3(-1.0, 0.8, -10.0),
  new THREE.Vector3(1.2, -0.3, -13.6),
  new THREE.Vector3(-0.8, 0.55, -17.2),
  new THREE.Vector3(0.6, 0.2, -20.6),
  new THREE.Vector3(0.0, 0.45, -24.0),
];

// ---- soft additive sprites ------------------------------------------------
function useSunTexture() {
  return useMemo(() => {
    const s = 128;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.0, "rgba(255,244,224,1)");
    g.addColorStop(0.18, "rgba(255,216,150,0.92)");
    g.addColorStop(0.45, "rgba(255,168,96,0.42)");
    g.addColorStop(0.75, "rgba(255,140,80,0.12)");
    g.addColorStop(1.0, "rgba(255,140,80,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
}

function useStarTexture() {
  return useMemo(() => {
    const s = 64;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(225,224,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
}

// build per-vertex arc position (0..1) for a TubeGeometry's vertex ordering
function tubeVertU(tubular: number, radial: number) {
  const n = (tubular + 1) * (radial + 1);
  const u = new Float32Array(n);
  for (let i = 0; i <= tubular; i++) {
    const uu = i / tubular;
    for (let j = 0; j <= radial; j++) u[i * (radial + 1) + j] = uu;
  }
  return u;
}

// ---- the journey ----------------------------------------------------------
function Journey({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced, progressRef } = api;
  const TUBULAR = small ? 200 : 380;
  const RADIAL = small ? 6 : 8;
  const KNOTS = small ? 7 : 9;
  const STARS = small ? 450 : 1200;
  const STRANDS = small ? 3 : 4;

  const curve = useMemo(() => new THREE.CatmullRomCurve3(CURVE_POINTS, false, "catmullrom", 0.5), []);

  const tubeRef = useRef<THREE.Mesh>(null!);
  const knotsRef = useRef<THREE.InstancedMesh>(null!);
  const skyRef = useRef<THREE.Group>(null!);
  const sunRef = useRef<THREE.Sprite>(null!);
  const starsRef = useRef<THREE.Points>(null!);
  const finaleRef = useRef<THREE.Group>(null!);

  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const sunTex = useSunTexture();
  const starTex = useStarTexture();

  // reusable temps (no per-frame allocation)
  const T = useMemo(
    () => ({
      pt: new THREE.Vector3(),
      ahead: new THREE.Vector3(),
      tan: new THREE.Vector3(),
      fwd: new THREE.Vector3(),
      cam: new THREE.Vector3(),
      look: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      gold: new THREE.Color("#ffb24a"),
      hot: new THREE.Color("#fff2d8"),
      tmpCol: new THREE.Color(),
      night: new THREE.Color(NIGHT),
      dawn: new THREE.Color(DAWN),
      dummy: new THREE.Object3D(),
    }),
    [],
  );

  // ---- the thread tube + a per-vertex colour buffer (white-hot near camera) -
  const tube = useMemo(() => {
    const geo = new THREE.TubeGeometry(curve, TUBULAR, 0.055, RADIAL, false);
    const uVert = tubeVertU(TUBULAR, RADIAL);
    const colArr = new Float32Array(uVert.length * 3);
    const colorAttr = new THREE.BufferAttribute(colArr, 3);
    geo.setAttribute("color", colorAttr);
    return { geo, uVert, colArr, colorAttr };
  }, [curve, TUBULAR, RADIAL]);

  // ---- knots strung along the thread (memories) -----------------------------
  const knots = useMemo(() => {
    const us: number[] = [];
    const pos: THREE.Vector3[] = [];
    for (let i = 0; i < KNOTS; i++) {
      const u = 0.06 + (i / (KNOTS - 1)) * 0.86;
      us.push(u);
      pos.push(curve.getPointAt(u, new THREE.Vector3()));
    }
    return { us, pos };
  }, [curve, KNOTS]);

  // ---- stars surrounding the camera (fade out as dawn breaks) ---------------
  const starGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(STARS * 3);
    for (let i = 0; i < STARS; i++) {
      const r = 30 + ((i * 37) % 100) / 100 * 10;
      const a = (i * 2.39963) % (Math.PI * 2);
      const b = (((i * 53) % 100) / 100) * Math.PI - Math.PI / 2;
      p[i * 3] = Math.cos(a) * Math.cos(b) * r;
      p[i * 3 + 1] = Math.sin(b) * r * 0.85 + 4;
      p[i * 3 + 2] = Math.sin(a) * Math.cos(b) * r;
    }
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    return g;
  }, [STARS]);

  // ---- finale: short strands converging into a woven cluster at the end -----
  const finaleMat = useMemo(() => {
    const m = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    return m;
  }, []);

  const strands = useMemo(() => {
    const end = curve.getPointAt(1, new THREE.Vector3());
    const geos: THREE.TubeGeometry[] = [];
    for (let i = 0; i < STRANDS; i++) {
      const a = (i / STRANDS) * Math.PI * 2;
      const rx = Math.cos(a) * 1.35;
      const ry = Math.sin(a) * 1.0;
      const sc = new THREE.CatmullRomCurve3([
        new THREE.Vector3(end.x + rx, end.y + ry, end.z + 2.6),
        new THREE.Vector3(end.x + rx * 0.5, end.y + ry * 0.45 + 0.15, end.z + 1.1),
        new THREE.Vector3(end.x + rx * 0.12, end.y + ry * 0.1, end.z + 0.25),
        new THREE.Vector3(end.x, end.y, end.z),
      ]);
      const seg = small ? 22 : 36;
      const rad = 5;
      const g = new THREE.TubeGeometry(sc, seg, 0.04, rad, false);
      const uVert = tubeVertU(seg, rad);
      const col = new Float32Array(uVert.length * 3);
      const gold = new THREE.Color("#ffb24a");
      const hot = new THREE.Color("#fff4e0");
      const c = new THREE.Color();
      for (let v = 0; v < uVert.length; v++) {
        c.copy(gold).lerp(hot, Math.pow(uVert[v], 1.6)); // brightest at convergence
        col[v * 3] = c.r;
        col[v * 3 + 1] = c.g;
        col[v * 3 + 2] = c.b;
      }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geos.push(g);
    }
    return geos;
  }, [curve, STRANDS, small]);

  // seed knot instance colours once (allocates instanceColor)
  useEffect(() => {
    const m = knotsRef.current;
    if (!m) return;
    for (let i = 0; i < KNOTS; i++) m.setColorAt(i, T.gold);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [KNOTS, T]);

  // ---- render one frame at a given progress --------------------------------
  // Phase map, retuned for the THREE-ACT layout:
  //   0.00–0.16  hero + Act I "The dark"     → night holds, stars bright
  //   0.16–0.58  Act II "The thread"         → dawn breaks, sun lifts, knots pass
  //   0.58–0.82  Act III "The light"         → full dawn
  //   0.82–1.00  finale at sunrise           → woven cluster fades in, CTA
  const applyFrame = (p: number, t: number) => {
    const dawn = smooth((p - 0.14) / 0.62); // 0 = night .. 1 = full dawn (holds longer in the dark)
    const camU = clamp01(p * 0.92);

    // sky colour: background + fog lerp night → dawn
    if (scene.background instanceof THREE.Color) {
      scene.background.copy(T.night).lerp(T.dawn, dawn);
    }
    if (scene.fog) {
      (scene.fog as THREE.Fog).color.copy(T.night).lerp(T.dawn, dawn);
    }

    // camera travels ALONG the thread, looking slightly ahead + up
    curve.getPointAt(camU, T.pt);
    curve.getTangentAt(camU, T.tan);
    curve.getPointAt(Math.min(camU + 0.045, 1), T.ahead);
    T.cam.copy(T.pt).addScaledVector(T.up, 0.62).addScaledVector(T.tan, -0.35);
    if (!reduced) T.cam.x += Math.sin(t * 0.18) * 0.06; // gentle, smooth sway
    camera.position.copy(T.cam);
    T.look.copy(T.ahead).addScaledVector(T.up, 0.18);
    camera.lookAt(T.look);
    T.fwd.copy(T.look).sub(T.cam).normalize();

    // sky group rides with the camera (position only — no rotation)
    if (skyRef.current) skyRef.current.position.copy(camera.position);

    // sun: low + dim through the dark, RISES + brightens across Act II→III
    if (sunRef.current) {
      const rise = smooth((p - 0.18) / 0.62);
      sunRef.current.position
        .copy(T.fwd)
        .multiplyScalar(23)
        .addScaledVector(T.up, lerp(-7.5, 3.4, rise));
      const sc = lerp(9, 21, rise);
      sunRef.current.scale.set(sc, sc, 1);
      (sunRef.current.material as THREE.SpriteMaterial).opacity = lerp(0.1, 0.96, rise);
    }

    // stars hold through the dark, then fade as the night lifts
    if (starsRef.current) {
      (starsRef.current.material as THREE.PointsMaterial).opacity =
        0.9 * (1 - smooth((p - 0.1) / 0.4));
      starsRef.current.rotation.y = reduced ? 0 : t * 0.005;
    }

    // thread glow: white-hot near the camera, warm gold along its length
    {
      const { uVert, colArr, colorAttr } = tube;
      for (let v = 0; v < uVert.length; v++) {
        const g = 1 - smooth(Math.abs(uVert[v] - camU) / 0.13); // proximity to camera
        T.tmpCol.copy(T.gold).lerp(T.hot, g);
        const k = 1 + dawn * 0.12; // whole thread warms a touch at dawn
        colArr[v * 3] = T.tmpCol.r * k;
        colArr[v * 3 + 1] = T.tmpCol.g * k;
        colArr[v * 3 + 2] = T.tmpCol.b * k;
      }
      colorAttr.needsUpdate = true;
    }

    // knots brighten + swell as the camera passes them
    {
      const m = knotsRef.current;
      if (m) {
        for (let i = 0; i < KNOTS; i++) {
          const near = 1 - smooth(Math.abs(knots.us[i] - camU) / 0.07);
          const pulse = reduced ? 0 : Math.sin(t * 1.6 + i * 1.3) * 0.06;
          const s = 0.085 * (1 + near * 1.5) + pulse * (0.4 + near);
          T.dummy.position.copy(knots.pos[i]);
          T.dummy.scale.setScalar(Math.max(0.04, s));
          T.dummy.updateMatrix();
          m.setMatrixAt(i, T.dummy.matrix);
          T.tmpCol.copy(T.gold).lerp(T.hot, near);
          m.setColorAt(i, T.tmpCol);
        }
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }

    // finale weave fades in only at the very end, settled so it won't fight the CTA
    if (finaleRef.current) {
      const f = smooth((p - 0.82) / 0.18);
      finaleRef.current.visible = f > 0.001;
      finaleMat.opacity = f * 0.85;
    }
  };

  useFrame((state) => {
    if (reduced) return;
    applyFrame(progressRef.current, state.clock.elapsedTime);
  });

  // reduced motion: paint one representative mid-journey frame, then stop
  useEffect(() => {
    if (!reduced) return;
    let r1 = 0, r2 = 0;
    const paint = () => { applyFrame(0.5, 0); invalidate(); };
    paint();
    r1 = requestAnimationFrame(() => { paint(); r2 = requestAnimationFrame(paint); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  return (
    <>
      {/* sky rides with the camera */}
      <group ref={skyRef}>
        <points ref={starsRef} geometry={starGeo}>
          <pointsMaterial
            map={starTex}
            size={small ? 0.3 : 0.26}
            transparent
            opacity={0.9}
            depthWrite={false}
            fog={false}
            blending={THREE.AdditiveBlending}
            sizeAttenuation
            toneMapped={false}
          />
        </points>
        <sprite ref={sunRef}>
          <spriteMaterial
            map={sunTex}
            transparent
            opacity={0.1}
            depthWrite={false}
            depthTest={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </sprite>
      </group>

      {/* the सूत्र thread */}
      <mesh ref={tubeRef} geometry={tube.geo}>
        <meshBasicMaterial vertexColors transparent opacity={0.96} toneMapped={false} />
      </mesh>

      {/* knots — moments strung on the thread */}
      <instancedMesh ref={knotsRef} args={[undefined as any, undefined as any, KNOTS]}>
        <sphereGeometry args={[1, 18, 18]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      {/* the woven cluster at journey's end */}
      <group ref={finaleRef} visible={false}>
        {strands.map((g, i) => (
          <mesh key={i} geometry={g} material={finaleMat} />
        ))}
      </group>
    </>
  );
}

function Scene({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced } = api;
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.62, 6], fov: 60 }}
      frameloop={reduced ? "never" : "always"}
    >
      <color attach="background" args={[NIGHT]} />
      <fog attach="fog" args={[NIGHT, 8, 42]} />
      <Suspense fallback={null}>
        <Journey api={api} small={small} />
      </Suspense>
      {!reduced && (
        <EffectComposer>
          <Bloom intensity={0.95} luminanceThreshold={0.2} luminanceSmoothing={0.65} mipmapBlur radius={0.75} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

// ---- the verse of Act II "The thread" — what Sutra does, line by line -------
// Each line is a beat in the weaving; they reveal in sequence as you scroll.
const WEAVE_LINES = [
  { lead: "It listens", rest: "while you talk — English, Hindi, or the Hinglish in between." },
  { lead: "It lets the audio go", rest: "the moment the meaning is caught. Nothing is kept to be heard again." },
  { lead: "It knows who spoke", rest: "by the sound of a voice. Name someone once; they are known ever after." },
  { lead: "It keeps what mattered", rest: "the summary, the facts, the decision, the promise, the thing that comes next." },
  { lead: "It ties the moments together", rest: "knot by knot, into one thread you can follow back through every day." },
];

export default function ProV5() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();
  return (
    <ScrollStage
      theme="dark"
      className="pv5"
      vars={VARS}
      reduced={reduced}
      scene={(api) => <Scene api={api} small={small} />}
    >
      {(api) => (
        <>
          <ProNav rootRef={api.rootRef} to="/pro/5" />

          {/* ── HERO · night ─────────────────────────────────────────────── */}
          <section className="pg-beat pv5-hero">
            <div className="pg-wrap pv5-hero-wrap">
              <Reveal className="pg-eyebrow pv5-eyebrow" delay={0}>
                <span className="pv5-dot" /> Ambient memory · सूत्र
              </Reveal>
              <Reveal as="h1" className="pg-hero-title pv5-title" delay={0.08}>
                Your conversations,
                <br />
                <span className="pg-grad pv5-serif">remembered.</span>
              </Reveal>
              <Reveal as="p" className="pv5-poetic" delay={0.16}>
                From the dark of forgetting to the light of remembering —
                <br className="pv5-br" /> follow the thread.
              </Reveal>
              <Reveal className="pg-cta-row pv5-hero-cta" delay={0.26}>
                <a href="#start" className="pg-btn pg-btn-primary">
                  {BRAND.ctaPrimary} <ArrowRight size={18} />
                </a>
                <a href="#how" className="pg-btn pg-btn-ghost">{BRAND.ctaSecondary}</a>
              </Reveal>
            </div>
            <div className="pg-scroll-hint" aria-hidden="true"><i />Follow the thread</div>
          </section>

          {/* ── ACT I · The dark · night ─────────────────────────────────── */}
          {/* maps to nav #how — the first chapter you arrive at */}
          <section className="pg-section pv5-act pv5-act-dark" id="how">
            <div className="pg-wrap pg-wrap-narrow">
              <Reveal className="pv5-chapter">
                <span className="pv5-chapter-num pv5-serif">I</span>
                <span className="pv5-chapter-rule" aria-hidden="true" />
                <span className="pv5-chapter-name">The dark</span>
              </Reveal>
              <Reveal as="p" className="pv5-verse" delay={0.08}>
                Every day the things that matter most are spoken —
                <br /> and then they're <span className="pv5-serif">gone</span>.
              </Reveal>
              <Reveal as="p" className="pv5-verse-sub" delay={0.16}>
                The decision in the meeting. The promise over chai. The number, the name,
                the date you were so sure you'd hold onto. Your real life happens in
                conversation — and memory lets it slip, quietly, into the dark.
              </Reveal>
            </div>
          </section>

          {/* ── ACT II · The thread · dawn breaking ──────────────────────── */}
          {/* maps to nav #features — the heart of what Sutra does */}
          <section className="pg-section pv5-act pv5-act-thread pv5-scrim-soft" id="features">
            <div className="pg-wrap pg-wrap-narrow">
              <Reveal className="pv5-chapter">
                <span className="pv5-chapter-num pv5-serif">II</span>
                <span className="pv5-chapter-rule" aria-hidden="true" />
                <span className="pv5-chapter-name">The thread</span>
              </Reveal>
              <Reveal as="h2" className="pg-h2 pv5-act-lead" delay={0.06}>
                Sutra catches the thread, and <span className="pv5-serif">weaves it whole.</span>
              </Reveal>
              <Reveal as="p" className="pv5-verse-sub pv5-act-intro" delay={0.12}>
                It listens while you talk, then knots every conversation into memory —
                who spoke, what was decided, what comes next — so none of it is lost.
              </Reveal>

              <ol className="pv5-weave">
                {WEAVE_LINES.map((l, i) => (
                  <Reveal as="li" className="pv5-weave-line" key={i} delay={0.04 * i}>
                    <span className="pv5-weave-knot" aria-hidden="true" />
                    <p className="pv5-weave-text">
                      <span className="pv5-weave-lead">{l.lead}</span> {l.rest}
                    </p>
                  </Reveal>
                ))}
              </ol>
            </div>
          </section>

          {/* ── ACT III · The light · full dawn ──────────────────────────── */}
          {/* maps to nav #privacy — the promise + what you get back */}
          <section className="pg-section pv5-act pv5-act-light pv5-scrim" id="privacy">
            <div className="pg-wrap pg-wrap-narrow">
              <Reveal className="pv5-chapter pv5-chapter-center">
                <span className="pv5-chapter-num pv5-serif">III</span>
                <span className="pv5-chapter-rule" aria-hidden="true" />
                <span className="pv5-chapter-name">The light</span>
              </Reveal>
              <Reveal as="h2" className="pg-h2 pv5-light-head" delay={0.06}>
                Months later, <span className="pv5-serif">just ask.</span>
              </Reveal>
              <Reveal as="p" className="pv5-verse-sub pv5-light-sub" delay={0.12}>
                Your own words answer back — every fact traced to where it was said,
                and an honest <span className="pv5-em">"I don't have a record of that"</span> when
                there's nothing to find.
              </Reveal>

              <div className="pv5-vows">
                <Reveal as="div" className="pv5-vow" delay={0.08}>
                  <span className="pv5-vow-icon"><Lock size={18} strokeWidth={1.7} /></span>
                  <p className="pv5-vow-text">
                    It lives <span className="pv5-em">encrypted on your phone</span> — the key held
                    in hardware-backed storage. Yours, and only yours.
                  </p>
                </Reveal>
                <Reveal as="div" className="pv5-vow" delay={0.14}>
                  <span className="pv5-vow-icon"><MicOff size={18} strokeWidth={1.7} /></span>
                  <p className="pv5-vow-text">
                    Your <span className="pv5-em">voice is never kept</span>. Audio is heard in the
                    moment, then released. Export your memory, or wipe it, whenever you wish.
                  </p>
                </Reveal>
              </div>
            </div>
          </section>

          {/* ── FINALE · sunrise · CTA ───────────────────────────────────── */}
          <section className="pg-section pv5-finale pv5-scrim">
            <div className="pg-wrap pg-wrap-narrow pv5-finale-wrap">
              <Reveal as="blockquote" className="pv5-finale-quote" delay={0}>
                <Quote className="pv5-quote-mark" size={26} aria-hidden="true" />
                <span className="pv5-serif">
                  The thread that connects.
                </span>
                <cite className="pv5-finale-cite">सूत्र — Sutra</cite>
              </Reveal>
              <Reveal as="h2" className="pg-h2 pv5-finale-head" delay={0.08}>
                <span className="pg-grad pv5-serif">Follow the thread.</span>
              </Reveal>
              <Reveal className="pg-cta-row pg-cta-center pv5-finale-cta" delay={0.14}>
                <a href="#start" className="pg-btn pg-btn-primary">
                  {BRAND.ctaPrimary} <ArrowRight size={18} />
                </a>
              </Reveal>
              <Reveal className="pv5-finale-trust" delay={0.2}>
                <Sunrise size={15} aria-hidden="true" /> Audio never stored · Encrypted on your device · English · Hindi · Hinglish
              </Reveal>
            </div>
          </section>

          <ProFooter to="/pro/5" />
        </>
      )}
    </ScrollStage>
  );
}
