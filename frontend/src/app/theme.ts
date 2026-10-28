// Theme: "dark" | "light", saved per device; applied before first paint by main.tsx. Until the user picks
// one, the OS appearance at launch decides (no live following — the app has exactly two modes).
export type ThemeChoice = "dark" | "light";
const KEY = "sutra_theme";

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch { /* storage unavailable */ }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(choice: ThemeChoice = readTheme(), persist = false): void {
  if (persist) { try { localStorage.setItem(KEY, choice); } catch { /* ignore */ } }
  const root = document.documentElement;
  try { (window as any).sutraDesktop?.theme?.(choice); } catch { /* not the desktop app */ }
  if (choice === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  // Phone: status bar colour and icons follow the theme.
  void import("../lib/nativeChrome").then((m) => m.syncNativeChrome()).catch(() => {});
}
