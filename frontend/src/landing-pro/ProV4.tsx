// ============================================================================
// Sutra · landing-pro V4 — "Liquid"  (light · airy · peach/cream)
//
// One continuous warm 3D world, scrubbed by whole-page scroll:
//   hero      a single living FLUID BLOB breathes at center (peach→coral→lilac)
//   split     it SPLITS into several smaller orbs (conversations) drifting out
//   arrange   the orbs settle into a tidy horizontal ARC — your week of talks
//   reunite   they ease back together into one calm blob for the close
//
// EDITORIAL variant: this is a warm, second-person essay — not a feature deck.
// The body is bespoke prose, not the shared Talk/Weave/Ask trio or icon cards:
//   hero        "Talk freely. Sutra remembers."
//   scenario    a flowing essay of the small moments memory drops
//   stays       features rewritten as warm pull-quote sentences, soft dividers
//   privacy     two human sentences (not a spec block)
//   close       a warm invitation + footer
//
// LIGHT variant: NO postprocessing (Bloom discards canvas alpha → opaque box on
// light bg). Glow comes from emissive MeshDistortMaterial + additive halo shells
// + a Lightformer-only <Environment> (no network preset). Opaque cream bg.
//
// Only this file + ProV4.css are touched. Palette comes through `vars`.
// ============================================================================
import { Suspense, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { MeshDistortMaterial, Environment, Lightformer, ContactShadows } from "@react-three/drei";
import * as THREE from "three";
import { ArrowRight } from "lucide-react";
import { BRAND, usePrefersReducedMotion, useIsSmallScreen } from "../landing/brand";
import ScrollStage, { Reveal, type StageApi } from "./ScrollStage";
import { ProNav, ProFooter } from "./primitives";
import "./ProV4.css";

const VARS: CSSProperties = {
  ["--pg-bg" as any]: "#fbf6f0",
  ["--pg-bg-2" as any]: "#f4ebe0",
  ["--pg-ink" as any]: "#2a2320",
  ["--pg-ink-2" as any]: "#6e6258",
  ["--pg-ink-3" as any]: "#9a8d80",
  ["--pg-accent" as any]: "#ff8a5c",
  ["--pg-accent-2" as any]: "#ffab7a",
  ["--pg-on-accent" as any]: "#ffffff",
  ["--pg-glow" as any]: "rgba(255,138,92,0.26)",
  ["--pg-line" as any]: "rgba(60,40,30,0.10)",
  ["--pg-card" as any]: "rgba(255,255,255,0.55)",
  ["--pg-card-border" as any]: "rgba(120,80,60,0.12)",
};

// ---- math helpers ---------------------------------------------------------
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// warm orb palette (3D scene colours — generic warm/lilac, no brand meaning)
const ORB_COLORS = ["#ffb48a", "#ff9e72", "#ffc7a0", "#d4bcff", "#ffab7a", "#ffd0b0", "#c9b6ff"];
const ORB_EMIS = ["#ff8a5c", "#ff7a4e", "#ffab7a", "#b9a0ff", "#ff8a5c", "#ffab7a", "#b9a0ff"];

interface Slot {
  arc: [number, number, number];
  scatter: [number, number, number];
  size: number;
  phase: number;
}

// ---- the liquid: one blob that splits into orbs, arcs, then reforms --------
function Liquid({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced, progressRef } = api;

  const NSEC = small ? 4 : 6; // secondary orbs (+ the primary = total in the arc)
  const N = NSEC + 1;
  const MID = Math.floor(N / 2); // arc slot the primary blob occupies
  const PRIMARY_DETAIL = small ? 40 : 80; // high subdivision for smooth distortion
  const ORB_DETAIL = small ? 16 : 32;
  const HERO_SCALE = small ? 0.92 : 1.05; // radius of the unified hero blob

  const groupRef = useRef<THREE.Group>(null!);
  const primaryGroupRef = useRef<THREE.Group>(null!);
  const blobRef = useRef<THREE.Mesh>(null!);
  const primaryMatRef = useRef<any>(null!);
  const haloARef = useRef<THREE.Mesh>(null!);
  const haloBRef = useRef<THREE.Mesh>(null!);
  const orbRefs = useRef<THREE.Mesh[]>([]);

  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);

  // precompute arc + scatter targets, sizes, phases, and the secondary→slot map
  const { layout, secondarySlots } = useMemo(() => {
    const ARC_W = small ? 1.95 : 2.55;
    const ARC_LIFT = 0.5;
    const ARC_DEPTH = 0.55;
    const SCATTER_R = small ? 1.8 : 2.4;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const L: Slot[] = [];
    for (let s = 0; s < N; s++) {
      const f = N > 1 ? s / (N - 1) : 0.5;
      const bow = f - 0.5;
      const arc: [number, number, number] = [
        lerp(-ARC_W, ARC_W, f),
        ARC_LIFT * (1 - 4 * bow * bow) - 0.18, // gentle rainbow bow, slight drop
        -Math.abs(bow) * ARC_DEPTH, // ends pushed back for arc depth
      ];
      const ang = golden * (s + 1);
      const rad = SCATTER_R * (0.7 + (((s * 13) % 5) / 5) * 0.5);
      const scatter: [number, number, number] = [
        Math.cos(ang) * rad,
        Math.sin(ang) * rad * 0.6,
        Math.sin(ang * 1.7) * rad * 0.35,
      ];
      const size = 0.42 + (((s * 7) % 5) / 5) * 0.16;
      const phase = (s * 1.7) % (Math.PI * 2);
      L.push({ arc, scatter, size, phase });
    }
    // the primary blob owns the middle slot — keep it anchored near center
    L[MID].scatter = [0, 0.12, 0];
    L[MID].size = small ? 0.5 : 0.56;
    const sec: number[] = [];
    for (let j = 0; j < NSEC; j++) sec.push(j < MID ? j : j + 1);
    return { layout: L, secondarySlots: sec };
  }, [N, MID, NSEC, small]);

  // one frame at a given progress p and time t (shared by useFrame + reduced paint)
  // Phase breakpoints retuned for the new 5-section editorial rhythm:
  //   0.00–0.16  hero — the blob breathes, whole
  //   0.16–0.46  SCENARIO essay — it splits, the small moments scatter out
  //   0.42–0.72  STAYS pull-quotes — the orbs settle into a tidy arc (each row a moment kept)
  //   0.72–1.00  PRIVACY + CLOSE — everything eases back into one calm blob
  const render = (p: number, t: number) => {
    const emerge = smooth((p - 0.16) / 0.3); // 0.16→0.46  orbs push out from center
    const toArc = smooth((p - 0.42) / 0.3); // 0.42→0.72  drift eases into tidy arc
    const back = smooth((p - 0.72) / 0.28); // 0.72→1.00  everything returns to one blob
    const sep = emerge * (1 - back); // overall separation amount

    if (groupRef.current) {
      groupRef.current.rotation.y = reduced ? 0 : Math.sin(t * 0.08) * 0.1 + p * 0.18;
      groupRef.current.position.y = reduced ? 0 : Math.sin(t * 0.18) * 0.03;
    }

    const place = (obj: THREE.Object3D, slot: number) => {
      const L = layout[slot];
      const sx = lerp(L.scatter[0], L.arc[0], toArc);
      const sy = lerp(L.scatter[1], L.arc[1], toArc);
      const sz = lerp(L.scatter[2], L.arc[2], toArc);
      let x = sx * emerge;
      let y = sy * emerge;
      let z = sz * emerge;
      x = lerp(x, 0, back);
      y = lerp(y, 0, back);
      z = lerp(z, 0, back);
      if (!reduced) y += Math.sin(t * 0.6 + L.phase) * 0.06 * sep; // gentle bob while apart
      obj.position.set(x, y, z);
    };

    // primary blob — shrinks to an orb as it splits, grows back as it reunites
    const pg = primaryGroupRef.current;
    if (pg) {
      place(pg, MID);
      let ps = lerp(HERO_SCALE, layout[MID].size, emerge);
      ps = lerp(ps, HERO_SCALE, back);
      const breath = reduced ? 1 : 1 + Math.sin(t * 0.5) * 0.02;
      pg.scale.setScalar(ps * breath);
    }
    if (blobRef.current) {
      blobRef.current.rotation.y = reduced ? 0.5 : t * 0.06;
      blobRef.current.rotation.x = reduced ? -0.15 : -0.15 + Math.sin(t * 0.15) * 0.1;
    }
    if (haloARef.current) haloARef.current.rotation.z = reduced ? 0 : t * 0.05;
    if (haloBRef.current) haloBRef.current.rotation.z = reduced ? 0 : -t * 0.04;

    // secondary orbs — scale up out of the blob, scale back to nothing on reunite
    for (let j = 0; j < secondarySlots.length; j++) {
      const mesh = orbRefs.current[j];
      if (!mesh) continue;
      const slot = secondarySlots[j];
      const L = layout[slot];
      place(mesh, slot);
      const pulse = reduced ? 1 : 1 + Math.sin(t * 1.1 + L.phase) * 0.05;
      const s = L.size * sep * pulse;
      mesh.scale.setScalar(s);
      mesh.visible = s > 0.002;
      mesh.rotation.y = reduced ? L.phase : t * 0.08 + L.phase;
    }
  };

  // calm Apple-easing dolly: close & intimate at the blob, pull back to see the arc
  const moveCamera = (p: number) => {
    const back = smooth((p - 0.72) / 0.28);
    const out = smooth(clamp01((p - 0.1) / 0.52));
    const zBase = lerp(4.7, 5.95, out);
    const z = lerp(zBase, 5.15, back);
    const y = lerp(0.05, 0.32, out) * (1 - back) + back * 0.08;
    camera.position.set(reduced ? 0 : Math.sin(p * Math.PI * 0.6) * 0.14 * (1 - back), y, z);
    camera.lookAt(0, 0.02, 0);
  };

  useFrame((state) => {
    if (reduced) return;
    const p = progressRef.current;
    const t = state.clock.elapsedTime;
    render(p, t);
    moveCamera(p);
  });

  // reduced motion: paint one representative "tidy arc" frame, then stop
  useEffect(() => {
    if (!reduced) return;
    let r1 = 0;
    let r2 = 0;
    const paint = () => {
      if (primaryMatRef.current) primaryMatRef.current.distort = 0.34;
      render(0.6, 0);
      moveCamera(0.6);
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
      {/* the unified hero blob + its additive glow shells (follow it as one group) */}
      <group ref={primaryGroupRef}>
        <mesh ref={haloARef} scale={1.38}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshBasicMaterial
            color="#ffd6b0"
            transparent
            opacity={0.12}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh ref={haloBRef} scale={1.72}>
          <sphereGeometry args={[1, 32, 32]} />
          <meshBasicMaterial
            color="#ffb98a"
            transparent
            opacity={0.07}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
        <mesh ref={blobRef}>
          <sphereGeometry args={[1, PRIMARY_DETAIL, PRIMARY_DETAIL]} />
          <MeshDistortMaterial
            ref={primaryMatRef}
            color="#ffb48a"
            emissive="#ff8a5c"
            emissiveIntensity={0.32}
            roughness={0.16}
            metalness={0.06}
            clearcoat={1}
            clearcoatRoughness={0.32}
            distort={0.4}
            speed={reduced ? 0 : 1.4}
          />
        </mesh>
      </group>

      {/* secondary orbs — the split conversations */}
      {secondarySlots.map((slot, j) => (
        <mesh
          key={j}
          ref={(el) => {
            if (el) orbRefs.current[j] = el as THREE.Mesh;
          }}
          visible={false}
        >
          <sphereGeometry args={[1, ORB_DETAIL, ORB_DETAIL]} />
          <MeshDistortMaterial
            color={ORB_COLORS[slot % ORB_COLORS.length]}
            emissive={ORB_EMIS[slot % ORB_EMIS.length]}
            emissiveIntensity={0.28}
            roughness={0.2}
            metalness={0.04}
            clearcoat={0.8}
            clearcoatRoughness={0.4}
            distort={0.32}
            speed={reduced ? 0 : 0.9 + (j % 3) * 0.15}
          />
        </mesh>
      ))}
    </group>
  );
}

// Manual + Lightformer-only lighting (NO network env preset). Warm coral key,
// soft lilac fill, cream top — sculpts the peach→coral→lilac gradient surface.
function Scene({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced } = api;
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.12, 4.9], fov: 42 }}
      frameloop={reduced ? "never" : "always"}
    >
      {/* OPAQUE cream background — matches the CSS bg, avoids the white-box bloom trap */}
      <color attach="background" args={["#fbf6f0"]} />
      <fog attach="fog" args={["#fbf6f0", 7.5, 17]} />

      <ambientLight intensity={0.85} color="#fff1e6" />
      <directionalLight position={[3, 5, 4]} intensity={1.0} color="#fff4ec" />
      <pointLight position={[-4, -1, 3]} intensity={22} color="#ff8a5c" />
      <pointLight position={[4, 2, -2]} intensity={15} color="#cdb8ff" />

      <Suspense fallback={null}>
        <Liquid api={api} small={small} />
        <Environment resolution={128} frames={1}>
          <Lightformer form="rect" intensity={2.0} color="#fff0e0" position={[0, 3, 2]} scale={[10, 5, 1]} />
          <Lightformer form="rect" intensity={1.5} color="#ffb98a" position={[-4, -1, 2]} scale={[6, 5, 1]} />
          <Lightformer form="ring" intensity={1.3} color="#d9c4ff" position={[4, 0, 3]} scale={[3, 3, 1]} />
        </Environment>
        {!small && !reduced && (
          <ContactShadows
            position={[0, -1.7, 0]}
            opacity={0.16}
            scale={11}
            blur={3.2}
            far={3.2}
            color="#82502f"
          />
        )}
      </Suspense>
    </Canvas>
  );
}

