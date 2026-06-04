import { chromium } from "playwright";
const base = "http://localhost:8000";
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const out = {};
const errs = [];
page.on("pageerror", (e) => errs.push(e.message.slice(0, 160)));

// 1) Search flow
await page.goto(base + "/memory", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Search" }).first().click();
await page.getByPlaceholder("Search your memory…").fill("Ashoka college application");
await page.keyboard.press("Enter");
await page.waitForTimeout(2500);
const searchCards = await page.locator("a.card").count();
out.search_results = searchCards;
await page.screenshot({ path: "/tmp/sutra-shots/flow-search.png" });

// 2) Conversation drill-in
await page.getByRole("button", { name: "Conversations" }).first().click();
await page.waitForTimeout(1200);
await page.locator("a.card").first().click();
await page.waitForTimeout(1800);
out.detail_has_transcript = await page.getByText("Transcript").count();
out.detail_url = page.url();
await page.screenshot({ path: "/tmp/sutra-shots/flow-detail.png", fullPage: true });

// 3) Chat flow (cited answer)
await page.goto(base + "/chat", { waitUntil: "networkidle" });
await page.getByPlaceholder("Ask your memory…").fill("What did Amartya say about his college shortlist?");
await page.keyboard.press("Enter");
await page.waitForTimeout(9000);
const bubbles = await page.locator(".turn .bubble").allInnerTexts();
out.chat_answer = (bubbles[bubbles.length - 1] || "").slice(0, 220);
out.chat_has_citation = await page.locator("a.cite").count();
await page.screenshot({ path: "/tmp/sutra-shots/flow-chat.png", fullPage: true });

// 4) Graph node tap
await page.goto(base + "/graph", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.mouse.click(195, 980); // tap near a node cluster
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/sutra-shots/flow-graph.png" });

out.pageerrors = errs;
console.log(JSON.stringify(out, null, 2));
await b.close();
