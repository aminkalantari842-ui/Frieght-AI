import { chromium } from "playwright";

const TARGET = process.env.TARGET_URL || "http://localhost:8080/";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "fa-IR" });
const page = await ctx.newPage();
await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".topbar, .drawer", { timeout: 30000 });
await page.waitForTimeout(12000);

const result = await page.evaluate(async () => {
  const counts = new Map();
  const samples = [];
  const key = (el) => {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    return `${el.tagName?.toLowerCase() || "?"}${cls ? "." + cls : ""}`;
  };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      const k = `${m.type}:${key(m.target)}`;
      counts.set(k, (counts.get(k) || 0) + 1);
      if (samples.length < 25) samples.push({ type: m.type, target: k, text: (m.target.textContent || "").slice(0, 60).replace(/\s+/g, " ") });
    }
  });
  obs.observe(document.getElementById("root"), { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  await new Promise((r) => setTimeout(r, 4000));
  obs.disconnect();
  return {
    total: [...counts.values()].reduce((a, b) => a + b, 0),
    byKey: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    samples,
    kpiText: (document.querySelector(".kpis")?.innerText || "").replace(/\s+/g, " ").slice(0, 160),
  };
});
console.log(JSON.stringify(result, null, 1));
await browser.close();
