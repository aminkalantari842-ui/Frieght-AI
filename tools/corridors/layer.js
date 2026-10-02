/* کریدورهای حمل‌ونقل — لایهٔ کریدورهای باربری منتهی به ایران و راه‌های داخلی
   کشورهای همسایه (OpenStreetMap / ODbL).
   Injected before the app bundle. It hooks the map engine via
   globalThis.__IR_CORRIDORS(engine), called right after the engine redraws its
   cached base layer. Geometry is projected with the engine's own
   equirectangular/Mercator math (affine fast path), falling back to
   engine.project(). Data: gzip+base64 payload in #ir-corridors-data. */
(function () {
  "use strict";

  var STATS = (globalThis.__IR_CORRIDORS_STATS = {
    ready: false,
    enabled: true,
    userOn: true,
    corridors: 0,
    corridorSegs: 0,
    roads: 0,
    roadByClass: [0, 0],
    countries: 0,
    points: 0,
    parseMs: null,
    drawMs: 0,
    drawnCorridorSegs: 0,
    drawnRoads: 0,
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
    return (2 * Math.atan(Math.exp(-my)) - Math.PI / 2) / XI;
  };

  // Corridors are the point of this layer, so they draw at every zoom.
  // Foreign motorway/trunk networks only earn their pixels when zoomed in.
  var LOD_ROAD = [3.0, 3.8]; // motorway, trunk
  var PALETTES = {
    dark: {
      roadCasing: "rgba(8,10,18,0.55)",
      roadFill: ["#8C7BF0", "#5B54B8"],
      corrCasing: "rgba(10,30,36,0.85)",
      corrFill: "#3FD0D6",
      roadWidth: [2.2, 1.5],
      corrWidth: 3.0,
    },
    light: {
      roadCasing: "rgba(255,255,255,0.92)",
      roadFill: ["#6E5CD8", "#4B45A0"],
      corrCasing: "rgba(233,252,253,0.95)",
      corrFill: "#12A3AC",
      roadWidth: [2.2, 1.5],
      corrWidth: 3.0,
    },
  };

  var corridorSegs = [];
  var roadSegs = [[], []];
  var engineRef = null;
  var parseStarted = false;
  var panel = null;
  var panelZoom = null;
  var panelInfo = null;
  var sw = null;

  // ---------------- data ----------------
  var CH = [];
  (function () {
    for (var d = 0; d <= 9; d++) CH[48 + d] = d;
    for (var a = 0; a < 26; a++) CH[97 + a] = 10 + a;
  })();

  // Single-pass decoder: base36 zigzag tokens separated by ";".
  // Projects straight to mercator radians (rx/my) so draw time never needs
  // trigonometry; longitude/latitude are recovered for the slow-path fallback.
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
      ref: "",
      owner: -1,
      km: 0,
      px: null,
      py: null,
      pv: -1,
      vis: false,
    };
  }

  function build(dataset) {
    var lines = dataset.lines || [];
    var roads = dataset.roads || [];
    var total = 0;
    var i;
    var w;
    var corridorKm = 0;
    for (i = 0; i < lines.length; i++) {
      var lrow = lines[i];
      w = decodeWay(lrow[1]);
      w.ref = lrow[2] || "";
      w.owner = lrow[3] | 0;
      corridorSegs.push(w);
      total += w.n;
    }
    for (i = 0; i < roads.length; i++) {
      var rrow = roads[i];
      var cls = rrow[0] | 0;
      if (cls > 1) cls = 1;
      w = decodeWay(rrow[1]);
      w.ref = rrow[2] || "";
      w.owner = rrow[3] | 0;
      roadSegs[cls].push(w);
      total += w.n;
      STATS.roadByClass[cls]++;
    }
    var metas = dataset.corridors || [];
    for (i = 0; i < metas.length; i++) corridorKm += metas[i].km || 0;
    var reached = {};
    for (i = 0; i < metas.length; i++) {
      var cs = metas[i].countries || [];
      for (var j = 0; j < cs.length; j++) reached[cs[j]] = 1;
    }

    STATS.corridors = metas.length;
    STATS.corridorSegs = corridorSegs.length;
    STATS.roads = roadSegs[0].length + roadSegs[1].length;
    STATS.countries = Object.keys(reached).length;
    STATS.corridorKm = Math.round(corridorKm);
    STATS.points = total;
    globalThis.__IR_CORRIDORS_WAYS = { corridors: corridorSegs, roads: roadSegs };
    globalThis.__IR_CORRIDORS_META = { corridors: metas, countries: dataset.countries || [] };
  }

  function fail(err) {
    STATS.error = String((err && err.message) || err);
    STATS.enabled = false;
  }

  function startParse() {
    if (parseStarted) return;
    parseStarted = true;
    var el = document.getElementById("ir-corridors-data");
    if (!el) return fail(new Error("missing #ir-corridors-data"));
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

  // ---------------- projection ----------------
  function projectList(engine, A, C, scale, fast, list) {
    for (var k = 0; k < list.length; k++) {
      var w = list[k];
      if (w.maxRx < engine.__lonMin || w.minRx > engine.__lonMax || w.maxMy < engine.__myMin || w.minMy > engine.__myMax) {
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

  function projectAll(engine) {
    var scale = engine.scale;
    var W = engine.W;
    var H = engine.H;
    var center = engine.view.center;
    var fast = engine.proj === "2d" && STATS.fastPath !== false;
    var A = W / 2 - center[0] * XI * scale;
    var C = H / 2 - mercY(center[1]) * scale;
    // Visible window in the same mercator-radian space the decoder produced,
    // so bbox culling is a pure comparison with no per-point work.
    engine.__lonMin = -A / scale;
    engine.__lonMax = (W - A) / scale;
    engine.__myMin = -C / scale;
    engine.__myMax = (H - C) / scale;
    projectList(engine, A, C, scale, fast, corridorSegs);
    projectList(engine, A, C, scale, fast, roadSegs[0]);
    projectList(engine, A, C, scale, fast, roadSegs[1]);
  }

  // Confirm the affine fast path agrees with engine.project() before trusting it.
  function selfCheck(engine) {
    if (STATS.fastPath !== null) return;
    try {
      var w = corridorSegs[0];
      if (!w || !w.px) return;
      var maxErr = 0;
      var step = Math.max(1, (w.n / 3) | 0);
      for (var i = 0; i < w.n; i += step) {
        var p = engine.project(w.rx[i] / XI, invMercY(w.my[i]));
        if (!p) continue;
        maxErr = Math.max(maxErr, Math.abs(p[0] - w.px[i]), Math.abs(p[1] - w.py[i]));
      }
      STATS.fastPath = maxErr < 0.75;
    } catch (err) {
      STATS.fastPath = false;
    }
  }

  // ---------------- draw ----------------
  function draw(engine) {
    if (!engine) return;
    if (!STATS.enabled || !STATS.userOn) {
      // Nothing is painted while the layer is off, so the debug counters must
      // report that too — a stale count otherwise reads as "still drawn".
      STATS.drawnCorridorSegs = 0;
      STATS.drawnRoads = 0;
      STATS.drawMs = 0;
      return;
    }
    if (!corridorSegs.length && !roadSegs[0].length && !roadSegs[1].length) {
      startParse();
      return;
    }
    if (!STATS.ready) return;
    var t0 = performance.now();
    try {
      projectAll(engine);
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

      // Foreign networks underneath, corridors on top: the corridors are the
      // narrative, the internal roads are the connective tissue.
      var roadWidthScale = Math.max(0.75, Math.min(1.35, zoom / 4));
      var drawnRoads = 0;
      for (var rpass = 0; rpass < 2; rpass++) {
        for (var cls = 1; cls >= 0; cls--) {
          if (zoom < LOD_ROAD[cls]) continue;
          var arr = roadSegs[cls];
          ctx.lineWidth = pal.roadWidth[cls] * roadWidthScale + (rpass === 0 ? 1.5 : 0);
          ctx.strokeStyle = rpass === 0 ? pal.roadCasing : pal.roadFill[cls];
          ctx.beginPath();
          for (var k = 0; k < arr.length; k++) {
            var w = arr[k];
            if (!w.vis || !w.px) continue;
            if (rpass === 1) drawnRoads++;
            ctx.moveTo(w.px[0], w.py[0]);
            for (var i = 1; i < w.n; i++) ctx.lineTo(w.px[i], w.py[i]);
          }
          ctx.stroke();
        }
      }

      // Corridors: constant minimum width so they stay legible zoomed out,
      // plus a soft halo that keeps them readable over dense road fill.
      var corrScale = Math.max(0.85, Math.min(1.6, 0.7 + zoom / 8));
      var drawnCorr = 0;
      for (var cpass = 0; cpass < 2; cpass++) {
        ctx.lineWidth = pal.corrWidth * corrScale + (cpass === 0 ? 3.4 : 0);
        ctx.strokeStyle = cpass === 0 ? pal.corrCasing : pal.corrFill;
        ctx.beginPath();
        for (var m = 0; m < corridorSegs.length; m++) {
          var cw = corridorSegs[m];
          if (!cw.vis || !cw.px) continue;
          if (cpass === 1) drawnCorr++;
          ctx.moveTo(cw.px[0], cw.py[0]);
          for (var q = 1; q < cw.n; q++) ctx.lineTo(cw.px[q], cw.py[q]);
        }
        ctx.stroke();
      }
      ctx.restore();
      STATS.drawnCorridorSegs = drawnCorr;
      STATS.drawnRoads = drawnRoads;
    } catch (err) {
      STATS.error = String((err && err.message) || err);
      STATS.enabled = false;
    }
    STATS.drawMs = Math.round((performance.now() - t0) * 10) / 10;
    if (panelZoom) panelZoom.textContent = STATS.error ? "خطا" : "z" + (STATS.zoom == null ? "?" : STATS.zoom);
  }

  globalThis.__IR_CORRIDORS = function (engine) {
    engineRef = engine;
    try {
      draw(engine);
    } catch (err) {
      STATS.error = String((err && err.message) || err);
    }
  };

  // ---------------- panel ----------------
  var CSS =
    ".ircp{position:fixed;z-index:60;direction:rtl;font-family:Vazirmatn,system-ui,sans-serif;font-size:11.5px;" +
    "background:var(--panel-solid,#1c1d1f);color:var(--text,#ecebe6);border:1px solid var(--line2,rgba(255,255,255,.14));" +
    "border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,.38);overflow:hidden;min-width:186px}" +
    ".ircp-head{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:pointer;user-select:none;background:transparent;border:0;color:inherit;width:100%;font:inherit;text-align:right}" +
    ".ircp-head:hover{background:rgba(255,255,255,.05)}" +
    ".ircp-dot{width:8px;height:8px;border-radius:50%;background:#3FD0D6;box-shadow:0 0 0 2px rgba(63,208,214,.25)}" +
    ".ircp-title{flex:1;font-weight:600}" +
    ".ircp-sw{position:relative;width:26px;height:14px;border-radius:999px;background:rgba(255,255,255,.18);transition:background .15s}" +
    ".ircp-sw[data-on='1']{background:#3FD0D6}" +
    ".ircp-sw:after{content:'';position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#fff;transition:transform .15s}" +
    ".ircp-sw[data-on='1']:after{transform:translateX(-12px)}" +
    ".ircp-body{padding:2px 10px 8px;border-top:1px solid var(--line2,rgba(255,255,255,.1))}" +
    ".ircp-row{display:flex;align-items:center;gap:6px;padding:2px 0;opacity:.94}" +
    ".ircp-l{width:16px;height:0;border-radius:2px;display:inline-block}" +
    ".ircp-c{border-top:3px solid #3FD0D6}.ircp-m{border-top:3px solid #8C7BF0}.ircp-t{border-top:2px solid #5B54B8}" +
    ".ircp-foot{margin-top:5px;opacity:.62;font-size:10px;line-height:1.7}" +
    ".ircp-foot a{color:inherit;text-decoration:underline}" +
    ".ircp[data-off='1'] .ircp-body{opacity:.45}" +
    ".ircp-note{opacity:.62;font-size:10px;margin-top:2px;line-height:1.7}";

  var fa = function (n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  };

  function updatePanel() {
    if (!sw || !panel) return;
    var on = STATS.userOn && STATS.ready;
    sw.setAttribute("data-on", on ? "1" : "0");
    panel.setAttribute("data-off", on ? "0" : "1");
    if (panelInfo) {
      if (STATS.error) {
        panelInfo.textContent = "خطا در بارگذاری داده";
      } else if (STATS.ready) {
        panelInfo.textContent =
          fa(STATS.corridors) + " کریدور · " + fa(STATS.countries) + " کشور";
      } else {
        panelInfo.textContent = "در حال بارگذاری…";
      }
    }
    if (panelZoom && !STATS.error && STATS.zoom != null) panelZoom.textContent = "z" + STATS.zoom;
  }

  function toggle() {
    if (!STATS.ready) return;
    STATS.userOn = !STATS.userOn;
    if (engineRef) engineRef.baseDirty = true;
    updatePanel();
  }

  // Stack this panel directly beneath the Iran-roads panel when both exist so
  // the two layers never overlap.
  function place() {
    if (!panel) return;
    var anchor = document.querySelector(".fx-tools");
    var r = anchor ? anchor.getBoundingClientRect() : null;
    var left = r && r.width ? r.left : 240;
    var top = r && r.height ? r.bottom + 10 : 120;
    var roads = document.getElementById("ir-roads-panel");
    if (roads && roads.getBoundingClientRect().height) {
      var rr = roads.getBoundingClientRect();
      top = Math.max(top, rr.bottom + 8);
    }
    panel.style.left = Math.round(left) + "px";
    panel.style.top = Math.round(top) + "px";
  }

  function mountPanel() {
    if (panel) return;
    var style = document.createElement("style");
    style.id = "ircp-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    panel = document.createElement("div");
    panel.className = "ircp";
    panel.id = "ir-corridors-panel";
    panel.innerHTML =
      '<button class="ircp-head" aria-label="نمایش/پنهان کریدورهای حمل‌ونقل">' +
      '<span class="ircp-dot"></span><span class="ircp-title">کریدورهای باربری</span><span class="ircp-sw" data-on="0"></span>' +
      "</button>" +
      '<div class="ircp-body">' +
      '<div class="ircp-row"><i class="ircp-l ircp-c"></i>کریدور منتهی به ایران</div>' +
      '<div class="ircp-row"><i class="ircp-l ircp-m"></i>آزادراه · کشورهای همسایه</div>' +
      '<div class="ircp-row"><i class="ircp-l ircp-t"></i>بزرگراه · کشورهای همسایه</div>' +
      '<div class="ircp-note"><span class="ircp-info">در حال بارگذاری…</span> · <span class="ircp-zoom">z?</span></div>' +
      '<div class="ircp-foot">دادهٔ <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> (ODbL)</div>' +
      "</div>";
    document.body.appendChild(panel);
    sw = panel.querySelector(".ircp-sw");
    panelZoom = panel.querySelector(".ircp-zoom");
    panelInfo = panel.querySelector(".ircp-info");
    panel.querySelector(".ircp-head").addEventListener("click", toggle);
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