import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const TARGET = process.env.TARGET_URL || "http://localhost:8080/";
const OUT = fileURLToPath(new URL("./metrics-deep.json", import.meta.url));
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

const INIT = () => {
  window.__perf = { frames: [], last: 0, longTasks: [], fcp: null, lcp: null, mountMs: null };
  const perf = window.__perf;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) perf.longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) perf.lcp = Math.round(e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") perf.fcp = Math.round(e.startTime); }).observe({ type: "paint", buffered: true });
  } catch {}
  const tick = (t) => { if (perf.last) perf.frames.push(+Math.max(0, t - perf.last).toFixed(2)); perf.last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const chk = () => { if (document.querySelector(".topbar") || document.querySelector(".drawer")) perf.mountMs = Math.round(performance.now()); else requestAnimationFrame(chk); };
  requestAnimationFrame(chk);
};

const frameStats = (frames) => {
  if (!frames.length) return { frames: 0 };
  const sorted = [...frames].sort((a, b) => a - b);
  const avg = frames.reduce((s, v) => s + v, 0) / frames.length;
  return {
    frames: frames.length,
    approxFps: +(1000 / avg).toFixed(1),
    avgFrameMs: +avg.toFixed(1),
    p95FrameMs: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
    over33ms: frames.filter((f) => f > 33.4).length,
  };
};

const out = { idleProfile: null, playbackProfile: null, inventory: null, throttled: null, mobile: null };

// ---------- main page: inventory + CPU profiles ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "fa-IR" });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");

  await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__perf && window.__perf.mountMs, null, { timeout: 30000 });
  await page.waitForTimeout(1800);

  const inventory = await page.evaluate(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const drawer = document.querySelector(".drawer");
    return {
      rootChildren: document.getElementById("root")?.children.length ?? 0,
      canvasCount: document.querySelectorAll("canvas").length,
      canvasSizes: [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}`),
      tabs: [...document.querySelectorAll(".drawer .tab")].map((b) => b.innerText.trim()),
      chips: q(".panel .presets .chip"),
      modeRows: q(".mode-row"),
      rcards: q(".rcard"),
      fxRoot: !!document.querySelector(".fx-root"),
      playBtn: !!document.querySelector(".play-btn"),
      drawerClasses: drawer?.className ?? null,
      drawerText: (drawer?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 260),
      kpiText: (document.querySelector(".kpis")?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 220),
    };
  });
  // open the routes tab (first) and see if route cards appear
  try {
    const first = page.locator(".drawer .tab").first();
    if (await first.count()) await first.click();
    await page.waitForTimeout(1200);
  } catch {}
  inventory.rcardsAfterFirstTab = await page.locator(".rcard").count();
  out.inventory = inventory;
  log("INVENTORY", JSON.stringify(inventory, null, 1));

  const meters = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  };
  const rate = (a, b, ms) => ({
    windowMs: ms,
    taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
    scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000),
    layoutMs: Math.round((b.LayoutDuration - a.LayoutDuration) * 1000),
    styleMs: Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000),
    taskPct: +(((b.TaskDuration - a.TaskDuration) * 1000 / ms) * 100).toFixed(1),
    scriptPct: +(((b.ScriptDuration - a.ScriptDuration) * 1000 / ms) * 100).toFixed(1),
  });

  const profile = async (ms) => {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
    await cdp.send("Profiler.start");
    await page.waitForTimeout(ms);
    const { profile: p } = await cdp.send("Profiler.stop");
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const self = new Map();
    for (let i = 0; i < p.samples.length; i++) {
      const n = byId.get(p.samples[i]);
      if (!n) continue;
      const cf = n.callFrame;
      const key = `${cf.functionName || "(anonymous)"} | ${cf.url.split("/").pop() || "inline"}:${cf.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + (p.timeDeltas[i] || 0));
    }
    const total = [...self.values()].reduce((x, y) => x + y, 0);
    return {
      ms,
      sampledMs: Math.round(total / 1000),
      top: [...self.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([k, v]) => ({ fn: k, ms: Math.round(v / 1000), pct: +((v / total) * 100).toFixed(1) })),
    };
  };

  await page.evaluate(() => { window.__perf.frames.length = 0; });
  const i0 = await meters();
  const idleProfile = await profile(4000);
  const i1 = await meters();
  const frames = await page.evaluate(() => window.__perf.frames);
  out.idleProfile = { rate: rate(i0, i1, 4000), frames: frameStats(frames), profile: idleProfile };
  log("IDLE", JSON.stringify(out.idleProfile, null, 1));

  // playback profile
  try {
    await page.locator(".play-btn").first().click();
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__perf.frames.length = 0; });
    const p0 = await meters();
    const playbackProfile = await profile(3000);
    const p1 = await meters();
    const frames2 = await page.evaluate(() => window.__perf.frames);
    out.playbackProfile = { rate: rate(p0, p1, 3000), frames: frameStats(frames2), profile: playbackProfile };
    log("PLAYBACK", JSON.stringify(out.playbackProfile, null, 1));
    await page.locator(".play-btn").first().click();
  } catch (e) {
    out.playbackProfile = { error: String(e.message || e).slice(0, 200) };
  }

  await ctx.close();
}

// ---------- throttled network load (Fast 3G) ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "fa-IR" });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: Math.round((1.6 * 1024 * 1024) / 8), // 1.6 Mbps
    uploadThroughput: Math.round((750 * 1024) / 8),
  });
  const t0 = Date.now();
  await page.goto(TARGET, { waitUntil: "load", timeout: 120000 });
  const wall = Date.now() - t0;
  try {
    await page.waitForFunction(() => window.__perf && window.__perf.mountMs, null, { timeout: 60000 });
  } catch {}
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    const p = window.__perf;
    return n
      ? { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), fcp: p.fcp, lcp: p.lcp, mountMs: p.mountMs, transferSize: n.transferSize, decodedBodySize: n.decodedBodySize }
      : null;
  });
  out.throttled = { wallMsToLoadEvent: wall, nav };
  log("THROTTLED (Fast 3G)", JSON.stringify(out.throttled, null, 1));
  await ctx.close();
}

// ---------- mobile viewport (390x844 @2x) ----------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "fa-IR" });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => window.__perf && window.__perf.mountMs, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const meters = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  };
  await page.evaluate(() => { window.__perf.frames.length = 0; });
  const m0 = await meters();
  await page.waitForTimeout(4000);
  const m1 = await meters();
  const frames = await page.evaluate(() => window.__perf.frames);
  const canvases = await page.evaluate(() => [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height} (dpr ${window.devicePixelRatio})`));
  out.mobile = {
    taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000),
    scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000),
    taskPct: +((((m1.TaskDuration - m0.TaskDuration) * 1000) / 4000) * 100).toFixed(1),
    scriptPct: +((((m1.ScriptDuration - m0.ScriptDuration) * 1000) / 4000) * 100).toFixed(1),
    frames: frameStats(frames),
    canvases,
  };
  log("MOBILE", JSON.stringify(out.mobile, null, 1));
  await ctx.close();
}

writeFileSync(OUT, JSON.stringify(out, null, 2));
log("wrote", OUT);
await browser.close();
