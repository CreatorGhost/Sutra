import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 393, height: 852 } });
const page = await ctx.newPage();
const errs=[]; page.on("pageerror",e=>errs.push(e.message.slice(0,160)));
await page.goto("http://localhost:8000/settings", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const wide = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  document.querySelectorAll("*").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > vw + 2 || r.right > vw + 50) {
      out.push({ tag: el.tagName, cls: (el.className||"").toString().slice(0,40), w: Math.round(r.width), right: Math.round(r.right) });
    }
  });
  return { vw, count: out.length, widest: out.sort((a,b)=>b.w-a.w).slice(0,8) };
});
console.log("pageerrors:", JSON.stringify(errs));
console.log(JSON.stringify(wide, null, 2));
await b.close();
