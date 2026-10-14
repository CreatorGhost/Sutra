// ============================================================================
// Sutra · landing-pro — shared, theme-aware UI primitives. SHARED, READ-ONLY.
// Nav / Footer / Pillars read the active variant's palette through CSS vars, so
// the same component looks correct on a light or dark page. Variant authors
// compose these and add their own bespoke 3D-narrative sections.
// ============================================================================
import { type RefObject } from "react";
import { Link } from "react-router-dom";
import {
  AudioLines,
  Workflow,
  Sparkles,
  ShieldCheck,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { BRAND } from "../landing/brand";
import { useScrolledPast, Reveal } from "./ScrollStage";

const PILLAR_ICONS: Record<string, LucideIcon> = { AudioLines, Workflow, Sparkles, ShieldCheck };

/** Sticky top bar; gains a frosted background once scrolled. */
export function ProNav({
  rootRef,
  to,
  ctaHref = "#start",
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  to: string;
  ctaHref?: string;
}) {
  const scrolled = useScrolledPast(rootRef, 48);
  return (
    <nav className={`pg-nav ${scrolled ? "is-scrolled" : ""}`} aria-label="Primary">
      <Link to={to} className="pg-brand" aria-label="Sutra home">
        <span className="pg-brand-dot" aria-hidden="true" />
        <span className="pg-brand-name">{BRAND.name}</span>
        <span className="pg-brand-sa" aria-hidden="true">सूत्र</span>
      </Link>
      <div className="pg-nav-links">
        <a href="#how" className="pg-nav-link">How it works</a>
        <a href="#features" className="pg-nav-link">Features</a>
        <a href="#privacy" className="pg-nav-link">Privacy</a>
        <a href={ctaHref} className="pg-nav-cta">
          {BRAND.ctaPrimary}
          <ArrowRight size={15} aria-hidden="true" />
        </a>
      </div>
    </nav>
  );
}

/** The four product pillars as reveal-on-enter cards. */
export function Pillars({ kicker = "Why Sutra" }: { kicker?: string }) {
  return (
    <div className="pg-grid">
      {BRAND.pillars.map((p, i) => {
        const Icon = PILLAR_ICONS[p.icon] ?? Sparkles;
        return (
          <Reveal as="article" className="pg-card" delay={i * 0.06} key={p.title}>
            <span className="pg-card-icon" aria-hidden="true">
              <Icon size={22} strokeWidth={1.7} />
            </span>
            <h3 className="pg-card-title">{p.title}</h3>
            <p className="pg-card-desc">{p.desc}</p>
          </Reveal>
        );
      })}
    </div>
  );
}

/** Footer used by every variant. */
export function ProFooter({ to }: { to: string }) {
  return (
    <footer className="pg-footer" id="start">
      <div className="pg-wrap pg-footer-inner">
        <div>
          <Link to={to} className="pg-brand" aria-label="Sutra home">
            <span className="pg-brand-dot" aria-hidden="true" />
            <span className="pg-brand-name">{BRAND.name}</span>
          </Link>
          <p className="pg-footer-tag">{BRAND.footerTagline}</p>
          <p className="pg-footer-priv">
            <ShieldCheck size={13} aria-hidden="true" />
            {BRAND.privacyLine}
          </p>
        </div>
        <nav className="pg-footer-links" aria-label="Footer">
          <span className="pg-footer-col">Sutra</span>
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#privacy">Privacy</a>
        </nav>
      </div>
      <p className="pg-footer-rule">{BRAND.meaning}</p>
    </footer>
  );
}
