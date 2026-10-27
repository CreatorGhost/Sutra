// Variant picker for the scroll-choreographed 3D homepage set. Clean index only.
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { BRAND } from "../landing/brand";

const VARIANTS = [
  {
    n: 1,
    name: "Constellation",
    mood: "Dark · cinematic",
    concept:
      "Scattered particles drift in deep space, then fly together and link into a glowing 3D knowledge graph as you scroll — your memory, assembling itself.",
    a: "#8b7bff",
    b: "#07060e",
  },
  {
    n: 2,
    name: "Whitelight",
    mood: "Light · Apple-white",
    concept:
      "A soft audio ribbon on pure white straightens into transcript lines, folds into a summary card, then fans into action items. Huge calm type, endless whitespace.",
    a: "#6f5cf0",
    b: "#f6f5f1",
  },
  {
    n: 3,
    name: "The Vault",
    mood: "Dark · glass",
    concept:
      "A real refractive glass monolith. Audio streams in, dissolves to nothing (never stored), and memory crystallizes inside the encrypted vault.",
    a: "#5fe6ff",
    b: "#04090d",
  },
  {
    n: 4,
    name: "Liquid",
    mood: "Light · airy",
    concept:
      "A warm morphing fluid blob splits into conversation orbs, arranges into your week, and reforms. Cream, peach and coral — soft, dreamy, effortless.",
    a: "#ff9e7d",
    b: "#fbf6f0",
  },
  {
    n: 5,
    name: "Dawn",
    mood: "Dark → light · journey",
    concept:
      "The camera flies along the सूत्र thread while the whole world transitions from indigo night to golden dawn, moments knotting into a woven tapestry.",
    a: "#ffc36e",
    b: "#0a0820",
  },
];

export default function ProGallery() {
  return (
    <div className="pro-root" data-theme="dark">
      <div className="pro-flow">
        <div className="pg-wrap" style={{ paddingBlock: "clamp(54px, 10vh, 120px)" }}>
          <p className="pg-eyebrow">{BRAND.name} · homepage concepts</p>
          <h1 className="pg-h2" style={{ marginTop: 12, marginBottom: 14, maxWidth: "18ch" }}>
            Five scroll-choreographed worlds.
          </h1>
          <p className="pg-lead" style={{ marginBottom: 44 }}>
            Each is a complete homepage built as one continuous 3D scene that animates as you scroll —
            Apple-grade motion, every concept a distinct mood. Open each full-screen and pick the one that feels like Sutra.
          </p>

          <div
            style={{
              display: "grid",
              gap: 18,
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            }}
          >
            {VARIANTS.map((v) => (
              <Link
                key={v.n}
                to={`/pro/${v.n}`}
                className="pg-card"
                style={{ display: "block", textDecoration: "none", color: "inherit" }}
              >
                <div
                  aria-hidden="true"
                  style={{
                    height: 96,
                    borderRadius: 12,
                    marginBottom: 18,
                    background: `radial-gradient(120% 120% at 20% 10%, ${v.a}55, transparent 60%), linear-gradient(135deg, ${v.b}, ${v.a}22)`,
                    border: "1px solid var(--pg-card-border)",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="pg-mono" style={{ color: v.a, fontSize: "0.8rem" }}>0{v.n}</span>
                  <span className="pg-mono pg-muted" style={{ fontSize: "0.72rem", letterSpacing: "0.12em", textTransform: "uppercase" }}>{v.mood}</span>
                </div>
                <h2 className="pg-card-title" style={{ marginTop: 8, fontSize: "1.4rem" }}>{v.name}</h2>
                <p className="pg-card-desc">{v.concept}</p>
                <span className="pg-accent-text" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 14, fontSize: "0.92rem", fontWeight: 550 }}>
                  Open full-screen <ArrowRight size={15} />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
