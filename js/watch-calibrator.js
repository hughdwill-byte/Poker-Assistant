/*
 * watch-calibrator.js - the improved (move / resize / green-guide) calibration
 * editor for WATCH MODE. It overlays the live capture preview with a table
 * ANCHOR rectangle and the calibration region boxes, lets you drag/resize them
 * into place (with green alignment guides), and on save writes FRAME-NORMALIZED
 * regions into Watch's store so the reader uses them.
 *
 * It reuses the pure Poker.CalibrationPreset coordinate math and the same anchor
 * model as the HUD's Calibration Mode, so a preset calibrated in the HUD only
 * needs its anchor placed over the capture once. This never reads a site — it
 * only positions boxes over a screen the user chose to share.
 *
 * Attaches to Poker.WatchCalibrator. The DOM entry point `open()` needs a
 * browser; the coordinate helpers are pure and unit-tested.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  var CP = Poker.CalibrationPreset;

  // ---- pure helpers (tested) ----------------------------------------------
  // The editor lives directly over the video, so its pixel box IS the frame's
  // displayed box. An anchor in editor px therefore becomes a fraction of the
  // frame simply by dividing by the editor size.
  function anchorToFrame(anchorPx, size) {
    var W = Math.max(1, size.w), H = Math.max(1, size.h);
    return { x: anchorPx.x / W, y: anchorPx.y / H, w: anchorPx.w / W, h: anchorPx.h / H };
  }
  // preset (anchor-normalized) + anchor placed in editor px + editor size
  // -> Watch region map: key -> { x, y, w, h } as fractions of the frame.
  function presetToFrameRegions(preset, anchorPx, size) {
    if (!CP) return {};
    return CP.presetToFrameRegions(preset, anchorToFrame(anchorPx, size));
  }

  var api = { anchorToFrame: anchorToFrame, presetToFrameRegions: presetToFrameRegions };
  Poker.WatchCalibrator = api;

  // Everything below is DOM; skip it under Node (no document).
  if (typeof document === "undefined") return;

  var STYLE_ID = "watch-calib-style";
  var CSS =
    ".wcal{position:absolute;z-index:40;font:12px monospace}" +
    ".wcal *{box-sizing:border-box}" +
    ".wcal-anchor{position:absolute;border:2px dashed #57ff9a;box-shadow:0 0 12px rgba(87,255,154,.3);cursor:move;touch-action:none}" +
    ".wcal-anchor-lab{position:absolute;top:-17px;left:0;color:#57ff9a;letter-spacing:.16em;font-size:10px;text-shadow:0 0 3px #000}" +
    ".wcal-ah{position:absolute;width:14px;height:14px;background:#0a0e0c;border:2px solid #57ff9a;touch-action:none}" +
    ".wcal-ah-se{right:-8px;bottom:-8px;cursor:nwse-resize}.wcal-ah-sw{left:-8px;bottom:-8px;cursor:nesw-resize}" +
    ".wcal-ah-ne{right:-8px;top:-8px;cursor:nesw-resize}.wcal-ah-nw{left:-8px;top:-8px;cursor:nwse-resize}" +
    ".wcal-region{position:absolute;border:1.5px solid #9a6fd0;background:rgba(0,0,0,.12);cursor:move;touch-action:none;z-index:45}" +
    ".wcal-region:hover{background:rgba(87,255,154,.10)}" +
    ".wcal-region.sel{box-shadow:0 0 0 1px rgba(255,176,46,.7)}" +
    ".wcal-region.snap{border-color:#57ff9a;box-shadow:0 0 8px rgba(87,255,154,.7)}" +
    ".wcal-lab{position:absolute;top:-12px;left:0;font-size:9px;white-space:nowrap;text-shadow:0 0 3px #000}" +
    ".wcal-rh{position:absolute;width:10px;height:10px;background:#0a0e0c;border:1.5px solid #ffb02e;display:none;z-index:47;touch-action:none}" +
    ".wcal-region:hover .wcal-rh,.wcal-region.sel .wcal-rh{display:block}" +
    ".wcal-rh-se{right:-6px;bottom:-6px;cursor:nwse-resize}.wcal-rh-nw{left:-6px;top:-6px;cursor:nwse-resize}" +
    ".wcal-rh-ne{right:-6px;top:-6px;cursor:nesw-resize}.wcal-rh-sw{left:-6px;bottom:-6px;cursor:nesw-resize}" +
    ".wcal-guide{position:absolute;background:#57ff9a;box-shadow:0 0 6px rgba(87,255,154,.8);z-index:60;pointer-events:none}" +
    ".wcal-guide-v{top:0;bottom:0;width:1px}.wcal-guide-h{left:0;right:0;height:1px}" +
    ".wcal-bar{position:absolute;left:6px;top:6px;display:flex;gap:6px;flex-wrap:wrap;z-index:70;" +
    "background:rgba(10,14,12,.94);border:1px solid #1c2a22;border-radius:4px;padding:6px}" +
    ".wcal-bar b{color:#ffb02e;letter-spacing:.16em;align-self:center}" +
    ".wcal-btn{background:#0c1712;color:#d7e4dc;border:1px solid #1c2a22;border-radius:2px;padding:5px 9px;font:inherit;cursor:pointer}" +
    ".wcal-btn:hover{border-color:#ffb02e;color:#ffb02e}.wcal-save{border-color:#57ff9a;color:#0a0e0c;background:#57ff9a}";

  var layer = null, active = null, anchorPx = null, videoEl = null, sizeEl = null, cleanup = [];

  function on(el, t, fn, o) { el.addEventListener(t, fn, o); cleanup.push(function () { el.removeEventListener(t, fn, o); }); }
  function mk(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function size() { var r = (videoEl || sizeEl).getBoundingClientRect(); return { w: r.width, h: r.height }; }

  api.open = function (stageEl, video, opts) {
    opts = opts || {};
    if (!CP) return;
    api.close();
    videoEl = video || null; sizeEl = stageEl;
    active = opts.preset || CP.createPreset({ name: "Watch preset", tableAspect: 16 / 9, fitMode: "contain", regions: CP.defaultRegions() });
    if (!active.regions || !active.regions.length) active.regions = CP.defaultRegions();

    if (!document.getElementById(STYLE_ID)) {
      var st = mk("style"); st.id = STYLE_ID; st.textContent = CSS; document.head.appendChild(st);
    }
    layer = mk("div", "wcal");
    positionLayer();
    stageEl.appendChild(layer);

    var s = size();
    var asp = active.tableAspect || 16 / 9;
    var w = Math.min(s.w * 0.9, s.h * 0.9 * asp), hgt = w / asp;
    anchorPx = { x: (s.w - w) / 2, y: (s.h - hgt) / 2, w: w, h: hgt };

    buildAnchor();
    buildBar(opts);
    buildGuides();
    render();

    var reposition = function () { positionLayer(); render(); };
    on(window, "resize", reposition);
    on(window, "scroll", reposition, true);
  };

  api.close = function () {
    cleanup.forEach(function (f) { try { f(); } catch (e) {} }); cleanup = [];
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = null; active = null; anchorPx = null;
  };

  // Position the editing layer exactly over the video's displayed box.
  function positionLayer() {
    if (!layer) return;
    var host = layer.parentNode || sizeEl;
    if (videoEl && host) {
      var vr = videoEl.getBoundingClientRect(), hr = host.getBoundingClientRect();
      layer.style.left = (vr.left - hr.left) + "px";
      layer.style.top = (vr.top - hr.top) + "px";
      layer.style.width = vr.width + "px";
      layer.style.height = vr.height + "px";
    } else {
      layer.style.left = "0"; layer.style.top = "0"; layer.style.width = "100%"; layer.style.height = "100%";
    }
  }

  function buildAnchor() {
    var a = mk("div", "wcal-anchor");
    a.appendChild(mk("span", "wcal-anchor-lab")).textContent = "TABLE ANCHOR — drag over the table, then Save";
    ["se", "sw", "ne", "nw"].forEach(function (d) { var hEl = mk("span", "wcal-ah wcal-ah-" + d); hEl.dataset.dir = d; a.appendChild(hEl); });
    layer.appendChild(a);
    a.anchorEl = true;
    var drag = null;
    on(a, "pointerdown", function (e) {
      if (e.target.classList.contains("wcal-ah")) return;
      drag = { px: e.clientX, py: e.clientY, x: anchorPx.x, y: anchorPx.y };
      a.setPointerCapture(e.pointerId); e.preventDefault();
    });
    on(a, "pointermove", function (e) {
      if (!drag) return;
      anchorPx = CP.moveAnchor({ x: drag.x, y: drag.y, w: anchorPx.w, h: anchorPx.h }, e.clientX - drag.px, e.clientY - drag.py);
      render();
    });
    on(a, "pointerup", function (e) { drag = null; try { a.releasePointerCapture(e.pointerId); } catch (x) {} });
    Array.prototype.forEach.call(a.querySelectorAll(".wcal-ah"), function (hEl) {
      var dir = hEl.dataset.dir, rz = null;
      on(hEl, "pointerdown", function (e) { rz = { px: e.clientX, py: e.clientY, a: Object.assign({}, anchorPx) }; hEl.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); });
      on(hEl, "pointermove", function (e) {
        if (!rz) return;
        var dx = e.clientX - rz.px, dy = e.clientY - rz.py;
        var w = rz.a.w + (dir.indexOf("e") >= 0 ? dx : -dx), hh = rz.a.h + (dir.indexOf("s") >= 0 ? dy : -dy);
        var na = CP.resizeAnchor(rz.a, Math.max(40, w), Math.max(30, hh), !!active.lockAspect, active.tableAspect);
        if (dir.indexOf("w") >= 0) na.x = rz.a.x + (rz.a.w - na.w);
        if (dir.indexOf("n") >= 0) na.y = rz.a.y + (rz.a.h - na.h);
        anchorPx = na; render();
      });
      on(hEl, "pointerup", function (e) { rz = null; try { hEl.releasePointerCapture(e.pointerId); } catch (x) {} });
    });
    layer._anchorEl = a;
  }

  function buildBar(opts) {
    var bar = mk("div", "wcal-bar");
    bar.appendChild(mk("b")).textContent = "◈ WATCH CALIBRATION";
    function btn(label, cls, fn) { var b = mk("button", "wcal-btn" + (cls ? " " + cls : "")); b.type = "button"; b.textContent = label; on(b, "click", fn); bar.appendChild(b); return b; }
    btn("DONE · SAVE & USE", "wcal-save", function () {
      var fr = presetToFrameRegions(active, anchorPx, size());
      if (opts.onSave) opts.onSave(fr, active);
      api.close();
    });
    btn("CANCEL", null, function () { if (opts.onCancel) opts.onCancel(); api.close(); });
    btn("RESET BOXES", null, function () { active.regions = CP.defaultRegions(); render(); });
    layer.appendChild(bar);
  }

  function buildGuides() {
    var v = mk("div", "wcal-guide wcal-guide-v"); v.hidden = true;
    var hh = mk("div", "wcal-guide wcal-guide-h"); hh.hidden = true;
    layer.appendChild(v); layer.appendChild(hh);
    layer._gv = v; layer._gh = hh;
  }
  function showGuides(guides) {
    var gv = null, gh = null;
    (guides || []).forEach(function (g) { if (g.orient === "v") gv = g.pos; else gh = g.pos; });
    if (gv != null) { layer._gv.style.left = gv + "px"; layer._gv.hidden = false; } else layer._gv.hidden = true;
    if (gh != null) { layer._gh.style.top = gh + "px"; layer._gh.hidden = false; } else layer._gh.hidden = true;
  }
  function hideGuides() { if (layer) { layer._gv.hidden = true; layer._gh.hidden = true; } }

  var regionZ = 100;
  function render() {
    if (!layer) return;
    var a = layer._anchorEl;
    a.style.left = anchorPx.x + "px"; a.style.top = anchorPx.y + "px"; a.style.width = anchorPx.w + "px"; a.style.height = anchorPx.h + "px";
    // clear old region els
    Array.prototype.slice.call(layer.querySelectorAll(".wcal-region")).forEach(function (el) { el.remove(); });
    var opts = { tableAspect: active.tableAspect, fitMode: active.fitMode };
    active.regions.forEach(function (reg, i) {
      var px = CP.denormalize(reg, anchorPx, opts);
      var el = mk("div", "wcal-region");
      el.style.left = px.x + "px"; el.style.top = px.y + "px"; el.style.width = px.w + "px"; el.style.height = px.h + "px";
      el.style.borderColor = reg.color;
      var lab = mk("span", "wcal-lab"); lab.textContent = reg.label; lab.style.color = reg.color; el.appendChild(lab);
      ["se", "nw", "ne", "sw"].forEach(function (d) { var hEl = mk("span", "wcal-rh wcal-rh-" + d); hEl.dataset.dir = d; el.appendChild(hEl); });
      wireRegion(el, i);
      layer.appendChild(el);
    });
  }

  function otherRects(skip) {
    var opts = { tableAspect: active.tableAspect, fitMode: active.fitMode }, out = [];
    active.regions.forEach(function (r, i) { if (i !== skip) out.push(CP.denormalize(r, anchorPx, opts)); });
    return out;
  }
  function writeBack(i, el, x, y, w, h) {
    el.style.left = x + "px"; el.style.top = y + "px"; el.style.width = w + "px"; el.style.height = h + "px";
    var n = CP.normalize({ x: x, y: y, w: w, h: h }, anchorPx, { tableAspect: active.tableAspect, fitMode: active.fitMode });
    active.regions[i].x = n.x; active.regions[i].y = n.y; active.regions[i].w = n.w; active.regions[i].h = n.h;
  }
  function select(el) {
    Array.prototype.forEach.call(layer.querySelectorAll(".wcal-region.sel"), function (o) { o.classList.remove("sel"); });
    el.classList.add("sel"); el.style.zIndex = String(++regionZ);
  }
  function wireRegion(el, i) {
    var d = null;
    on(el, "pointerdown", function (e) {
      if (e.target.classList.contains("wcal-rh")) return;
      select(el); d = { px: e.clientX, py: e.clientY, l: parseFloat(el.style.left), t: parseFloat(el.style.top) };
      el.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault();
    });
    on(el, "pointermove", function (e) {
      if (!d) return;
      var nx = d.l + (e.clientX - d.px), ny = d.t + (e.clientY - d.py);
      var w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      var snap = CP.snapMove({ x: nx, y: ny, w: w, h: h }, otherRects(i), anchorPx, 6);
      nx = snap.rect.x; ny = snap.rect.y; showGuides(snap.guides);
      el.classList.toggle("snap", snap.snappedV || snap.snappedH);
      writeBack(i, el, nx, ny, w, h);
    });
    on(el, "pointerup", function (e) { d = null; hideGuides(); el.classList.remove("snap"); try { el.releasePointerCapture(e.pointerId); } catch (x) {} });
    Array.prototype.forEach.call(el.querySelectorAll(".wcal-rh"), function (hEl) {
      var dir = hEl.dataset.dir, rz = null;
      on(hEl, "pointerdown", function (e) { select(el); rz = { px: e.clientX, py: e.clientY, l: parseFloat(el.style.left), t: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }; hEl.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); });
      on(hEl, "pointermove", function (e) {
        if (!rz) return;
        var dx = e.clientX - rz.px, dy = e.clientY - rz.py, x = rz.l, y = rz.t, w = rz.w, h = rz.h, MIN = 6;
        if (dir.indexOf("e") >= 0) w = Math.max(MIN, rz.w + dx);
        if (dir.indexOf("s") >= 0) h = Math.max(MIN, rz.h + dy);
        if (dir.indexOf("w") >= 0) { w = Math.max(MIN, rz.w - dx); x = rz.l + (rz.w - w); }
        if (dir.indexOf("n") >= 0) { h = Math.max(MIN, rz.h - dy); y = rz.t + (rz.h - h); }
        writeBack(i, el, x, y, w, h);
      });
      on(hEl, "pointerup", function (e) { rz = null; try { hEl.releasePointerCapture(e.pointerId); } catch (x) {} });
    });
  }
})(typeof self !== "undefined" ? self : this);
