// Fetch freight corridor data for the atlas from OpenStreetMap via Overpass API.
// Usage:
//   node fetch.mjs corridors          # route relations that touch Iran  -> raw-corridors.json
//   node fetch.mjs reach              # which countries each corridor crosses -> raw-reach.json
//                                     # (corridor relation ids per country)
//   node fetch.mjs roads <ISO2>       # internal motorway/trunk near corridors of one country
//                                     #                                   -> raw-roads-<ISO2>.json
//   node fetch.mjs roads-all          # every country in COUNTRIES (sequentially, cached)
//
// Definition used by this layer (kept explicit and reproducible):
//   * a corridor is an OSM route relation (type=route, route=road|trunk) that has
//     at least one member inside Iran's admin_level=2 area, i.e. it terminates
//     at or passes through Iran;
//   * a corridor's "internal roads" are the motorway/trunk ways of every other
//     country the corridor crosses, within CORRIDOR_BUFFER_KM of the corridor
//     line itself.
// Raw responses are cached as raw-*.json; re-runs skip existing files.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Mirrors are tried in rotation so one busy/limited instance cannot stall a build.
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const UA = "iran-freight-atlas/1.0 (corridor layer data build)";

// Countries considered for internal roads. Iran itself is already served by the
// tools/roads layer, so it is only used as the corridor anchor.
const COUNTRIES = [
  "IR", // anchor: relations are discovered inside Iran
  "TR",
  "IQ",
  "SY",
  "AM",
  "AZ",
  "GE",
  "TM",
  "UZ",
  "AF",
  "PK",
  "OM",
  "SA",
  "KW",
];

const ROUTE_RE = "^(road|trunk)$";
// How close a motorway/trunk way must be to a corridor line to count as part
// of that corridor's internal network. Applied by build.mjs, not Overpass.
const CORRIDOR_BUFFER_KM = 40;
const BATCH = 12;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Overpass mirrors throttle aggressively; back off longer when we see 429/504.
let penalty = 0;
const pause = async (base) => {
  const wait = base + penalty;
  penalty = Math.min(penalty + 20_000, 120_000);
  await sleep(wait);
};
const reward = () => {
  penalty = Math.max(0, penalty - 10_000);
};

