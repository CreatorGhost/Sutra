// Variant picker — links to the 5 homepage concepts so they can be reviewed side by side.
// Not a final marketing page; just a clean index.
import { Link } from "react-router-dom";
import { BRAND } from "./brand";

const VARIANTS = [
  { n: 1, name: "The Thread", concept: "Dark & cinematic. Flowing 3D threads weave glowing conversation-nodes onto a single strand. Sutra = सूत्र, the thread.", tint: "var(--accent)" },
  { n: 2, name: "Terminal", concept: "Brutalist-technical. Near-black, monospace, hairline grids and a wireframe memory readout with HUD labels. A precision instrument.", tint: "var(--ok)" },
  { n: 3, name: "Field Notes", concept: "Warm & light. Cream paper, ink, a serif voice and an organic ink-in-water form. Memory as a beautiful journal.", tint: "var(--amber)" },
  { n: 4, name: "Aurora", concept: "Luminous soft-futurism. A flowing gradient fluid orb in an ethereal aurora field. Bright, dreamy, airy, premium.", tint: "var(--accent-2)" },
  { n: 5, name: "Swiss", concept: "Gallery-grade minimalism. Stark monochrome, a strict grid, enormous restrained type where the typography is the design.", tint: "var(--text)" },
];

export default function LandingGallery() {
  return (
    <div className="landing-root">
      <div className="l-container" style={{ paddingBlock: "clamp(48px, 9vh, 110px)" }}>
        <div className="l-eyebrow">{BRAND.name} · homepage concepts</div>
        <h1 className="l-h2" style={{ marginTop: 10, marginBottom: 10 }}>Five directions for the website</h1>
        <p className="l-lead" style={{ marginBottom: 40 }}>
          Each is a complete, premium homepage with its own 3D centerpiece. Open them full-screen and pick the one that feels like Sutra.
        </p>
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {VARIANTS.map((v) => (
            <Link key={v.n} to={`/landing/${v.n}`} className="card tap" style={{ display: "block", textDecoration: "none" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="mono" style={{ color: v.tint, fontSize: "var(--fs-xs)" }}>0{v.n}</span>
                <span className="chip accent">View →</span>
              </div>
              <div className="ctitle" style={{ marginTop: 10 }}>{v.name}</div>
              <p className="cdesc">{v.concept}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
