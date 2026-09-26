// Tiny app-wide "data changed" signal so the sidebar and the open meeting refresh after a recording
// finishes, a meeting is deleted, a tag changes, … without a state library.
import { useEffect, useState } from "react";

const EVT = "sutra:data";

export function notifyDataChanged(): void {
  try { window.dispatchEvent(new Event(EVT)); } catch { /* non-DOM */ }
}

/** A counter that bumps on every notifyDataChanged() — use it as an effect dependency. */
export function useDataVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const on = () => setV((x) => x + 1);
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return v;
}
