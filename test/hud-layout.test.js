/*
 * hud-layout.test.js - pure-function tests for the HUD Overlay layout maths
 * (extension/hud-layout.js): viewport clamping, border snapping, adaptive
 * breakpoint selection, and layout persistence round-trip. No DOM required.
 */
module.exports = function (t) {
  var HL = global.Poker.HudLayout;
  var VP = { w: 1280, h: 800 };

  t.section("HudLayout.clampRect");
  (function () {
    var inside = HL.clampRect({ x: 100, y: 100, w: 400, h: 300 }, VP);
    t.equal("in-bounds rect is unchanged x", inside.x, 100);
    t.equal("in-bounds rect is unchanged w", inside.w, 400);

    var right = HL.clampRect({ x: 1200, y: 100, w: 400, h: 300 }, VP);
    t.equal("overflow right pulled back so right edge sits on viewport", right.x, VP.w - 400);
    t.ok("clamped rect stays on screen (right)", right.x + right.w <= VP.w);

    var bottom = HL.clampRect({ x: 100, y: 700, w: 400, h: 300 }, VP);
    t.equal("overflow bottom pulled back", bottom.y, VP.h - 300);

    var neg = HL.clampRect({ x: -50, y: -80, w: 400, h: 300 }, VP);
    t.equal("negative x clamped to 0", neg.x, 0);
    t.equal("negative y clamped to 0", neg.y, 0);

    var small = HL.clampRect({ x: 10, y: 10, w: 5, h: 5 }, VP);
    t.equal("width floored to min", small.w, HL.MIN_W);
    t.equal("height floored to min", small.h, HL.MIN_H);

    var huge = HL.clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, VP);
    t.ok("width capped to viewport", huge.w <= VP.w);
    t.ok("height capped to viewport", huge.h <= VP.h);

    var tiny = HL.clampRect({ x: 0, y: 0, w: 400, h: 300 }, { w: 100, h: 90 });
    t.ok("stays on-screen even when min exceeds viewport", tiny.x === 0 && tiny.y === 0);
  })();

  t.section("HudLayout.snapToEdges");
  (function () {
    var toLeft = HL.snapToEdges({ x: 8, y: 300, w: 300, h: 200 }, VP, 16);
    t.equal("near-left edge snaps to 0", toLeft.x, 0);

    var toRight = HL.snapToEdges({ x: VP.w - 300 - 8, y: 300, w: 300, h: 200 }, VP, 16);
    t.equal("near-right edge snaps flush right", toRight.x, VP.w - 300);

    var toTop = HL.snapToEdges({ x: 400, y: 10, w: 300, h: 200 }, VP, 16);
    t.equal("near-top edge snaps to 0", toTop.y, 0);

    var toBottom = HL.snapToEdges({ x: 400, y: VP.h - 200 - 5, w: 300, h: 200 }, VP, 16);
    t.equal("near-bottom edge snaps flush bottom", toBottom.y, VP.h - 200);

    var noSnap = HL.snapToEdges({ x: 400, y: 300, w: 300, h: 200 }, VP, 16);
    t.equal("centre box not snapped x", noSnap.x, 400);
    t.equal("centre box not snapped y", noSnap.y, 300);

    var corner = HL.snapToEdges({ x: 6, y: 7, w: 300, h: 200 }, VP, 16);
    t.ok("both axes snap at a corner", corner.x === 0 && corner.y === 0);
  })();

  t.section("HudLayout.pickBreakpoint");
  (function () {
    t.equal("wide -> full", HL.pickBreakpoint(500), "full");
    t.equal("exact full boundary -> full", HL.pickBreakpoint(460), "full");
    t.equal("just under full -> compact", HL.pickBreakpoint(459), "compact");
    t.equal("exact compact boundary -> compact", HL.pickBreakpoint(300), "compact");
    t.equal("just under compact -> mini", HL.pickBreakpoint(299), "mini");
    t.equal("zero width -> mini", HL.pickBreakpoint(0), "mini");
    t.equal("custom table respected", HL.pickBreakpoint(120, [
      { name: "big", minWidth: 200 }, { name: "small", minWidth: 0 },
    ]), "small");
  })();

  t.section("HudLayout.defaultLayout / clampLayout");
  (function () {
    var d = HL.defaultLayout(VP);
    t.ok("default table on screen", d.table.x + d.table.w <= VP.w && d.table.y + d.table.h <= VP.h);
    t.ok("default info on screen", d.info.x + d.info.w <= VP.w && d.info.y + d.info.h <= VP.h);
    t.equal("default taskbar edge is bottom", d.taskbar.edge, "bottom");
    t.ok("info sits right of table", d.info.x >= d.table.x);

    // A layout valid on a big screen is re-clamped onto a small one.
    var shrunk = HL.clampLayout(d, { w: 360, h: 640 });
    t.ok("table re-clamped into small viewport",
      shrunk.table.x + shrunk.table.w <= 360 && shrunk.table.y + shrunk.table.h <= 640);
    t.ok("info re-clamped into small viewport",
      shrunk.info.x + shrunk.info.w <= 360 && shrunk.info.y + shrunk.info.h <= 640);
    t.equal("clampLayout preserves taskbar edge", HL.clampLayout(
      { table: d.table, info: d.info, taskbar: { edge: "top" } }, VP).taskbar.edge, "top");
    // Garbage boxes fall back to defaults rather than throwing.
    var repaired = HL.clampLayout({ table: null, info: "nope", taskbar: {} }, VP);
    t.ok("clampLayout repairs bad boxes", repaired.table && repaired.info);
  })();

  t.section("HudLayout persistence round-trip");
  (function () {
    var layout = {
      table: { x: 40, y: 24, w: 620, h: 420 },
      info: { x: 700, y: 24, w: 380, h: 560 },
      taskbar: { edge: "top" },
    };
    var s = HL.serialize(layout);
    t.ok("serialize returns a string", typeof s === "string");
    var back = HL.deserialize(s, null);
    t.ok("round-trip preserves table", back.table.x === 40 && back.table.w === 620);
    t.ok("round-trip preserves info", back.info.y === 24 && back.info.h === 560);
    t.equal("round-trip preserves taskbar edge", back.taskbar.edge, "top");

    var fb = { table: {}, info: {}, taskbar: { edge: "bottom" } };
    t.equal("garbage string -> fallback", HL.deserialize("{not json", fb), fb);
    t.equal("missing boxes -> fallback", HL.deserialize('{"taskbar":{"edge":"top"}}', fb), fb);
    t.equal("bad edge normalised to bottom",
      HL.deserialize('{"table":{"x":0,"y":0,"w":300,"h":200},"info":{"x":0,"y":0,"w":300,"h":200},"taskbar":{"edge":"sideways"}}', fb).taskbar.edge,
      "bottom");
  })();
};
