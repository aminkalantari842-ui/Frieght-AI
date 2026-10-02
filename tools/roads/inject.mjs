// Inject (or re-inject) the Iran road layer into the atlas HTML.
// Usage: node inject.mjs [path-to-html]
// Requires: iran-roads-packed.json and layer.js in this folder.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const HTML_PATH = process.argv[2] ? process.argv[2] : REPO + "iran-freight-atlas-v3.html";

const MARK_START = "<!-- iran-roads:start -->";
const MARK_END = "<!-- iran-roads:end -->";
const ANCHOR = "this.baseDirty&&(this._drawBase(),this.baseDirty=!1)";
const ANCHOR_NEW =
  "this.baseDirty&&(this._drawBase(),globalThis.__IR_ROADS&&globalThis.__IR_ROADS(this),this.baseDirty=!1)";

const payload = readFileSync(HERE + "iran-roads-packed.json", "utf8").trim();
const layer = readFileSync(HERE + "layer.js", "utf8");

if (payload.includes("</script") || layer.includes("</script")) {
  throw new Error("refusing to inject: content contains </script");
}
JSON.parse(payload); // validate payload shape

let html = readFileSync(HTML_PATH, "utf8");
const before = Buffer.byteLength(html);

// 1) remove a previous injection
const startIdx = html.indexOf(MARK_START);
if (startIdx !== -1) {
  const endIdx = html.indexOf(MARK_END);
  if (endIdx === -1) throw new Error("found start marker without end marker; aborting");
  // also remove the line's trailing indentation/newline up to the next tag
  html = html.slice(0, startIdx) + html.slice(endIdx + MARK_END.length);
  html = html.replace(/^\s*\n/, "");
}

// 2) revert a previous engine hook
if (html.includes(ANCHOR_NEW)) html = html.split(ANCHOR_NEW).join(ANCHOR);

// 3) locate the main bundle script (first <script> after the sourcemap script)
const sm = html.indexOf("window.__artifactSourceMap");
if (sm === -1) throw new Error("sourcemap anchor not found; unexpected file");
const scriptIdx = html.indexOf("<script", sm);
if (scriptIdx === -1) throw new Error("bundle script not found");

const block =
  MARK_START +
  "\n    <script type=\"application/json\" id=\"iran-roads-data\">" +
  payload +
  "</script>\n    <script>\n" +
  layer +
  "\n</script>\n" +
  MARK_END +
  "\n    ";
html = html.slice(0, scriptIdx) + block + html.slice(scriptIdx);

// 4) hook the engine frame loop (exactly once)
const count = html.split(ANCHOR).length - 1;
if (count !== 1) throw new Error("engine anchor count is " + count + ", expected 1");
html = html.replace(ANCHOR, ANCHOR_NEW);

writeFileSync(HTML_PATH, html);
const after = Buffer.byteLength(html);
console.log("injected into", HTML_PATH);
console.log("size:", (before / 1048576).toFixed(2), "MB ->", (after / 1048576).toFixed(2), "MB (+" + ((after - before) / 1024).toFixed(0) + " KB)");
console.log("payload:", (payload.length / 1024).toFixed(0), "KB base64 | layer module:", (layer.length / 1024).toFixed(1), "KB");
console.log("html bytes:", statSync(HTML_PATH).size);
