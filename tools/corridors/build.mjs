// Build the compact corridor dataset for the atlas.
//
// Inputs
//   raw-corridors.json   corridor route relations (geometry) reaching Iran
//   raw-reach.json       per-country corridor-way membership
//   raw-roads-<ISO2>.json internal motorway/trunk ways near the corridors
//
// Outputs
//   corridors.json          readable dataset (debug / tooling)
//   corridors-packed.json   embed payload: delta/base36 + gzip + base64
//
// Row layout (compact, mirrors tools/roads):
//   lines: [kind, encodedPath, ref, corridorIndex]
//   roads: [class, encodedPath, ref, countryIndex]
// kind:  0 corridor line
// class: 0 motorway, 1 trunk

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";

// Douglas-Peucker tolerance in degrees, per line kind. Corridors span
// thousands of kilometres, so they tolerate coarser simplification than the
// dense per-country motorway/trunk networks.
const TOL = {
  corridor: Number(process.env.TOLC || 0.004), // ~350 m
  motorway: Number(process.env.TOL0 || 0.004),
  trunk: Number(process.env.TOL1 || 0.01),
};

// Segments shorter than this (km) are dropped.
const MIN_KM = {
  corridor: Number(process.env.MINC || 2),
  motorway: Number(process.env.MIN0 || 1.5),
  trunk: Number(process.env.MIN1 || 1.5),
};

const R4 = (v) => Math.round(v * 1e4) / 1e4;

// Great-circle-ish length in km, accurate enough for segment filtering.
function pathKm(g) {
  let km = 0;
  for (let i = 1; i < g.length; i++) {
    const lat = ((g[i].lat + g[i - 1].lat) / 2) * (Math.PI / 180);
    const dx = (g[i].lon - g[i - 1].lon) * 111.32 * Math.cos(lat);
    const dy = (g[i].lat - g[i - 1].lat) * 110.57;
    km += Math.hypot(dx, dy);
  }
  return km;
}

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

function prepare(geom) {
  const pts = [];
  for (const g of geom) {
    if (typeof g.lat !== "number" || typeof g.lon !== "number") continue;
    pts.push([R4(g.lon), R4(g.lat)]);
  }
  return pts;
}

const cleanRef = (raw) => {
  const ref = (raw || "").split(";")[0].trim().slice(0, 16);
  return /^[A-Za-z۰-۹0-9][A-Za-z۰-۹0-9\s.\-/]{0,15}$/.test(ref) ? ref : "";
};

// Decode an encoded row back to [lon, lat] pairs. Used only by the build-time
// corridor-proximity filter, so a straightforward split() is fast enough.
const CH36 = [];
for (let d = 0; d <= 9; d++) CH36[48 + d] = d;
for (let a = 0; a < 26; a++) CH36[97 + a] = 10 + a;

const decodedForFilter = (str) => {
  const toks = str.split(";");
  const out = [];
  let lon = 0;
  let lat = 0;
  for (let i = 0; i + 1 < toks.length; i += 2) {
    let v = 0;
    for (let c = 0; c < toks[i].length; c++) v = v * 36 + CH36[toks[i].charCodeAt(c)];
    lon += v & 1 ? -(v + 1) / 2 : v / 2;
    v = 0;
    for (let c = 0; c < toks[i + 1].length; c++) v = v * 36 + CH36[toks[i + 1].charCodeAt(c)];
    lat += v & 1 ? -(v + 1) / 2 : v / 2;
    out.push([lon / 1e4, lat / 1e4]);
  }
  return out;
};

// Country display names for the layer legend / tooltips.
const COUNTRIES = [
  { iso: "IR", name: "Iran" },
  { iso: "TR", name: "Turkey" },
  { iso: "IQ", name: "Iraq" },
  { iso: "SY", name: "Syria" },
  { iso: "AM", name: "Armenia" },
  { iso: "AZ", name: "Azerbaijan" },
  { iso: "GE", name: "Georgia" },
  { iso: "TM", name: "Turkmenistan" },
  { iso: "UZ", name: "Uzbekistan" },
  { iso: "AF", name: "Afghanistan" },
  { iso: "PK", name: "Pakistan" },
  { iso: "OM", name: "Oman" },
  { iso: "SA", name: "Saudi Arabia" },
  { iso: "KW", name: "Kuwait" },
];
const ISO_LIST = COUNTRIES.map((c) => c.iso);
const NAME_OF = Object.fromEntries(COUNTRIES.map((c) => [c.iso, c.name]));

const stats = {
  corridors: 0,
  corridorSegs: 0,
  corridorKm: 0,
  roads: 0,
  byClass: [0, 0],
  offCorridor: 0,
  segsBefore: 0,
  segsAfter: 0,
  skipped: 0,
};

const corridorRows = [];
const roadRows = [];
const corridorMeta = [];
const countryMeta = [];
let ts = null;

