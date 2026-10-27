// ============================================================================
// Sutra · landing-pro — the scroll-choreography engine. SHARED, READ-ONLY.
//
// Renders a FIXED full-viewport 3D stage pinned behind NORMAL-FLOW content that
// scrolls over it (Apple-style "one continuous world"). It owns ONE source of
// truth — a smoothed 0..1 scroll-progress value in a ref — that the 3D scene
// reads each frame (useFrame) to scrub camera/scene state. Foreground text
// reveals on enter via GSAP ScrollTrigger (custom scroller = our container).
//
// Why a ref + render-prop (not React context): R3F's <Canvas> spins up its own
// reconciler and does NOT forward outer React context across that boundary.
// Passing a plain ref object as a prop into the scene works flawlessly instead.
// ============================================================================
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type MutableRefObject,
  type RefObject,
} from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(ScrollTrigger, useGSAP);

/** Handed to both the 3D scene and the foreground content. */
export interface StageApi {
  /** The scroll container element. */
  rootRef: RefObject<HTMLDivElement | null>;
  /** Smoothed whole-page scroll progress, 0 (top) .. 1 (bottom). Read in useFrame. */
  progressRef: MutableRefObject<number>;
  /** Smoothed per-frame delta of progress — a cheap "scroll velocity". */
  velocityRef: MutableRefObject<number>;
  reduced: boolean;
}

interface ScrollStageProps {
  theme: "dark" | "light";
  /** Per-variant palette overrides (CSS custom properties on .pro-root). */
  vars?: CSSProperties;
  /** Unique variant root class, e.g. "pv1". */
  className?: string;
  reduced: boolean;
  /** The 3D layer — typically a full <Canvas>. Receives the live api. */
  scene: (api: StageApi) => ReactNode;
  /** The scrolling foreground content. Receives the live api. */
  children: (api: StageApi) => ReactNode;
}

export default function ScrollStage({
  theme,
  vars,
  className,
  reduced,
  scene,
  children,
}: ScrollStageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef(0);
  const targetRef = useRef(0);
  const velocityRef = useRef(0);

  const api: StageApi = { rootRef, progressRef, velocityRef, reduced };

  // ---- scroll → smoothed progress ----------------------------------------
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      const max = root.scrollHeight - root.clientHeight;
      targetRef.current = max > 0 ? Math.min(1, Math.max(0, root.scrollTop / max)) : 0;
    };
    measure();

    if (reduced) {
      // No smoothing loop — snap progress to scroll so a scene that re-paints on
      // demand still reflects position, but nothing animates on its own.
      progressRef.current = targetRef.current;
      const onScroll = () => {
        measure();
        progressRef.current = targetRef.current;
      };
      root.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", measure);
      return () => {
        root.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", measure);
      };
    }

    let raf = 0;
    const tick = () => {
      const cur = progressRef.current;
      const next = cur + (targetRef.current - cur) * 0.085; // critically-damped feel
      velocityRef.current = next - cur;
      progressRef.current = Math.abs(next - targetRef.current) < 1e-5 ? targetRef.current : next;
      raf = requestAnimationFrame(tick);
    };
    root.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    raf = requestAnimationFrame(tick);
    return () => {
      root.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(raf);
    };
  }, [reduced]);

  // ---- foreground reveals (GSAP ScrollTrigger, scroller = our container) ----
  useGSAP(
    () => {
      const root = rootRef.current;
      if (!root) return;

      if (reduced) {
        gsap.set(root.querySelectorAll(".pro-reveal"), { opacity: 1, y: 0, clearProps: "transform" });
        return;
      }

      const items = gsap.utils.toArray<HTMLElement>(root.querySelectorAll(".pro-reveal"));
      items.forEach((el) => {
        const delay = parseFloat(el.dataset.delay || "0");
        gsap.fromTo(
          el,
          { opacity: 0, y: 44 },
          {
            opacity: 1,
            y: 0,
            duration: 1.05,
            ease: "power3.out",
            delay,
            scrollTrigger: { trigger: el, scroller: root, start: "top 88%", once: true },
          },
        );
      });
      // fonts/layout settle after first paint — recompute trigger positions.
      const r = setTimeout(() => ScrollTrigger.refresh(), 350);
      return () => clearTimeout(r);
    },
    { dependencies: [reduced], scope: rootRef },
  );

  return (
    <div className={`pro-root ${className ?? ""}`} data-theme={theme} style={vars} ref={rootRef}>
      <div className="pro-stage" aria-hidden="true">
        {scene(api)}
      </div>
      <div className="pro-flow">{children(api)}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helpers shared by every variant.
// ---------------------------------------------------------------------------

/** Toggles `true` once the container has scrolled past `threshold`px. For nav. */
export function useScrolledPast(rootRef: RefObject<HTMLDivElement | null>, threshold = 40): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const on = () => setScrolled(root.scrollTop > threshold);
    on();
    root.addEventListener("scroll", on, { passive: true });
    return () => root.removeEventListener("scroll", on);
  }, [rootRef, threshold]);
  return scrolled;
}

/** Convenience wrapper for reveal-on-enter content. */
export function Reveal({
  children,
  delay,
  as: Tag = "div",
  className,
  ...rest
}: {
  children: ReactNode;
  delay?: number;
  as?: any;
  className?: string;
} & Record<string, unknown>) {
  return (
    <Tag className={`pro-reveal ${className ?? ""}`} data-delay={delay} {...rest}>
      {children}
    </Tag>
  );
}
