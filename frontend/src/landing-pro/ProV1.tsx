// ============================================================================
// Sutra · landing-pro V1 — "Constellation"  (dark · cinematic · violet/black)
//
// One continuous 3D world, scrubbed by whole-page scroll:
//   hero      scattered particles drift in deep space
//   converge  nodes fly together + edges draw in → a living knowledge graph
//   orbit     the graph rotates, fully connected ("connected memory")
//   focus     camera pushes into one node — a single recalled memory
//   calm      the field recedes for the privacy + CTA close
//
// BESPOKE BODY (not the shared template): hero → entity legend → grounded-chat
// showcase → a single conceptual scale line → a one-line privacy promise → CTA.
// Only this file + ProV1.css are touched. Palette comes through `vars`.
// ============================================================================
import { Suspense, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { ArrowRight } from "lucide-react";
import { BRAND, usePrefersReducedMotion, useIsSmallScreen } from "../landing/brand";
import ScrollStage, { Reveal, type StageApi } from "./ScrollStage";
import { ProNav, ProFooter } from "./primitives";
import "./ProV1.css";

const VARS: CSSProperties = {
  ["--pg-bg" as any]: "#07060e",
  ["--pg-bg-2" as any]: "#0b0a16",
  ["--pg-ink" as any]: "#f3f1fb",
  ["--pg-ink-2" as any]: "#bdb8d6",
  ["--pg-ink-3" as any]: "#7d779b",
  ["--pg-accent" as any]: "#8b7bff",
  ["--pg-accent-2" as any]: "#b3a6ff",
  ["--pg-on-accent" as any]: "#0a0912",
  ["--pg-glow" as any]: "rgba(139,123,255,0.55)",
  ["--pg-line" as any]: "rgba(255,255,255,0.10)",
  ["--pg-card" as any]: "rgba(255,255,255,0.035)",
  ["--pg-card-border" as any]: "rgba(255,255,255,0.085)",
};

// ---- math helpers ---------------------------------------------------------
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---- soft round sprite for dust ------------------------------------------
function useDustTexture() {
  return useMemo(() => {
    const s = 64;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(200,190,255,0.7)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
}

// ---- the constellation ----------------------------------------------------
// (3D PRESERVED — only the scroll-phase breakpoints are retuned to align the
//  beats with the new section layout: convergence over the hero→legend stretch,
//  orbit through the chat showcase, recede into the scale/privacy/CTA close.)
function Constellation({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced, progressRef } = api;
  const NODES = small ? 16 : 28;
  const DUST = small ? 600 : 1500;

  const nodesRef = useRef<THREE.InstancedMesh>(null!);
  const edgesRef = useRef<THREE.LineSegments>(null!);
  const dustRef = useRef<THREE.Points>(null!);
  const groupRef = useRef<THREE.Group>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const invalidate = useThree((s) => s.invalidate);
  const dustTex = useDustTexture();

  // precompute scattered + graph-target positions, sizes, colours, edges
  const data = useMemo(() => {
    const scattered = new Float32Array(NODES * 3);
    const target = new Float32Array(NODES * 3);
    const sizes = new Float32Array(NODES);
    const phase = new Float32Array(NODES);
    const colors: THREE.Color[] = [];
    const C = [new THREE.Color("#b3a6ff"), new THREE.Color("#8b7bff"), new THREE.Color("#ffce7a")];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NODES; i++) {
      // fibonacci sphere target (the formed graph), radius ~4
      const y = 1 - (i / (NODES - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = golden * i;
      const rad = 3.9 + (((i * 13) % 7) / 7) * 0.7;
      target[i * 3] = Math.cos(th) * r * rad;
      target[i * 3 + 1] = y * rad * 0.78;
      target[i * 3 + 2] = Math.sin(th) * r * rad;
      // scattered start — random far shell
      const sr = 9 + ((i * 31) % 11);
      const sa = (i * 2.39963) % (Math.PI * 2);
      const sb = ((i * 7) % 13) / 13 * Math.PI - Math.PI / 2;
      scattered[i * 3] = Math.cos(sa) * Math.cos(sb) * sr;
      scattered[i * 3 + 1] = Math.sin(sb) * sr * 0.8;
      scattered[i * 3 + 2] = Math.sin(sa) * Math.cos(sb) * sr;
      sizes[i] = 0.07 + (((i * 17) % 9) / 9) * 0.06;
      phase[i] = (i * 1.7) % (Math.PI * 2);
      colors.push(i === 0 ? new THREE.Color("#ffce7a") : C[i % 3]);
    }
    sizes[0] = 0.16; // the focus node
    // edges: 2 nearest neighbours each, de-duped
    const seen = new Set<string>();
    const E: number[] = [];
    for (let i = 0; i < NODES; i++) {
      const d: { j: number; v: number }[] = [];
      for (let j = 0; j < NODES; j++) {
        if (i === j) continue;
        const dx = target[i * 3] - target[j * 3];
        const dy = target[i * 3 + 1] - target[j * 3 + 1];
        const dz = target[i * 3 + 2] - target[j * 3 + 2];
        d.push({ j, v: dx * dx + dy * dy + dz * dz });
      }
      d.sort((a, b) => a.v - b.v);
      for (let k = 0; k < 2; k++) {
        const a = Math.min(i, d[k].j);
        const b = Math.max(i, d[k].j);
        const key = `${a}-${b}`;
        if (!seen.has(key)) { seen.add(key); E.push(a, b); }
      }
    }
    const cur = new Float32Array(NODES * 3);
    const linePos = new Float32Array((E.length / 2) * 2 * 3);
    return { scattered, target, sizes, phase, colors, edges: E, cur, linePos };
  }, [NODES]);

  // dust cloud
  const dustGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(DUST * 3);
    for (let i = 0; i < DUST; i++) {
      const r = 6 + Math.pow(((i * 53) % 100) / 100, 0.5) * 16;
      const a = (i * 2.39963) % (Math.PI * 2);
      const b = (((i * 29) % 100) / 100) * Math.PI - Math.PI / 2;
      pos[i * 3] = Math.cos(a) * Math.cos(b) * r;
      pos[i * 3 + 1] = Math.sin(b) * r;
      pos[i * 3 + 2] = Math.sin(a) * Math.cos(b) * r;
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, [DUST]);

  const edgeGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.linePos, 3));
    return g;
  }, [data]);

  // per-instance colours, once
  useEffect(() => {
    const m = nodesRef.current;
    if (!m) return;
    for (let i = 0; i < NODES; i++) m.setColorAt(i, data.colors[i]);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [NODES, data]);

  // shared render of one frame at a given progress
  const render = (p: number, t: number) => {
    const cEase = smooth((p - 0.05) / 0.32); // 0..1 convergence — settles by the legend section
    const recede = smooth((p - 0.72) / 0.28); // 0..1 — dim + sink the field for the calm close
    const m = nodesRef.current;
    if (m) {
      for (let i = 0; i < NODES; i++) {
        const i3 = i * 3;
        const drift = reduced ? 0 : Math.sin(t * 0.5 + data.phase[i]) * 0.08 * (0.5 + 0.5 * cEase);
        const x = lerp(data.scattered[i3], data.target[i3], cEase);
        const y = lerp(data.scattered[i3 + 1], data.target[i3 + 1], cEase) + drift;
        const z = lerp(data.scattered[i3 + 2], data.target[i3 + 2], cEase);
        data.cur[i3] = x; data.cur[i3 + 1] = y; data.cur[i3 + 2] = z;
        const s = data.sizes[i] * (0.5 + 0.5 * cEase) * (1 - recede * 0.45);
        const pulse = reduced ? 1 : 1 + Math.sin(t * 1.4 + data.phase[i]) * 0.12 * cEase * (1 - recede);
        dummy.position.set(x, y, z);
        dummy.scale.setScalar(s * pulse);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
      }
      m.instanceMatrix.needsUpdate = true;
    }
    // edges follow node positions
    const e = edgesRef.current;
    if (e) {
      const lp = data.linePos;
      for (let k = 0; k < data.edges.length; k += 2) {
        const a = data.edges[k] * 3;
        const b = data.edges[k + 1] * 3;
        const o = (k / 2) * 6;
        lp[o] = data.cur[a]; lp[o + 1] = data.cur[a + 1]; lp[o + 2] = data.cur[a + 2];
        lp[o + 3] = data.cur[b]; lp[o + 4] = data.cur[b + 1]; lp[o + 5] = data.cur[b + 2];
      }
      (e.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (e.material as THREE.LineBasicMaterial).opacity = (0.05 + 0.42 * cEase) * (1 - recede * 0.92);
    }
    // whole graph slow rotation + orbit
    if (groupRef.current) {
      groupRef.current.rotation.y = (reduced ? 0.6 : t * 0.045) + p * 1.1;
      groupRef.current.rotation.x = Math.sin(p * Math.PI) * 0.12;
    }
    if (dustRef.current) {
      dustRef.current.rotation.y = reduced ? 0 : t * 0.012;
      (dustRef.current.material as THREE.PointsMaterial).opacity = 0.55 * (1 - recede * 0.7);
    }
  };

  // camera rig
  const { camera } = useThree();
  const lookTarget = useMemo(() => new THREE.Vector3(), []);
  const moveCamera = (p: number) => {
    const recede = smooth((p - 0.72) / 0.28);
    const base = lerp(13, 6.2, smooth(p / 0.46));
    const z = lerp(base, 9.2, recede); // pull back so the close feels open + calm
    camera.position.set(
      Math.sin(p * Math.PI * 0.7) * 0.9 * (1 - recede),
      lerp(0.8, 0.3, smooth(p / 0.46)) + recede * 2.4, // rise so the graph sinks below the text
      z,
    );
    lookTarget.set(0, recede * 1.7, 0);
    camera.lookAt(lookTarget);
  };

  useFrame((state) => {
    if (reduced) return;
    const p = progressRef.current;
    const t = state.clock.elapsedTime;
    render(p, t);
    moveCamera(p);
  });

  // reduced motion: paint one representative formed-graph frame
  useEffect(() => {
    if (!reduced) return;
    let r1 = 0, r2 = 0;
    const paint = () => { render(0.3, 0); moveCamera(0.3); invalidate(); };
    paint();
    r1 = requestAnimationFrame(() => { paint(); r2 = requestAnimationFrame(paint); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  return (
    <group ref={groupRef}>
      <points ref={dustRef} geometry={dustGeo}>
        <pointsMaterial
          map={dustTex}
          size={small ? 0.13 : 0.1}
          transparent
          opacity={0.55}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          sizeAttenuation
          toneMapped={false}
        />
      </points>

      <lineSegments ref={edgesRef} geometry={edgeGeo}>
        <lineBasicMaterial
          color="#8b7bff"
          transparent
          opacity={0.2}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </lineSegments>

      <instancedMesh ref={nodesRef} args={[undefined as any, undefined as any, NODES]}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

function Scene({ api, small }: { api: StageApi; small: boolean }) {
  const { reduced } = api;
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.8, 13], fov: 50 }}
      frameloop={reduced ? "never" : "always"}
    >
      <color attach="background" args={["#07060e"]} />
      <fog attach="fog" args={["#07060e", 9, 30]} />
      <Suspense fallback={null}>
        <Constellation api={api} small={small} />
      </Suspense>
      {!reduced && (
        <EffectComposer>
          <Bloom intensity={1.15} luminanceThreshold={0.15} luminanceSmoothing={0.6} mipmapBlur radius={0.7} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

// ---- bespoke content data -------------------------------------------------

// the entity legend — maps 1:1 to the coloured nodes of the constellation
const LEGEND: { label: string; dot: string; gloss: string }[] = [
  { label: "People", dot: "#b3a6ff", gloss: "who was in the room" },
  { label: "Topics", dot: "#8b7bff", gloss: "what it was about" },
  { label: "Decisions", dot: "#a98bff", gloss: "what you settled" },
  { label: "Commitments", dot: "#ffce7a", gloss: "who owes what" },
  { label: "Places", dot: "#7aa6ff", gloss: "where it happened" },
  { label: "Events", dot: "#ff9ed1", gloss: "what's on the calendar" },
];

// the grounded-chat showcase — every answer carries a source chip
type ChatTurn =
  | { role: "you"; text: string }
  | { role: "sutra"; text: string; source: string }
  | { role: "sutra-empty"; text: string };

const CHAT: ChatTurn[] = [
  { role: "you", text: "What did Farha commit to in Tuesday's sync?" },
  { role: "sutra", text: "She'll send the revised deck by Thursday.", source: "Tuesday sync · 14:32" },
  { role: "you", text: "And what did we decide about the launch date?" },
  { role: "sutra", text: "You moved it to the 14th so QA gets a full week.", source: "Planning call · Mon 11:08" },
  { role: "you", text: "Did Arjun mention his new number?" },
  { role: "sutra-empty", text: "I don't have a record of that." },
];

// ---- chat-bubble component ------------------------------------------------
function ChatBubble({ turn, delay }: { turn: ChatTurn; delay: number }) {
  if (turn.role === "you") {
    return (
      <Reveal className="pv1-chat-row pv1-chat-row--you" delay={delay}>
        <div className="pv1-bubble pv1-bubble--you">{turn.text}</div>
      </Reveal>
    );
  }
  const empty = turn.role === "sutra-empty";
  return (
    <Reveal className="pv1-chat-row pv1-chat-row--sutra" delay={delay}>
      <div className={`pv1-bubble pv1-bubble--sutra${empty ? " is-empty" : ""}`}>
        <span className="pv1-bubble-mark" aria-hidden="true" />
        <p className="pv1-bubble-text">{turn.text}</p>
        {!empty && "source" in turn && (
          <span className="pv1-chip">
            <span className="pv1-chip-dot" aria-hidden="true" />
            {turn.source}
          </span>
        )}
      </div>
    </Reveal>
  );
}

export default function ProV1() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();
  return (
    <ScrollStage
      theme="dark"
      className="pv1"
      vars={VARS}
      reduced={reduced}
      scene={(api) => <Scene api={api} small={small} />}
    >
      {(api) => (
        <>
          <ProNav rootRef={api.rootRef} to="/pro/1" />

          {/* ── 1 · HERO ─────────────────────────────────────────────── */}
          <section className="pg-beat pv1-hero">
            <div className="pg-wrap">
              <Reveal className="pg-eyebrow" delay={0}>
                <span className="pv1-dot" /> Ambient memory · {BRAND.meaning}
              </Reveal>
              <Reveal as="h1" className="pg-hero-title pv1-title" delay={0.08}>
                Your conversations,
                <br />
                <span className="pg-grad">remembered.</span>
              </Reveal>
              <Reveal as="p" className="pg-lead pv1-lead" delay={0.16}>
                Talk. Sutra listens, then quietly weaves every conversation into one living
                graph — the people, the topics, the decisions and who owes what — that you can
                walk through and ask anything.
              </Reveal>
              <Reveal className="pg-cta-row" delay={0.24}>
                <a href="#start" className="pg-btn pg-btn-primary">
                  {BRAND.ctaPrimary} <ArrowRight size={18} />
                </a>
                <a href="#how" className="pg-btn pg-btn-ghost">See the thread</a>
              </Reveal>
            </div>
            <div className="pg-scroll-hint" aria-hidden="true"><i />Scroll</div>
          </section>

          {/* ── 2 · EVERYTHING CONNECTS — entity legend (maps to nodes) ── */}
          <section className="pg-section pv1-legend-sec" id="how">
            <div className="pg-wrap">
              <Reveal className="pg-eyebrow">Everything connects</Reveal>
              <Reveal as="h2" className="pg-h2 pv1-section-title" delay={0.05}>
                The graph you're looking at <span className="pg-grad">is your memory.</span>
              </Reveal>
              <Reveal as="p" className="pg-lead pv1-legend-lead" delay={0.1}>
                Sutra finds the people, topics, decisions and commitments in what you say —
                and links them into one graph you can walk.
              </Reveal>

              <ul className="pv1-legend">
                {LEGEND.map((e, i) => (
                  <Reveal as="li" className="pv1-legend-key" delay={0.12 + i * 0.05} key={e.label}>
                    <span className="pv1-legend-dot" style={{ background: e.dot, boxShadow: `0 0 14px ${e.dot}` }} aria-hidden="true" />
                    <span className="pv1-legend-label">{e.label}</span>
                    <span className="pv1-legend-gloss">{e.gloss}</span>
                  </Reveal>
                ))}
              </ul>
            </div>
          </section>

          {/* ── 3 · ASK YOUR MEMORY — grounded-chat showcase ───────────── */}
          <section className="pg-section pv1-ask-sec" id="features">
            <div className="pg-wrap pv1-ask-grid">
              <div className="pv1-ask-intro">
                <Reveal className="pg-eyebrow">Ask your memory</Reveal>
                <Reveal as="h2" className="pg-h2 pv1-section-title" delay={0.05}>
                  Months later, just ask.
                </Reveal>
                <Reveal as="p" className="pg-lead pv1-ask-lead" delay={0.1}>
                  Sutra answers from your own conversations — never from thin air. Every answer
                  cites its source, and when there's nothing on record it tells you so.
                </Reveal>
              </div>

              <Reveal className="pv1-chat" delay={0.06}>
                <div className="pv1-chat-head" aria-hidden="true">
                  <span className="pv1-chat-head-dot" />
                  <span className="pv1-chat-head-name">Ask Sutra</span>
                </div>
                <div className="pv1-chat-body">
                  {CHAT.map((turn, i) => (
                    <ChatBubble key={i} turn={turn} delay={0.04 * i} />
                  ))}
                </div>
              </Reveal>
            </div>
            <Reveal as="p" className="pv1-ask-caption" delay={0.1}>
              Every answer cites its source — and Sutra says "I don't have a record of that"
              instead of guessing.
            </Reveal>
          </section>

          {/* ── 4 · SCALE LINE — one conceptual statement ──────────────── */}
          <section className="pg-beat pv1-scale">
            <div className="pg-wrap pg-wrap-narrow">
              <Reveal as="p" className="pv1-scale-line">
                One thread through <span className="pg-grad">every conversation</span> you've ever had.
              </Reveal>
            </div>
          </section>

          {/* ── 5 · PRIVACY — single confident line ────────────────────── */}
          <section className="pg-section pv1-privacy" id="privacy">
            <div className="pg-wrap pg-wrap-narrow">
              <Reveal as="p" className="pv1-privacy-line">
                Your audio is never stored. Your memory never leaves your phone.
              </Reveal>
            </div>
          </section>

          {/* ── 6 · CTA ────────────────────────────────────────────────── */}
          <section className="pg-section pv1-cta">
            <div className="pg-wrap pg-wrap-narrow" style={{ textAlign: "center" }}>
              <Reveal as="h2" className="pg-h2 pv1-cta-title">
                Stop trying to remember. <span className="pg-grad">Just start talking.</span>
              </Reveal>
              <Reveal className="pg-cta-row pg-cta-center" delay={0.06}>
                <a href="#start" className="pg-btn pg-btn-primary">
                  {BRAND.ctaPrimary} <ArrowRight size={18} />
                </a>
              </Reveal>
            </div>
          </section>

          <ProFooter to="/pro/1" />
        </>
      )}
    </ScrollStage>
  );
}
