import { useEffect, useRef } from "react";

/** Hold a screen wake lock while `active`, re-acquiring when the tab returns to view. */
export function useWakeLock(active: boolean) {
  const lockRef = useRef<any>(null);
  useEffect(() => {
    let cancelled = false;
    const acquire = async () => {
      try {
        if (active && "wakeLock" in navigator && document.visibilityState === "visible") {
          lockRef.current = await (navigator as any).wakeLock.request("screen");
        }
      } catch { /* refused (e.g. low battery) — non-fatal */ }
    };
    const onVis = () => { if (document.visibilityState === "visible") acquire(); };
    if (active) { acquire(); document.addEventListener("visibilitychange", onVis); }
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      try { lockRef.current?.release?.(); } catch { /* ignore */ }
      lockRef.current = null;
      void cancelled;
    };
  }, [active]);
}
