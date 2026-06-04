import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 393, height: 852 } });
const page = await ctx.newPage();
await page.goto("http://localhost:8000/settings", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  // find the deepest element whose right edge is way off-screen
  let off = null;
  document.querySelectorAll("svg, img, div, span, a, button, input").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1000 && (!off || r.right > off.r.right)) off = { el, r };
  });
  if (!off) return { vw, msg: "none" };
  // walk up ancestors reporting computed layout
  const chain = [];
  let n = off.el, depth = 0;
  while (n && depth < 8) {
    const cs = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    chain.push({
      tag: n.tagName, cls: (typeof n.className === "string" ? n.className : (n.getAttribute("class") || "")).slice(0, 40),
      left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
      position: cs.position, transform: cs.transform.slice(0, 30), ws: cs.whiteSpace, display: cs.display,
    });
    n = n.parentElement; depth++;
  }
  return { vw, chain };
});
console.log(JSON.stringify(info, null, 2));
await b.close();