async function overpass(query, label) {
  const attempts = ENDPOINTS.length * 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];
    try {
      const t0 = Date.now();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(240_000),
      });
      const text = await res.text();
      if (!res.ok) {
        console.log(`  [${new URL(endpoint).host}] attempt ${attempt}: HTTP ${res.status} ${text.slice(0, 90).replace(/\s+/g, " ")}`);
        await pause(9000 * Math.ceil(attempt / ENDPOINTS.length));
        continue;
      }
      console.log(`  ${label}: ok via ${new URL(endpoint).host}, ${(text.length / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      reward();
      return JSON.parse(text);
    } catch (err) {
      console.log(`  [${new URL(endpoint).host}] attempt ${attempt} failed: ${err.message}`);
      await pause(9000 * Math.ceil(attempt / ENDPOINTS.length));
    }
  }
  throw new Error(`overpass failed for ${label} (tried ${attempts} request(s) across ${ENDPOINTS.length} mirror(s))`);
}

const areaSet = (iso) => `area["ISO3166-1"="${iso}"][admin_level=2]->.a${iso};`;

const lineMembers = (rel) =>
  (rel.members || [])
    .filter((m) => m.type === "way" && Array.isArray(m.geometry) && m.geometry.length > 1)
    .map((m) => m.geometry);

// ---------------------------------------------------------------- corridors
async function fetchCorridors() {
  const file = "raw-corridors.json";
  if (existsSync(file)) {
    console.log(`skip ${file}`);
    return;
  }
  // The candidate id list is stable for the life of the fetch, so cache it
  // after the first successful pass. Re-running then costs zero requests
  // before the geometry batches, which matters a lot while the public mirrors
  // are throttling us.
  let idsJson;
  if (existsSync("raw-corridors-index.json")) {
    const cached = JSON.parse(readFileSync("raw-corridors-index.json", "utf8"));
    idsJson = { elements: cached.ids.map((id) => ({ id })), osm3s: { timestamp_osm_base: cached.ts } };
    console.log(`skip corridor id list (${cached.ids.length} relations)`);
  } else {
    const base = `[out:json][timeout:240];${areaSet("IR")}relation(area.aIR)["type"="route"]["route"~"${ROUTE_RE}"];out ids tags;`;
    idsJson = await overpass(base, "corridor relations (ids+tags)");
    const rels = idsJson.elements || [];
    if (!rels.length) throw new Error("no corridor relations found in Iran");
    console.log(`  ${rels.length} candidate corridor relations`);
    writeFileSync(
      "raw-corridors-index.json",
      JSON.stringify({ ts: idsJson.osm3s?.timestamp_osm_base || null, ids: rels.map((r) => r.id) })
    );
  }

  // geometry is fetched in small batches and cached per batch, so a server-side
  // 504 never discards work already done
  const rels = idsJson.elements || [];
  const batches = [];
  for (let i = 0; i < rels.length; i += BATCH) batches.push(rels.slice(i, i + BATCH));

  const out = [];
  let ts = idsJson.osm3s?.timestamp_osm_base || null;
  let failed = 0;
  for (let b = 0; b < batches.length; b++) {
    const slice = batches[b];
    const part = `raw-corr-${String(b).padStart(3, "0")}.json`;
    if (existsSync(part)) {
      const cached = JSON.parse(readFileSync(part, "utf8"));
      out.push(...cached.corridors);
      ts ||= cached.ts || null;
      console.log(`skip ${part} (${cached.corridors.length} corridors)`);
      continue;
    }
    const q = `[out:json][timeout:300];relation(id:${slice.map((r) => r.id).join(",")});out geom;`;
    try {
      const json = await overpass(q, `corridor geometry ${b + 1}/${batches.length}`);
      const got = [];
      for (const el of json.elements || []) {
        const lines = lineMembers(el);
        if (!lines.length) continue;
        got.push({ id: el.id, tags: el.tags || {}, lines });
      }
      ts ||= json.osm3s?.timestamp_osm_base || null;
      writeFileSync(part, JSON.stringify({ ts: json.osm3s?.timestamp_osm_base || null, corridors: got }));
      out.push(...got);
      console.log(`  ${part}: ${got.length} corridors`);
    } catch (err) {
      failed++;
      console.log(`  ${part}: FAILED (${err.message}) — re-run to retry`);
      await pause(30_000);
    }
    if (b + 1 < batches.length) await pause(12_000);
  }
  if (!out.length) throw new Error("no corridor geometry fetched");

  writeFileSync(file, JSON.stringify({ osmTimestamp: ts, corridors: out }));
  console.log(`raw-corridors.json: ${out.length} corridors with geometry${failed ? ` (${failed} batch(es) still missing)` : ""}`);
}

// -------------------------------------------------------------------- reach
// Which countries does the corridor network reach? Overpass answers this
// directly per country: a route relation "in" a country's area is a corridor
// that has at least one member inside that country. The result is a set of
// *corridor relation ids* per country, which is exactly the key build.mjs
// needs to label corridors — no way-id join required. Each country is cached
// separately (raw-reach-<ISO>.json) so throttled passes accumulate progress.
async function fetchReach() {
  const file = "raw-reach.json";
  if (existsSync(file)) {
    console.log(`skip ${file}`);
    return;
  }
  if (!existsSync("raw-corridors-index.json")) throw new Error("run: node fetch.mjs corridors");

  // Restricting to the already-known corridor ids keeps this cheap: the server
  // only has to filter 271 relations against the country area instead of
  // scanning every route relation in it.
  const ids = JSON.parse(readFileSync("raw-corridors-index.json", "utf8")).ids || [];

  // Per-country cache so throttled passes still make forward progress.
  const reach = {};
  for (const iso of COUNTRIES) {
    const part = `raw-reach-${iso}.json`;
    if (existsSync(part)) {
      reach[iso] = JSON.parse(readFileSync(part, "utf8")).ids || [];
      console.log(`skip ${part} (${reach[iso].length} corridors)`);
      continue;
    }
    const q =
      `[out:json][timeout:180];${areaSet(iso)}` +
      `relation(id:${ids.join(",")})(area.a${iso});out ids;`;
    let json;
    try {
      json = await overpass(q, `reach ${iso}`);
    } catch {
      console.log(`  reach ${iso}: unavailable — re-run to retry`);
      await pause(20_000);
      continue;
    }
    const got = (json.elements || []).map((e) => e.id);
    writeFileSync(part, JSON.stringify({ ids: got }));
    reach[iso] = got;
    console.log(`  reach ${iso}: ${got.length} corridors`);
    await sleep(2500);
  }
  const done = COUNTRIES.filter((iso) => existsSync(`raw-reach-${iso}.json`));
  if (done.length === COUNTRIES.length) {
    writeFileSync(file, JSON.stringify({ reach }));
  }
  console.log(`raw-reach.json: ${done.length}/${COUNTRIES.length} countries (${done.join(", ") || "none"})`);
}

// -------------------------------------------------------------------- roads
// Deliberately a *plain* per-country network query rather than a corridor-aware
// one. Overpass throttles (and 504s on) large multi-step corridor-relation
// traversals, and a `way(around:…)` join over ~270 relations is exactly the
// shape that times out. Fetching the country's whole motorway/trunk network is
// a single cheap selector that every mirror answers reliably; build.mjs then
// keeps only the ways that actually lie within CORRIDOR_BUFFER_KM of a
// corridor line, which is the same answer at a fraction of the server cost.
const roadsQuery = (iso) =>
  `[out:json][timeout:300];${areaSet(iso)}` +
  `way["highway"~"^(motorway|trunk)$"](area.a${iso});` +
  `out geom;`;

async function fetchRoads(iso) {
  const file = `raw-roads-${iso}.json`;
  if (existsSync(file)) {
    console.log(`skip ${file}`);
    return;
  }
  const json = await overpass(roadsQuery(iso), `internal roads ${iso}`);
  const ways = (json.elements || [])
    .filter((e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length > 1)
    .map((e) => ({ id: e.id, tags: e.tags || {}, geometry: e.geometry }));
  writeFileSync(
    file,
    JSON.stringify({ osmTimestamp: json.osm3s?.timestamp_osm_base || null, country: iso, ways })
  );
  console.log(`raw-roads-${iso}.json: ${ways.length} ways`);
}

const known = new Set(COUNTRIES);

const job = process.argv[2];
if (job === "corridors") await fetchCorridors();
else if (job === "reach") await fetchReach();
else if (job === "roads") {
  const iso = (process.argv[3] || "").toUpperCase();
  if (!known.has(iso)) {
    console.log(`countries: ${COUNTRIES.join(", ")}`);
    process.exit(1);
  }
  await fetchRoads(iso);
} else if (job === "roads-all") {
  for (const iso of COUNTRIES) {
    if (iso === "IR") continue; // already covered by tools/roads
    try {
      await fetchRoads(iso);
    } catch (err) {
      console.log(`raw-roads-${iso}.json: FAILED (${err.message})`);
    }
    await sleep(5000);
  }
} else {
  console.log("usage: node fetch.mjs corridors | reach | roads <ISO2> | roads-all");
  console.log("countries:", COUNTRIES.join(", "));
  process.exit(1);
}