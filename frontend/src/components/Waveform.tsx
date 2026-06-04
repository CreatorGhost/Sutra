import { useEffect, useRef } from "react";

/** Animated capture visualizer — layered organic waves whose amplitude follows the mic level.
 *  Idle = a slow breathing pulse. Pure canvas + rAF (no deps). The emotional centerpiece. */
export function Waveform({ active, level }: { active: boolean; level: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const levelRef = useRef(level);
  levelRef.current = level;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    const css = getComputedStyle(document.documentElement);
    const accent = (css.getPropertyValue("--accent").trim() || "#8b7bff");
    let t = 0, smooth = 0, raf = 0;
    const resize = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(cv);
    const hex = (a: string) => accent + a;
    const draw = () => {
      const w = cv.clientWidth, h = cv.clientHeight, mid = h / 2;
      const target = activeRef.current ? Math.max(0.08, Math.min(1, levelRef.current)) : 0.05;
      smooth += (target - smooth) * 0.12;
      const amp = smooth * h * 0.46;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = hex("44"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
      for (let layer = 0; layer < 3; layer++) {
        const a = amp * (1 - layer * 0.3);
        const ph = t * (1 + layer * 0.6);
        const freq = 1.7 + layer * 0.8;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 4) {
          const k = x / w;
          const env = Math.sin(k * Math.PI);
          const y = mid + Math.sin(k * Math.PI * freq + ph) * a * env * (0.65 + 0.35 * Math.sin(t * 0.7 + layer));
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = hex(layer === 0 ? "ee" : layer === 1 ? "99" : "55");
        ctx.lineWidth = layer === 0 ? 2.2 : 1.4;
        ctx.shadowColor = accent; ctx.shadowBlur = layer === 0 ? 16 : 7;
        ctx.stroke(); ctx.shadowBlur = 0;
      }
      t += activeRef.current ? 0.07 : 0.022;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={ref} aria-hidden />;
}
