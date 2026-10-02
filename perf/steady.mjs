import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const TARGET = process.env.TARGET_URL || "http://localhost:8080/";
const OUT = fileURLToPath(new URL("./metrics-steady.json", import.meta.url));
const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "fa-IR" });
const page = await ctx.newPage();

await page.addInitScript(() => {
  window.__perf = { frames: [], last: 0, longTasks: [], mountMs: null };
  const perf = window.__perf;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) perf.longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); }).observe({ type: "longtask", buffered: true });
  } catch {}
  const tick = (t) => { if (perf.last) perf.frames.push(+Math.max(0, t - perf.last).toFixed(2)); perf.last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const chk = () => { if (document.querySelector(".topbar") || document.querySelector(".drawer")) perf.mountMs = Math.round(performance.now()); else requestAnimationFrame(chk); };
  requestAnimationFrame(chk);
});

const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");
const meters = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
};
const rate = (a, b, ms) => ({
  windowMs: ms,
  taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
  scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000),
  scriptPct: +(((b.ScriptDuration - a.ScriptDuration) * 1000 / ms) * 100).toFixed(1),
});
const frameStats = (frames) => {
  const sorted = [...frames].sort((x, y) => x - y);
  const avg = frames.reduce((s, v) => s + v, 0) / frames.length;
  return { frames: frames.length, approxFps: +(1000 / avg).toFixed(1), p95FrameMs: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), over33ms: frames.filter((f) => f > 33.4).length };
};

await page.goto(TARGET, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => window.__perf && window.__perf.mountMs, null, { timeout: 30000 });

const flagsAtLoad = await page.evaluate(() => ({ toured: localStorage.getItem("ifa.toured"), fx: localStorage.getItem("ifa-fx") }));
log("flags at load:", JSON.stringify(flagsAtLoad));

// wait out the onboarding tour / initial animations (25s total from load)
log("waiting 22s for steady state...");
await page.waitForTimeout(22000);
const flagsSteady = await page.evaluate(() => ({ toured: localStorage.getItem("ifa.toured"), fx: localStorage.getItem("ifa-fx") }));
log("flags after wait:", JSON.stringify(flagsSteady));

await page.evaluate(() => { window.__perf.frames.length = 0; window.__perf.longTasks.length = 0; });
const s0 = await meters();
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
await cdp.send("Profiler.start");
await page.waitForTimeout(4000);
const { profile: p } = await cdp.send("Profiler.stop");
const s1 = await meters();
const frames = await page.evaluate(() => window.__perf.frames);
const lt = await page.evaluate(() => window.__perf.longTasks);

const byId = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const n = byId.get(p.samples[i]);
  if (!n) continue;
  const cf = n.callFrame;
  const key = `${cf.functionName || "(anonymous)"} | ${cf.url.split("/").pop() || "inline"}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + (p.timeDeltas[i] || 0));
}
const totalSampled = [...self.values()].reduce((x, y) => x + y, 0);

const steady = {
  flagsAtLoad,
  flagsSteady,
  rate: rate(s0, s1, 4000),
  frames: frameStats(frames),
  longTasks: { count: lt.length, totalMs: lt.reduce((s, t) => s + t.dur, 0) },
  top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => ({ fn: k, ms: Math.round(v / 1000), pct: +((v / totalSampled) * 100).toFixed(1) })),
};
log("STEADY", JSON.stringify(steady, null, 1));

// ---- preset scenario latency (app-reported ms + wall time to UI refresh) ----
const presets = [];
const chips = page.locator(".panel .presets .chip");
const n = await chips.count();
for (let i = 0; i < n; i++) {
  const before = await page.evaluate(() => document.querySelector(".drawer")?.innerText || "");
  const t = Date.now();
  let wall = null;
  let reported = null;
  let routes = null;
  try {
    await chips.nth(i).click({ timeout: 5000 });
    await page.waitForFunction(
      (prev) => (document.querySelector(".drawer")?.innerText || "") !== prev,
      before,
      { timeout: 8000 }
    );
    wall = Date.now() - t;
    const text = await page.evaluate(() => document.querySelector(".drawer")?.innerText || "");
    const m = /(\d+)\s*ms/.exec(text);
    reported = m ? Number(m[1]) : null;
    const r = /(\d+)\s*مسیر/.exec(text);
    routes = r ? Number(r[1]) : null;
    presets.push({ chip: i, label: (await chips.nth(i).innerText()).trim().slice(0, 60), wallMsToUIUpdate: wall, reportedComputeMs: reported, routes });
  } catch (e) {
    presets.push({ chip: i, error: String(e.message || e).slice(0, 160), wallMsToUIUpdate: wall });
  }
  log("preset", i, JSON.stringify(presets[presets.length - 1]));
}
steady.presets = presets;

writeFileSync(OUT, JSON.stringify(steady, null, 2));
log("wrote", OUT);
await browser.close();