// ---------------------------------------------------------------- corridors
// The merged raw-corridors.json is the normal input, but the fetch caches one
// file per Overpass batch. If some batches are still missing, fall back to
// whatever batches exist so the build (and its size/perf estimate) can run
// mid-fetch instead of only after every batch lands.
let corridorsRaw;
if (existsSync("raw-corridors.json")) {
  corridorsRaw = JSON.parse(readFileSync("raw-corridors.json", "utf8"));
} else {
  const parts = readdirSync(".").filter((f) => /^raw-corr-\d{3}\.json$/.test(f)).sort();
  if (!parts.length) {
    console.error("missing raw-corridors.json — run: node fetch.mjs corridors");
    process.exit(1);
  }
  corridorsRaw = { osmTimestamp: null, corridors: [] };
  for (const p of parts) {
    const cached = JSON.parse(readFileSync(p, "utf8"));
    corridorsRaw.corridors.push(...cached.corridors);
    corridorsRaw.osmTimestamp ||= cached.ts || null;
  }
  console.log(`note: raw-corridors.json absent — merged ${parts.length} cached batch(es) (${corridorsRaw.corridors.length} corridors)`);
}
ts ||= corridorsRaw.osmTimestamp || null;

// raw-reach.json maps country ISO -> set of *corridor relation ids* that pass
// through it (see fetchReach). Invert it once so each corridor can be labelled
// with the countries it actually crosses.
let relToCountries = new Map();
if (existsSync("raw-reach.json")) {
  const reach = JSON.parse(readFileSync("raw-reach.json", "utf8")).reach || {};
  for (const iso of ISO_LIST) {
    for (const id of reach[iso] || []) {
      if (!relToCountries.has(id)) relToCountries.set(id, []);
      relToCountries.get(id).push(iso);
    }
  }
  console.log(`reach: ${relToCountries.size} corridors labelled across ${Object.keys(reach).length} countries`);
} else {
  console.log("note: raw-reach.json absent — corridors will not be country-labelled");
}

const countryIndex = (iso) => {
  let i = countryMeta.findIndex((c) => c.iso === iso);
  if (i === -1) {
    countryMeta.push({ iso, name: NAME_OF[iso] || iso, segs: 0 });
    i = countryMeta.length - 1;
  }
  return i;
};

for (const rel of corridorsRaw.corridors) {
  const tags = rel.tags || {};
  const ref = cleanRef(tags.ref);
  if (!ref) continue;
  const name = tags["name:en"] || tags.name || tags["name:fa"] || ref;
  const network = tags.network || "";

  const countries = relToCountries.get(rel.id) || [];

  const idx = corridorMeta.length;
  let segs = 0;
  let segKm = 0;
  for (const line of rel.lines) {
    const km = pathKm(line);
    if (km < MIN_KM.corridor) {
      stats.skipped++;
      continue;
    }
    const pts = prepare(line);
    if (pts.length < 2) {
      stats.skipped++;
      continue;
    }
    const simplified = simplify(pts, TOL.corridor);
    if (simplified.length < 2) {
      stats.skipped++;
      continue;
    }
    const ints = [];
    for (const [lon, lat] of simplified) ints.push(Math.round(lon * 1e4), Math.round(lat * 1e4));
    corridorRows.push([0, encodeWay(ints), ref, idx]);
    segs++;
    segKm += km;
    stats.segsBefore += pts.length;
    stats.segsAfter += simplified.length;
  }
  if (!segs) continue;
  stats.corridors++;
  stats.corridorSegs += segs;
  stats.corridorKm += Math.round(segKm);
  corridorMeta.push({
    id: rel.id,
    ref,
    name: String(name).slice(0, 90),
    network: String(network).slice(0, 40),
    countries,
    segs,
    km: Math.round(segKm),
  });
}

// ------------------------------------------------------- internal road nets
const roadFiles = ISO_LIST.map((iso) => `raw-roads-${iso}.json`).filter((f) => existsSync(f) && /raw-roads-[A-Z]{2}\.json$/.test(f));
if (!roadFiles.length) console.log("note: no raw-roads-<ISO2>.json yet — corridor lines only");

// Overpass returns each country's whole motorway/trunk network (see
// fetchRoads), so keep only the parts that actually serve a freight corridor:
// a way is in when any of its points falls within BUFFER_KM of any corridor
// line. Corridor points are bucketed into a 1-degree grid first so this stays
// near-linear instead of comparing every road point against every corridor.
const BUFFER_KM = Number(process.env.BUFM || 40);
const BUFFER_DEG_LAT = BUFFER_KM / 110.57;
const BUFFER_DEG_LON = (() => {
  // Widest latitude covered by the corridor set, in degrees.
  let lo = 90;
  let hi = -90;
  for (const rows of [corridorRows]) {
    for (const row of rows) for (const g of decodedForFilter(row[1])) {
      if (g[1] < lo) lo = g[1];
      if (g[1] > hi) hi = g[1];
    }
  }
  const widest = Math.max(Math.abs(lo), Math.abs(hi));
  const c = Math.cos(Math.min(1.49, (widest * Math.PI) / 180));
  return c < 0.05 ? 360 : BUFFER_DEG_LAT / c;
})();

