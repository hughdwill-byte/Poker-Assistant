/*
 * calibration-layer.js - the in-HUD Calibration editing layer (Phase 3).
 *
 * Default OFF. When toggled ON (Taskbar CALIB button or Ctrl/Cmd+Shift+C), it
 * overlays an editing surface above the HUD: a single ANCHOR rectangle (the
 * poker-table box) with drag/resize + lock-aspect, and every calibration region
 * drawn from the active preset via the PURE Poker.CalibrationPreset math. Moving
 * or resizing the anchor moves the whole set (regions are anchor-normalized).
 * The HUD panels dim and go non-interactive underneath so edits target
 * calibration. "Save & Hide" writes the normalized values to the active preset;
 * ESC exits without saving. Nothing here touches poker math.
 *
 * State is driven by the pure Poker.CalibrationToggle reducer; coordinates by
 * the pure Poker.CalibrationPreset. This file is the DOM/glue only.
 *
 * Storage (renderer localStorage; Electron persists it):
 *   pokerHud.presets      -> { [id]: <serialized preset string> }
 *   pokerHud.activePreset  -> id
 *   pokerHud.calibToggle   -> CalibrationToggle.serialize (active id only)
 */
(function () {
  "use strict";
  var CP = self.Poker && self.Poker.CalibrationPreset;
  var CT = self.Poker && self.Poker.CalibrationToggle;
  var api = window.overlayAPI || null;
  var HUD_ID = "poker-assistant-hud-root";

  var LS_PRESETS = "pokerHud.presets";
  var LS_ACTIVE = "pokerHud.activePreset";
  var LS_TOGGLE = "pokerHud.calibToggle";

  var state = CT ? CT.deserialize(lsGet(LS_TOGGLE)) : { on: false, activePresetId: null };
  var layer = null;         // the editing-layer root element
  var anchorPx = null;      // current anchor rect in overlay px
  var active = null;        // active preset object (regions live-normalized)
  var cleanup = [];

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function root() { var h = document.getElementById(HUD_ID); return h ? h.shadowRoot : null; }
  function on(el, type, fn, opts) { el.addEventListener(type, fn, opts); cleanup.push(function () { el.removeEventListener(type, fn, opts); }); }
  function vp() { return { w: window.innerWidth, h: window.innerHeight }; }

  // ---- preset storage ------------------------------------------------------
  function loadPresets() {
    try { return JSON.parse(lsGet(LS_PRESETS)) || {}; } catch (e) { return {}; }
  }
  function savePresets(map) { lsSet(LS_PRESETS, JSON.stringify(map)); }
  function newId() { return "preset_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function ensureActive() {
    var map = loadPresets();
    var id = state.activePresetId || lsGet(LS_ACTIVE);
    if (id && map[id]) { active = CP.deserialize(map[id]); active._id = id; return; }
    // Migrate a legacy Watch calibration if present; else start an empty preset.
    var legacy = null;
    try { legacy = JSON.parse(lsGet("pokerwatch.regions.v1")); } catch (e) {}
    if (legacy && Object.keys(legacy).length) {
      active = CP.migrateLegacy(legacy, { name: "Imported from Watch" });
    } else {
      active = CP.createPreset({ name: "New preset", tableAspect: 16 / 9, fitMode: "contain", regions: CP.defaultRegions() });
    }
    active._id = newId();
    persistActive();
  }
  function persistActive() {
    if (!active) return;
    var map = loadPresets();
    map[active._id] = CP.serialize(active);
    savePresets(map);
    lsSet(LS_ACTIVE, active._id);
    state = CT.reduce(state, { type: "SET_PRESET", id: active._id });
    lsSet(LS_TOGGLE, CT.serialize(state));
  }

  // ---- default anchor ------------------------------------------------------
  function defaultAnchor() {
    var v = vp();
    var asp = (active && active.tableAspect) || 16 / 9;
    var w = Math.min(v.w * 0.7, v.h * 0.7 * asp);
    var h = w / asp;
    return { x: (v.w - w) / 2, y: (v.h - h) / 2, w: w, h: h };
  }

  // ================= enter / exit ==========================================
  function enter() {
    if (state.on) return;
    if (!CP || !CT) { console.warn("[calib] preset/toggle modules missing"); return; }
    ensureActive();
    if (!anchorPx) anchorPx = defaultAnchor();
    state = CT.reduce(state, { type: "ENTER" });
    build();
    var host = document.getElementById(HUD_ID);
    if (host) host.classList.add("calib-active");        // dims + disables HUD
    render();
  }

  function exit(save) {
    if (!state.on) return;
    if (save) { persistActive(); state = CT.reduce(state, { type: "SAVE_AND_HIDE" }); state = CT.reduce(state, { type: "ACK_SAVE" }); }
    else { state = CT.reduce(state, { type: "EXIT" }); }
    lsSet(LS_TOGGLE, CT.serialize(state));
    teardown();
    var host = document.getElementById(HUD_ID);
    if (host) host.classList.remove("calib-active");
  }

  function toggle() { if (state.on) exit(false); else enter(); }

  function teardown() {
    cleanup.forEach(function (fn) { try { fn(); } catch (e) {} });
    cleanup = [];
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = null;
  }

  // ================= build DOM =============================================
  function build() {
    var r = root();
    if (!r) return;
    if (!r.getElementById("calib-style")) {
      var st = document.createElement("style");
      st.id = "calib-style";
      st.textContent = CALIB_CSS;
      r.appendChild(st);
    }
    layer = document.createElement("div");
    layer.className = "calib-layer";
    layer.setAttribute("role", "application");
    layer.setAttribute("aria-label", "Calibration editing layer");
    layer.innerHTML =
      '<div class="calib-anchor" tabindex="0" aria-label="Table anchor">' +
      '  <span class="calib-anchor-label">TABLE ANCHOR</span>' +
      '  <span class="calib-h calib-h-e" data-dir="e"></span><span class="calib-h calib-h-s" data-dir="s"></span>' +
      '  <span class="calib-h calib-h-se" data-dir="se"></span><span class="calib-h calib-h-sw" data-dir="sw"></span>' +
      '  <span class="calib-h calib-h-ne" data-dir="ne"></span><span class="calib-h calib-h-nw" data-dir="nw"></span>' +
      '</div>' +
      '<div class="calib-regions"></div>' +
      '<div class="calib-guide calib-guide-v" hidden></div>' +
      '<div class="calib-guide calib-guide-h" hidden></div>';
    r.querySelector(".hud-root").appendChild(layer);
    buildToolbar(r);
    wireAnchor();
    wireKeys();
  }

  function buildToolbar(r) {
    var bar = document.createElement("div");
    bar.className = "calib-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Calibration controls");
    bar.innerHTML =
      '<span class="calib-title">◈ CALIBRATION</span>' +
      '<select class="calib-select" aria-label="Active preset"></select>' +
      '<input class="calib-name" aria-label="Preset name" />' +
      '<button class="calib-btn" data-act="new">NEW</button>' +
      '<button class="calib-btn" data-act="dup">DUP</button>' +
      '<button class="calib-btn" data-act="del">DEL</button>' +
      '<button class="calib-btn" data-act="fit">FIT: CONTAIN</button>' +
      '<button class="calib-btn" data-act="lock">LOCK ASPECT: OFF</button>' +
      '<button class="calib-btn" data-act="export">EXPORT</button>' +
      '<button class="calib-btn" data-act="import">IMPORT</button>' +
      '<button class="calib-btn calib-save" data-act="save">DONE · SAVE &amp; HIDE</button>' +
      '<button class="calib-btn" data-act="cancel">ESC · CANCEL</button>' +
      '<textarea class="calib-io" hidden aria-label="Preset JSON (paste to import, copy to export)"></textarea>';
    layer.appendChild(bar);
    toolbar = bar;
    refreshPresetSelect();
    on(bar, "click", onToolbarClick);
    var name = bar.querySelector(".calib-name");
    on(name, "input", function () { if (active) { active.name = name.value; persistActive(); refreshPresetSelect(); } });
    var sel = bar.querySelector(".calib-select");
    on(sel, "change", function () { setActive(sel.value); });
    syncToolbar();
  }

  var toolbar = null;
  function syncToolbar() {
    if (!toolbar || !active) return;
    toolbar.querySelector(".calib-name").value = active.name || "";
    toolbar.querySelector('[data-act="fit"]').textContent = "FIT: " + (active.fitMode === "stretch" ? "STRETCH" : "CONTAIN");
    toolbar.querySelector('[data-act="lock"]').textContent = "LOCK ASPECT: " + (active.lockAspect ? "ON" : "OFF");
  }
  function refreshPresetSelect() {
    if (!toolbar) return;
    var sel = toolbar.querySelector(".calib-select");
    var map = loadPresets();
    sel.innerHTML = "";
    Object.keys(map).forEach(function (id) {
      var p = CP.deserialize(map[id]);
      var opt = document.createElement("option");
      opt.value = id; opt.textContent = p.name || id;
      if (active && id === active._id) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  function setActive(id) {
    var map = loadPresets();
    if (!map[id]) return;
    active = CP.deserialize(map[id]); active._id = id;
    lsSet(LS_ACTIVE, id);
    state = CT.reduce(state, { type: "SET_PRESET", id: id });
    lsSet(LS_TOGGLE, CT.serialize(state));
    anchorPx = defaultAnchor();
    syncToolbar(); render();
  }

  function onToolbarClick(e) {
    var b = e.target.closest(".calib-btn"); if (!b) return;
    var act = b.getAttribute("data-act");
    if (act === "save") return exit(true);
    if (act === "cancel") return exit(false);
    if (act === "fit") { active.fitMode = active.fitMode === "stretch" ? "contain" : "stretch"; persistActive(); syncToolbar(); render(); }
    if (act === "lock") { active.lockAspect = !active.lockAspect; persistActive(); syncToolbar(); }
    if (act === "new") { active = CP.createPreset({ name: "New preset", tableAspect: 16 / 9, fitMode: "contain", regions: CP.defaultRegions() }); active._id = newId(); persistActive(); refreshPresetSelect(); anchorPx = defaultAnchor(); syncToolbar(); render(); }
    if (act === "dup") { var d = CP.deserialize(CP.serialize(active)); d.name = (active.name || "Preset") + " copy"; d._id = newId(); active = d; persistActive(); refreshPresetSelect(); syncToolbar(); }
    if (act === "del") {
      var map = loadPresets(); delete map[active._id]; savePresets(map);
      var ids = Object.keys(map);
      if (ids.length) setActive(ids[0]); else { active = CP.createPreset({ name: "New preset", tableAspect: 16 / 9, fitMode: "contain", regions: CP.defaultRegions() }); active._id = newId(); persistActive(); refreshPresetSelect(); render(); }
    }
    if (act === "export") {
      var io = toolbar.querySelector(".calib-io"); io.hidden = false; io.value = CP.serialize(active); io.focus(); io.select();
      try { navigator.clipboard && navigator.clipboard.writeText(io.value); } catch (x) {}
    }
    if (act === "import") {
      var io2 = toolbar.querySelector(".calib-io");
      if (io2.hidden) { io2.hidden = false; io2.value = ""; io2.placeholder = "Paste preset JSON, then click IMPORT again"; io2.focus(); return; }
      var parsed = CP.deserialize(io2.value);
      if (parsed && parsed.ok) { parsed._id = newId(); active = parsed; persistActive(); refreshPresetSelect(); anchorPx = defaultAnchor(); io2.hidden = true; syncToolbar(); render(); }
      else { io2.style.borderColor = "#ff6b6b"; }
    }
  }

  // ================= anchor drag / resize (group transform) ================
  function wireAnchor() {
    var a = layer.querySelector(".calib-anchor");
    var drag = null;
    on(a, "pointerdown", function (e) {
      if (e.target.classList.contains("calib-h")) return;
      drag = { px: e.clientX, py: e.clientY, x: anchorPx.x, y: anchorPx.y };
      a.setPointerCapture(e.pointerId); e.preventDefault();
    });
    on(a, "pointermove", function (e) {
      if (!drag) return;
      anchorPx = CP.moveAnchor({ x: drag.x, y: drag.y, w: anchorPx.w, h: anchorPx.h }, e.clientX - drag.px, e.clientY - drag.py);
      render();
    });
    on(a, "pointerup", function (e) { drag = null; try { a.releasePointerCapture(e.pointerId); } catch (x) {} });

    Array.prototype.forEach.call(a.querySelectorAll(".calib-h"), function (hEl) {
      var dir = hEl.getAttribute("data-dir"), rz = null;
      on(hEl, "pointerdown", function (e) { rz = { px: e.clientX, py: e.clientY, a: Object.assign({}, anchorPx) }; hEl.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); });
      on(hEl, "pointermove", function (e) {
        if (!rz) return;
        var dx = e.clientX - rz.px, dy = e.clientY - rz.py;
        var w = rz.a.w + (dir.indexOf("e") >= 0 ? dx : dir.indexOf("w") >= 0 ? -dx : 0);
        var h = rz.a.h + (dir.indexOf("s") >= 0 ? dy : dir.indexOf("n") >= 0 ? -dy : 0);
        var na = CP.resizeAnchor(rz.a, Math.max(40, w), Math.max(30, h), active.lockAspect, active.tableAspect);
        if (dir.indexOf("w") >= 0) na.x = rz.a.x + (rz.a.w - na.w);
        if (dir.indexOf("n") >= 0) na.y = rz.a.y + (rz.a.h - na.h);
        anchorPx = na; render();
      });
      on(hEl, "pointerup", function (e) { rz = null; try { hEl.releasePointerCapture(e.pointerId); } catch (x) {} });
    });
  }

  function wireKeys() {
    on(document, "keydown", function (e) {
      if (!state.on) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); exit(false); }
    }, true);
  }

  // ================= render =================================================
  function render() {
    if (!layer) return;
    var a = layer.querySelector(".calib-anchor");
    a.style.left = anchorPx.x + "px"; a.style.top = anchorPx.y + "px";
    a.style.width = anchorPx.w + "px"; a.style.height = anchorPx.h + "px";

    var wrap = layer.querySelector(".calib-regions");
    wrap.innerHTML = "";
    var opts = { tableAspect: active.tableAspect, fitMode: active.fitMode };
    active.regions.forEach(function (reg, i) {
      var px = CP.denormalize(reg, anchorPx, opts);
      var el = document.createElement("div");
      el.className = "calib-region";
      el.style.left = px.x + "px"; el.style.top = px.y + "px";
      el.style.width = px.w + "px"; el.style.height = px.h + "px";
      el.style.borderColor = reg.color;
      el.title = reg.label;
      if (CP.regionOutOfBounds(reg)) el.classList.add("calib-region-warn");
      var lab = document.createElement("span");
      lab.className = "calib-region-label"; lab.textContent = reg.label; lab.style.color = reg.color;
      el.appendChild(lab);
      wireRegionDrag(el, i);
      wrap.appendChild(el);
    });
  }

  // Per-region fine-tune: drag writes back NORMALIZED coords vs the anchor.
  function wireRegionDrag(el, idx) {
    var d = null;
    on(el, "pointerdown", function (e) {
      d = { px: e.clientX, py: e.clientY, l: parseFloat(el.style.left), t: parseFloat(el.style.top) };
      el.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault();
    });
    on(el, "pointermove", function (e) {
      if (!d) return;
      var nx = d.l + (e.clientX - d.px), ny = d.t + (e.clientY - d.py);
      var w = parseFloat(el.style.width), h = parseFloat(el.style.height);
      // Snap to the anchor's edges/centre and to any other box's edges/centre;
      // matched lines glow green (they are always flat/vertical, i.e. at 90°).
      var others = otherRegionRectsPx(idx);
      var snap = CP.snapMove({ x: nx, y: ny, w: w, h: h }, others, anchorPx, 6);
      nx = snap.rect.x; ny = snap.rect.y;
      showGuides(snap.guides);
      el.classList.toggle("calib-snapped", snap.snappedV || snap.snappedH);
      var norm = CP.normalize({ x: nx, y: ny, w: w, h: h }, anchorPx, { tableAspect: active.tableAspect, fitMode: active.fitMode });
      active.regions[idx].x = norm.x; active.regions[idx].y = norm.y;
      el.style.left = nx + "px"; el.style.top = ny + "px";
      el.classList.toggle("calib-region-warn", CP.regionOutOfBounds(active.regions[idx]));
    });
    on(el, "pointerup", function (e) { d = null; hideGuides(); el.classList.remove("calib-snapped"); try { el.releasePointerCapture(e.pointerId); } catch (x) {} });
  }

  // Pixel rects of every region EXCEPT the one being dragged (snap targets).
  function otherRegionRectsPx(skipIdx) {
    var opts = { tableAspect: active.tableAspect, fitMode: active.fitMode };
    var out = [];
    active.regions.forEach(function (r, i) { if (i !== skipIdx) out.push(CP.denormalize(r, anchorPx, opts)); });
    return out;
  }

  // Green alignment guide lines, drawn full-screen along a snapped axis.
  function showGuides(guides) {
    if (!layer) return;
    var v = layer.querySelector(".calib-guide-v"), h = layer.querySelector(".calib-guide-h");
    var gv = null, gh = null;
    (guides || []).forEach(function (g) { if (g.orient === "v") gv = g.pos; else gh = g.pos; });
    if (v) { if (gv != null) { v.style.left = gv + "px"; v.hidden = false; } else v.hidden = true; }
    if (h) { if (gh != null) { h.style.top = gh + "px"; h.hidden = false; } else h.hidden = true; }
  }
  function hideGuides() {
    if (!layer) return;
    var v = layer.querySelector(".calib-guide-v"), h = layer.querySelector(".calib-guide-h");
    if (v) v.hidden = true; if (h) h.hidden = true;
  }

  var CALIB_CSS =
    ".calib-layer{position:absolute;inset:0;pointer-events:none;z-index:50}" +
    ".calib-layer .calib-anchor,.calib-layer .calib-region,.calib-layer .calib-toolbar{pointer-events:auto}" +
    ".calib-anchor{position:absolute;border:2px dashed #57ff9a;box-shadow:0 0 12px rgba(87,255,154,.25);cursor:move;touch-action:none}" +
    ".calib-anchor-label{position:absolute;top:-18px;left:0;color:#57ff9a;font:10px monospace;letter-spacing:.18em}" +
    ".calib-h{position:absolute;width:14px;height:14px;background:#0a0e0c;border:2px solid #57ff9a;touch-action:none}" +
    ".calib-h-e{right:-8px;top:50%;margin-top:-7px;cursor:ew-resize}.calib-h-s{bottom:-8px;left:50%;margin-left:-7px;cursor:ns-resize}" +
    ".calib-h-se{right:-8px;bottom:-8px;cursor:nwse-resize}.calib-h-sw{left:-8px;bottom:-8px;cursor:nesw-resize}" +
    ".calib-h-ne{right:-8px;top:-8px;cursor:nesw-resize}.calib-h-nw{left:-8px;top:-8px;cursor:nwse-resize}" +
    ".calib-region{position:absolute;border:1.5px solid #9a6fd0;background:rgba(0,0,0,.15);cursor:move;touch-action:none}" +
    ".calib-region.calib-snapped{border-color:#57ff9a;box-shadow:0 0 8px rgba(87,255,154,.7)}" +
    ".calib-region-warn{outline:2px solid #ff6b6b}" +
    ".calib-guide{position:absolute;background:#57ff9a;box-shadow:0 0 6px rgba(87,255,154,.8);pointer-events:none;z-index:60}" +
    ".calib-guide-v{top:0;bottom:0;width:1px;margin-left:-0.5px}.calib-guide-h{left:0;right:0;height:1px;margin-top:-0.5px}" +
    ".calib-region-label{position:absolute;top:-13px;left:0;font:9px monospace;white-space:nowrap;text-shadow:0 0 3px #000}" +
    ".calib-toolbar{position:absolute;left:8px;right:8px;top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;" +
    "background:rgba(10,14,12,.94);border:1px solid #1c2a22;padding:8px;border-radius:4px}" +
    ".calib-title{color:#ffb02e;font:700 12px monospace;letter-spacing:.18em}" +
    ".calib-select,.calib-name,.calib-io{background:#05100b;color:#d7e4dc;border:1px solid #1c2a22;font:12px monospace;padding:4px 6px;border-radius:2px}" +
    ".calib-name{width:150px}.calib-io{width:100%;height:64px}" +
    ".calib-btn{background:#0c1712;color:#d7e4dc;border:1px solid #1c2a22;font:11px monospace;letter-spacing:.06em;padding:5px 9px;border-radius:2px;cursor:pointer}" +
    ".calib-btn:hover{border-color:#ffb02e;color:#ffb02e}.calib-save{border-color:#57ff9a;color:#0a0e0c;background:#57ff9a}" +
    ":host(.calib-active) .hud-box,:host(.calib-active) .hud-taskbar{opacity:.35;filter:grayscale(.4);pointer-events:none!important}";

  // ---- receive hotkey from main (desktop) ----------------------------------
  if (api && api.onHotkey) api.onHotkey(function (name) { if (name === "calibration") toggle(); });

  // ---- self-install a CALIB button on the shared HUD taskbar ---------------
  // Works in BOTH the browser extension and the desktop overlay: the HUD's
  // Taskbar is the same in both, so calibration registers its own control
  // rather than each host having to add it.
  function installButton(tries) {
    var r = root();
    var btns = r && r.querySelector(".hud-taskbar-btns");
    if (!btns) { if ((tries || 0) < 60) setTimeout(function () { installButton((tries || 0) + 1); }, 50); return; }
    if (btns.querySelector("[data-calib-btn]")) return;
    var b = document.createElement("button");
    b.className = "hud-btn"; b.type = "button"; b.setAttribute("data-calib-btn", "1");
    b.textContent = "CALIB";
    b.title = "Calibration Mode — move the table anchor + region boxes into place";
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", toggle);
    // Put CALIB just before the desktop EXIT/close button when present.
    var close = btns.querySelector(".hud-btn-close");
    if (close) btns.insertBefore(b, close); else btns.appendChild(b);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { installButton(0); });
  else installButton(0);

  window.PokerCalibration = {
    enter: enter, exit: exit, toggle: toggle,
    isOn: function () { return !!state.on; },
    activePreset: function () { return active; },
  };
})();
