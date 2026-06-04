import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await b.newContext({ viewport: { width: 393, height: 852 } })).newPage();
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 180)); });
page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message.slice(0, 180)));
await page.goto("http://localhost:4173/memory", { waitUntil: "networkidle" });
await page.waitForTimeout(3500);  // jeep-sqlite + wasm init + first query
const txt = await page.evaluate(() => document.body.innerText.slice(0, 400));
const dbInit = await page.evaluate(() => !!document.querySelector("jeep-sqlite"));
await page.screenshot({ path: "/tmp/sutra-shots/local-memory.png" });
console.log(JSON.stringify({ jeep_sqlite_present: dbInit, body_text: txt.replace(/\s+/g, " ").slice(0, 200), console_errors: errs }, null, 2));
await b.close();
