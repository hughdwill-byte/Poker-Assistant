/*
 * calibration-preset.js - PURE, resolution-independent calibration model shared
 * by web Watch mode and the /desktop overlay. No DOM, no storage, no Electron.
 *
 * THE MODEL
 *   A calibration is a set of regions (Seat 1-6 spot/cards/bet, board cards +
 *   suits, hero cards + suits, pot/stack/to-call/my-bet) plus one ANCHOR
 *   rectangle = the poker-table bounding box. Every region is stored as a
 *   NORMALIZED rect { x, y, w, h } in [0,1] RELATIVE TO THE ANCHOR (not the
 *   screen). To draw, you denormalize against wherever the anchor currently is;
 *   move/resize the anchor and the whole set follows. Switching monitors or
 *   resolutions means re-placing the anchor once — nothing else changes.
 *
 *   Aspect: presets carry `tableAspect` (authored table w/h) and `fitMode`:
 *     - "contain" (default) letterboxes a tableAspect rect inside the anchor so
 *       regions never stretch onto the wrong area across differently-shaped
 *       anchors;
 *     - "stretch" fills the anchor exactly (opt-in).
 *
 * Attaches to Poker.CalibrationPreset (namespace/IIFE convention) so it loads in
 * the browser, the desktop renderer, and the Node test harness alike.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  // ---- region catalogue (ids match the Watch-mode region keys) -------------
  var LABELS = {
    hero0: "Your card 1", hero1: "Your card 2",
    b0: "Flop 1", b1: "Flop 2", b2: "Flop 3", b3: "Turn", b4: "River",
    hero0s: "Your card 1 · suit", hero1s: "Your card 2 · suit",
    b0s: "Flop 1 · suit", b1s: "Flop 2 · suit", b2s: "Flop 3 · suit", b3s: "Turn · suit", b4s: "River · suit",
    pot: "Pot (number)", mystack: "My stack (number)", tocall: "To call (button)", mybet: "My bet (number)",
    bet0: "Seat 1 bet", bet1: "Seat 2 bet", bet2: "Seat 3 bet", bet3: "Seat 4 bet", bet4: "Seat 5 bet", bet5: "Seat 6 bet",
    s0c: "Seat 1 cards", s1c: "Seat 2 cards", s2c: "Seat 3 cards", s3c: "Seat 4 cards", s4c: "Seat 5 cards", s5c: "Seat 6 cards",
    s0: "Seat 1 spot", s1: "Seat 2 spot", s2: "Seat 3 spot", s3: "Seat 4 spot", s4: "Seat 5 spot", s5: "Seat 6 spot",
  };
  // Stable draw/serialize order.
  var ALL_KEYS = [
    "hero0", "hero1", "b0", "b1", "b2", "b3", "b4",
    "hero0s", "hero1s", "b0s", "b1s", "b2s", "b3s", "b4s",
    "pot", "mystack", "tocall", "mybet",
    "bet0", "bet1", "bet2", "bet3", "bet4", "bet5",
    "s0c", "s1c", "s2c", "s3c", "s4c", "s5c",
    "s0", "s1", "s2", "s3", "s4", "s5",
  ];
  var CATEGORY_COLOR = {
    card: "#5fd38d", suit: "#4da3e6", money: "#e6a43a",
    bet: "#e86cae", cards: "#9a6fd0", spot: "#9a6fd0",
  };
  function typeOfKey(k) {
    if (/^(hero0|hero1|b0|b1|b2|b3|b4)s$/.test(k)) return "suit";
    if (/^(hero0|hero1|b0|b1|b2|b3|b4)$/.test(k)) return "card";
    if (k === "pot" || k === "mystack" || k === "tocall" || k === "mybet") return "money";
    if (/^bet[0-5]$/.test(k)) return "bet";
    if (/^s[0-5]c$/.test(k)) return "cards";
    if (/^s[0-5]$/.test(k)) return "spot";
    return "card";
  }
  function colorOfKey(k) { return CATEGORY_COLOR[typeOfKey(k)]; }

  // ---- helpers -------------------------------------------------------------
  function isRect(r) {
    return r && isFinite(r.x) && isFinite(r.y) && isFinite(r.w) && isFinite(r.h);
  }
  function clampNum(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /**
   * The content rectangle inside an anchor, honouring fitMode/aspect. Regions
   * are denormalized against THIS, not the raw anchor, so "contain" keeps the
   * table's aspect no matter the anchor's shape.
   */
  function contentRect(anchor, tableAspect, fitMode) {
    if (fitMode !== "contain" || !tableAspect || tableAspect <= 0) {
      return { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h };
    }
    var aspect = anchor.w / anchor.h;
    if (aspect > tableAspect) {                 // anchor too wide -> pillarbox
      var w = anchor.h * tableAspect;
      return { x: anchor.x + (anchor.w - w) / 2, y: anchor.y, w: w, h: anchor.h };
    }
    var h = anchor.w / tableAspect;             // anchor too tall -> letterbox
    return { x: anchor.x, y: anchor.y + (anchor.h - h) / 2, w: anchor.w, h: h };
  }

  /** Region (normalized) -> pixel rect against a placed anchor. */
  function denormalize(region, anchor, opts) {
    opts = opts || {};
    var c = contentRect(anchor, opts.tableAspect, opts.fitMode || "contain");
    return {
      x: c.x + region.x * c.w,
      y: c.y + region.y * c.h,
      w: region.w * c.w,
      h: region.h * c.h,
    };
  }

  /** Pixel rect -> normalized region against a placed anchor. Inverse of above. */
  function normalize(pxRect, anchor, opts) {
    opts = opts || {};
    var c = contentRect(anchor, opts.tableAspect, opts.fitMode || "contain");
    return {
      x: (pxRect.x - c.x) / c.w,
      y: (pxRect.y - c.y) / c.h,
      w: pxRect.w / c.w,
      h: pxRect.h / c.h,
    };
  }

  // ---- group transforms (operate on the ANCHOR; regions follow) ------------
  function moveAnchor(a, dx, dy) { return { x: a.x + dx, y: a.y + dy, w: a.w, h: a.h }; }
  function scaleAnchor(a, factor, origin) {
    var o = origin || { x: a.x, y: a.y };
    return {
      x: o.x + (a.x - o.x) * factor,
      y: o.y + (a.y - o.y) * factor,
      w: a.w * factor,
      h: a.h * factor,
    };
  }
  /** Resize keeping the top-left corner; lockAspect ties height to tableAspect. */
  function resizeAnchor(a, newW, newH, lockAspect, tableAspect) {
    var w = Math.max(1e-6, newW);
    var h = lockAspect && tableAspect ? w / tableAspect : Math.max(1e-6, newH);
    return { x: a.x, y: a.y, w: w, h: h };
  }

  // ---- bounds / warnings ---------------------------------------------------
  function regionOutOfBounds(region, eps) {
    eps = eps == null ? 1e-6 : eps;
    return region.x < -eps || region.y < -eps ||
      region.x + region.w > 1 + eps || region.y + region.h > 1 + eps;
  }
  function clampRegion(region) {
    var x = clampNum(region.x, 0, 1);
    var y = clampNum(region.y, 0, 1);
    var w = clampNum(region.w, 0, 1 - x);
    var h = clampNum(region.h, 0, 1 - y);
    var out = { x: x, y: y, w: w, h: h };
    if (region.poly) out.poly = region.poly;
    return out;
  }
  /** ids of any regions that would remap outside the anchor/screen. */
  function warnings(preset) {
    var out = [];
    (preset.regions || []).forEach(function (r) {
      if (regionOutOfBounds(r)) out.push(r.id);
    });
    return out;
  }

  // ---- migration: legacy calibration -> anchor-relative preset -------------
  // Accepts a Watch-mode `regions` map (key -> { x,y,w,h[,poly] }). Those rects
  // may be frame-normalized (current Watch) or absolute pixels (older builds) —
  // either way we infer the anchor as their tight bounding box, then re-normalize
  // every region against it. Denormalizing at the inferred anchor reproduces the
  // originals exactly (contain over an equal-aspect anchor == the anchor).
  function boundsOf(regionMap) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    Object.keys(regionMap || {}).forEach(function (k) {
      var r = regionMap[k];
      if (!isRect(r)) return;
      any = true;
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    });
    if (!any) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function migrateLegacy(regionMap, opts) {
    opts = opts || {};
    var anchor = boundsOf(regionMap);
    if (!anchor || anchor.w <= 0 || anchor.h <= 0) {
      return { ok: false, error: "No usable regions to migrate.", regions: [], anchor: null };
    }
    var tableAspect = anchor.w / anchor.h;
    var regions = [], dropped = [];
    ALL_KEYS.forEach(function (k) {
      var r = regionMap[k];
      if (!isRect(r)) return;
      var n = normalize(r, anchor, { fitMode: "stretch" });  // tight bbox -> stretch is exact
      var reg = {
        id: k, label: LABELS[k] || k, type: typeOfKey(k), color: colorOfKey(k),
        x: n.x, y: n.y, w: n.w, h: n.h,
      };
      if (r.poly && r.poly.length) {
        reg.poly = r.poly.map(function (p) {
          return { x: (p.x - anchor.x) / anchor.w, y: (p.y - anchor.y) / anchor.h };
        });
      }
      regions.push(reg);
    });
    // Preserve any non-standard keys rather than losing them.
    Object.keys(regionMap).forEach(function (k) {
      if (ALL_KEYS.indexOf(k) >= 0 || !isRect(regionMap[k])) return;
      var n = normalize(regionMap[k], anchor, { fitMode: "stretch" });
      regions.push({ id: k, label: k, type: "card", color: CATEGORY_COLOR.card, x: n.x, y: n.y, w: n.w, h: n.h });
    });
    var preset = createPreset({
      name: opts.name || "Migrated calibration",
      siteHint: opts.siteHint || null,
      authoredRef: opts.authoredRef || { width: anchor.w, height: anchor.h },
      tableAspect: tableAspect,
      fitMode: opts.fitMode || "contain",
      lockAspect: !!opts.lockAspect,
      regions: regions,
    });
    preset.ok = true;
    preset.inferredAnchor = anchor;
    preset.dropped = dropped;
    return preset;
  }

  // ---- preset construction / (de)serialization -----------------------------
  function createPreset(spec) {
    spec = spec || {};
    return {
      schemaVersion: 1,
      name: spec.name || "Untitled preset",
      createdAt: spec.createdAt || new Date().toISOString(),
      siteHint: spec.siteHint || null,
      authoredRef: spec.authoredRef || { width: 1, height: 1 },
      tableAspect: spec.tableAspect || (spec.authoredRef ? spec.authoredRef.width / spec.authoredRef.height : 1),
      fitMode: spec.fitMode === "stretch" ? "stretch" : "contain",
      lockAspect: !!spec.lockAspect,
      regions: (spec.regions || []).map(function (r) {
        var reg = {
          id: r.id, label: r.label || LABELS[r.id] || r.id,
          type: r.type || typeOfKey(r.id), color: r.color || colorOfKey(r.id),
          x: +r.x, y: +r.y, w: +r.w, h: +r.h,
        };
        if (r.poly) reg.poly = r.poly;
        return reg;
      }),
    };
  }

  function serialize(preset) {
    return JSON.stringify({
      schemaVersion: 1,
      name: preset.name,
      createdAt: preset.createdAt,
      siteHint: preset.siteHint || null,
      authoredRef: preset.authoredRef,
      tableAspect: preset.tableAspect,
      fitMode: preset.fitMode,
      lockAspect: !!preset.lockAspect,
      regions: preset.regions.map(function (r) {
        var reg = { id: r.id, label: r.label, type: r.type, color: r.color, x: r.x, y: r.y, w: r.w, h: r.h };
        if (r.poly) reg.poly = r.poly;
        return reg;
      }),
    });
  }

  function deserialize(str) {
    var o;
    try { o = typeof str === "string" ? JSON.parse(str) : str; }
    catch (e) { return { ok: false, error: "Invalid JSON." }; }
    if (!o || typeof o !== "object") return { ok: false, error: "Empty preset." };
    if (o.schemaVersion !== 1) return { ok: false, error: "Unsupported schemaVersion: " + o.schemaVersion };
    var regions = (o.regions || []).filter(function (r) { return r && r.id && isRect(r); })
      .map(function (r) {
        var reg = {
          id: r.id, label: r.label || LABELS[r.id] || r.id,
          type: r.type || typeOfKey(r.id), color: r.color || colorOfKey(r.id),
          x: +r.x, y: +r.y, w: +r.w, h: +r.h,
        };
        if (r.poly) reg.poly = r.poly;
        return reg;
      });
    var preset = createPreset({
      name: o.name, createdAt: o.createdAt, siteHint: o.siteHint,
      authoredRef: o.authoredRef, tableAspect: o.tableAspect,
      fitMode: o.fitMode, lockAspect: o.lockAspect, regions: regions,
    });
    preset.ok = true;
    return preset;
  }

  // ---- bridge: preset -> Watch-mode frame-normalized regions ---------------
  // Web Watch mode consumes a `key -> {x,y,w,h}` map normalized to the CAPTURE
  // FRAME. Given the anchor placed as a frame-normalized rect, this produces
  // exactly that map, so a shared preset drives the existing Watch reader
  // unchanged.
  function presetToFrameRegions(preset, anchorFrameRect) {
    var out = {};
    var opts = { tableAspect: preset.tableAspect, fitMode: preset.fitMode };
    preset.regions.forEach(function (r) {
      var px = denormalize(r, anchorFrameRect, opts);
      var rect = { x: px.x, y: px.y, w: px.w, h: px.h };
      if (r.poly) {
        var c = contentRect(anchorFrameRect, preset.tableAspect, preset.fitMode);
        rect.poly = r.poly.map(function (p) { return { x: c.x + p.x * c.w, y: c.y + p.y * c.h }; });
      }
      out[r.id] = rect;
    });
    return out;
  }

  // ---- default region layout (so users MOVE boxes, never redraw) -----------
  // Starting positions for all 36 regions, normalized to the anchor. Sourced
  // from docs/calibration-box-map.* so a fresh preset already has every box on
  // screen to drag into place. These are approximate seeds, not final geometry.
  var DEFAULT_LAYOUT = {
    hero0: [0.590, 0.694, 0.028, 0.055], hero1: [0.622, 0.694, 0.028, 0.055],
    b0: [0.455, 0.455, 0.028, 0.052], b1: [0.497, 0.455, 0.028, 0.052], b2: [0.538, 0.455, 0.028, 0.052],
    b3: [0.578, 0.455, 0.028, 0.052], b4: [0.618, 0.451, 0.028, 0.052],
    hero0s: [0.590, 0.752, 0.024, 0.040], hero1s: [0.622, 0.752, 0.024, 0.040],
    b0s: [0.455, 0.508, 0.024, 0.040], b1s: [0.497, 0.508, 0.024, 0.040], b2s: [0.538, 0.508, 0.024, 0.040],
    b3s: [0.578, 0.508, 0.024, 0.040], b4s: [0.618, 0.508, 0.024, 0.040],
    pot: [0.549, 0.571, 0.056, 0.038], mybet: [0.549, 0.613, 0.056, 0.034],
    mystack: [0.460, 0.801, 0.059, 0.041], tocall: [0.716, 0.867, 0.077, 0.070],
    bet0: [0.382, 0.553, 0.042, 0.042], bet1: [0.374, 0.466, 0.042, 0.042], bet2: [0.470, 0.344, 0.042, 0.042],
    bet3: [0.647, 0.350, 0.042, 0.042], bet4: [0.757, 0.462, 0.044, 0.045], bet5: [0.721, 0.553, 0.044, 0.045],
    s0c: [0.372, 0.654, 0.026, 0.045], s1c: [0.410, 0.372, 0.026, 0.045], s2c: [0.540, 0.342, 0.026, 0.045],
    s3c: [0.658, 0.359, 0.026, 0.045], s4c: [0.735, 0.395, 0.028, 0.045], s5c: [0.740, 0.650, 0.026, 0.045],
    s0: [0.319, 0.637, 0.022, 0.041], s1: [0.320, 0.318, 0.022, 0.041], s2: [0.453, 0.222, 0.022, 0.040],
    s3: [0.633, 0.218, 0.022, 0.040], s4: [0.769, 0.327, 0.024, 0.041], s5: [0.793, 0.635, 0.022, 0.041],
  };
  /** All 36 regions with their default normalized positions, ready to drag. */
  function defaultRegions() {
    return ALL_KEYS.map(function (k) {
      var r = DEFAULT_LAYOUT[k] || [0.48, 0.48, 0.03, 0.04];
      return { id: k, label: LABELS[k] || k, type: typeOfKey(k), color: colorOfKey(k),
        x: r[0], y: r[1], w: r[2], h: r[3] };
    });
  }

  // ---- alignment snapping (green guides for flat/vertical/right-angle) ------
  // Given a moving rect in PIXELS, the other region rects, and the anchor (px),
  // snap the moving rect so an edge/centre lines up with the anchor's edges or
  // another box's edges when within `threshold` px. Returns the snapped rect
  // plus the guide lines to draw green. Boxes are axis-aligned, so a matched
  // guide is always perfectly horizontal ("flat") or vertical, i.e. at 90°.
  function snapMove(rect, others, anchor, threshold) {
    threshold = threshold == null ? 5 : threshold;
    var candV = [], candH = [];
    function push3(arr, a, b, c) { arr.push(a, b, c); }
    if (anchor) { push3(candV, anchor.x, anchor.x + anchor.w / 2, anchor.x + anchor.w);
                  push3(candH, anchor.y, anchor.y + anchor.h / 2, anchor.y + anchor.h); }
    (others || []).forEach(function (o) {
      push3(candV, o.x, o.x + o.w / 2, o.x + o.w);
      push3(candH, o.y, o.y + o.h / 2, o.y + o.h);
    });
    var mineX = [rect.x, rect.x + rect.w / 2, rect.x + rect.w];
    var mineY = [rect.y, rect.y + rect.h / 2, rect.y + rect.h];
    var bestV = null, bestH = null;
    mineX.forEach(function (mx) {
      candV.forEach(function (cv) { var d = cv - mx; if (Math.abs(d) <= threshold && (!bestV || Math.abs(d) < Math.abs(bestV.d))) bestV = { d: d, pos: cv }; });
    });
    mineY.forEach(function (my) {
      candH.forEach(function (ch) { var d = ch - my; if (Math.abs(d) <= threshold && (!bestH || Math.abs(d) < Math.abs(bestH.d))) bestH = { d: d, pos: ch }; });
    });
    var guides = [];
    if (bestV) guides.push({ orient: "v", pos: bestV.pos });
    if (bestH) guides.push({ orient: "h", pos: bestH.pos });
    return {
      rect: { x: rect.x + (bestV ? bestV.d : 0), y: rect.y + (bestH ? bestH.d : 0), w: rect.w, h: rect.h },
      guides: guides,
      snappedV: !!bestV,
      snappedH: !!bestH,
    };
  }

  Poker.CalibrationPreset = {
    LABELS: LABELS,
    ALL_KEYS: ALL_KEYS,
    DEFAULT_LAYOUT: DEFAULT_LAYOUT,
    defaultRegions: defaultRegions,
    snapMove: snapMove,
    CATEGORY_COLOR: CATEGORY_COLOR,
    CATEGORY_COLOR: CATEGORY_COLOR,
    typeOfKey: typeOfKey,
    colorOfKey: colorOfKey,
    contentRect: contentRect,
    normalize: normalize,
    denormalize: denormalize,
    moveAnchor: moveAnchor,
    scaleAnchor: scaleAnchor,
    resizeAnchor: resizeAnchor,
    regionOutOfBounds: regionOutOfBounds,
    clampRegion: clampRegion,
    warnings: warnings,
    boundsOf: boundsOf,
    migrateLegacy: migrateLegacy,
    createPreset: createPreset,
    serialize: serialize,
    deserialize: deserialize,
    presetToFrameRegions: presetToFrameRegions,
  };
})(typeof self !== "undefined" ? self : this);
