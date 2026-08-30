/*
 * calibration-preset.test.js - pure tests for the resolution-independent
 * calibration model (js/calibration-preset.js): normalize/denormalize
 * round-trips, cross-resolution/cross-aspect remap under "contain" vs "stretch",
 * group move/scale applied uniformly, export/import round-trip, legacy migration
 * fidelity, and out-of-bounds warnings.
 */
module.exports = function (t) {
  var CP = global.Poker.CalibrationPreset;
  var TOL = 1e-9;

  function approxRect(name, a, b, tol) {
    tol = tol || 1e-6;
    var ok = Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
      Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
    t.ok(name, ok);
  }

  t.section("normalize / denormalize round-trip");
  (function () {
    var anchor = { x: 200, y: 120, w: 800, h: 500 };
    var region = { x: 0.25, y: 0.4, w: 0.1, h: 0.08 };
    // stretch: content == anchor
    var pxS = CP.denormalize(region, anchor, { fitMode: "stretch" });
    var backS = CP.normalize(pxS, anchor, { fitMode: "stretch" });
    approxRect("stretch normalize∘denormalize is identity", backS, region);
    t.ok("stretch px inside anchor", pxS.x >= anchor.x && pxS.x + pxS.w <= anchor.x + anchor.w);

    // contain with matching aspect == stretch
    var aspect = anchor.w / anchor.h;
    var pxC = CP.denormalize(region, anchor, { fitMode: "contain", tableAspect: aspect });
    approxRect("contain over equal-aspect anchor == stretch", pxC, pxS);
    var backC = CP.normalize(pxC, anchor, { fitMode: "contain", tableAspect: aspect });
    approxRect("contain round-trip identity", backC, region);
  })();

  t.section("cross-resolution / cross-aspect remap");
  (function () {
    var tableAspect = 16 / 9;
    var region = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };

    // Author on a 1600x900 anchor (aspect 16:9 exactly).
    var a1 = { x: 0, y: 0, w: 1600, h: 900 };
    var px1 = CP.denormalize(region, a1, { fitMode: "contain", tableAspect: tableAspect });

    // Remap to a DIFFERENT-aspect anchor (a tall 21:9-ish window). Contain must
    // keep the region's on-screen ASPECT identical (no stretch/drift).
    var a2 = { x: 300, y: 100, w: 1000, h: 1000 };
    var px2 = CP.denormalize(region, a2, { fitMode: "contain", tableAspect: tableAspect });
    var aspect1 = px1.w / px1.h, aspect2 = px2.w / px2.h;
    t.approx("contain preserves region aspect across anchors", aspect2, aspect1, 1e-6);
    // The content box stays within the anchor (no mismap outside).
    var c2 = CP.contentRect(a2, tableAspect, "contain");
    t.ok("contain content box within anchor",
      c2.x >= a2.x - 1e-6 && c2.y >= a2.y - 1e-6 &&
      c2.x + c2.w <= a2.x + a2.w + 1e-6 && c2.y + c2.h <= a2.y + a2.h + 1e-6);

    // Stretch fills the anchor exactly: a full [0..1] region covers the anchor.
    var full = { x: 0, y: 0, w: 1, h: 1 };
    var pxFull = CP.denormalize(full, a2, { fitMode: "stretch" });
    approxRect("stretch fills the anchor exactly", pxFull, a2);
  })();

  t.section("group transforms apply uniformly to all regions");
  (function () {
    var anchor = { x: 100, y: 100, w: 600, h: 400 };
    var opts = { fitMode: "stretch" };
    var regions = [
      { x: 0.1, y: 0.1, w: 0.05, h: 0.05 },
      { x: 0.8, y: 0.2, w: 0.1, h: 0.1 },
      { x: 0.4, y: 0.7, w: 0.2, h: 0.05 },
    ];
    var before = regions.map(function (r) { return CP.denormalize(r, anchor, opts); });

    // Move: every region shifts by exactly (dx,dy).
    var moved = CP.moveAnchor(anchor, 37, -22);
    regions.forEach(function (r, i) {
      var after = CP.denormalize(r, moved, opts);
      t.ok("region " + i + " moved by dx", Math.abs((after.x - before[i].x) - 37) < 1e-9);
      t.ok("region " + i + " moved by dy", Math.abs((after.y - before[i].y) - (-22)) < 1e-9);
      t.ok("region " + i + " size unchanged on move", Math.abs(after.w - before[i].w) < 1e-9);
    });

    // Uniform scale about the anchor's top-left: sizes ×f, offsets ×f.
    var f = 1.5, origin = { x: anchor.x, y: anchor.y };
    var scaled = CP.scaleAnchor(anchor, f, origin);
    regions.forEach(function (r, i) {
      var after = CP.denormalize(r, scaled, opts);
      t.approx("region " + i + " width scaled ×f", after.w, before[i].w * f, 1e-6);
      t.approx("region " + i + " offset from origin scaled ×f",
        after.x - origin.x, (before[i].x - origin.x) * f, 1e-6);
    });
  })();

  t.section("export / import round-trip");
  (function () {
    var preset = CP.createPreset({
      name: "My table", siteHint: "example", authoredRef: { width: 1920, height: 1080 },
      tableAspect: 1920 / 1080, fitMode: "contain", lockAspect: true,
      regions: [
        { id: "pot", x: 0.45, y: 0.55, w: 0.08, h: 0.05 },
        { id: "hero0", x: 0.46, y: 0.8, w: 0.03, h: 0.06 },
        { id: "s2", x: 0.5, y: 0.1, w: 0.02, h: 0.03, poly: [{ x: 0.5, y: 0.1 }, { x: 0.52, y: 0.1 }, { x: 0.51, y: 0.14 }] },
      ],
    });
    var back = CP.deserialize(CP.serialize(preset));
    t.ok("import ok", back.ok === true);
    t.equal("name preserved", back.name, "My table");
    t.equal("fitMode preserved", back.fitMode, "contain");
    t.equal("lockAspect preserved", back.lockAspect, true);
    t.equal("region count preserved", back.regions.length, 3);
    var pot = back.regions.find(function (r) { return r.id === "pot"; });
    t.ok("region coords preserved", Math.abs(pot.x - 0.45) < 1e-9 && Math.abs(pot.h - 0.05) < 1e-9);
    t.equal("derived label filled", pot.label, "Pot (number)");
    t.equal("derived color filled", pot.color, "#e6a43a");
    var seat = back.regions.find(function (r) { return r.id === "s2"; });
    t.ok("poly preserved", seat.poly && seat.poly.length === 3);
    t.ok("bad schema rejected", CP.deserialize('{"schemaVersion":99}').ok === false);
    t.ok("garbage rejected", CP.deserialize("{not json").ok === false);
  })();

  t.section("legacy migration reproduces originals at authoring anchor");
  (function () {
    // Legacy Watch regions, frame-normalized (0..1 over the capture frame).
    var legacy = {
      hero0: { x: 0.46, y: 0.80, w: 0.03, h: 0.06 },
      hero1: { x: 0.50, y: 0.80, w: 0.03, h: 0.06 },
      b0: { x: 0.42, y: 0.45, w: 0.03, h: 0.05 },
      b4: { x: 0.58, y: 0.45, w: 0.03, h: 0.05 },
      pot: { x: 0.47, y: 0.55, w: 0.06, h: 0.04 },
      s2: { x: 0.50, y: 0.12, w: 0.02, h: 0.03 },
    };
    var preset = CP.migrateLegacy(legacy, { name: "Legacy" });
    t.ok("migration ok", preset.ok === true);
    t.ok("no absolute pixels leaked (all regions within [0,1])",
      preset.regions.every(function (r) {
        return r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9;
      }));
    // Denormalizing at the inferred anchor must reproduce every original rect.
    var A = preset.inferredAnchor;
    var opts = { tableAspect: preset.tableAspect, fitMode: preset.fitMode };
    var ok = true;
    preset.regions.forEach(function (r) {
      var px = CP.denormalize(r, A, opts);
      var orig = legacy[r.id];
      if (!orig) return;
      if (Math.abs(px.x - orig.x) > 1e-9 || Math.abs(px.y - orig.y) > 1e-9 ||
          Math.abs(px.w - orig.w) > 1e-9 || Math.abs(px.h - orig.h) > 1e-9) ok = false;
    });
    t.ok("regions reproduce originals at inferred anchor", ok);
    t.ok("no region silently dropped", preset.regions.length === 6);
  })();

  t.section("out-of-bounds warnings");
  (function () {
    var preset = CP.createPreset({
      tableAspect: 1, fitMode: "contain",
      regions: [
        { id: "pot", x: 0.4, y: 0.4, w: 0.1, h: 0.1 },   // fine
        { id: "s0", x: 0.95, y: 0.5, w: 0.1, h: 0.1 },   // spills right
        { id: "s1", x: 0.5, y: -0.05, w: 0.1, h: 0.1 },  // spills top
      ],
    });
    var w = CP.warnings(preset);
    t.ok("warns for the two out-of-bounds regions", w.indexOf("s0") >= 0 && w.indexOf("s1") >= 0);
    t.ok("does not warn for the in-bounds region", w.indexOf("pot") < 0);
    var clamped = CP.clampRegion({ x: 0.95, y: 0.5, w: 0.2, h: 0.1 });
    t.ok("clampRegion keeps it inside", clamped.x + clamped.w <= 1 + 1e-9);
  })();

  t.section("preset -> Watch frame regions bridge");
  (function () {
    var preset = CP.createPreset({
      tableAspect: 2, fitMode: "stretch",
      regions: [{ id: "pot", x: 0.5, y: 0.5, w: 0.1, h: 0.1 }],
    });
    // Anchor placed as a frame-normalized rect (0..1 over the capture frame).
    var anchorFrame = { x: 0.2, y: 0.1, w: 0.6, h: 0.4 };
    var frameRegions = CP.presetToFrameRegions(preset, anchorFrame);
    var expect = CP.denormalize(preset.regions[0], anchorFrame, { fitMode: "stretch", tableAspect: 2 });
    approxRect("bridge produces frame-normalized rect Watch can consume", frameRegions.pot, expect);
  })();
};
