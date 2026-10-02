import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const TARGET = process.env.TARGET_URL || "http://localhost:8080/";
const DSF = Number(process.env.DSF || 1);
const OUT = fileURLToPath(new URL(`./metrics-dsf${DSF}.json`, import.meta.url));

const IDLE_SECONDS = Number(process.env.IDLE_SECONDS || 5);
const PLAYBACK_SECONDS = Number(process.env.PLAYBACK_SECONDS || 3);

const stamp = () => new Date().toISOString();
const log = (...a) => console.log(`[${stamp()}]`, ...a);

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: DSF,
  locale: "fa-IR",
});

const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const failedRequests = [];

page.on("console", (m) => consoleMessages.push({ type: m.type(), text: m.text().slice(0, 500) }));
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 500)));
page.on("requestfailed", (r) =>
  failedRequests.push({ url: r.url(), error: r.failure()?.errorText || "unknown" })
);

await page.addInitScript(() => {
  const perf = (window.__perf = {
    frames: [],
    last: 0,
    longTasks: [],
    fcp: null,
    lcp: null,
    mountMs: null,
  });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.lcp = Math.round(e.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === "first-contentful-paint") perf.fcp = Math.round(e.startTime);
    }).observe({ type: "paint", buffered: true });
  } catch {}

  const tick = (t) => {
    if (perf.last) perf.frames.push(+Math.max(0, t - perf.last).toFixed(2));
    perf.last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const checkMount = () => {
    if (document.querySelector(".topbar") || document.querySelector(".drawer")) {
      perf.mountMs = Math.round(performance.now());
    } else {
      requestAnimationFrame(checkMount);
    }
  };
  requestAnimationFrame(checkMount);
});

const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
async function cdpMetrics() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}
const MS_KEYS = ["ScriptDuration", "TaskDuration", "LayoutDuration", "RecalcStyleDuration"];
function diffMetrics(a, b) {
  const out = {};
  for (const k of MS_KEYS) out[k] = Math.round((b[k] - a[k]) * 1000);
  out.JSHeapUsedMB = Math.round((b.JSHeapUsedSize / 1048576) * 10) / 10;
  out.Nodes = b.Nodes;
  return out;
}
function frameStats(frames) {
  if (!frames.length) return { frames: 0 };
  const sorted = [...frames].sort((x, y) => x - y);
  const avg = frames.reduce((s, v) => s + v, 0) / frames.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const long = frames.filter((f) => f > 33.4).length;
  return {
    frames: frames.length,
    avgFrameMs: +avg.toFixed(2),
    approxFps: +(1000 / avg).toFixed(1),
    p95FrameMs: +p95.toFixed(2),
    droppedFrames: long,
    droppedPct: +((long / frames.length) * 100).toFixed(1),
  };
}
async function resetCounters() {
  await page.evaluate(() => {
    window.__perf.frames.length = 0;
    window.__perf.longTasks.length = 0;
  });
}
async function readCounters() {
  return page.evaluate(() => ({
    frames: window.__perf.frames,
    longTasks: window.__perf.longTasks,
    fcp: window.__perf.fcp,
    lcp: window.__perf.lcp,
    mountMs: window.__perf.mountMs,
    heapMB: performance.memory ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10 : null,
    domNodes: document.querySelectorAll("*").length,
  }));
}

const result = {
  meta: {
    target: TARGET,
    deviceScaleFactor: DSF,
    viewport: "1440x900",
    startedAt: stamp(),
    userAgent: null,
    idleSeconds: IDLE_SECONDS,
  },
  load: {},
  resources: [],
  phases: [],
  interactions: [],
  console: {},
  errors: {},
};

log("navigating", TARGET);
const t0 = Date.now();
await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
result.load.gotoLoadWallMs = Date.now() - t0;
result.meta.userAgent = await page.evaluate(() => navigator.userAgent);

try {
  await page.waitForFunction(() => window.__perf && window.__perf.mountMs, null, { timeout: 30000 });
} catch {
  result.load.mountTimeout = true;
}

const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType("navigation")[0];
  return n
    ? {
        domInteractive: Math.round(n.domInteractive),
        domContentLoaded: Math.round(n.domContentLoadedEventEnd),
        loadEventEnd: Math.round(n.loadEventEnd),
        responseEnd: Math.round(n.responseEnd),
        transferSize: n.transferSize,
        encodedBodySize: n.encodedBodySize,
        decodedBodySize: n.decodedBodySize,
      }
    : null;
});
const first = await readCounters();
result.load.navigation = nav;
result.load.firstPaint = { fcp: first.fcp, lcp: first.lcp, appMountMs: first.mountMs };
result.load.wallClock = { loadMs: result.load.gotoLoadWallMs };
result.resources = await page.evaluate(() =>
  performance.getEntriesByType("resource").map((r) => ({
    name: r.name.length > 120 ? r.name.slice(0, 120) + "…" : r.name,
    type: r.initiatorType,
    ms: Math.round(r.duration),
    transferSize: r.transferSize,
  }))
);
log("load done:", JSON.stringify({ nav: result.load.navigation, paint: result.load.firstPaint }));

