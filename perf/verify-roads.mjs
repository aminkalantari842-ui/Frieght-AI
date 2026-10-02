import { chromium } from "playwright";

const TARGET = process.env.TARGET_URL || "http://localhost:8080/";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "fa-IR" });
const page = await ctx.newPage();
const consoleMsgs = [];
const pageErrors = [];
page.on("console", (m) => consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 300) }));
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

await page.addInitScript(() => {
  window.__perf = { frames: [], last: 0 };
  const tick = (t) => {
    if (window.__perf.last) window.__perf.frames.push(t - window.__perf.last);
    window.__perf.last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const t0 = Date.now();
await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
await page.waitForSelector(".topbar, .drawer", { timeout: 30000 });

// wait for the road layer to decode
try {
  await page.waitForFunction(() => window.__IR_ROADS_STATS && window.__IR_ROADS_STATS.ready, null, { timeout: 20000 });
} catch {}
await page.waitForTimeout(1200);

const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType("navigation")[0];
  return n ? { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), transferSize: n.transferSize, decodedBodySize: n.decodedBodySize } : null;
});

const stats = await page.evaluate(() => ({ ...window.__IR_ROADS_STATS, panel: (() => {
  const p = document.querySelector("#ir-roads-panel");
  if (!p) return null;
  const r = p.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), swOn: p.querySelector(".irp-sw")?.getAttribute("data-on"), text: p.innerText.replace(/\s+/g, " ").slice(0, 120) };
})() }));

// pixel probe: sample projected motorway points on the base canvas
const probe = async () =>
  page.evaluate(() => {
    const canvas = document.querySelectorAll("canvas")[0];
    const c2 = canvas.getContext("2d");
    const ways = window.__IR_ROADS_WAYS || [[], [], []];
    const motor = ways[0] || [];
    const visible = motor.filter((w) => w.vis && w.px && w.n > 4);
    let orange = 0;
    let sampled = 0;
    const hits = [];
    for (let wi = 0; wi < Math.min(visible.length, 8); wi++) {
      const w = visible[wi];
      for (let k = 1; k < w.n - 1; k += Math.max(1, Math.floor(w.n / 4))) {
        const x = Math.round(w.px[k]);
        const y = Math.round(w.py[k]);
        if (x < 2 || y < 2 || x > 1437 || y > 897) continue;
        sampled++;
        const d = c2.getImageData(x - 1, y - 1, 3, 3).data;
        // search 3x3 for orange fill (motorway) or its dark casing
        let found = false;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          if (r > 170 && g > 85 && g < 185 && b < 120) found = true; // orange-ish
        }
        if (found) {
          orange++;
          if (hits.length < 4) hits.push({ x, y });
        }
      }
    }
    return { sampled, orange, hits, drawnWays: window.__IR_ROADS_STATS.drawnWays, zoom: window.__IR_ROADS_STATS.zoom };
  });

const probeOn = await probe();

// toggle off via panel and re-probe
await page.click("#ir-roads-panel .irp-head");
await page.waitForTimeout(600);
const probeOff = await probe();
// toggle back on
await page.click("#ir-roads-panel .irp-head");
await page.waitForTimeout(600);
const probeBackOn = await probe();

// the app's own "جاده‌ای" layer row must hide/show the road layer too
const rowToggle = await (async () => {
  try {
    const row = page.locator(".mode-row[aria-pressed]").filter({ hasText: "جاده" }).first();
    if (!(await row.count())) return { rowFound: false };
    await row.click();
    await page.waitForTimeout(600);
    const off = await probe();
    await row.click();
    await page.waitForTimeout(600);
    const on = await probe();
    return { rowFound: true, orangeWhenRowOff: off.orange, orangeWhenRowOn: on.orange };
  } catch (e) {
    return { rowFound: false, error: String(e.message || e).slice(0, 160) };
  }
})();

// zoom in twice and re-check
const zin = page.locator('[aria-label="بزرگ‌نمایی"]').first();
if (await zin.count()) {
  await zin.click();
  await page.waitForTimeout(300);
  await zin.click();
  await page.waitForTimeout(600);
}
const probeZoomed = await probe();

// drag the map to force a base redraw
await page.mouse.move(760, 380);
await page.mouse.down();
await page.mouse.move(660, 430, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(600);
const afterDrag = await page.evaluate(() => ({
  drawMs: window.__IR_ROADS_STATS.drawMs,
  drawnWays: window.__IR_ROADS_STATS.drawnWays,
  zoom: window.__IR_ROADS_STATS.zoom,
  fastPath: window.__IR_ROADS_STATS.fastPath,
  syncMs: window.__IR_ROADS_STATS.syncMs,
}));

// idle cost (4s) via CDP
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");
const meters = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};
await page.evaluate(() => { window.__perf.frames.length = 0; });
const m0 = await meters();
await page.waitForTimeout(4000);
const m1 = await meters();
const frames = await page.evaluate(() => window.__perf.frames);
const avg = frames.reduce((s, v) => s + v, 0) / Math.max(1, frames.length);
const idle = {
  taskPct: +((((m1.TaskDuration - m0.TaskDuration) * 1000) / 4000) * 100).toFixed(1),
  scriptPct: +((((m1.ScriptDuration - m0.ScriptDuration) * 1000) / 4000) * 100).toFixed(1),
  fps: +(1000 / avg).toFixed(1),
  frames: frames.length,
};

await page.screenshot({ path: "roads-preview.png" });

const errors = consoleMsgs.filter((m) => m.type === "error");
console.log(JSON.stringify({
  wallMsToLoad: Date.now() - t0,
  nav,
  stats,
  probeOn,
  probeOff,
  probeBackOn,
  rowToggle,
  probeZoomed,
  afterDrag,
  idle,
  consoleErrors: errors.length,
  pageErrors: pageErrors.length,
  consoleSample: errors.slice(0, 3),
}, null, 1));

await browser.close();
