import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

// Per-route scroll restoration. The routed .page div is the scroll container (body is overflow:hidden)
// and it REMOUNTS per route, so we query it inside the effect rather than holding a ref. Positions are
// kept in a module-scoped Map so they survive route changes. Renders nothing.
const positions = new Map<string, number>();

export function ScrollMemory() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    let el: HTMLElement | null = null;
    const onScroll = () => { if (el) positions.set(pathname, el.scrollTop); };
    // Two rAFs: wait for the lazy page (Suspense) to mount + lay out before restoring/attaching.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        el = document.querySelector(".page");
        if (!el) return; // page not mounted yet (or this route has none) — bail quietly
        el.scrollTop = positions.get(pathname) ?? 0;
        el.addEventListener("scroll", onScroll, { passive: true });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      el?.removeEventListener("scroll", onScroll);
    };
  }, [pathname]);

  return null;
}
