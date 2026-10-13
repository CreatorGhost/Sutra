// Small building blocks shared by the Settings sections. They only arrange the existing classes
// (.set-group / .set-card / .set-row / .switch) so every section looks like the original sheet.
import { useEffect, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { api } from "../../local/sutra";
import { Popover, Switch } from "../ui";

export type Settings = Record<string, unknown>;
/** What every section gets from the sheet: the current settings and a saver that returns the new ones. */
export interface SectionProps { settings: Settings; put: (patch: Settings) => Promise<void>; toast: (msg: string) => void }

export function Group({ label, hint, children }: { label?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="set-group">
      {label && <div className="set-label">{label}</div>}
      <div className="set-card">{children}</div>
      {hint && <p className="set-hint">{hint}</p>}
    </div>
  );
}

export function Row({ title, desc, children, className }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={`set-row${className ? ` ${className}` : ""}`}>
      <div className="grow"><div className="t">{title}</div>{desc && <div className="d">{desc}</div>}</div>
      {children}
    </div>
  );
}

export function SwitchRow({ title, desc, checked, onChange, disabled }: { title: string; desc?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Row title={title} desc={desc}>
      <span style={disabled ? { opacity: 0.45, pointerEvents: "none" } : undefined}><Switch checked={checked} onChange={onChange} label={title} /></span>
    </Row>
  );
}

/** A "…" menu for row actions (opens leftward from the right edge). */
export function RowMenu({ label, items }: { label: string; items: { label: string; icon?: ReactNode; danger?: boolean; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="set-menu">
      <Popover open={open} onOpenChange={setOpen}
        trigger={<button className="icon-btn ghost sm" aria-label={label} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}><MoreHorizontal size={17} /></button>}>
        {items.map((it) => (
          <button key={it.label} role="menuitem" className={it.danger ? "danger" : undefined} onClick={() => { setOpen(false); it.onSelect(); }}>
            {it.icon}{it.label}
          </button>
        ))}
      </Popover>
    </div>
  );
}

/** Status dot + label. */
export function Status({ kind, children }: { kind?: "ok" | "err"; children: ReactNode }) {
  return <span className="status"><i className={`dot${kind ? ` ${kind}` : ""}`} />{children}</span>;
}

export function useMedia(query: string): boolean {
  const get = () => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const h = () => setOn(m.matches);
    m.addEventListener?.("change", h);
    return () => m.removeEventListener?.("change", h);
  }, [query]);
  return on;
}

/** Copy to the clipboard with the WebView-safe fallback the rest of the app uses. */
export const copy = (text: string): Promise<boolean> => api.copyText(text);
