import type { ReactNode } from "react";

export function Empty({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="empty fade-in">
      {icon}
      <div style={{ fontSize: "var(--fs-body)", color: "var(--muted)", marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: "var(--fs-s)" }}>{hint}</div>}
    </div>
  );
}

export function Spinner() { return <span className="spinner" />; }

/** Loading placeholder that mirrors the real list anatomy (a faint section bar + rows shaped like
 *  the settings-row: leading dot, title bar, subtitle bar). Replaces blank dark voids during load.
 *  `bar` draws the faint Today/Yesterday-style section header above the rows. The shimmer is the
 *  shared `.skeleton` keyframe — already neutralized under prefers-reduced-motion. */
export function SkeletonList({ rows = 3, bar = true }: { rows?: number; bar?: boolean }) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {bar && <div className="skeleton skeleton-section" />}
      <div className="settings-group-body">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton-row">
            <span className="skeleton skeleton-dot" />
            <span className="skeleton-row-main">
              <span className="skeleton skeleton-bar" style={{ width: `${68 - i * 9}%` }} />
              <span className="skeleton skeleton-bar sub" style={{ width: `${52 - i * 6}%` }} />
            </span>
            <span className="skeleton skeleton-meta" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Loading placeholder for a DRILLED-IN detail view (conversation / minutes). Mirrors the real
 *  page anatomy — a sub-line, a pill-toggle row, then a tall summary card and a couple of shorter
 *  cards — so a detail open never flashes a single blank dark block. Shares the `.skeleton` shimmer
 *  (already neutralized under prefers-reduced-motion). */
export function SkeletonDetail() {
  return (
    <div className="skeleton-detail" aria-hidden="true">
      <span className="skeleton skeleton-bar" style={{ width: "32%", height: 11, marginBottom: 18 }} />
      <span className="skeleton" style={{ display: "block", height: 40, borderRadius: 12, marginBottom: 18 }} />
      <span className="skeleton" style={{ display: "block", height: 132, borderRadius: 16, marginBottom: 12 }} />
      <span className="skeleton" style={{ display: "block", height: 96, borderRadius: 16, marginBottom: 12 }} />
      <span className="skeleton" style={{ display: "block", height: 72, borderRadius: 16 }} />
    </div>
  );
}

export function Chip({ children, kind }: { children: ReactNode; kind?: string }) {
  return <span className={`chip ${kind ?? ""}`}>{children}</span>;
}

/** True for benign engine limitations that should never paint the global banner
 *  (e.g. web sql.js lacks FTS5 — the device build has it). */
export function isBenignError(message?: string | null) {
  if (!message) return false;
  return /no such module:\s*fts5/i.test(String(message));
}

export function ErrorBar({ message, onDismiss }: { message?: string | null; onDismiss?: () => void }) {
  if (!message) return null;
  const raw = String(message);
  // never leak raw engine/SQL exceptions to users — show a friendly line, log the real one
  const technical = /executesql|no such module|sqlite|sql logic|fts5|datatype mismatch|near "/i.test(raw);
  if (technical) console.error("[sutra] error:", raw);
  const shown = technical ? "Something went wrong loading this. Try reopening the app." : raw;
  return (
    <div className="card fade-in row" style={{ borderColor: "rgba(240,85,107,0.35)", color: "var(--danger)", marginBottom: 14, padding: "10px 14px", fontSize: "var(--fs-s)", alignItems: "flex-start", gap: 10 }}>
      <span style={{ flex: 1 }}>{shown}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" title="Dismiss"
          style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 13, margin: -13, lineHeight: 1, fontSize: "var(--fs-xl)", flexShrink: 0, opacity: 0.8 }}>×</button>
      )}
    </div>
  );
}

/** Quiet inline "couldn't load — retry" for one section degrading independently
 *  (vs. the full-page ErrorBar). */
export function SectionError({ onRetry, label }: { onRetry?: () => void; label?: string }) {
  return (
    <div className="row faint" style={{ fontSize: "var(--fs-s)", gap: 10, padding: "10px 2px" }}>
      <span style={{ flex: 1 }}>{label ?? "Couldn't load this."}</span>
      {onRetry && <button className="btn ghost sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}

const TYPE_COLOR: Record<string, string> = {
  person: "#7c6cff", project: "#34d39a", topic: "#f5b14c", org: "#56ccf2",
  place: "#f0556b", event: "#c084fc", commitment: "#fde047",
};
export function typeColor(t: string) { return TYPE_COLOR[t] ?? "#9a9aa7"; }
