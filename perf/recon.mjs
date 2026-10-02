import { chromium } from "playwright";

const TARGET = process.env.TARGET_URL || "http://localhost:8080/";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "fa-IR" });
const page = await ctx.newPage();
await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".topbar, .drawer", { timeout: 30000 });
await page.waitForTimeout(2500);

const out = await page.evaluate(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const q = (s) => document.querySelector(s);
  return {
    viewport: { w: innerWidth, h: innerHeight },
    canvases: [...document.querySelectorAll("canvas")].map((c) => ({ rect: rect(c), w: c.width, h: c.height, cls: c.className, parentCls: c.parentElement?.className })),
    topbar: rect(q(".topbar")),
    kpis: rect(q(".topbar .kpis")),
    mapTools: rect(q(".map-tools")),
    legend: rect(q(".legend")),
    drawer: rect(q(".drawer")),
    panel: rect(q(".panel")),
    fxTools: rect(q(".fx-tools")),
    fxSearch: rect(q(".fx-search")),
    fxResize: rect(q(".fx-resize")),
    modeRows: [...document.querySelectorAll(".mode-row[aria-pressed]")].map((b) => ({ text: b.textContent.trim(), pressed: b.getAttribute("aria-pressed"), rect: rect(b) })),
    legendSegs: [...document.querySelectorAll(".legend .seg button")].map((b) => b.textContent.trim()),
    topbarSegs: [...document.querySelectorAll(".topbar .seg button")].map((b) => b.textContent.trim()),
    tabs: [...document.querySelectorAll(".drawer .tab")].map((b) => b.textContent.trim()),
    mapContainerGuess: (() => {
      // find the nearest common ancestor of the canvases
      const cs = [...document.querySelectorAll("canvas")];
      if (!cs.length) return null;
      let el = cs[0].parentElement;
      for (let i = 0; i < 4 && el; i++) {
        if (el.contains(cs[cs.length - 1])) return { cls: el.className, tag: el.tagName, rect: rect(el) };
        el = el.parentElement;
      }
      return null;
    })(),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
