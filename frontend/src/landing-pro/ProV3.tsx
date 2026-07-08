// ============================================================================
// Sutra · landing-pro V3 — "The Vault"  (dark · glass · cyan · privacy datasheet)
//
// A bespoke, datasheet-grade privacy page. The 3D world (a sealed refractive
// glass MONOLITH that takes in your words and lets the SOUND dissolve while only
// the MEANING crystallizes safely inside) is UNCHANGED — it is retuned only so
// its beats line up with this page's new section rhythm:
//
//   hero        the sealed glass monolith slowly rotates, faint cyan core inside.
//   intake      a stream of audio PARTICLES flows in from the dark toward it.
//   dissolve    KEY BEAT — the incoming audio FADES TO NOTHING at the surface.
//   crystallize the inner CORE brightens and forms — memory sealed in the vault.
//   calm        steady rotation; the world recedes for the FAQ + CTA close.
//
// Voice: precise, technical, reassuring; tasteful JetBrains-Mono accents. Unlike
// the other variants, the body is NOT a Talk/Weave/Ask trio + pillar grid — it is
// a comparison ledger, a security SPEC SHEET (label → value HUD rows), and a short
// FAQ. All left-aligned so the center-right vault is never occluded by copy.
//
// Only this file + ProV3.css are touched. Palette comes through `vars`.
// Architecture mirrors ProV1 exactly (scene render-prop, one useFrame scrubber,
// opaque <color> background so Bloom has no alpha to discard, reduced-motion
// single-paint, small-screen budget + material fallback).
// ============================================================================
import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { MeshTransmissionMaterial, RoundedBox, Environment, Lightformer, Float } from "@react-three/drei";
import * as THREE from "three";
import {
  Lock,
  ArrowRight,
  ShieldCheck,
  Check,
  Plus,
  Cloud,
  ServerCrash,
  Waves,
  HardDriveDownload,
  KeyRound,
  Network,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { BRAND, usePrefersReducedMotion, useIsSmallScreen } from "../landing/brand";
import ScrollStage, { Reveal, type StageApi } from "./ScrollStage";
import { ProNav, ProFooter } from "./primitives";
import "./ProV3.css";

const VARS: CSSProperties = {
  ["--pg-bg" as any]: "#04090d",
  ["--pg-bg-2" as any]: "#07121a",
  ["--pg-ink" as any]: "#eafcff",
  ["--pg-ink-2" as any]: "#9fc4cf",
  ["--pg-ink-3" as any]: "#5f8591",
  ["--pg-accent" as any]: "#5fe6ff",
  ["--pg-accent-2" as any]: "#8af0ff",
  ["--pg-on-accent" as any]: "#04090d",
  ["--pg-glow" as any]: "rgba(95,230,255,0.45)",
  ["--pg-line" as any]: "rgba(180,240,255,0.10)",
  ["--pg-card" as any]: "rgba(120,220,255,0.04)",
  ["--pg-card-border" as any]: "rgba(150,235,255,0.12)",
};

// ---- math helpers ---------------------------------------------------------
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
};
const ss = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t); // smoothstep
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---- audio-intake particle shader (per-particle alpha + size, additive) ----
const PARTICLE_VERT = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  varying float vAlpha;
  uniform float uSize;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float ps = aSize * uSize * (300.0 / -mv.z);
    gl_PointSize = clamp(ps, 0.0, 36.0);
    // fade points that are behind / too close to the camera so nothing
    // balloons into a near-plane blob as it streams past the lens
    float near = smoothstep(-2.0, -5.0, mv.z);
    vAlpha = aAlpha * near;
    gl_Position = projectionMatrix * mv;
  }
`;
const PARTICLE_FRAG = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uOpacity;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.0, d);
    vec3 col = mix(uColorB, uColorA, soft);
    gl_FragColor = vec4(col, soft * vAlpha * uOpacity);
  }
`;

