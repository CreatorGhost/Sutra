import type { ReactNode } from "react";

export function Empty({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="empty fade-in">
      {icon}
      <div style={{ fontSize: 15, color: "var(--muted)", marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 13 }}>{hint}</div>}
    </div>
  );
}

export function Spinner() { return <span className="spinner" />; }

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
    <div className="card fade-in row" style={{ borderColor: "rgba(240,85,107,0.35)", color: "var(--danger)", marginBottom: 14, padding: "10px 14px", fontSize: 13.5, alignItems: "flex-start", gap: 10 }}>
      <span style={{ flex: 1 }}>{shown}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" title="Dismiss"
          style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1, fontSize: 18, flexShrink: 0, opacity: 0.8 }}>×</button>
      )}
    </div>
  );
}

/** Quiet inline "couldn't load — retry" for one section degrading independently
 *  (vs. the full-page ErrorBar). */
export function SectionError({ onRetry, label }: { onRetry?: () => void; label?: string }) {
  return (
    <div className="row faint" style={{ fontSize: 13, gap: 10, padding: "10px 2px" }}>
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
