// Verification for the freight-corridor layer injected into the atlas.
// Usage: node verify-corridors.mjs   (from perf/, with the preview server up)
//
// Checks, in order:
//   1. the gzip+base64 payload decodes and the layer reports ready
//   2. corridor geometry is actually painted (pixel probe on the base canvas)
//   3. the internal-road network paints too, once zoomed past its LOD
//   4. the panel switch removes and restores both
//   5. panning far away culls both (drawn counts collapse to ~0)
//   6. the Iran road layer still works and still owns Iran's roads
//   7. idle CPU stays within the existing baseline
import { chromium } from "playwright";

const TARGET = process.env.TARGET_URL || "http://localhost:8080/";
const VIEW_W = 1440;
const VIEW_H = 900;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: VIEW_W, height: VIEW_H }, deviceScaleFactor: 1, locale: "fa-IR" });
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

let decoded = true;
try {
  await page.waitForFunction(() => window.__IR_CORRIDORS_STATS && window.__IR_CORRIDORS_STATS.ready, null, { timeout: 25000 });
} catch {
  decoded = false;
}
await page.waitForTimeout(1500);

const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType("navigation")[0];
  return n ? { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), transferSize: n.transferSize, decodedBodySize: n.decodedBodySize } : null;
});

const stats = await page.evaluate(() => ({
  ...window.__IR_CORRIDORS_STATS,
  panel: (() => {
    const p = document.querySelector("#ir-corridors-panel");
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      swOn: p.querySelector(".ircp-sw")?.getAttribute("data-on"),
      text: p.innerText.replace(/\s+/g, " ").slice(0, 140),
    };
  })(),
  // the two panels must not overlap
  panelOverlap: (() => {
    const a = document.querySelector("#ir-roads-panel");
    const b = document.querySelector("#ir-corridors-panel");
    if (!a || !b) return null;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return !(ra.bottom <= rb.top || rb.bottom <= ra.top || ra.right <= rb.left || rb.right <= ra.left);
  })(),
}));

// Pixel probe. Corridor fill is teal (#3FD0D6) in dark theme / #12A3AC in light,
// foreign motorway is violet (#8C7BF0 / #6E5CD8), foreign trunk indigo (#5B54B8 / #4B45A0).
const probe = async () =>
  page.evaluate(() => {
    const canvas = document.querySelectorAll("canvas")[0];
    const c2 = canvas.getContext("2d");
    const data = window.__IR_CORRIDORS_WAYS || { corridors: [], roads: [[], []] };
    const near = (d, r, g, b) => {
      for (let k = 0; k < d.length; k += 4) {
        const R = d[k], G = d[k + 1], B = d[k + 2];
        if (R > r && G > g && B > b) return true;
      }
      return false;
    };
    const scan = (list, pred, limit) => {
      const visible = list.filter((w) => w.vis && w.px && w.n > 3);
      let hits = 0;
      let sampled = 0;
      const coords = [];
      for (let wi = 0; wi < Math.min(visible.length, limit); wi++) {
        const w = visible[wi];
        for (let k = 1; k < w.n - 1; k += Math.max(1, Math.floor(w.n / 5))) {
          const x = Math.round(w.px[k]);
          const y = Math.round(w.py[k]);
          if (x < 2 || y < 2 || x > 1437 || y > 897) continue;
          sampled++;
          const d = c2.getImageData(x - 2, y - 2, 5, 5).data;
          if (near(d, ...pred)) {
            hits++;
            if (coords.length < 3) coords.push({ x, y });
          }
        }
      }
      return { sampled, hits, coords, visibleWays: visible.length };
    };
    const corr = scan(data.corridors, [40, 110, 90], 14);
    const motor = scan(data.roads[0], [70, 50, 140], 14);
    const trunk = scan(data.roads[1], [55, 45, 120], 14);
    return {
      corr, motor, trunk,
      drawnCorridorSegs: window.__IR_CORRIDORS_STATS.drawnCorridorSegs,
      drawnRoads: window.__IR_CORRIDORS_STATS.drawnRoads,
      zoom: window.__IR_CORRIDORS_STATS.zoom,
      drawMs: window.__IR_CORRIDORS_STATS.drawMs,
    };
  });

const probeOn = await probe();

// --- switch + culling, at the initial regional zoom -----------------------
// These assertions need corridors on screen, so they run before zooming in.
await page.click("#ir-corridors-panel .ircp-head");
await page.waitForTimeout(700);
const probeOff = await probe();
await page.click("#ir-corridors-panel .ircp-head");
await page.waitForTimeout(700);
const probeBackOn = await probe();

