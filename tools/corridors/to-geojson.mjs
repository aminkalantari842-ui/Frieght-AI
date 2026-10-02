// Emit RFC 7946 GeoJSON from the built corridor dataset, so the same data can
// be inspected in QGIS / geojson.io / mapshaper without the atlas.
// Usage: node to-geojson.mjs
// Outputs: corridors.geojson  (FeatureCollection of freight corridor lines)
//          internal-roads.geojson (FeatureCollection of neighbouring motorway/trunk ways)

import { existsSync, readFileSync, writeFileSync } from "node:fs";

if (!existsSync("corridors.json")) {
  console.error("missing corridors.json — run: node build.mjs");
  process.exit(1);
}
const ds = JSON.parse(readFileSync("corridors.json", "utf8"));

const CH = [];
for (let d = 0; d <= 9; d++) CH[48 + d] = d;
for (let a = 0; a < 26; a++) CH[97 + a] = 10 + a;

// Inverse of build.mjs encodeWay(): interleaved lon/lat base36 zigzag deltas.
const val36 = (tok) => {
  let v = 0;
  for (let i = 0; i < tok.length; i++) v = v * 36 + CH[tok.charCodeAt(i)];
  return v;
};

function decodeWay(str) {
  const toks = str.split(";");
  const pts = [];
  let lon = 0;
  let lat = 0;
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const vLon = val36(toks[i]);
    const vLat = val36(toks[i + 1]);
    lon += vLon & 1 ? -(vLon + 1) / 2 : vLon / 2;
    lat += vLat & 1 ? -(vLat + 1) / 2 : vLat / 2;
    pts.push([lon / 1e4, lat / 1e4]);
  }
  return pts;
}

const corridorMeta = ds.corridors || [];
const countryMeta = ds.countries || [];
const NAME_OF = Object.fromEntries(countryMeta.map((c) => [c.iso, c.name || c.iso]));
const fa = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const mkCollection = (features) => ({
  type: "FeatureCollection",
  ...(ds.ts ? { "generated": ds.ts } : {}),
  license: ds.license,
  features,
});

const corridorFeatures = (ds.lines || []).map((row) => {
  const meta = corridorMeta[row[3]] || {};
  return {
    type: "Feature",
    properties: {
      corridor_id: row[3],
      osm_relation: meta.id ?? null,
      ref: row[2] || null,
      name: meta.name || null,
      network: meta.network || null,
      countries: (meta.countries || []).map((iso) => NAME_OF[iso] || iso),
      countries_iso: meta.countries || [],
      km: meta.km ?? null,
    },
    geometry: { type: "LineString", coordinates: decodeWay(row[1]) },
  };
});

const roadFeatures = (ds.roads || []).map((row) => {
  const c = countryMeta[row[3]] || {};
  return {
    type: "Feature",
    properties: {
      class: row[0] === 0 ? "motorway" : "trunk",
      ref: row[2] || null,
      country: c.name || null,
      country_iso: c.iso || null,
    },
    geometry: { type: "LineString", coordinates: decodeWay(row[1]) },
  };
});

writeFileSync("corridors.geojson", JSON.stringify(mkCollection(corridorFeatures)));
writeFileSync("internal-roads.geojson", JSON.stringify(mkCollection(roadFeatures)));

const km = corridorMeta.reduce((a, c) => a + (c.km || 0), 0);
console.log(`corridors.geojson:     ${fa(corridorFeatures.length)} features, ${corridorMeta.length} corridors, ${fa(Math.round(km))} km`);
console.log(`internal-roads.geojson: ${fa(roadFeatures.length)} features across ${new Set(roadFeatures.map((f) => f.properties.country_iso)).size} countries`);