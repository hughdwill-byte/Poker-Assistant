/*
 * watch-calibrator.test.js - pure coordinate conversion for the Watch visual
 * calibrator (js/watch-calibrator.js): editor-pixel anchor -> frame-normalized
 * regions Watch reads. The DOM editor needs a browser and is covered by the
 * headless smoke test.
 */
module.exports = function (t) {
  var WC = global.Poker.WatchCalibrator;
  var CP = global.Poker.CalibrationPreset;

  t.section("WatchCalibrator.anchorToFrame");
  (function () {
    // Editor is 800x600 (== the video's displayed box). Anchor covering the
    // middle half becomes the same fraction of the frame.
    var fr = WC.anchorToFrame({ x: 200, y: 150, w: 400, h: 300 }, { w: 800, h: 600 });
    t.approx("x fraction", fr.x, 0.25, 1e-9);
    t.approx("y fraction", fr.y, 0.25, 1e-9);
    t.approx("w fraction", fr.w, 0.5, 1e-9);
    t.approx("h fraction", fr.h, 0.5, 1e-9);
  })();

  t.section("WatchCalibrator.presetToFrameRegions");
  (function () {
    // A preset with one region at the anchor's centre, stretch fit. With the
    // anchor placed over the middle half of an 800x600 frame, the region's
    // frame coords should be the anchor-centre mapped into [0,1].
    var preset = CP.createPreset({
      tableAspect: 4 / 3, fitMode: "stretch",
      regions: [{ id: "pot", x: 0.5, y: 0.5, w: 0.1, h: 0.1 }],
    });
    var frame = WC.presetToFrameRegions(preset, { x: 200, y: 150, w: 400, h: 300 }, { w: 800, h: 600 });
    t.ok("returns the pot region keyed by id", !!frame.pot);
    // anchor frame rect = {0.25,0.25,0.5,0.5}; region at 0.5,0.5 size 0.1
    // -> x = 0.25 + 0.5*0.5 = 0.5 ; w = 0.1*0.5 = 0.05
    t.approx("pot x in frame", frame.pot.x, 0.5, 1e-9);
    t.approx("pot y in frame", frame.pot.y, 0.5, 1e-9);
    t.approx("pot w in frame", frame.pot.w, 0.05, 1e-9);
    t.approx("pot h in frame", frame.pot.h, 0.05, 1e-9);
    // Everything stays within the frame [0,1].
    Object.keys(frame).forEach(function (k) {
      var r = frame[k];
      t.ok("region " + k + " within frame", r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9);
    });
  })();

  t.section("WatchCalibrator: default preset covers all 36 Watch keys");
  (function () {
    var preset = CP.createPreset({ tableAspect: 16 / 9, fitMode: "contain", regions: CP.defaultRegions() });
    var frame = WC.presetToFrameRegions(preset, { x: 0, y: 0, w: 1000, h: 600 }, { w: 1000, h: 600 });
    t.equal("36 regions produced", Object.keys(frame).length, 36);
    t.ok("hero0 present (Watch key)", !!frame.hero0);
    t.ok("s2c present (seat 3 cards key)", !!frame.s2c);
  })();
};
