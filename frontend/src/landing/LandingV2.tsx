// ============================================================================
// Sutra — Landing variant 2: "TERMINAL"
// Brutalist-technical, near-black, JetBrains Mono + Space Grotesk, one signal
// color (terminal-green). The 3D is a MONOCHROME WIREFRAME MEMORY READOUT:
// a slowly-rotating wireframe globe (latitude/longitude line segments) wrapped
// in a scanning point-cloud "graph", rendered as lines + points on black with
// a subtle scanline/crosshair instrument feel. Built imperatively in useMemo.
// ============================================================================
import { Suspense, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { Canvas, useFrame } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import {
  AudioLines,
  Workflow,
  Sparkles,
  ShieldCheck,
  ArrowRight,
  CornerDownRight,
  type LucideIcon,
} from "lucide-react";
import { BRAND, usePrefersReducedMotion, useIsSmallScreen } from "./brand";
import "./LandingV2.css";

// The ONE signal color, as three.js Color (terminal-green).
const SIG = new THREE.Color("#3ddc97");
const SIG_DIM = new THREE.Color("#1f7a55");

// Deterministic PRNG so the headless screenshot is stable.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------------------
// Wireframe globe — latitude/longitude rings as LineSegments. Imperative geo.
// ----------------------------------------------------------------------------
function buildGlobe(radius: number, lats: number, longs: number, segs: number) {
  const pts: number[] = [];
  // latitude rings
  for (let i = 1; i < lats; i++) {
    const phi = (i / lats) * Math.PI; // 0..PI
    const y = Math.cos(phi) * radius;
    const r = Math.sin(phi) * radius;
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2;
      const a1 = ((s + 1) / segs) * Math.PI * 2;
      pts.push(Math.cos(a0) * r, y, Math.sin(a0) * r);
      pts.push(Math.cos(a1) * r, y, Math.sin(a1) * r);
    }
  }
  // longitude rings
  for (let j = 0; j < longs; j++) {
    const theta = (j / longs) * Math.PI * 2;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    for (let s = 0; s < segs; s++) {
      const p0 = (s / segs) * Math.PI;
      const p1 = ((s + 1) / segs) * Math.PI;
      const y0 = Math.cos(p0) * radius;
      const r0 = Math.sin(p0) * radius;
      const y1 = Math.cos(p1) * radius;
      const r1 = Math.sin(p1) * radius;
      pts.push(ct * r0, y0, st * r0);
      pts.push(ct * r1, y1, st * r1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

// ----------------------------------------------------------------------------
// Memory point-cloud: nodes on a fibonacci sphere + sparse nearest-neighbour
// edges. Points are the "memories"; edges are the threads between them.
// ----------------------------------------------------------------------------
function buildCloud(count: number, radius: number) {
  const rand = mulberry32(20260615);
  const pos: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const rad = radius * (0.97 + rand() * 0.08);
    pos.push(new THREE.Vector3(Math.cos(theta) * r * rad, y * rad, Math.sin(theta) * r * rad));
  }
  // points geometry
  const pArr: number[] = [];
  pos.forEach((p) => pArr.push(p.x, p.y, p.z));
  const points = new THREE.BufferGeometry();
  points.setAttribute("position", new THREE.Float32BufferAttribute(pArr, 3));

  // sparse edges: each node → 2 nearest
  const eArr: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const d: { j: number; v: number }[] = [];
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      d.push({ j, v: pos[i].distanceToSquared(pos[j]) });
    }
    d.sort((a, b) => a.v - b.v);
    for (let k = 0; k < 2; k++) {
      const j = d[k].j;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      eArr.push(pos[i].x, pos[i].y, pos[i].z, pos[j].x, pos[j].y, pos[j].z);
    }
  }
  const edges = new THREE.BufferGeometry();
  edges.setAttribute("position", new THREE.Float32BufferAttribute(eArr, 3));
  return { points, edges, count };
}

// ----------------------------------------------------------------------------
// The rotating instrument group. One slow Y rotation + a vertical "scan" plane
// that pulses the point cloud as it passes (rebuilds a color attribute per
// frame). Reads as an oscilloscope / point-cloud scanner, not a glossy orb.
// ----------------------------------------------------------------------------
function Scope({ reduced, small }: { reduced: boolean; small: boolean }) {
  const group = useRef<THREE.Group>(null!);

  const radius = 2.45;
  const globe = useMemo(
    () => buildGlobe(radius, small ? 6 : 9, small ? 8 : 12, small ? 36 : 64),
    [small],
  );
  const { points, edges, count } = useMemo(
    () => buildCloud(small ? 46 : 80, radius * 1.02),
    [small],
  );

  // per-point color attribute we mutate each frame for the scan sweep.
  // Bake one lit scan band at y≈0 so the static (reduced-motion) frame already
  // reads as an active instrument, not a dead dim cloud.
  const colorAttr = useMemo(() => {
    const arr = new Float32Array(count * 3);
    const posAttr = points.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const d = Math.abs(posAttr.getY(i) - 0.0);
      const k = Math.max(0, 1 - d / 0.55) ** 2;
      arr[i * 3] = SIG_DIM.r + (SIG.r - SIG_DIM.r) * k;
      arr[i * 3 + 1] = SIG_DIM.g + (SIG.g - SIG_DIM.g) * k;
      arr[i * 3 + 2] = SIG_DIM.b + (SIG.b - SIG_DIM.b) * k;
    }
    return new THREE.Float32BufferAttribute(arr, 3);
  }, [count, points]);

  // attach color attr once
  useMemo(() => {
    points.setAttribute("color", colorAttr);
  }, [points, colorAttr]);

  const yScratch = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, dt) => {
    const g = group.current;
    if (!g) return;
    if (reduced) return; // declarative pose holds; no mutation
    g.rotation.y += dt * 0.12;
    g.rotation.x = 0.16 + Math.sin(state.clock.elapsedTime * 0.18) * 0.05;

    // vertical scan sweep across the cloud (in local Y)
    const t = state.clock.elapsedTime;
    const sweepY = Math.sin(t * 0.7) * radius;
    const posAttr = points.getAttribute("position") as THREE.BufferAttribute;
    const col = colorAttr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      yScratch.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      const d = Math.abs(yScratch.y - sweepY);
      const hot = Math.max(0, 1 - d / 0.55); // band thickness
      const k = hot * hot;
      col[i * 3] = SIG_DIM.r + (SIG.r - SIG_DIM.r) * k;
      col[i * 3 + 1] = SIG_DIM.g + (SIG.g - SIG_DIM.g) * k;
      col[i * 3 + 2] = SIG_DIM.b + (SIG.b - SIG_DIM.b) * k;
    }
    colorAttr.needsUpdate = true;
  });

  return (
    <group ref={group} rotation={[0.16, -0.6, 0]}>
      {/* wireframe globe — dim structural lines */}
      <lineSegments geometry={globe}>
        <lineBasicMaterial color={SIG} transparent opacity={0.12} toneMapped={false} />
      </lineSegments>
      {/* memory threads — slightly brighter */}
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={SIG} transparent opacity={0.26} toneMapped={false} />
      </lineSegments>
      {/* memory nodes — point cloud with scanned vertex colors */}
      <points geometry={points}>
        <pointsMaterial
          size={small ? 0.06 : 0.05}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0.95}
          toneMapped={false}
        />
      </points>
    </group>
  );
}

