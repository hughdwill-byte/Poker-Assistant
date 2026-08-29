/*
 * hud-layout.js - PURE layout maths for the HUD Overlay. No DOM, no chrome
 * APIs, no side effects. The content script (hud.js) uses these to place,
 * clamp, snap and reflow the movable boxes; the Node test harness loads the
 * exact same functions to verify them. Attaches to `Poker.HudLayout` so it
 * rides the same IIFE/namespace convention as the engine modules and can be
 * required under test/load.js.
 *
 * A "rect" is { x, y, w, h } in CSS pixels, origin at the viewport top-left.
 * A "viewport" is { w, h }. Nothing here reads or mutates its inputs; every
 * function returns a fresh object.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  // Minimum usable box footprint. Below this the internal UI switches to its
  // most compact form (see pickBreakpoint) rather than being clipped.
  var MIN_W = 220;
  var MIN_H = 140;

  // Snap distance (px) from a viewport edge at which a box docks to it.
  var SNAP = 16;

  // Adaptive breakpoints for a box's *content* keyed off its current width.
  // Ordered widest-first; pickBreakpoint returns the first whose minWidth the
  // box meets, falling back to the narrowest. Kept as data so the same table
  // drives the CSS class names the content script toggles.
  var BREAKPOINTS = [
    { name: "full", minWidth: 460 },
    { name: "compact", minWidth: 300 },
    { name: "mini", minWidth: 0 },
  ];

  function clampNum(v, lo, hi) {
    if (hi < lo) hi = lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  /**
   * Keep a rect fully inside the viewport and no smaller than the minimums.
   * Width/height are capped to the viewport first (so a box can never be wider
   * than the screen), then the position is pulled back so no edge spills out.
   */
  function clampRect(rect, viewport, minW, minH) {
    minW = typeof minW === "number" ? minW : MIN_W;
    minH = typeof minH === "number" ? minH : MIN_H;
    var w = clampNum(rect.w, minW, Math.max(minW, viewport.w));
    var h = clampNum(rect.h, minH, Math.max(minH, viewport.h));
    var x = clampNum(rect.x, 0, Math.max(0, viewport.w - w));
    var y = clampNum(rect.y, 0, Math.max(0, viewport.h - h));
    return { x: x, y: y, w: w, h: h };
  }

  /**
   * Snap a rect's edges to the viewport border when within `threshold` px.
   * Snapping only moves the box (never resizes it) and is applied after
   * clamping, so the result is always on-screen. Left/right are considered
   * independently from top/bottom; if a box is near both left and right
   * (narrower gap wins) left takes precedence deterministically.
   */
  function snapToEdges(rect, viewport, threshold) {
    threshold = typeof threshold === "number" ? threshold : SNAP;
    var r = clampRect(rect, viewport);
    var x = r.x, y = r.y;
    var rightGap = viewport.w - (r.x + r.w);
    var bottomGap = viewport.h - (r.y + r.h);
    if (r.x <= threshold) x = 0;
    else if (rightGap <= threshold) x = Math.max(0, viewport.w - r.w);
    if (r.y <= threshold) y = 0;
    else if (bottomGap <= threshold) y = Math.max(0, viewport.h - r.h);
    return { x: x, y: y, w: r.w, h: r.h };
  }

  /**
   * Choose the content breakpoint name for a given box width.
   * @param {number} width   current box content width in px
   * @param {Array}  [table] optional override [{name, minWidth}], widest-first
   */
  function pickBreakpoint(width, table) {
    var bps = table || BREAKPOINTS;
    for (var i = 0; i < bps.length; i++) {
      if (width >= bps[i].minWidth) return bps[i].name;
    }
    return bps[bps.length - 1].name;
  }

  var VALID_EDGES = { top: 1, bottom: 1 };

  /**
   * A sensible starting layout derived from the viewport: the Table box on the
   * left, the Info panel on the right, the Taskbar docked to the bottom.
   */
  function defaultLayout(viewport) {
    var vw = viewport.w, vh = viewport.h;
    var bar = 48; // reserved taskbar height
    var gap = 16;
    var usableH = Math.max(MIN_H, vh - bar - gap * 2);
    var tableW = clampNum(Math.round(vw * 0.52), MIN_W, Math.max(MIN_W, vw - gap * 2));
    var infoW = clampNum(Math.round(vw * 0.34), MIN_W, Math.max(MIN_W, vw - gap * 2));
    var table = clampRect(
      { x: gap, y: gap, w: tableW, h: Math.min(usableH, Math.round(vh * 0.6)) },
      viewport
    );
    var info = clampRect(
      { x: Math.max(gap, vw - infoW - gap), y: gap, w: infoW, h: Math.min(usableH, Math.round(vh * 0.7)) },
      viewport
    );
    return { table: table, info: info, taskbar: { edge: "bottom" }, version: 1 };
  }

  function validRect(r) {
    return r && typeof r.x === "number" && typeof r.y === "number" &&
      typeof r.w === "number" && typeof r.h === "number" &&
      isFinite(r.x) && isFinite(r.y) && isFinite(r.w) && isFinite(r.h);
  }

  /** Re-clamp every box after a viewport change; taskbar edge is preserved. */
  function clampLayout(layout, viewport) {
    var edge = layout && layout.taskbar && VALID_EDGES[layout.taskbar.edge]
      ? layout.taskbar.edge : "bottom";
    var base = defaultLayout(viewport);
    return {
      table: validRect(layout && layout.table) ? clampRect(layout.table, viewport) : base.table,
      info: validRect(layout && layout.info) ? clampRect(layout.info, viewport) : base.info,
      taskbar: { edge: edge },
      version: 1,
    };
  }

  /** Serialize a layout to a compact JSON string for storage. */
  function serialize(layout) {
    return JSON.stringify({
      table: layout.table,
      info: layout.info,
      taskbar: layout.taskbar,
      version: 1,
    });
  }

  /**
   * Parse a stored layout string back into a layout, returning `fallback` on
   * any malformed/partial input so a corrupted store can never crash the HUD.
   */
  function deserialize(str, fallback) {
    try {
      var o = typeof str === "string" ? JSON.parse(str) : str;
      if (!o || typeof o !== "object") return fallback || null;
      if (!validRect(o.table) || !validRect(o.info)) return fallback || null;
      var edge = o.taskbar && VALID_EDGES[o.taskbar.edge] ? o.taskbar.edge : "bottom";
      return {
        table: { x: o.table.x, y: o.table.y, w: o.table.w, h: o.table.h },
        info: { x: o.info.x, y: o.info.y, w: o.info.w, h: o.info.h },
        taskbar: { edge: edge },
        version: 1,
      };
    } catch (e) {
      return fallback || null;
    }
  }

  Poker.HudLayout = {
    MIN_W: MIN_W,
    MIN_H: MIN_H,
    SNAP: SNAP,
    BREAKPOINTS: BREAKPOINTS,
    clampRect: clampRect,
    snapToEdges: snapToEdges,
    pickBreakpoint: pickBreakpoint,
    defaultLayout: defaultLayout,
    clampLayout: clampLayout,
    serialize: serialize,
    deserialize: deserialize,
  };
})(typeof self !== "undefined" ? self : this);
