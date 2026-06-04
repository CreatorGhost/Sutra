import { chromium } from "playwright";
const base = "http://localhost:8000";
const devices = [
  { name: "android-360", w: 360, h: 800 },
  { name: "iphoneSE-375", w: 375, h: 667 },
  { name: "iphone14-393", w: 393, h: 852 },
  { name: "ipad-768", w: 768, h: 1024 },
];
const routes = ["/", "/memory", "/graph", "/chat", "/settings"];
const b = await chromium.launch({ channel: "chrome", headless: true });
const report = {};
for (const d of devices) {
  const ctx = await b.newContext({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const issues = [];
  for (const r of routes) {
    const errs = [];
    const onE = (e) => errs.push(e.message.slice(0, 100));
    page.on("pageerror", onE);
    await page.goto(base + r, { waitUntil: "networkidle" }).catch((e) => errs.push("NAV " + e.message.slice(0, 60)));
    await page.waitForTimeout(1200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) issues.push(`${r}: horizontal overflow ${overflow}px`);
    if (errs.length) issues.push(`${r}: errors ${JSON.stringify(errs)}`);
    page.off("pageerror", onE);
  }
  // capture the smallest device's key pages for visual review
  if (d.name === "iphoneSE-375") {
    for (const [r, n] of [["/", "se-capture"], ["/memory", "se-memory"], ["/settings", "se-settings"]]) {
      await page.goto(base + r, { waitUntil: "networkidle" }); await page.waitForTimeout(1000);
      await page.screenshot({ path: `/tmp/sutra-shots/${n}.png` });
    }
  }
  report[d.name] = issues.length ? issues : "OK (no overflow, no errors)";
  await ctx.close();
}
console.log(JSON.stringify(report, null, 2));
await b.close();
