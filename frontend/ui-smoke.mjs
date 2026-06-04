import { chromium } from "playwright";
const base = "http://localhost:8000";
const routes = [["/", "1-capture"], ["/memory", "2-memory"], ["/graph", "3-graph"], ["/chat", "4-chat"], ["/settings", "5-settings"]];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const report = {};
for (const [route, name] of routes) {
  const errs = [];
  const onC = (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); };
  const onE = (e) => errs.push("PAGEERROR: " + e.message.slice(0, 200));
  page.on("console", onC); page.on("pageerror", onE);
  try { await page.goto(base + route, { waitUntil: "networkidle", timeout: 30000 }); }
  catch (e) { errs.push("NAV: " + e.message.slice(0, 120)); }
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `/tmp/sutra-shots/${name}.png` });
  page.off("console", onC); page.off("pageerror", onE);
  report[name] = errs;
}
console.log(JSON.stringify(report, null, 2));
await browser.close();