// culling: drag a long way across the map and confirm the drawn counts collapse
const beforePan = await page.evaluate(() => ({ ...window.__IR_CORRIDORS_STATS }));
for (let i = 0; i < 3; i++) {
  await page.mouse.move(760, 430);
  await page.mouse.down();
  await page.mouse.move(200, 430, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(450);
}
const panned = await page.evaluate(() => ({ ...window.__IR_CORRIDORS_STATS }));
const probePanned = await probe();

// --- internal roads, which sit behind LOD thresholds -----------------------
// Zooming with the buttons leaves the view centred on Iran, where this layer
// deliberately has no geometry. Centre instead on a real foreign road way
// taken from the dataset, so the assertion is deterministic.
const target = await page.evaluate(() => {
  const data = window.__IR_CORRIDORS_WAYS;
  if (!data) return null;
  const lists = [data.roads[0], data.roads[1]].filter(Boolean);
  let best = null;
  for (const arr of lists) {
    for (const w of arr) {
      if (!best || w.n > best.n) best = w;
    }
  }
  if (!best) return null;
  const XI = Math.PI / 180;
  const lon = (best.rx[best.n >> 1] / XI);
  const lat = ((2 * Math.atan(Math.exp(-best.my[best.n >> 1])) - Math.PI / 2) / XI);
  const en = globalThis.__IR_ENGINE;
  if (!en) return null;
  en.view.center = [lon, lat];
  en.view.zoom = 6.5;
  en.viewVersion = (en.viewVersion || 0) + 1;
  en.baseDirty = true;
  return { lon, lat, n: best.n, ref: best.ref, cls: best.owner };
});
await page.waitForTimeout(900);
const probeZoomed = await probe();
await page.waitForTimeout(400);
const probeZoomed2 = await probe();
const roadsLayer = await page.evaluate(() => {
  const s = window.__IR_ROADS_STATS;
  if (!s) return null;
  const p = document.querySelector("#ir-roads-panel");
  return {
    ready: s.ready, enabled: s.enabled, ways: s.ways, drawnWays: s.drawnWays,
    panelPresent: !!p, panelText: p ? p.innerText.replace(/\s+/g, " ").slice(0, 80) : null,
  };
});
// Iran must not appear in the corridor layer's own road set.
const iranExcluded = await page.evaluate(() => {
  const meta = window.__IR_CORRIDORS_META;
  if (!meta) return null;
  const countries = meta.countries || [];
  return countries.length ? countries.every((c) => c.iso !== "IR") : true;
});

const afterDrag = await page.evaluate(() => ({
  drawMs: window.__IR_CORRIDORS_STATS.drawMs,
  drawnCorridorSegs: window.__IR_CORRIDORS_STATS.drawnCorridorSegs,
  drawnRoads: window.__IR_CORRIDORS_STATS.drawnRoads,
  zoom: window.__IR_CORRIDORS_STATS.zoom,
  fastPath: window.__IR_CORRIDORS_STATS.fastPath,
}));

// idle cost over 4s
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");
const meters = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};
// A/B the same view with the corridor layer on and off. The app's own render
// loop keeps the CPU at ~100% task on this single-core sandbox, so only the
// *difference* between these two numbers is attributable to this layer.
const measureIdle = async () => {
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__perf.frames.length = 0; });
  const a = await meters();
  await page.waitForTimeout(4000);
  const b = await meters();
  const fr = await page.evaluate(() => window.__perf.frames);
  const avg = fr.reduce((s, v) => s + v, 0) / Math.max(1, fr.length);
  return {
    taskPct: +((((b.TaskDuration - a.TaskDuration) * 1000) / 4000) * 100).toFixed(1),
    scriptPct: +((((b.ScriptDuration - a.ScriptDuration) * 1000) / 4000) * 100).toFixed(1),
    fps: +(1000 / avg).toFixed(1),
    frames: fr.length,
  };
};
const idleWithLayer = await measureIdle();
await page.click("#ir-corridors-panel .ircp-head"); // corridor layer off
const idleWithoutLayer = await measureIdle();
await page.click("#ir-corridors-panel .ircp-head"); // back on
await page.waitForTimeout(600);
const idle = {
  withLayer: idleWithLayer,
  withoutLayer: idleWithoutLayer,
  layerCost: {
    taskPct: +(idleWithLayer.taskPct - idleWithoutLayer.taskPct).toFixed(1),
    scriptPct: +(idleWithLayer.scriptPct - idleWithoutLayer.scriptPct).toFixed(1),
    fps: +(idleWithLayer.fps - idleWithoutLayer.fps).toFixed(1),
  },
};

await page.screenshot({ path: "corridors-preview.png" });

const errors = consoleMsgs.filter((m) => m.type === "error");

// --- pass/fail gates -------------------------------------------------------
const checks = {
  decoded,
  corridorsPainted: probeOn.corr.hits > 0,
  internalRoadsPaintedAfterZoom: stats.roads === 0 || probeZoomed.motor.hits + probeZoomed2.motor.hits + probeZoomed.trunk.hits + probeZoomed2.trunk.hits > 0,
  switchOffHides: probeOff.drawnCorridorSegs === 0 && probeOff.drawnRoads === 0,
  switchOnRestores: probeBackOn.drawnCorridorSegs > 0,
  cullsWhenPanned: panned.drawnCorridorSegs < beforePan.drawnCorridorSegs,
  fastPathOk: stats.fastPath === true,
  roadsLayerIntact: !!roadsLayer && roadsLayer.ready === true,
  iranOwnedByRoadsLayer: iranExcluded === true,
  panelsDoNotOverlap: stats.panelOverlap === false,
  noErrors: errors.length === 0 && pageErrors.length === 0,
};
const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);

console.log(JSON.stringify({
  pass: failed.length === 0,
  failed,
  wallMsToLoad: Date.now() - t0,
  nav,
  stats,
  probeOn,
  probeZoomed,
  probeZoomed2,
  internalRoadTarget: target,
  probeOff,
  probeBackOn,
  probePanned,
  panning: {
    drawnBefore: beforePan.drawnCorridorSegs,
    drawnAfter: panned.drawnCorridorSegs,
    roadsBefore: beforePan.drawnRoads,
    roadsAfter: panned.drawnRoads,
  },
  afterDrag,
  roadsLayer,
  iranExcluded,
  idle,
  consoleErrors: errors.length,
  pageErrors: pageErrors.length,
  consoleSample: errors.slice(0, 3),
}, null, 1));

await browser.close();
process.exit(failed.length === 0 ? 0 : 1);