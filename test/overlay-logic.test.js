/*
 * overlay-logic.test.js - pure-function tests for the desktop overlay logic
 * (desktop/overlay-logic.js): pointer-over-panel hit-testing (click-through),
 * multi-monitor bounds math, and desktop config persistence round-trip.
 *
 * The shared geometry (viewport/overlay clamping, border snapping, adaptive
 * breakpoints, per-box persistence) is covered by hud-layout.test.js; this
 * suite also re-checks that HudLayout is reused (not re-implemented) here.
 */
module.exports = function (t) {
  var OL = global.Poker.OverlayLogic;
  var HL = global.Poker.HudLayout;

  t.section("OverlayLogic: pointer-over-panel hit-testing (click-through)");
  (function () {
    var table = { x: 20, y: 20, w: 300, h: 200 };   // z 0
    var info = { x: 360, y: 40, w: 260, h: 400 };    // z 1
    var rects = [table, info];

    t.ok("point inside a panel captures", OL.pointerOverPanels(40, 40, rects) === true);
    t.ok("point in empty area passes through", OL.pointerOverPanels(340, 10, rects) === false);
    t.ok("point in second panel captures", OL.pointerOverPanels(400, 100, rects) === true);
    t.ok("edge (top-left corner) counts as over", OL.pointerOverPanels(20, 20, rects) === true);
    t.ok("just outside right edge passes through", OL.pointerOverPanels(321, 100, rects) === false);
    t.equal("empty rect list -> passthrough", OL.pointerOverPanels(40, 40, []), false);

    // topmost respects z-order (later = higher). Overlap region:
    var a = { x: 0, y: 0, w: 100, h: 100 };
    var b = { x: 50, y: 50, w: 100, h: 100 };
    t.equal("overlap resolves to higher-z panel", OL.topmostPanelAt(60, 60, [a, b]), 1);
    t.equal("only-in-lower panel resolves to it", OL.topmostPanelAt(10, 10, [a, b]), 0);
    t.equal("miss -> -1", OL.topmostPanelAt(500, 500, [a, b]), -1);
  })();

  t.section("OverlayLogic: multi-monitor bounds math");
  (function () {
    var primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    var left = { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 1024 } };
    var right = { id: 3, bounds: { x: 1920, y: 0, width: 1280, height: 1024 } };
    var displays = [primary, left, right];

    t.equal("point on primary", OL.displayForPoint({ x: 100, y: 100 }, displays).id, 1);
    t.equal("point on the left (negative x) monitor", OL.displayForPoint({ x: -200, y: 200 }, displays).id, 2);
    t.equal("point on the right monitor", OL.displayForPoint({ x: 2500, y: 200 }, displays).id, 3);
    // A point in a vertical gap below all displays resolves to nearest centre.
    t.ok("point in a gap resolves to nearest display",
      [1, 2, 3].indexOf(OL.displayForPoint({ x: 100, y: 5000 }, displays).id) >= 0);
    t.equal("empty displays -> null", OL.displayForPoint({ x: 0, y: 0 }, []), null);

    t.equal("displayById finds by id", OL.displayById(3, displays).id, 3);
    t.equal("displayById falls back to primary id", OL.displayById(99, displays, 1).id, 1);
    t.equal("displayById falls back to first when no primary", OL.displayById(99, displays).id, 1);

    var ob = OL.overlayBoundsForDisplay(left);
    t.ok("overlay bounds cover the whole display",
      ob.x === -1280 && ob.y === 0 && ob.width === 1280 && ob.height === 1024);
    var obDefault = OL.overlayBoundsForDisplay(null);
    t.ok("overlay bounds have sane defaults when no display", obDefault.width > 0 && obDefault.height > 0);
  })();

  t.section("OverlayLogic: desktop config persistence round-trip");
  (function () {
    var d = OL.defaultConfig();
    t.equal("default starts click-through (locked)", d.interactive, false);
    t.equal("default taskbar edge bottom", d.taskbarEdge, "bottom");
    t.ok("default hotkeys present", !!(d.hotkeys.toggleShow && d.hotkeys.toggleInteractive && d.hotkeys.cycleDisplay));

    var cfg = {
      displayId: 3, taskbarEdge: "top", interactive: true,
      hotkeys: { toggleShow: "Alt+H", toggleInteractive: "Alt+L", cycleDisplay: "Alt+D" },
    };
    var back = OL.deserializeConfig(OL.serializeConfig(cfg));
    t.equal("round-trip displayId", back.displayId, 3);
    t.equal("round-trip taskbar edge", back.taskbarEdge, "top");
    t.equal("round-trip interactive", back.interactive, true);
    t.equal("round-trip hotkey", back.hotkeys.toggleShow, "Alt+H");

    var repaired = OL.deserializeConfig("{ not valid json");
    t.equal("garbage -> default edge", repaired.taskbarEdge, "bottom");
    t.equal("garbage -> default hotkey", repaired.hotkeys.cycleDisplay, d.hotkeys.cycleDisplay);
    var partial = OL.deserializeConfig('{"taskbarEdge":"sideways","hotkeys":{"toggleShow":"F8"}}');
    t.equal("bad edge normalised", partial.taskbarEdge, "bottom");
    t.equal("partial hotkeys kept", partial.hotkeys.toggleShow, "F8");
    t.equal("missing hotkeys filled from default", partial.hotkeys.cycleDisplay, d.hotkeys.cycleDisplay);
  })();

  t.section("OverlayLogic: reuses HudLayout geometry (not re-implemented)");
  (function () {
    t.ok("HudLayout is available to the overlay", !!HL && typeof HL.clampRect === "function");
    t.ok("OverlayLogic exposes the same HudLayout", OL.HudLayout === HL);
    // Clamp/snap/breakpoint behaviour is asserted in hud-layout.test.js.
    var clamped = HL.clampRect({ x: 99999, y: 0, w: 300, h: 200 }, { w: 1280, h: 800 });
    t.ok("overlay clamps a box into the window via HudLayout", clamped.x + clamped.w <= 1280);
  })();
};
