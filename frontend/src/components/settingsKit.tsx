import { tapHaptic } from "../lib/nativeChrome";

// Module-scoped so its identity is stable across renders — defining it INSIDE Settings made every
// keystroke remount the section and steal focus from inputs (one-char-then-blocked bug).
export function Section({ icon, title, children }: any) {
  return (
    <section className="settings-group">
      <div className="settings-group-title">{icon}<strong>{title}</strong></div>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

export function SwitchRow({ label, caption, checked, disabled, onChange }: {
  label: string;
  caption?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void | Promise<void>;
}) {
  return (
    <button
      type="button"
      className="settings-row switch-row"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        void tapHaptic();
        void onChange(!checked);
      }}
    >
      <span className="settings-row-main">
        <strong>{label}</strong>
        {caption && <small>{caption}</small>}
      </span>
      <span className={`switch ${checked ? "on" : ""}`} aria-hidden="true"><span /></span>
    </button>
  );
}

export type ThemeChoice = "system" | "dark" | "light";
// Resolve + apply an appearance choice immediately (mirrors the boot logic in main.tsx).
// Dark is the default; "light" applies the light tokens, "system" follows the OS preference.
export function applyThemeChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  const light = choice === "light" || (choice === "system" && window.matchMedia?.("(prefers-color-scheme: light)").matches);
  if (light) root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
}
export function readThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem("sutra_theme");
    if (v === "system" || v === "light" || v === "dark") return v;
  } catch { /* localStorage unavailable */ }
  return "dark";
}
