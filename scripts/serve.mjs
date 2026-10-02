import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";
const ENTRY = "iran-freight-atlas-v3.html";
const ENTRY_FILE = join(ROOT, ENTRY);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const cache = new Map();

function load(file) {
  const { mtimeMs } = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const raw = readFileSync(file);
  const entry = { raw, gz: gzipSync(raw, { level: 6 }), mtimeMs };
  cache.set(file, entry);
  return entry;
}

createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (pathname === "/" || pathname === "/index.html") pathname = `/${ENTRY}`;

  const file = normalize(join(ROOT, pathname));
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404 Not Found");
    return;
  }

  const entry = load(file);
  const headers = {
    "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store",
    vary: "Accept-Encoding",
  };
  const useGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  const body = useGzip ? entry.gz : entry.raw;
  if (useGzip) headers["content-encoding"] = "gzip";
  headers["content-length"] = body.length;

  if (req.method === "HEAD") {
    res.writeHead(200, headers).end();
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}).listen(PORT, HOST, () => {
  const { raw, gz } = load(ENTRY_FILE);
  console.log(
    `Freight Atlas preview: http://${HOST}:${PORT}/  (entry: ${ENTRY}, ` +
      `${(raw.length / 1024).toFixed(0)} KB raw / ${(gz.length / 1024).toFixed(0)} KB gzip)`
  );
});