// ---- the vault ------------------------------------------------------------
function Vault({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced, progressRef } = api;
  // MeshTransmissionMaterial renders the scene to an FBO every frame — too heavy
  // for phones (and pointless when nothing animates). Fall back to a frosted
  // physical material with envmap-only transmission there.
  const useTransmission = !small && !reduced;

  const worldRef = useRef<THREE.Group>(null!);
  const spinRef = useRef<THREE.Group>(null!);
  const coreRef = useRef<THREE.Mesh>(null!);
  const facetsRef = useRef<THREE.Group>(null!);
  const coreLightRef = useRef<THREE.PointLight>(null!);
  const pointsRef = useRef<THREE.Points>(null!);
  const invalidate = useThree((s) => s.invalidate);
  const { camera } = useThree();
  const lookTarget = useMemo(() => new THREE.Vector3(), []);

  const GX = small ? 0 : 1.25; // the vault sits center-right on desktop; centered on phones
  const WORLD_SCALE = small ? 0.7 : 1; // smaller on phones — the cubic block has a wider footprint

  // particle geometry + material + flat data arrays (precomputed once)
  const { geo, mat, P } = useMemo(() => {
    const N = small ? 480 : 1300;
    const pos = new Float32Array(N * 3);
    const alpha = new Float32Array(N);
    const size = new Float32Array(N);
    const dir = new Float32Array(N * 3);
    const outer = new Float32Array(N);
    const off = new Float32Array(N);
    const base = new Float32Array(N);
    const shell = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i * 2.39963) % (Math.PI * 2);
      const yb = ((i * 0.61803398875) % 1) * 2 - 1; // -1..1, evenly spread
      const r2 = Math.sqrt(Math.max(0, 1 - yb * yb));
      const dx = Math.cos(a) * r2;
      const dz = Math.sin(a) * r2;
      dir[i * 3] = dx;
      dir[i * 3 + 1] = yb;
      dir[i * 3 + 2] = dz;
      outer[i] = 7 + (((i * 53) % 100) / 100) * 6; // 7..13 (far, fogged shell)
      off[i] = (i * 0.7548776662) % 1; // travel phase
      base[i] = 0.9 + (((i * 17) % 100) / 100) * 1.3; // 0.9..2.2 px scale
      shell[i] = 1.9 + (((i * 29) % 100) / 100) * 0.3; // dissolve radius — roughly uniform around the cubic vault
      pos[i * 3] = dx * outer[i];
      pos[i * 3 + 1] = yb * outer[i];
      pos[i * 3 + 2] = dz * outer[i];
      size[i] = base[i];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uColorA: { value: new THREE.Color("#cffaff") },
        uColorB: { value: new THREE.Color("#39c6e6") },
        uOpacity: { value: 1 },
        uSize: { value: small ? 0.16 : 0.12 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geo: g, mat: m, P: { N, pos, alpha, size, dir, outer, off, base, shell } };
  }, [small]);

  useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);

  // ---- one frame at a given progress (shared by live loop + reduced paint) --
  // Retuned for the new section layout: hero (0–.14) holds the sealed monolith;
  // the COMPARISON section pulls audio inward + begins the dissolve (.14–.46);
  // the SPEC SHEET is where meaning crystallizes (.46–.74); the FAQ + CTA close
  // is the calm recede (.9–1).
  const render = (p: number, t: number) => {
    const intake = smooth((p - 0.14) / 0.24);
    const dissolve = smooth((p - 0.36) / 0.16);
    const crystallize = smooth((p - 0.46) / 0.24);
    const recede = smooth((p - 0.9) / 0.1);

    // audio particles streaming inward + dissolving at the glass
    const gate = intake * (1 - recede * 0.85);
    const fadeStart = lerp(0.84, 0.56, dissolve); // dissolve beat pulls the fade earlier → legible
    const speed = reduced ? 0 : 0.05;
    const { N, pos, alpha, size, dir, outer, off, base, shell } = P;
    for (let i = 0; i < N; i++) {
      let cyc = off[i] + t * speed;
      cyc = cyc - Math.floor(cyc); // 0..1 inward travel, wraps (respawn hidden in fog)
      const r = lerp(outer[i], shell[i], cyc);
      const i3 = i * 3;
      pos[i3] = dir[i3] * r;
      pos[i3 + 1] = dir[i3 + 1] * r;
      pos[i3 + 2] = dir[i3 + 2] * r;
      const aIn = ss(0.0, 0.12, cyc);
      const aOut = 1 - ss(fadeStart, 1.0, cyc); // → 0 as it reaches the shell
      alpha[i] = aIn * aOut * gate;
      size[i] = base[i] * (0.3 + 0.7 * aOut);
    }
    if (pointsRef.current) {
      const ga = pointsRef.current.geometry.attributes;
      (ga.position as THREE.BufferAttribute).needsUpdate = true;
      (ga.aAlpha as THREE.BufferAttribute).needsUpdate = true;
      (ga.aSize as THREE.BufferAttribute).needsUpdate = true;
    }

    // core crystallizes inside the vault
    if (coreRef.current) {
      const m = coreRef.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = lerp(0.12, 2.6, crystallize) * (1 - recede * 0.25);
      coreRef.current.scale.setScalar(lerp(0.45, 1, crystallize));
    }
    if (coreLightRef.current) {
      coreLightRef.current.intensity = lerp(0.15, 3.2, crystallize) * (1 - recede * 0.3);
    }
    if (facetsRef.current) {
      facetsRef.current.scale.setScalar(crystallize);
      facetsRef.current.rotation.y = reduced ? 0 : t * 0.35;
    }

    // slow premium rotation of the glass + core
    if (spinRef.current) {
      spinRef.current.rotation.y = (reduced ? 0.6 : t * 0.06) + p * 0.8;
      spinRef.current.rotation.x = Math.sin(p * Math.PI) * 0.07;
    }
    // recede the whole world (sink + shrink) for the FAQ + CTA close
    if (worldRef.current) {
      worldRef.current.position.set(GX, -recede * 1.6, 0);
      worldRef.current.scale.setScalar(lerp(WORLD_SCALE, WORLD_SCALE * 0.9, recede));
    }
  };

  const moveCamera = (p: number) => {
    const pin = smooth(p / 0.45);
    const recede = smooth((p - 0.9) / 0.1);
    let z = lerp(10, 7.6, pin); // gentle push-in (framed for the wider cubic vault)
    z = lerp(z, 8.6, recede) + (small ? 0.8 : 0); // pull back for the calm close
    camera.position.set(
      Math.sin(p * Math.PI * 0.6) * 0.6 * (1 - recede), // subtle orbit
      lerp(0.5, 0.15, pin) + recede * 1.8, // rise so the vault sinks below the close text
      z,
    );
    lookTarget.set(0, recede * 1.2, 0);
    camera.lookAt(lookTarget);
  };

  useFrame((state) => {
    if (reduced) return;
    const p = progressRef.current;
    const t = state.clock.elapsedTime;
    render(p, t);
    moveCamera(p);
  });

  // reduced motion: paint one representative "crystallized vault" frame
  useEffect(() => {
    if (!reduced) return;
    let r1 = 0, r2 = 0;
    const paint = () => { render(0.6, 0); moveCamera(0.6); invalidate(); };
    paint();
    r1 = requestAnimationFrame(() => { paint(); r2 = requestAnimationFrame(paint); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  return (
    <group ref={worldRef} position={[GX, 0, 0]} scale={WORLD_SCALE}>
      <group ref={spinRef}>
        {/* the sealed glass vault — a rounded strongbox BLOCK (not a tall capsule),
            so it reads as "your memory, locked safe" rather than a pill or a device */}
        <RoundedBox args={[2.7, 2.5, 2.7]} radius={0.16} smoothness={5} steps={1} creaseAngle={0.5}>
          {useTransmission ? (
            <MeshTransmissionMaterial
              samples={6}
              resolution={256}
              thickness={1.4}
              roughness={0.06}
              transmission={1}
              ior={1.34}
              chromaticAberration={0.18}
              anisotropicBlur={0.4}
              distortion={0.2}
              distortionScale={0.3}
              temporalDistortion={0.08}
              clearcoat={1}
              clearcoatRoughness={0.12}
              attenuationColor={"#2fd0ff"}
              attenuationDistance={3.2}
              color={"#bff6ff"}
            />
          ) : (
            <meshPhysicalMaterial
              transmission={0.92}
              thickness={1.2}
              roughness={0.16}
              ior={1.32}
              metalness={0}
              color={"#bff6ff"}
              attenuationColor={"#2fd0ff"}
              attenuationDistance={2.6}
              clearcoat={1}
              clearcoatRoughness={0.22}
              envMapIntensity={1.3}
              transparent
            />
          )}
        </RoundedBox>

        {/* the memory core that crystallizes inside */}
        <mesh ref={coreRef} scale={0.45}>
          <icosahedronGeometry args={[0.6, 0]} />
          <meshStandardMaterial
            color={"#05202b"}
            emissive={"#5fe6ff"}
            emissiveIntensity={0.12}
            roughness={0.3}
            metalness={0}
            toneMapped={false}
          />
        </mesh>

        {/* small facets that appear as the core forms */}
        <group ref={facetsRef} scale={0}>
          {[0, 1, 2].map((i) => {
            const ang = (i / 3) * Math.PI * 2;
            return (
              <Float key={i} speed={2} rotationIntensity={1.2} floatIntensity={0.6}>
                <mesh position={[Math.cos(ang) * 0.85, Math.sin(ang * 1.7) * 0.7, Math.sin(ang) * 0.85]}>
                  <icosahedronGeometry args={[0.16, 0]} />
                  <meshStandardMaterial
                    color={"#072530"}
                    emissive={"#8af0ff"}
                    emissiveIntensity={1.6}
                    roughness={0.25}
                    toneMapped={false}
                  />
                </mesh>
              </Float>
            );
          })}
        </group>

        <pointLight ref={coreLightRef} position={[0, 0, 0]} color={"#5fe6ff"} intensity={0.15} distance={9} decay={1.4} />
      </group>

      {/* the audio intake — streams in, dissolves at the glass */}
      <points ref={pointsRef} geometry={geo} material={mat} />
    </group>
  );
}

function Scene({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced } = api;
  return (
    <Canvas
      dpr={[1, small ? 1.5 : 2]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.5, 9.6], fov: 42 }}
      frameloop={reduced ? "never" : "always"}
    >
      {/* OPAQUE background first — so Bloom has no alpha to discard */}
      <color attach="background" args={["#04090d"]} />
      <fog attach="fog" args={["#04090d", 13, 30]} />
      <ambientLight intensity={0.18} color={"#5fe6ff"} />
      <directionalLight position={[5, 7, 6]} intensity={0.5} color={"#bff6ff"} />
      <Suspense fallback={null}>
        {/* environment for the glass to refract — Lightformers only, no network preset */}
        <Environment frames={1} resolution={256}>
          <color attach="background" args={["#03070a"]} />
          <Lightformer form="rect" intensity={3} color="#5fe6ff" scale={[7, 7, 1]} position={[0, 3, -6]} />
          {/* rect (not circle/ring) front reflections — round highlights read as an "eye" on the glass */}
          <Lightformer form="rect" intensity={3.6} color="#8af0ff" scale={[5, 5, 1]} position={[5, 2, 3]} />
          <Lightformer form="rect" intensity={2.2} color="#bff6ff" scale={[4, 4, 1]} position={[-4, 4, 2]} />
          <Lightformer form="rect" intensity={1.6} color="#2fd0ff" scale={[10, 2, 1]} position={[-5, -2, -1]} rotation-y={Math.PI / 2} />
        </Environment>
        <Vault api={api} small={small} />
      </Suspense>
      {!reduced && (
        <EffectComposer>
          <Bloom intensity={0.85} luminanceThreshold={0.22} luminanceSmoothing={0.5} mipmapBlur radius={0.7} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

// ---- bespoke content data -------------------------------------------------

// COMPARISON — honest, no competitor names.
const COMPARE_THEM = [
  "Your recordings are uploaded and kept on their servers.",
  "Your conversations become data living in someone else's cloud.",
  "Leaving means trusting them to actually delete it.",
];
const COMPARE_US = [
  "Audio is processed in the moment and never stored — anywhere.",
  "Your memory is encrypted on your own device, not a cloud account.",
  "Export the whole thing or wipe it, anytime, on your terms.",
];

// SECURITY SPEC SHEET — label → value HUD rows.
type SpecRow = { Icon: LucideIcon; label: string; value: string; note: string };
const SPEC: SpecRow[] = [
  {
    Icon: Waves,
    label: "Audio",
    value: "Never persisted",
    note: "Enforced at the data-model level — there is no field to hold a recording.",
  },
  {
    Icon: Lock,
    label: "Memory",
    value: "Encrypted, on-device",
    note: "Transcripts and distilled memory live on your phone, encrypted at rest.",
  },
  {
    Icon: KeyRound,
    label: "Key",
    value: "Hardware-backed",
    note: "The encryption key is held in your device's secure storage, never exported.",
  },
  {
    Icon: Network,
    label: "Network",
    value: "In-flight only",
    note: "Audio is sent solely to be understood, then discarded — nothing is retained.",
  },
  {
    Icon: HardDriveDownload,
    label: "Your data",
    value: "Export or wipe",
    note: "Take a full copy with you, or erase everything, whenever you decide.",
  },
  {
    Icon: WifiOff,
    label: "Offline",
    value: "Full recall",
    note: "Search, browse and revisit everything already remembered with no connection.",
  },
];

// SHORT FAQ — accordion rows.
const FAQ = [
  {
    q: "Do you keep my recordings?",
    a: "No. Audio is processed in the moment and discarded — it is never written to disk, never uploaded to be kept, never stored.",
  },
  {
    q: "Where does my data live?",
    a: "On your device, encrypted at rest, with the key in hardware-backed secure storage. It does not sit in a cloud account by default.",
  },
  {
    q: "Does it work offline?",
    a: "Yes — for everything already remembered. You can search, browse and recall your memory with no connection at all.",
  },
  {
    q: "What languages does it understand?",
    a: "English, Hindi, and Hinglish — mixed freely, mid-sentence. Hindi-English is a first-class citizen, not an afterthought.",
  },
];

function FaqRow({ q, a, defaultOpen }: { q: string; a: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className={`pv3-faq-row ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="pv3-faq-q"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{q}</span>
        <Plus className="pv3-faq-icon" size={20} aria-hidden="true" />
      </button>
      <div className="pv3-faq-a" hidden={!open}>
        <p>{a}</p>
      </div>
    </div>
  );
}

export default function ProV3() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();
  return (
    <ScrollStage
      theme="dark"
      className="pv3"
      vars={VARS}
      reduced={reduced}
      scene={(api) => <Scene api={api} small={small} />}
    >
      {(api) => (
        <>
          <ProNav rootRef={api.rootRef} to="/pro/3" />

          {/* ---- HERO ----------------------------------------------------- */}
          <section className="pg-beat pv3-hero">
            <div className="pg-wrap">
              <Reveal className="pg-eyebrow" delay={0}>
                <span className="pv3-dot" /> Private ambient memory · {BRAND.meaning}
              </Reveal>
              <Reveal as="h1" className="pg-hero-title pv3-title" delay={0.08}>
                Your conversations,
                <br />
                <span className="pg-grad">kept safe.</span>
              </Reveal>
              <Reveal as="p" className="pg-lead pv3-lead" delay={0.16}>
                Sutra listens, distils every conversation into searchable memory, and seals it on
                your device. The audio dissolves the moment it's understood — only the meaning is
                kept, and only by you.
              </Reveal>
              <Reveal className="pg-cta-row pv3-cta-row" delay={0.24}>
                <a href="#start" className="pg-btn pg-btn-primary">
                  {BRAND.ctaPrimary} <ArrowRight size={18} />
                </a>
                <a href="#privacy" className="pg-btn pg-btn-ghost">Read the FAQ</a>
              </Reveal>
              <Reveal className="pv3-hud" delay={0.32}>
                <span className="pv3-chip"><ShieldCheck size={13} /> Audio never stored</span>
                <span className="pv3-chip">Encrypted on device</span>
                <span className="pv3-chip">Hindi · Hinglish</span>
              </Reveal>
            </div>
            <div className="pg-scroll-hint" aria-hidden="true"><i />Scroll</div>
          </section>

          {/* ---- COMPARISON — tracks intake → dissolve ------------------- */}
          <section className="pg-section pv3-compare" id="how">
            <div className="pg-wrap">
              <Reveal className="pg-eyebrow">The difference</Reveal>
              <Reveal as="h2" className="pg-h2 pv3-section-title" delay={0.05}>
                How memory apps usually work — and how Sutra works.
              </Reveal>
              <Reveal as="p" className="pg-lead pv3-compare-lead" delay={0.1}>
                Most ambient-memory tools earn your trust, then quietly hold your life on their
                servers. Sutra is built the other way around.
              </Reveal>

              <div className="pv3-ledger">
                <Reveal as="article" className="pv3-col pv3-col-them" delay={0.05}>
                  <header className="pv3-col-head">
                    <Cloud size={16} aria-hidden="true" />
                    <span className="pv3-col-tag">Most AI memory apps</span>
                  </header>
                  <ul className="pv3-col-list">
                    {COMPARE_THEM.map((line, i) => (
                      <li key={i}>
                        <ServerCrash size={15} aria-hidden="true" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </Reveal>

                <Reveal as="article" className="pv3-col pv3-col-us" delay={0.12}>
                  <header className="pv3-col-head">
                    <ShieldCheck size={16} aria-hidden="true" />
                    <span className="pv3-col-tag">Sutra</span>
                  </header>
                  <ul className="pv3-col-list">
                    {COMPARE_US.map((line, i) => (
                      <li key={i}>
                        <Check size={15} aria-hidden="true" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </Reveal>
              </div>
            </div>
          </section>

          {/* ---- SECURITY SPEC SHEET — tracks crystallize --------------- */}
          <section className="pg-section pv3-spec" id="features">
            <div className="pg-wrap">
              <div className="pv3-spec-head">
                <div>
                  <Reveal className="pg-eyebrow"><Lock size={13} /> Security datasheet</Reveal>
                  <Reveal as="h2" className="pg-h2 pv3-section-title" delay={0.05}>
                    The whole privacy model, on one page.
                  </Reveal>
                </div>
                <Reveal className="pv3-spec-stamp" delay={0.1} aria-hidden="true">
                  <span className="pv3-spec-stamp-k">SPEC</span>
                  <span className="pv3-spec-stamp-v">v1</span>
                </Reveal>
              </div>

              <Reveal as="dl" className="pv3-spec-grid" delay={0.08}>
                {SPEC.map((row) => (
                  <div className="pv3-spec-row" key={row.label}>
                    <span className="pv3-spec-icon"><row.Icon size={18} strokeWidth={1.7} /></span>
                    <dt className="pv3-spec-label">{row.label}</dt>
                    <dd className="pv3-spec-value">{row.value}</dd>
                    <p className="pv3-spec-note">{row.note}</p>
                  </div>
                ))}
              </Reveal>
            </div>
          </section>

          {/* ---- FAQ — calm recede begins ------------------------------- */}
          <section className="pg-section pv3-faq" id="privacy">
            <div className="pg-wrap">
              <div className="pv3-faq-inner">
                <Reveal className="pg-eyebrow">Straight answers</Reveal>
                <Reveal as="h2" className="pg-h2 pv3-section-title" delay={0.05}>
                  No fine print. Ask the obvious questions.
                </Reveal>
                <Reveal as="div" className="pv3-faq-list" delay={0.1}>
                  {FAQ.map((f, i) => (
                    <FaqRow key={f.q} q={f.q} a={f.a} defaultOpen={i === 0} />
                  ))}
                </Reveal>
              </div>
            </div>
          </section>

          {/* ---- CLOSING CTA -------------------------------------------- */}
          <section className="pg-section pv3-cta">
            <div className="pg-wrap">
              <div className="pv3-cta-inner">
                <Reveal as="h2" className="pg-h2 pv3-cta-title">
                  Seal your memory. <span className="pg-grad">Just start talking.</span>
                </Reveal>
                <Reveal as="p" className="pg-lead pv3-cta-lead" delay={0.05}>
                  Nothing to configure, nothing leaving your phone. Open Sutra and speak.
                </Reveal>
                <Reveal className="pg-cta-row" delay={0.1}>
                  <a href="#start" className="pg-btn pg-btn-primary">
                    {BRAND.ctaPrimary} <ArrowRight size={18} />
                  </a>
                </Reveal>
                <Reveal as="ul" className="pg-assurances" delay={0.16} style={{ marginTop: 26 }}>
                  <li><Check size={14} /> Audio never stored</li>
                  <li><Check size={14} /> Encrypted on your device</li>
                  <li><Check size={14} /> English · Hindi · Hinglish</li>
                </Reveal>
              </div>
            </div>
          </section>

          <ProFooter to="/pro/3" />
        </>
      )}
    </ScrollStage>
  );
}
