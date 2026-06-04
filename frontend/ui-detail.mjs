import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage(); const errs=[]; page.on("pageerror",e=>errs.push(e.message.slice(0,140)));
await page.goto("http://localhost:8000/conversation/6", { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
console.log(JSON.stringify({
  has500: await page.getByText("500").count(),
  hasTranscript: await page.getByText("Transcript").count(),
  hasSummary: await page.getByText("Summary").count(),
  pageerrors: errs,
}));
await page.screenshot({ path: "/tmp/sutra-shots/flow-detail2.png", fullPage: true });
await b.close();