// ---- editorial copy --------------------------------------------------------
// The small moments memory quietly drops — written as relatable fragments, not
// bullet points. Set as flowing prose in the SCENARIO section.
const MOMENTS = [
  "The standup you half-remember.",
  "The promise you made in the hallway.",
  "The number your landlord rattled off.",
  "The idea at dinner that felt unforgettable —",
  "until morning.",
];

// Features rewritten as warm pull-quote sentences (one per row, soft dividers).
// Each is a true Sutra capability, said plainly and human.
const STAYS = [
  {
    line: "It remembers who said what.",
    note: "Sutra knows your voices apart — name someone once, and they’re recognised in every conversation after.",
  },
  {
    line: "It turns a rambling call into three clear next steps.",
    note: "Every conversation softens into a summary, the decisions, and the action items — with the steps spelled out.",
  },
  {
    line: "It answers, months later, in your own words.",
    note: "Ask your memory anything. You get a grounded answer with citations — and an honest “I don’t have a record of that” when it’s true.",
  },
  {
    line: "And it speaks your language — even when you mix two.",
    note: "Fluent in English, Hindi and Hinglish, the way you actually talk. No switching, no cleanup.",
  },
  {
    line: "And it never keeps your voice.",
    note: "Audio is heard in the moment, then gone. Only the meaning stays — encrypted, on your device.",
  },
];