function ScopeCanvas({ reduced, small }: { reduced: boolean; small: boolean }) {
  return (
    <Canvas
      dpr={[1, small ? 1.5 : 2]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 7.4], fov: 40 }}
      frameloop={reduced ? "never" : "always"}
    >
      <Suspense fallback={null}>
        <Scope reduced={reduced} small={small} />
        <EffectComposer enableNormalPass={false}>
          {/* Bloom kept deliberately tight — a faint phosphor lift on the hottest
              scanned nodes, not a glow. The display must read crisp, like a CRT
              instrument, not a glossy orb. */}
          <Bloom
            intensity={small ? 0.32 : 0.42}
            luminanceThreshold={0.55}
            luminanceSmoothing={0.32}
            mipmapBlur
            radius={0.32}
          />
        </EffectComposer>
      </Suspense>
    </Canvas>
  );
}

// ----------------------------------------------------------------------------
// DOM data.
// ----------------------------------------------------------------------------
const ICONS: Record<string, LucideIcon> = { AudioLines, Workflow, Sparkles, ShieldCheck };

// spec-sheet keys per pillar (mono metadata feel)
const SPEC_KEYS = ["IN · AMBIENT", "GRAPH · LINK", "QUERY · RAG", "LOCAL · E2E"];

// right-aligned register value per pillar — reads like a status register dump,
// the kind of column you'd see in a real instrument spec sheet.
const SPEC_REG = [
  { k: "0x01", v: "STREAMING" },
  { k: "0x02", v: "LINKED" },
  { k: "0x03", v: "GROUNDED" },
  { k: "0x04", v: "ENCRYPTED" },
];

