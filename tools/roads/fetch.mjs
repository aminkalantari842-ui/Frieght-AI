// Fetch Iran road geometry from OpenStreetMap via Overpass API.
// Usage: node fetch.mjs <job>   where <job> is one of the keys below.
// Raw responses are cached as raw-<job>.json (re-runs skip existing files).

import { existsSync, writeFileSync } from "node:fs";

const ENDPOINT = "https://overpass-api.de/api/interpreter";
const UA = "iran-freight-atlas/1.0 (road layer data build)";

const JOBS = {
  motorway: { cls: "motorway" },
  trunk: { cls: "trunk" },
  "primary-sw": { cls: "primary", bbox: [25.0, 44.0, 33.0, 54.0] },
  "primary-se": { cls: "primary", bbox: [25.0, 54.0, 33.0, 63.6] },
  "primary-nw": { cls: "primary", bbox: [33.0, 44.0, 40.0, 54.0] },
  "primary-ne": { cls: "primary", bbox: [33.0, 54.0, 40.0, 63.6] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(name, job) {
  const file = `raw-${name}.json`;
  if (existsSync(file)) {
    console.log(`skip ${file} (already fetched)`);
    return;
  }
  const bbox = job.bbox ? `(${job.bbox.join(",")})` : "";
  const query = `[out:json][timeout:180];area["ISO3166-1"="IR"][admin_level=2]->.a;way(area.a)["highway"="${job.cls}"]${bbox};out geom;`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(170_000),
      });
      const text = await res.text();
      if (!res.ok) {
        console.log(`attempt ${attempt}: HTTP ${res.status} ${text.slice(0, 120).replace(/\s+/g, " ")}`);
        await sleep(10_000 * attempt);
        continue;
      }
      const json = JSON.parse(text);
      const ways = (json.elements || []).filter((e) => e.type === "way" && e.geometry?.length);
      writeFileSync(
        file,
        JSON.stringify({ osmTimestamp: json.osm3s?.timestamp_osm_base || null, ways })
      );
      console.log(
        `${file}: ${ways.length} ways, ${(text.length / 1048576).toFixed(1)} MB downloaded, ${((Date.now() - t0) / 1000).toFixed(1)}s`
      );
      return;
    } catch (err) {
      console.log(`attempt ${attempt} failed: ${err.message}`);
      await sleep(10_000 * attempt);
    }
  }
  console.log(`FAILED ${file}`);
  process.exitCode = 1;
}

const name = process.argv[2];
if (!JOBS[name]) {
  console.log("jobs:", Object.keys(JOBS).join(", "));
  process.exit(1);
}
await run(name, JOBS[name]);
