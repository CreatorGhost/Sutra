import { useEffect, useRef, useState, type ReactNode } from "react";

/** App icon from the OS when we have it, else a letter glyph. */
export function AppIcon({ src, name, size = 22, className = "app-icon" }: { src?: string; name?: string | null; size?: number; className?: string }) {
  if (src) return <img className={className} src={src} alt="" width={size} height={size} />;
  const letter = (name || "•").trim().charAt(0).toUpperCase();
  return <span className={`app-glyph ${className}`} style={{ width: size, height: size }} aria-hidden>{letter}</span>;
}

/** Five bars driven by a 0..1 level. */
export function LevelBars({ level, count = 5 }: { level: number; count?: number }) {
  const l = Math.min(1, Math.max(0, level * 6)); // speech RMS is small; stretch it
  const shape = [0.45, 0.8, 1, 0.7, 0.5, 0.85, 0.6];
  return (
    <span className="bars" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} style={{ height: `${Math.max(3, Math.round(3 + l * shape[i % shape.length] * 15))}px` }} />
      ))}
    </span>
  );
}

/** A click-away popover anchored under its trigger. */
export function Popover({ trigger, children, open, onOpenChange }: {
  trigger: ReactNode; children: ReactNode; open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onOpenChange(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, onOpenChange]);
  return (
    <div className="pop-wrap" ref={ref}>
      {trigger}
      {open && <div className="menu" role="menu">{children}</div>}
    </div>
  );
}

/** Transient confirmation ("Copied"). */
export function useToast(): [ReactNode, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (m: string) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 1800);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [msg ? <div className="toast" role="status">{msg}</div> : null, show];
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

/** Friendly error text: never leak raw SQL/engine errors. */
export function friendlyError(e: unknown): string {
  const raw = String((e as any)?.message ?? e ?? "").replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
  const dbDown = raw.match(/SUTRA_DB_UNAVAILABLE:\s*(.*)$/s);
  if (dbDown) return dbDown[1].trim();
  if (/executesql|no such (module|table|column)|sqlite|sql logic|fts5|datatype mismatch|near "/i.test(raw)) {
    console.error("[sutra]", raw);
    return "Something went wrong reading your notes. Try restarting Sutra.";
  }
  if (/unreachable|failed to fetch|networkerror/i.test(raw)) return "Can't reach the Sutra service — check your connection.";
  return raw || "Something went wrong.";
}

/** The real app logo (Google Chrome, WhatsApp, Zoom…) from the OS, via the desktop bridge. */
const iconCache = new Map<string, Promise<string | null>>();
export function useAppIcon(name: string | null | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(undefined);
  useEffect(() => {
    const bridge = (globalThis as any).sutraDesktop;
    if (!name || !bridge?.icon) { setSrc(undefined); return; }
    let alive = true;
    if (!iconCache.has(name)) iconCache.set(name, bridge.icon(name).catch(() => null));
    void iconCache.get(name)!.then((s) => { if (alive) setSrc(s ?? undefined); });
    return () => { alive = false; };
  }, [name]);
  return src;
}
