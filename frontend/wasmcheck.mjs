import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await (await b.newContext({ viewport: { width: 393, height: 852 } })).newPage();
const errs = [];
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
p.on("pageerror", (e) => errs.push("PAGEERR: " + e.message.slice(0, 160)));
await p.goto("http://localhost:5173/", { waitUntil: "networkidle" });
await p.waitForTimeout(4000);   // jeep-sqlite + wasm init + Memory query
const linkErr = errs.filter((e) => /LinkError|WebAssembly|wasm/i.test(e));
console.log("WASM/Link errors:", linkErr.length ? JSON.stringify(linkErr) : "NONE ✅");
console.log("other errors:", JSON.stringify(errs.filter((e) => !/LinkError|WebAssembly|wasm/i.test(e)).slice(0, 4)));
await b.close();