// Settle, then measure idle cost.
await page.waitForTimeout(1500);
await resetCounters();
const idle0 = await cdpMetrics();
await page.waitForTimeout(IDLE_SECONDS * 1000);
const idle1 = await cdpMetrics();
const idleCounters = await readCounters();
result.phases.push({
  name: `idle-${IDLE_SECONDS}s`,
  cdpCost: diffMetrics(idle0, idle1),
  frames: frameStats(idleCounters.frames),
  longTasks: idleCounters.longTasks,
  heapMB: idleCounters.heapMB,
  domNodes: idleCounters.domNodes,
});
log("idle phase:", JSON.stringify(result.phases[result.phases.length - 1]));

async function action(name, fn, settleMs = 800) {
  const m0 = await cdpMetrics();
  const t = Date.now();
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = String(e.message || e).slice(0, 300);
  }
  await page.waitForTimeout(settleMs);
  const m1 = await cdpMetrics();
  const entry = { name, wallMs: Date.now() - t, settleMs, ...diffMetrics(m0, m1), error };
  result.interactions.push(entry);
  log("action:", JSON.stringify(entry));
  return entry;
}

// ---- simulated user interactions ----
await action("open command palette (Ctrl+K) + search", async () => {
  await page.keyboard.press("Control+K");
  await page.waitForSelector(".fx-pal", { timeout: 5000 });
  await page.fill(".fx-pal input", "کریدور");
  await page.waitForFunction(
    () => document.querySelectorAll(".fx-pal .fx-it").length > 0,
    null,
    { timeout: 5000 }
  );
});
await page.keyboard.press("Escape");

await action("apply preset scenario (first chip)", async () => {
  const chip = page.locator(".panel .presets .chip").first();
  await chip.click({ timeout: 5000 });
}, 1200);

await action("switch results tab (rates editor)", async () => {
  const tabs = page.locator(".drawer .tab");
  const count = await tabs.count();
  if (count > 1) await tabs.nth(1).click({ timeout: 5000 });
  else throw new Error("no second tab found");
});

await action("switch results tab (quote)", async () => {
  const tabs = page.locator(".drawer .tab");
  const count = await tabs.count();
  if (count > 2) await tabs.nth(2).click({ timeout: 5000 });
  else throw new Error("no third tab found");
});

await action("select first route card", async () => {
  const card = page.locator(".rcard").first();
  if (await card.count()) await card.click({ timeout: 5000 });
  else throw new Error("no .rcard found");
}, 1000);

await action("toggle map layer (first mode-row)", async () => {
  const row = page.locator(".mode-row[aria-pressed]").first();
  if (await row.count()) await row.click({ timeout: 5000 });
  else throw new Error("no mode-row found");
}, 1000);

await action("zoom in x2 + zoom out", async () => {
  const zin = page.locator('[aria-label="بزرگ‌نمایی"]').first();
  const zout = page.locator('[aria-label="کوچک‌نمایی"]').first();
  if (await zin.count()) {
    await zin.click();
    await zin.click();
    if (await zout.count()) await zout.click();
  } else throw new Error("zoom controls not found");
}, 1000);

await action("toggle theme", async () => {
  const b = page.locator('[aria-label="تغییر تم"]').first();
  if (await b.count()) await b.click({ timeout: 5000 });
  else throw new Error("theme button not found");
}, 1000);

// playback: measure FPS while the trip animation runs
const playback = { clicked: false, notes: [] };
try {
  const play = page.locator(".play-btn").first();
  if (await play.count()) {
    await playbackClick("start");
    await resetCounters();
    const p0 = await cdpMetrics();
    await page.waitForTimeout(PLAYBACK_SECONDS * 1000);
    const p1 = await cdpMetrics();
    const pc = await readCounters();
    playback.fpsDuringPlayback = frameStats(pc.frames);
    playback.cdpCost = diffMetrics(p0, p1);
    playback.longTasks = pc.longTasks;
    playback.clicked = true;
    await playbackClick("stop");
  } else {
    playback.notes.push(".play-btn not found");
  }
} catch (e) {
  playback.notes.push(String(e.message || e).slice(0, 200));
}
async function playbackClick(kind) {
  await page.locator(".play-btn").first().click({ timeout: 5000 });
  await page.waitForTimeout(400);
  log(`playback ${kind}`);
}
result.playback = playback;

// final state
const finalCounters = await readCounters();
result.final = { heapMB: finalCounters.heapMB, domNodes: finalCounters.domNodes };

const byType = (t) => consoleMessages.filter((m) => m.type === t);
result.console = {
  errors: byType("error"),
  warnings: byType("warning"),
  total: consoleMessages.length,
};
result.errors = { pageErrors, failedRequests };

await page.screenshot({ path: fileURLToPath(new URL(`./screenshot-dsf${DSF}.png`, import.meta.url)) });
writeFileSync(OUT, JSON.stringify(result, null, 2));
log("wrote", OUT);

await browser.close();
console.log("\n=== SUMMARY ===");
console.log(
  JSON.stringify(
    {
      load: result.load,
      idle: result.phases[0],
      interactions: result.interactions.map((i) => ({
        name: i.name,
        wallMs: i.wallMs,
        ScriptDuration: i.ScriptDuration,
        LayoutDuration: i.LayoutDuration,
        RecalcStyleDuration: i.RecalcStyleDuration,
        error: i.error,
      })),
      playback: result.playback,
      final: result.final,
      consoleErrors: result.console.errors.length,
      pageErrors: result.errors.pageErrors.length,
      failedRequests: result.errors.failedRequests.length,
    },
    null,
    2
  )
);
