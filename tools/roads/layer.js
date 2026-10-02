/* راه‌های ایران — لایهٔ راه‌های بین‌شهری از OpenStreetMap (ODbL)
   This module is injected before the app bundle. It hooks the map engine via
   globalThis.__IR_ROADS(engine), which the engine calls right after it redraws
   its cached base layer. Geometry is projected with the engine's own
   equirectangular/Mercator math (affine fast path), or engine.project() as a
   fallback. Data: gzip+base64 payload in #iran-roads-data. */
(function () {
  "use strict";

  var STATS = (globalThis.__IR_ROADS_STATS = {
    ready: false,
    enabled: true,
    rowOn: true,
    userOn: true,
    ways: 0,
    points: 0,
    parseMs: null,
    drawMs: 0,
    drawnWays: 0,
    zoom: null,
    fastPath: null,
    error: null,
  });

  var XI = Math.PI / 180;
  var LAT_CLAMP = 84.9;
  var mercY = function (lat) {
    var a = lat * XI;
    if (a > LAT_CLAMP * XI) a = LAT_CLAMP * XI;
    else if (a < -LAT_CLAMP * XI) a = -LAT_CLAMP * XI;
    return -Math.log(Math.tan(Math.PI / 4 + a / 2));
  };
  var invMercY = function (my) {
    return ((2 * Math.atan(Math.exp(-my)) - Math.PI / 2) / XI);
  };

  var LOD = [0, 2.0, 3.2]; // min zoom per class: motorway always, trunk, primary
  var PALETTES = {
    dark: {
      casing: "rgba(10,12,16,0.6)",
      fill: ["#E8873B", "#DFB75A", "#7E8BA3"],
      width: [2.6, 1.9, 1.3],
    },
    light: {
      casing: "rgba(255,255,255,0.9)",
      fill: ["#D9772B", "#D9A33B", "#97A2B4"],
      width: [2.6, 1.9, 1.3],
    },
  };

  var ways = null;
  var byClass = [[], [], []];
  var engineRef = null;
  var parseStarted = false;
  var panel = null;
  var panelZoom = null;
  var sw = null;
  var roadRow = null;
  var roadRowObserved = false;

  // ---------------- data ----------------
  var CH = [];
  (function () {
    for (var d = 0; d <= 9; d++) CH[48 + d] = d;
    for (var a = 0; a < 26; a++) CH[97 + a] = 10 + a;
  })();

  // single-pass decoder: base36 zigzag tokens separated by ";"
  function decodeWay(str) {
    var len = str.length;
    var sep = 0;
    for (var i = 0; i < len; i++) if (str.charCodeAt(i) === 59) sep++;
    var n = (sep + 1) >> 1;
    var rx = new Float32Array(n);
    var my = new Float32Array(n);
    var pos = 0;
    var idx = 0;
    var lon = 0;
    var lat = 0;
    var minRx = 1e9;
    var maxRx = -1e9;
    var minMy = 1e9;
    var maxMy = -1e9;
    while (pos < len && idx < n) {
      var v = 0;
      var ch = 0;
      while (pos < len && (ch = str.charCodeAt(pos)) !== 59) {
        v = v * 36 + CH[ch];
        pos++;
      }
      pos++;
      lon += v & 1 ? -(v + 1) / 2 : v / 2;
      v = 0;
      while (pos < len && (ch = str.charCodeAt(pos)) !== 59) {
        v = v * 36 + CH[ch];
        pos++;
      }
      pos++;
      lat += v & 1 ? -(v + 1) / 2 : v / 2;
      var x = (lon / 1e4) * XI;
      var y = mercY(lat / 1e4);
      rx[idx] = x;
      my[idx] = y;
      idx++;
      if (x < minRx) minRx = x;
      if (x > maxRx) maxRx = x;
      if (y < minMy) minMy = y;
      if (y > maxMy) maxMy = y;
    }
    return {
      n: n,
      rx: rx,
      my: my,
      minRx: minRx,
      maxRx: maxRx,
      minMy: minMy,
      maxMy: maxMy,
      cls: 0,
      ref: "",
      px: null,
      py: null,
      pv: -1,
      vis: false,
    };
  }

  function build(dataset) {
    var total = 0;
    for (var i = 0; i < dataset.ways.length; i++) {
      var row = dataset.ways[i];
      var w = decodeWay(row[1]);
      w.cls = row[0] | 0;
      w.ref = row[2] || "";
      byClass[w.cls].push(w);
      total += w.n;
    }
    ways = true;
    STATS.ways = dataset.ways.length;
    STATS.points = total;
    globalThis.__IR_ROADS_WAYS = byClass; // debug / verification hook
  }

  function fail(err) {
    STATS.error = String((err && err.message) || err);
    STATS.enabled = false;
  }

  function startParse() {
    if (parseStarted) return;
    parseStarted = true;
    var el = document.getElementById("iran-roads-data");
    if (!el) return fail(new Error("missing #iran-roads-data"));
    if (typeof DecompressionStream === "undefined") return fail(new Error("DecompressionStream unsupported"));
    var t0 = performance.now();
    try {
      var payload = JSON.parse(el.textContent || "{}");
      var bin = atob(payload.data || "");
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      new Response(stream)
        .text()
        .then(function (text) {
          build(JSON.parse(text));
          STATS.parseMs = Math.round(performance.now() - t0);
          STATS.ready = true;
          if (engineRef) engineRef.baseDirty = true;
          updatePanel();
        })
        .catch(fail);
    } catch (err) {
      fail(err);
    }
  }

  // ---------------- projection + draw ----------------
  function projectWays(engine) {
    var scale = engine.scale;
    var W = engine.W;
    var H = engine.H;
    var center = engine.view.center;
    var fast = engine.proj === "2d" && STATS.fastPath !== false;
    var A = W / 2 - center[0] * XI * scale;
    var C = H / 2 - mercY(center[1]) * scale;
    var lonMin = -A / scale;
    var lonMax = (W - A) / scale;
    var myMin = -C / scale;
    var myMax = (H - C) / scale;

    for (var ci = 0; ci < 3; ci++) {
      var arr = byClass[ci];
      for (var k = 0; k < arr.length; k++) {
        var w = arr[k];
        if (
          w.maxRx < lonMin ||
          w.minRx > lonMax ||
          w.maxMy < myMin ||
          w.minMy > myMax
        ) {
          w.vis = false;
          continue;
        }
        if (fast) {
          if (w.pv !== engine.viewVersion || !w.px) {
            var px = w.px || (w.px = new Float32Array(w.n));
            var py = w.py || (w.py = new Float32Array(w.n));
            for (var i = 0; i < w.n; i++) {
              px[i] = A + w.rx[i] * scale;
              py[i] = C + w.my[i] * scale;
            }
            w.pv = engine.viewVersion;
          }
          w.vis = true;
        } else {
          // fallback: engine.project per point
          var px2 = w.px || (w.px = new Float32Array(w.n));
          var py2 = w.py || (w.py = new Float32Array(w.n));
          var ok = true;
          for (var j = 0; j < w.n; j++) {
            var p = engine.project(w.rx[j] / XI, invMercY(w.my[j]));
            if (!p) {
              ok = false;
              break;
            }
            px2[j] = p[0];
            py2[j] = p[1];
          }
          w.vis = ok;
        }
      }
    }
  }

  function selfCheck(engine) {
    if (STATS.fastPath !== null) return;
    try {
      var w = byClass[0][0] || byClass[1][0] || byClass[2][0];
      if (!w || !w.px) return;
      var maxErr = 0;
      for (var i = 0; i < w.n; i += Math.max(1, (w.n / 3) | 0)) {
        var p = engine.project(w.rx[i] / XI, invMercY(w.my[i]));
        if (!p) continue;
        maxErr = Math.max(maxErr, Math.abs(p[0] - w.px[i]), Math.abs(p[1] - w.py[i]));
      }
      STATS.fastPath = maxErr < 0.75;
    } catch (err) {
      STATS.fastPath = false;
    }
  }

  // Mirror the app's own "جاده‌ای" layer row. The row may not exist yet when
  // this module boots (React renders it later), so resolve lazily on each
  // base redraw and attach an observer the first time it is found.
  function roadRowOn() {
    if (!roadRow || !roadRow.isConnected) {
      roadRow = null;
      var rows = document.querySelectorAll(".mode-row[aria-pressed]");
      for (var i = 0; i < rows.length; i++) {
        if (/جاده/.test(rows[i].textContent || "")) {
          roadRow = rows[i];
          break;
        }
      }
      if (!roadRow) return true;
      if (!roadRowObserved) {
        roadRowObserved = true;
        try {
          new MutationObserver(function () {
            STATS.rowOn = roadRow.getAttribute("aria-pressed") === "true";
            if (engineRef) engineRef.baseDirty = true;
          }).observe(roadRow, { attributes: true, attributeFilter: ["aria-pressed"] });
        } catch (err) {
          /* non-fatal */
        }
      }
    }
    return roadRow.getAttribute("aria-pressed") === "true";
  }

  function draw(engine) {
    if (!engine) return;
    STATS.rowOn = roadRowOn();
    if (!STATS.enabled || !STATS.rowOn || !STATS.userOn) return;
    if (!ways) {
      startParse();
      return;
    }
    var t0 = performance.now();
    try {
      projectWays(engine);
      selfCheck(engine);
      var zoom = (engine.view && engine.view.zoom) || 1;
      STATS.zoom = Math.round(zoom * 100) / 100;
      var pal = PALETTES[engine.theme === "light" ? "light" : "dark"];
      var ctx = engine.bctx;
      if (!ctx) return;
      ctx.save();
      var dpr = engine.dpr || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      var ws = Math.max(0.75, Math.min(1.5, zoom / 3));
      var drawn = 0;
      for (var pass = 0; pass < 2; pass++) {
        for (var ci = 2; ci >= 0; ci--) {
          if (zoom < LOD[ci]) continue;
          var arr = byClass[ci];
          ctx.lineWidth = pal.width[ci] * ws + (pass === 0 ? 1.7 : 0);
          ctx.strokeStyle = pass === 0 ? pal.casing : pal.fill[ci];
          ctx.beginPath();
          for (var k = 0; k < arr.length; k++) {
            var w = arr[k];
            if (!w.vis || !w.px) continue;
            if (pass === 0) drawn++;
            ctx.moveTo(w.px[0], w.py[0]);
            for (var i = 1; i < w.n; i++) ctx.lineTo(w.px[i], w.py[i]);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
      STATS.drawnWays = drawn;
    } catch (err) {
      STATS.error = String((err && err.message) || err);
      STATS.enabled = false;
    }
    STATS.drawMs = Math.round((performance.now() - t0) * 10) / 10;
    if (panelZoom) panelZoom.textContent = "z" + (STATS.zoom == null ? "?" : STATS.zoom);
  }

  globalThis.__IR_ROADS = function (engine) {
    engineRef = engine;
    globalThis.__IR_ENGINE = engine; // debug / verification hook
    try {
      draw(engine);
    } catch (err) {
      STATS.error = String((err && err.message) || err);
    }
  };

  // ---------------- panel ----------------
  var CSS =
    ".irp{position:fixed;z-index:60;direction:rtl;font-family:Vazirmatn,system-ui,sans-serif;font-size:11.5px;" +
    "background:var(--panel-solid,#1c1d1f);color:var(--text,#ecebe6);border:1px solid var(--line2,rgba(255,255,255,.14));" +
    "border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,.38);overflow:hidden;min-width:168px}" +
    ".irp-head{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:pointer;user-select:none;background:transparent;border:0;color:inherit;width:100%;font:inherit;text-align:right}" +
    ".irp-head:hover{background:rgba(255,255,255,.05)}" +
    ".irp-dot{width:8px;height:8px;border-radius:50%;background:#E8873B;box-shadow:0 0 0 2px rgba(232,135,59,.25)}" +
    ".irp-title{flex:1;font-weight:600}" +
    ".irp-sw{position:relative;width:26px;height:14px;border-radius:999px;background:rgba(255,255,255,.18);transition:background .15s}" +
    ".irp-sw[data-on='1']{background:#E8873B}" +
    ".irp-sw:after{content:'';position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#fff;transition:transform .15s}" +
    ".irp-sw[data-on='1']:after{transform:translateX(-12px)}" +
    ".irp-body{padding:2px 10px 8px;border-top:1px solid var(--line2,rgba(255,255,255,.1))}" +
    ".irp-row{display:flex;align-items:center;gap:6px;padding:2px 0;opacity:.94}" +
    ".irp-l{width:16px;height:0;border-radius:2px;display:inline-block}" +
    ".irp-m{border-top:3px solid #E8873B}.irp-t{border-top:3px solid #DFB75A}.irp-p{border-top:2px solid #7E8BA3}" +
    ".irp-foot{margin-top:5px;opacity:.62;font-size:10px;line-height:1.7}" +
    ".irp-foot a{color:inherit;text-decoration:underline}" +
    ".irp[data-off='1'] .irp-body{opacity:.45}" +
    ".irp-note{opacity:.62;font-size:10px;margin-top:2px}";

  function updatePanel() {
    if (!sw || !panel) return;
    sw.setAttribute("data-on", STATS.userOn && STATS.ready ? "1" : "0");
    panel.setAttribute("data-off", STATS.userOn && STATS.ready ? "0" : "1");
    if (STATS.error && panelZoom) panelZoom.textContent = "خطا";
  }

  function toggle() {
    if (!STATS.ready) return;
    STATS.userOn = !STATS.userOn;
    if (engineRef) engineRef.baseDirty = true;
    updatePanel();
  }

  function place() {
    if (!panel) return;
    var anchor = document.querySelector(".fx-tools");
    var r = anchor ? anchor.getBoundingClientRect() : null;
    var left = r && r.width ? r.left : 240;
    var top = r && r.height ? r.bottom + 10 : 120;
    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
  }

  function mountPanel() {
    if (panel) return;
    var style = document.createElement("style");
    style.id = "irp-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    panel = document.createElement("div");
    panel.className = "irp";
    panel.id = "ir-roads-panel";
    panel.innerHTML =
      '<button class="irp-head" aria-label="نمایش/پنهان راه‌های بین‌شهری">' +
      '<span class="irp-dot"></span><span class="irp-title">راه‌های ایران</span><span class="irp-sw" data-on="0"></span>' +
      "</button>" +
      '<div class="irp-body">' +
      '<div class="irp-row"><i class="irp-l irp-m"></i>آزادراه</div>' +
      '<div class="irp-row"><i class="irp-l irp-t"></i>بزرگراه / شریانی</div>' +
      '<div class="irp-row"><i class="irp-l irp-p"></i>راه اصلی</div>' +
      '<div class="irp-note">شبکهٔ بین‌شهری · <span class="irp-zoom">z?</span></div>' +
      '<div class="irp-foot">دادهٔ <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> (ODbL)</div>' +
      "</div>";
    document.body.appendChild(panel);
    sw = panel.querySelector(".irp-sw");
    panelZoom = panel.querySelector(".irp-zoom");
    panel.querySelector(".irp-head").addEventListener("click", toggle);
    place();
    setTimeout(place, 500);
    setTimeout(place, 1500);
    window.addEventListener("resize", place);
    updatePanel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel);
  } else {
    mountPanel();
  }
})();
