// Build compact road data for the atlas from raw Overpass responses.
// Reads raw-*.json, simplifies geometry, then emits:
//   iran-roads.json      — readable dataset (debug / tooling)
//   iran-roads-packed.json — embed payload: delta/base36 + gzip + base64
// class: 0 motorway, 1 trunk, 2 primary

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";

const TOL = [
  Number(process.env.TOL0 || 0.002), // motorway (~180 m at Iran latitudes)
  Number(process.env.TOL1 || 0.005), // trunk    (~450 m)
  Number(process.env.TOL2 || 0.012), // primary  (~1.1 km)
];
// Drop short urban fragments below this length (km); 0 keeps everything.
const MIN_KM = [
  Number(process.env.MIN0 || 0.8),
  Number(process.env.MIN1 || 0.8),
  Number(process.env.MIN2 || 0.8),
];

const wayKm = (g) => {
  let km = 0;
  for (let i = 1; i < g.length; i++) {
    const dx = (g[i].lon - g[i - 1].lon) * 111 * Math.cos((32 * Math.PI) / 180);
    const dy = (g[i].lat - g[i - 1].lat) * 111;
    km += Math.hypot(dx, dy);
  }
  return km;
};

const INPUTS = [
  { file: "raw-motorway.json", cls: 0 },
  { file: "raw-trunk.json", cls: 1 },
  { file: "raw-primary-sw.json", cls: 2 },
  { file: "raw-primary-se.json", cls: 2 },
  { file: "raw-primary-nw.json", cls: 2 },
  { file: "raw-primary-ne.json", cls: 2 },
];

function simplify(points, tol) {
  if (points.length < 3) return points;
  const tol2 = tol * tol;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > tol2) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);

// delta + zigzag + base36, tokens joined by ";"
function encodeWay(ints) {
  const tokens = [];
  let prevLon = 0;
  let prevLat = 0;
  for (let i = 0; i < ints.length; i += 2) {
    const lon = ints[i];
    const lat = ints[i + 1];
    tokens.push(zz(lon - prevLon).toString(36), zz(lat - prevLat).toString(36));
    prevLon = lon;
    prevLat = lat;
  }
  return tokens.join(";");
}

const seen = new Set();
const ways = [];
let ts = null;
const stats = { kept: 0, skipped: 0, pointsBefore: 0, pointsAfter: 0, byClass: [0, 0, 0], ptsBefore: [0, 0, 0], ptsAfter: [0, 0, 0] };

for (const { file, cls } of INPUTS) {
  if (!existsSync(file)) {
    console.log("missing", file);
    continue;
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  ts ||= raw.osmTimestamp || null;
  for (const w of raw.ways) {
    if (seen.has(w.id)) {
      stats.skipped++;
      continue;
    }
    seen.add(w.id);
    const pts = [];
    for (const g of w.geometry || []) {
      if (typeof g.lat !== "number" || typeof g.lon !== "number") continue;
      pts.push([r4(g.lon), r4(g.lat)]);
    }
    if (pts.length < 2) {
      stats.skipped++;
      continue;
    }
    if (wayKm(w.geometry) < MIN_KM[cls]) {
      stats.skipped++;
      continue;
    }
    stats.pointsBefore += pts.length;
    stats.ptsBefore[cls] += pts.length;
    const simplified = simplify(pts, TOL[cls]);
    if (simplified.length < 2) {
      stats.skipped++;
      continue;
    }
    stats.pointsAfter += simplified.length;
    stats.ptsAfter[cls] += simplified.length;
    stats.byClass[cls]++;
    stats.kept++;

    const ints = [];
    for (const [lon, lat] of simplified) ints.push(Math.round(lon * 1e4), Math.round(lat * 1e4));
    let ref = (w.tags?.ref || "").split(";")[0].trim().slice(0, 12);
    if (!/^[A-Za-z]{0,3}\s?-?\d+/.test(ref)) ref = "";
    ways.push([cls, encodeWay(ints), ref]);
  }
}

ways.sort((a, b) => a[0] - b[0]);
const dataset = { v: 1, ts, license: "© OpenStreetMap contributors (ODbL)", ways };
const readable = JSON.stringify(dataset);
writeFileSync("iran-roads.json", readable);

const packedRaw = Buffer.from(readable, "utf8");
const gz = gzipSync(packedRaw, { level: 9 });
const br = brotliCompressSync(packedRaw);
const payload = {
  v: 1,
  ts,
  license: dataset.license,
  enc: "dz36+gzip+base64",
  data: gz.toString("base64"),
};
const payloadJson = JSON.stringify(payload);
writeFileSync("iran-roads-packed.json", payloadJson);

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log("tolerances:", TOL.join(" / "), "| minKm:", MIN_KM.join(" / "));
console.log("ways:", stats.kept, JSON.stringify(stats.byClass), "| skipped:", stats.skipped);
console.log("points:", stats.pointsBefore, "->", stats.pointsAfter);
console.log("per class pts:", JSON.stringify(stats.ptsBefore), "->", JSON.stringify(stats.ptsAfter));
console.log("encoded text:", kb(readable.length));
console.log("gzip:", kb(gz.length), "| brotli:", kb(br.length));
console.log("embedded payload (base64 gzip):", kb(payloadJson.length));
