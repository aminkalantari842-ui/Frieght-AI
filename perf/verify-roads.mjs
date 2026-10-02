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

// Pixel probe: sample projected motorway points on the base canvas.
//
// The corridor layer (tools/corridors) draws freight corridors over the same
// arteries this layer draws, so a motorway point that *is* a corridor is
// legitimately painted teal instead of orange. Those points are skipped, and
// counted separately, so this test still measures what it means to measure:
// that the road layer paints its own geometry.
const probe = async () =>
  page.evaluate(() => {
    const canvas = document.querySelectorAll("canvas")[0];
    const c2 = canvas.getContext("2d");
    const ways = window.__IR_ROADS_WAYS || [[], [], []];
    const motor = ways[0] || [];
    const visible = motor.filter((w) => w.vis && w.px && w.n > 4);

    // The corridor layer draws freight corridors over the same arteries this layer
    // draws, so a motorway point that *is* a corridor is legitimately painted
    // teal instead of orange. Skip those and count them separately, so this
    // test still measures what it means to measure: that the road layer paints
    // its own geometry.
    //
    // Corridor segments are long and sparse (27k points over a small area), so
    // a cell grid is useless: the cells between two vertices are empty. Sample
    // each segment's polyline densely instead, which approximates the drawn
    // stroke accurately at this scale.
    //
    // Nearly every Iranian motorway is also a corridor, so the skip is applied
    // to *measurement* points rather than treated as a failure: the caller
    // re-runs this probe with the corridor layer off to measure the road layer
    // on its own. `orangeOrCovered` therefore reports "orange when the corridor
    // layer is off", which is exactly the regression this test guards.
    const corr = (window.__IR_CORRIDORS_WAYS || {}).corridors || [];
    const COVER_PX = 6;
    const stroke = [];
    for (const c of corr) {
      if (!c.vis || !c.px) continue;
      for (let i = 1; i < c.n; i++) {
        const ax = c.px[i - 1], ay = c.py[i - 1];
        const bx = c.px[i], by = c.py[i];
        const len = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(len / 3));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          stroke.push(ax + (bx - ax) * t, ay + (by - ay) * t);
        }
      }
    }
    const corridorLayerOn = !!window.__IR_CORRIDORS_STATS?.userOn;
    const nearCorridor = (x, y) => {
      if (!corridorLayerOn) return false;
      const d2 = COVER_PX * COVER_PX;
      for (let i = 0; i < stroke.length; i += 2) {
        const dx = stroke[i] - x;
        const dy = stroke[i + 1] - y;
        if (dx * dx + dy * dy <= d2) return true;
      }
      return false;
    };

    let orange = 0;
    let sampled = 0;
    let skippedOnCorridor = 0;
    const hits = [];
    for (let wi = 0; wi < Math.min(visible.length, 8); wi++) {
      const w = visible[wi];
      for (let k = 1; k < w.n - 1; k += Math.max(1, Math.floor(w.n / 4))) {
        const x = Math.round(w.px[k]);
        const y = Math.round(w.py[k]);
        if (x < 2 || y < 2 || x > 1437 || y > 897) continue;
        if (nearCorridor(x, y)) {
          skippedOnCorridor++;
          continue;
        }
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
    return {
      sampled,
      orange,
      skippedOnCorridor,
      hits,
      drawnWays: window.__IR_ROADS_STATS.drawnWays,
      zoom: window.__IR_ROADS_STATS.zoom,
    };
  });

// Measure the road layer on its own first. The corridor layer paints over the
// same arteries (by design), so with it on, motorway pixels read teal. Turning
// it off isolates the road layer and keeps this a true regression guard.
const corrPanel = page.locator("#ir-corridors-panel .ircp-head");
const hasCorrPanel = (await corrPanel.count()) > 0;
if (hasCorrPanel) {
  await corrPanel.click();
  await page.waitForTimeout(900);
}
const probeOn = await probe();
const corridorLayerWasOn = probeOn.skippedOnCorridor === undefined;

const probeOff = await (async () => {
  await page.click("#ir-roads-panel .irp-head");
  await page.waitForTimeout(700);
  const p = await probe();
  await page.click("#ir-roads-panel .irp-head");
  await page.waitForTimeout(700);
  return p;
})();
const probeBackOn = await probe();

// corridor layer back on
if (hasCorrPanel) {
  await corrPanel.click();
  await page.waitForTimeout(900);
}
const probeWithCorridors = hasCorrPanel ? await probe() : null;

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

// --- pass/fail gates -------------------------------------------------------
// Without these the script only printed, so CI could not fail on a regression.
const checks = {
  layerReady: stats.ready === true,
  // the road layer must paint its own geometry (measured with the corridor
  // layer off, see probeOn)
  paintsMotorways: probeOn.orange > 0,
  switchOffHides: probeOff.orange === 0,
  switchOnRestores: probeBackOn.orange > 0,
  drawsAfterDrag: afterDrag.drawnWays > 0,
  fastPathOk: stats.fastPath === true,
  noErrors: errors.length === 0 && pageErrors.length === 0,
};
const failed = Object.entries(checks)
  .filter(([, v]) => !v)
  .map(([k]) => k);

console.log(JSON.stringify({
  pass: failed.length === 0,
  failed,
  wallMsToLoad: Date.now() - t0,
  nav,
  stats,
  probeOn,
  probeOff,
  probeBackOn,
  probeWithCorridors,
  rowToggle,
  probeZoomed,
  afterDrag,
  idle,
  consoleErrors: errors.length,
  pageErrors: pageErrors.length,
  consoleSample: errors.slice(0, 3),
}, null, 1));

await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