// Decode corridor rows once, into both the grid and a reusable list.
const grid = new Map();
const gkey = (a, b) => a + "," + b;
const corridorPts = [];
for (const row of corridorRows) {
  for (const g of decodedForFilter(row[1])) {
    corridorPts.push(g);
    for (const [da, db] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      const k = gkey(Math.floor(g[1] / BUFFER_DEG_LAT) + da, Math.floor(g[0] / BUFFER_DEG_LON) + db);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(g);
    }
  }
}

const nearCorridor = (lon, lat) => {
  const list = grid.get(
    gkey(Math.floor(lat / BUFFER_DEG_LAT), Math.floor(lon / BUFFER_DEG_LON))
  );
  if (!list) return false;
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (Math.abs(g[1] - lat) <= BUFFER_DEG_LAT && Math.abs(g[0] - lon) <= BUFFER_DEG_LON) return true;
  }
  return false;
};

const seenWays = new Set();
for (const file of roadFiles) {
  // ISO 3166-1 alpha-2 codes (IQ, TR, IR, ...), not alpha-3.
  const iso = /raw-roads-([A-Z]{2})\.json$/.exec(file)[1];
  const raw = JSON.parse(readFileSync(file, "utf8"));
  ts ||= raw.osmTimestamp || null;
  const cIdx = countryIndex(iso);
  for (const w of raw.ways) {
    // Iran is owned by the tools/roads layer; keep the two layers disjoint.
    if (iso === "IR") continue;
    const key = w.id;
    if (seenWays.has(key)) {
      stats.skipped++;
      continue;
    }
    seenWays.add(key);
    const cls = w.tags?.highway === "motorway" ? 0 : w.tags?.highway === "trunk" ? 1 : null;
    if (cls === null) continue;
    const km = pathKm(w.geometry);
    if (km < MIN_KM[cls === 0 ? "motorway" : "trunk"]) {
      stats.skipped++;
      continue;
    }
    const pts = prepare(w.geometry);
    if (pts.length < 2) {
      stats.skipped++;
      continue;
    }
    // the way must actually serve a freight corridor
    let serves = false;
    for (let i = 0; i < pts.length; i++) {
      if (nearCorridor(pts[i][0], pts[i][1])) {
        serves = true;
        break;
      }
    }
    if (!serves) {
      stats.offCorridor++;
      continue;
    }
    const simplified = simplify(pts, TOL[cls === 0 ? "motorway" : "trunk"]);
    if (simplified.length < 2) {
      stats.skipped++;
      continue;
    }
    const ints = [];
    for (const [lon, lat] of simplified) ints.push(Math.round(lon * 1e4), Math.round(lat * 1e4));
    const ref = cleanRef(w.tags?.ref);
    roadRows.push([cls, encodeWay(ints), ref, cIdx]);
    stats.roads++;
    stats.byClass[cls]++;
    stats.segsBefore += pts.length;
    stats.segsAfter += simplified.length;
    countryMeta[cIdx].segs++;
  }
}

// Stable, deterministic output ordering.
corridorRows.sort((a, b) => a[3] - b[3] || a[2].localeCompare(b[2]));
roadRows.sort((a, b) => a[3] - b[3] || a[0] - b[0]);

const dataset = {
  v: 1,
  ts,
  license: "© OpenStreetMap contributors (ODbL)",
  enc: "dz36",
  corridors: corridorMeta,
  countries: countryMeta,
  lines: corridorRows,
  roads: roadRows,
};

const readable = JSON.stringify(dataset);
writeFileSync("corridors.json", readable);

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
writeFileSync("corridors-packed.json", JSON.stringify(payload));

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log("corridors:", stats.corridors, "| segments:", stats.corridorSegs, "| skipped:", stats.skipped);
console.log("countries (internal road segs):", countryMeta.map((c) => `${c.iso}=${c.segs}`).join(", ") || "(none)");
const touched = new Set(corridorMeta.flatMap((c) => c.countries));
console.log("countries (corridor reach):", [...touched].join(", ") || "(unlabelled)");
console.log("road segments:", stats.roads, JSON.stringify(stats.byClass), `(dropped ${stats.offCorridor} ways beyond ${BUFFER_KM} km of a corridor)`);
console.log("points:", stats.segsBefore, "->", stats.segsAfter, `(${(100 - (stats.segsAfter / Math.max(1, stats.segsBefore)) * 100).toFixed(0)}% dropped)`);
console.log("corridor length:", stats.corridorKm.toLocaleString("en-US"), "km");
console.log("corridor samples:", corridorMeta.slice(0, 6).map((c) => `${c.ref}(${c.km}km)`).join(", "));
console.log("encoded text:", kb(readable.length));
console.log("gzip:", kb(gz.length), "| brotli:", kb(br.length));
console.log("embedded payload (base64 gzip):", kb(JSON.stringify(payload).length));