export default function ProV4() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();
  return (
    <ScrollStage
      theme="light"
      className="pv4"
      vars={VARS}
      reduced={reduced}
      scene={(api) => <Scene api={api} small={small} />}
    >
      {(api) => (
        <>
          <ProNav rootRef={api.rootRef} to="/pro/4" />

          {/* ── HERO ── the whole blob breathes ─────────────────────────── */}
          <section className="pg-beat pv4-hero">
            <div className="pg-wrap">
              <Reveal className="pg-eyebrow" delay={0}>
                <span className="pv4-dot" /> Ambient memory · {BRAND.meaning}
              </Reveal>
              <Reveal as="h1" className="pg-hero-title pv4-title" delay={0.08}>
                Talk freely.
                <br />
                Sutra <span className="pv4-em pg-grad">remembers.</span>
              </Reveal>
              <Reveal as="p" className="pg-lead pv4-lead" delay={0.16}>
                Leave it running and just talk. Sutra listens, then quietly keeps the meaning of
                everything that mattered — so you don’t have to.
              </Reveal>
              <Reveal className="pg-cta-row" delay={0.24}>
                <a href="#start" className="pg-btn pg-btn-primary">
                  {BRAND.ctaPrimary} <ArrowRight size={18} />
                </a>
                <a href="#how" className="pg-btn pg-btn-ghost">Read on</a>
              </Reveal>
            </div>
            <div className="pg-scroll-hint" aria-hidden="true"><i />Scroll</div>
          </section>

          {/* ── SCENARIO ── editorial prose; the blob splits & scatters ──── */}
          <section className="pg-section pv4-scene" id="how">
            <div className="pg-wrap pg-wrap-narrow">
              <Reveal as="p" className="pv4-scene-lead">
                Think about everything that slipped through this week.
              </Reveal>
              <Reveal as="div" className="pv4-prose" delay={0.05}>
                {MOMENTS.map((m, i) => (
                  <span key={i} className="pv4-moment" style={{ ["--i" as any]: i }}>
                    {m}{" "}
                  </span>
                ))}
              </Reveal>
              <Reveal as="p" className="pv4-scene-turn" delay={0.12}>
                Sutra was listening.
                <span className="pv4-em pg-grad"> It kept all of it.</span>
              </Reveal>
            </div>
          </section>

          {/* ── WHAT STAYS WITH YOU ── pull-quote rows, soft dividers ────── */}
          <section className="pg-section pv4-stays" id="features">
            <div className="pg-wrap pg-wrap-narrow">
              <Reveal className="pg-eyebrow">What stays with you</Reveal>
              <Reveal as="h2" className="pg-h2 pv4-stays-head" delay={0.05}>
                The voice fades. The meaning doesn’t.
              </Reveal>
              <div className="pv4-rows">
                {STAYS.map((s, i) => (
                  <Reveal as="div" className="pv4-row" key={i} delay={i * 0.04}>
                    <p className="pv4-row-line">{s.line}</p>
                    <p className="pv4-row-note">{s.note}</p>
                  </Reveal>
                ))}
              </div>
            </div>
          </section>

          {/* ── PRIVACY ── two warm human sentences ─────────────────────── */}
          <section className="pg-section pv4-privacy" id="privacy">
            <div className="pg-wrap pg-wrap-narrow">
              <Reveal as="p" className="pv4-privacy-line">
                Your voice is never kept. Sutra hears a conversation, holds onto what it
                <em> meant</em>, and lets the sound go.
              </Reveal>
              <Reveal as="p" className="pv4-privacy-sub" delay={0.08}>
                What remains lives encrypted on your device, with the key in hardware-backed
                storage. It’s your memory — export it or wipe it whenever you like.
              </Reveal>
            </div>
          </section>

          {/* ── CLOSE ── the orbs reunite into one calm blob ────────────── */}
          <section className="pg-section pv4-cta">
            <div className="pg-wrap pg-wrap-narrow" style={{ textAlign: "center" }}>
              <Reveal as="h2" className="pg-h2 pv4-cta-head">
                Stop trying to remember.
                <br />
                <span className="pv4-em pg-grad">Just start talking.</span>
              </Reveal>
              <Reveal className="pg-cta-row pg-cta-center" delay={0.06}>
                <a href="#start" className="pg-btn pg-btn-primary">
                  {BRAND.ctaPrimary} <ArrowRight size={18} />
                </a>
              </Reveal>
              <Reveal as="p" className="pv4-cta-foot" delay={0.12}>
                {BRAND.privacyLine}
              </Reveal>
            </div>
          </section>

          <ProFooter to="/pro/4" />
        </>
      )}
    </ScrollStage>
  );
}
