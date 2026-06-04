import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", e => errs.push(e.message));
for (const [r,n] of [["/","prod-capture"],["/settings","prod-settings"],["/graph","prod-graph"]]) {
  await p.goto("http://localhost:8000"+r, { waitUntil: "networkidle" }); await p.waitForTimeout(1500);
  await p.screenshot({ path: `/tmp/sutra-shots/${n}.png` });
}
console.log("prod UI pageerrors:", JSON.stringify(errs));
await b.close();
