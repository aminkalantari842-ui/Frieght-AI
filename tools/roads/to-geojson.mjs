// Convert the packed road dataset to a standard GeoJSON FeatureCollection.
// Usage: node to-geojson.mjs   ->  iran-roads.geojson  (WGS84 / RFC 7946)

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const packed = JSON.parse(readFileSync("iran-roads-packed.json", "utf8"));
const dataset = JSON.parse(gunzipSync(Buffer.from(packed.data, "base64")).toString("utf8"));

const CLASSES = ["motorway", "trunk", "primary"];
const unzig = (t) => {
  const v = parseInt(t, 36);
  return v & 1 ? -(v + 1) / 2 : v / 2;
};

function coords(str) {
  const out = [];
  const tk = str.split(";");
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < tk.length; i += 2) {
    lon += unzig(tk[i]);
    lat += unzig(tk[i + 1]);
    out.push([+(lon / 1e4).toFixed(4), +(lat / 1e4).toFixed(4)]);
  }
  return out;
}

const geojson = {
  type: "FeatureCollection",
  name: "iran-roads-intercity",
  attribution: dataset.license,
  source_timestamp: dataset.ts,
  description:
    "Intercity road network of Iran derived from OpenStreetMap (motorway/trunk/primary, >= 0.8-2 km segments, Douglas-Peucker simplified).",
  features: dataset.ways.map(([cls, str, ref]) => ({
    type: "Feature",
    properties: { highway: CLASSES[cls], ref: ref || undefined },
    geometry: { type: "LineString", coordinates: coords(str) },
  })),
};

const json = JSON.stringify(geojson);
writeFileSync("iran-roads.geojson", json);
console.log("features:", geojson.features.length, "| size:", (json.length / 1024 / 1024).toFixed(2), "MB");
console.log(
  "by class:",
  CLASSES.map((c) => c + "=" + geojson.features.filter((f) => f.properties.highway === c).length).join(", ")
);
