import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: true });
const errs = [];
const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
p.on("pageerror", (e) => errs.push(e.message.slice(0, 140)));
await p.goto("http://localhost:4174/preview.html", { waitUntil: "networkidle" });
await p.waitForTimeout(1800);
await p.screenshot({ path: "/tmp/sutra-shots/polish-home-fold.png" });          // hero above the fold
await p.screenshot({ path: "/tmp/sutra-shots/polish-home-full.png", fullPage: true }); // home + swatches
const wide = await (await b.newContext({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2 })).newPage();
await wide.goto("http://localhost:4174/preview.html", { waitUntil: "networkidle" });
await wide.waitForTimeout(1500);
await wide.screenshot({ path: "/tmp/sutra-shots/polish-home-wide.png" });
console.log("pageerrors:", JSON.stringify(errs));
await b.close();
