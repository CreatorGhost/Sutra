// Theme: "system" | "dark" | "light", saved per device; applied before first paint by main.tsx.
export type ThemeChoice = "system" | "dark" | "light";
const KEY = "sutra_theme";

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

let mql: MediaQueryList | null = null;
const onSystemChange = () => applyTheme("system");

export function applyTheme(choice: ThemeChoice = readTheme(), persist = false): void {
  if (persist) { try { localStorage.setItem(KEY, choice); } catch { /* ignore */ } }
  const light = choice === "light" || (choice === "system" && !!window.matchMedia?.("(prefers-color-scheme: light)").matches);
  const root = document.documentElement;
  if (light) root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  // Follow live OS changes only while "system" is chosen.
  mql ??= window.matchMedia?.("(prefers-color-scheme: light)") ?? null;
  mql?.removeEventListener?.("change", onSystemChange);
  if (choice === "system") mql?.addEventListener?.("change", onSystemChange);
}