// deterministic wave bar heights for step 1 (no Math.random in render)
const WAVE = [34, 62, 88, 48, 100, 70, 40, 80, 54, 92, 44, 72, 36, 84, 58];

export default function LandingV2() {
  const reduced = usePrefersReducedMotion();
  const small = useIsSmallScreen();

  // Keep the DOM readout honest to the geometry actually rendered (cloud count
  // drops on small screens), zero-padded for the spec-sheet register feel.
  const nodeStr = String(small ? 46 : 80).padStart(3, "0");

  return (
    <div className={`landing-root lv2${reduced ? " is-reduced" : ""}`}>
      <div className="lv2-shell">
        {/* ----------------------------------------------------------- TOP BAR */}
        <header className="lv2-topbar">
          <Link to="/landing/2" className="lv2-brand" aria-label="Sutra home">
            <span className="lv2-brand-mark" aria-hidden="true" />
            Sutra
            <span className="lv2-brand-deva" aria-hidden="true">
              सूत्र
            </span>
          </Link>
          <nav className="lv2-topnav" aria-label="Primary">
            <a href="#capture">01 / Capture</a>
            <a href="#connect">02 / Connect</a>
            <a href="#process">03 / Process</a>
            <a href="#start" className="lv2-topcta">
              {BRAND.ctaPrimary}
            </a>
          </nav>
        </header>

        <div className="lv2-body">
          {/* --------------------------------------------------- LEFT META RAIL */}
          <aside className="lv2-rail" aria-hidden="true">
            <div className="lv2-rail-block">
              <span className="lv2-rail-k">Status</span>
              <span className="lv2-rail-v is-sig lv2-rail-status">Listening</span>
            </div>
            <div className="lv2-rail-block">
              <span className="lv2-rail-k">System</span>
              <span className="lv2-rail-v">sutra / ambient-memory</span>
            </div>
            <div className="lv2-rail-block">
              <span className="lv2-rail-k">Lang</span>
              <span className="lv2-rail-v">EN · HI · HINGLISH</span>
            </div>
            <div className="lv2-rail-block">
              <span className="lv2-rail-k">Audio</span>
              <span className="lv2-rail-v">never persisted</span>
            </div>
            <div className="lv2-rail-block">
              <span className="lv2-rail-k">Store</span>
              <span className="lv2-rail-v">encrypted · on-device</span>
            </div>
            <span className="lv2-rail-spacer" />
            <div className="lv2-rail-block">
              <span className="lv2-rail-k">Build</span>
              <span className="lv2-rail-v">v2 · terminal</span>
            </div>
            <div className="lv2-rail-cursor">
              <b>sutra@local</b> ~ <span className="lv2-caret" />
            </div>
          </aside>

          {/* ------------------------------------------------------- MAIN COLUMN */}
          <main className="lv2-main">
            {/* ------------------------------------------------------------ HERO */}
            <section className="lv2-hero">
              <div className="lv2-hero-grid">
                <div className="lv2-hero-copy">
                  <span className="lv2-eyebrow">
                    <b>सूत्र</b> Sanskrit · "thread"
                  </span>
                  <h1 className="lv2-h1">
                    Conversations in.
                    <br />
                    Memory <span className="lv2-out">out</span>
                  </h1>
                  <p className="lv2-lead">
                    Sutra runs in the background and listens while you talk. Every conversation
                    becomes searchable memory — <b>summaries, action items, the people, the
                    decisions</b> — woven into one connected graph you can ask questions of.
                  </p>
                  <div className="lv2-cta-row">
                    <a href="#start" className="lv2-btn lv2-btn-primary">
                      {BRAND.ctaPrimary}
                      <ArrowRight className="lv2-ico" size={15} aria-hidden="true" />
                    </a>
                    <a href="#capture" className="lv2-btn lv2-btn-ghost">
                      {BRAND.ctaSecondary}
                    </a>
                  </div>
                  <span className="lv2-privacy">
                    <ShieldCheck size={14} aria-hidden="true" />
                    Audio is never stored — processed in the moment, then discarded.
                  </span>
                </div>

                {/* instrument panel */}
                <div className="lv2-hero-vis">
                  <div className="lv2-canvas" aria-hidden="true">
                    <ScopeCanvas reduced={reduced} small={small} />
                  </div>
                  <div className="lv2-scope-frame" aria-hidden="true">
                    <div className="lv2-scope-cross" />
                    <span className="lv2-corner tl" />
                    <span className="lv2-corner tr" />
                    <span className="lv2-corner bl" />
                    <span className="lv2-corner br" />
                    <div className="lv2-scope-head">
                      <span className="lv2-scope-tag">
                        <b>MEMORY</b> · READOUT
                      </span>
                      <span className="lv2-scope-sig">
                        SIG <b>#3DDC97</b>
                      </span>
                    </div>
                    <div className="lv2-scope-readout">
                      <span>
                        NODES <b>{nodeStr}</b>
                      </span>
                      <span>
                        THREADS <b>linked</b>
                      </span>
                      <span>
                        SCAN <b>{reduced ? "held" : "active"}</b>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* --------------------------------------------------- PILLARS SPEC */}
            <section id="capture" aria-labelledby="lv2-spec-h">
              <div className="lv2-sec-head">
                <span className="lv2-sec-no">// SPEC</span>
                <h2 className="lv2-sec-title" id="lv2-spec-h">
                  What the system does
                </h2>
                <p className="lv2-sec-note">
                  Four functions. No setup, no commands — it runs while you talk.
                </p>
              </div>
              <div className="lv2-spec">
                {BRAND.pillars.map((p, i) => {
                  const Icon = ICONS[p.icon] ?? Sparkles;
                  return (
                    <div className="lv2-spec-row" key={p.title}>
                      <span className="lv2-spec-no">0{i + 1}</span>
                      <div className="lv2-spec-main">
                        <div className="lv2-spec-head">
                          <Icon className="lv2-spec-ico" size={18} aria-hidden="true" />
                          <div>
                            <h3 className="lv2-spec-title">{p.title}</h3>
                            <span className="lv2-spec-key">{SPEC_KEYS[i]}</span>
                          </div>
                        </div>
                        <p className="lv2-spec-desc">{p.desc}</p>
                        <div className="lv2-spec-reg" aria-hidden="true">
                          <span className="lv2-spec-reg-k">{SPEC_REG[i].k}</span>
                          <span className="lv2-spec-reg-line" />
                          <span className="lv2-spec-reg-v">{SPEC_REG[i].v}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* ------------------------------------------------- HOW IT WORKS */}
            <section id="connect" aria-labelledby="lv2-flow-h">
              <div className="lv2-sec-head">
                <span className="lv2-sec-no">// FLOW</span>
                <h2 className="lv2-sec-title" id="lv2-flow-h">
                  Talk → weave → ask
                </h2>
                <p className="lv2-sec-note">Three beats, from spoken to searchable.</p>
              </div>
              <div className="lv2-flow">
                {/* 01 TALK */}
                <article className="lv2-flow-step">
                  <div className="lv2-flow-top">
                    <span className="lv2-flow-verb">Talk</span>
                    <span className="lv2-flow-idx">01</span>
                  </div>
                  <h3 className="lv2-flow-title">Just have the conversation.</h3>
                  <p className="lv2-flow-desc">
                    Sutra listens in the background — meetings, calls, hallway chats — in English,
                    Hindi or Hinglish. No note-taking, no commands.
                  </p>
                  <div className="lv2-wave" aria-hidden="true">
                    {WAVE.map((h, i) => (
                      <i
                        key={i}
                        style={{ height: `${h}%`, animationDelay: `${(i * 0.07).toFixed(2)}s` }}
                      />
                    ))}
                  </div>
                  <div className="lv2-flow-pipe" aria-hidden="true">
                    rec <span className="lv2-tick" /> stream
                  </div>
                </article>

                {/* 02 WEAVE */}
                <article className="lv2-flow-step" id="process">
                  <div className="lv2-flow-top">
                    <span className="lv2-flow-verb">Weave</span>
                    <span className="lv2-flow-idx">02</span>
                  </div>
                  <h3 className="lv2-flow-title">Threaded into your graph.</h3>
                  <p className="lv2-flow-desc">
                    People, topics, decisions and commitments are extracted and linked — each
                    conversation connected to everything related before it.
                  </p>
                  <div className="lv2-mini" aria-hidden="true">
                    <div className="lv2-mini-line">
                      <b>+</b> person <span className="lv2-ink">Priya</span>
                    </div>
                    <div className="lv2-mini-line">
                      <b>+</b> topic <span className="lv2-ink">Q3 launch</span>
                    </div>
                    <div className="lv2-mini-line">
                      <b>+</b> decision <span className="lv2-ink">ship Friday</span>
                    </div>
                    <div className="lv2-mini-line">
                      <b>~</b> link 3 · weave ok
                    </div>
                  </div>
                  <div className="lv2-flow-pipe" aria-hidden="true">
                    extract <span className="lv2-tick" /> link
                  </div>
                </article>

                {/* 03 ASK */}
                <article className="lv2-flow-step">
                  <div className="lv2-flow-top">
                    <span className="lv2-flow-verb">Ask</span>
                    <span className="lv2-flow-idx">03</span>
                  </div>
                  <h3 className="lv2-flow-title">Ask your memory anything.</h3>
                  <p className="lv2-flow-desc">
                    Query your past in plain language. Get a grounded answer in seconds — every
                    claim traced back to the conversation it came from.
                  </p>
                  <div className="lv2-ask" aria-hidden="true">
                    <span className="lv2-ask-q">What did we decide for Q3?</span>
                    <span className="lv2-ask-a">
                      Ship Friday, with Priya leading QA.
                      <span className="lv2-ask-cite">
                        <CornerDownRight size={11} aria-hidden="true" /> Standup · Jun 12
                      </span>
                    </span>
                  </div>
                  <div className="lv2-flow-pipe" aria-hidden="true">
                    query <span className="lv2-tick" /> answer
                  </div>
                </article>
              </div>
            </section>

            {/* --------------------------------------------------- CLOSING CTA */}
            <section className="lv2-closing" id="start" aria-labelledby="lv2-close-h">
              <div className="lv2-closing-inner">
                <span className="lv2-closing-eyebrow">Ready</span>
                <h2 className="lv2-closing-h2" id="lv2-close-h">
                  Stop taking notes.
                  <br />
                  Start <span className="lv2-out">remembering.</span>
                </h2>
                <p className="lv2-closing-lead">{BRAND.subShort}</p>
                <div className="lv2-closing-cta">
                  <a href="#start" className="lv2-btn lv2-btn-primary">
                    {BRAND.ctaPrimary}
                    <ArrowRight className="lv2-ico" size={15} aria-hidden="true" />
                  </a>
                  <a href="#capture" className="lv2-btn lv2-btn-ghost">
                    {BRAND.ctaSecondary}
                  </a>
                </div>
                <p className="lv2-closing-note">{BRAND.privacyLine}</p>
              </div>
            </section>

            {/* -------------------------------------------------------- FOOTER */}
            <footer className="lv2-footer">
              <div className="lv2-footer-top">
                <div className="lv2-footer-brand">
                  <span className="lv2-footer-word">
                    <span className="lv2-brand-mark" aria-hidden="true" />
                    Sutra
                  </span>
                  <p className="lv2-footer-tag">{BRAND.footerTagline}</p>
                  <span className="lv2-footer-privacy">
                    <ShieldCheck size={13} aria-hidden="true" />
                    {BRAND.privacyLine}
                  </span>
                </div>
                <nav className="lv2-footer-nav" aria-label="Footer">
                  <a href="#capture">Spec</a>
                  <a href="#connect">Flow</a>
                  <a href="#start">Get the app</a>
                </nav>
              </div>
              <div className="lv2-footer-bottom">
                <span>
                  Sutra · {BRAND.meaning}
                </span>
                <span>
                  <b>© 2026</b> · ambient memory
                </span>
              </div>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}
