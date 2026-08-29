/*
 * hand-features.test.js - combinatorial checks for made hands, draws and board
 * texture. Every feature is asserted against real card ids.
 */
module.exports = function (t) {
  var P = global.Poker;
  var HF = P.HandFeatures;
  var id = P.makeId;
  var C = 0, D = 1, H = 2, S = 3;

  t.section("Features: made hand + pair position");
  (function () {
    // AK on A-7-2 rainbow: top pair, two overcards? K is overcard.
    var f = HF.extract([id(14, S), id(13, H)], [id(14, C), id(7, D), id(2, H)]);
    t.eq("top pair aces", f.pair === "top-pair");
    t.eq("made hand is a pair", f.made.category === P.CATEGORY.PAIR);
  })();
  (function () {
    var f = HF.extract([id(12, S), id(12, H)], [id(7, C), id(5, D), id(2, H)]);
    t.eq("QQ on 752 is an overpair", f.pair === "overpair");
  })();
  (function () {
    var f = HF.extract([id(9, S), id(9, H)], [id(9, C), id(5, D), id(2, H)]);
    t.eq("99 on 952 is a set", f.pair === "set");
    t.eq("set made hand is trips category", f.made.category === P.CATEGORY.TRIPS);
  })();
  (function () {
    var f = HF.extract([id(8, S), id(6, H)], [id(14, C), id(8, D), id(2, H)]);
    t.eq("middle/bottom pair recognised", f.pair === "middle-pair" || f.pair === "bottom-pair");
  })();

  t.section("Features: flush draws");
  (function () {
    // Two hearts + two hearts on board = flush draw; hero holds Ah = nut fd.
    var f = HF.extract([id(14, H), id(9, H)], [id(5, H), id(2, H), id(13, S)]);
    t.eq("flush draw detected", f.flush.flushDraw === true);
    t.eq("nut flush draw (holds Ace of suit)", f.flush.nutFlushDraw === true);
  })();
  (function () {
    var f = HF.extract([id(13, H), id(9, H)], [id(5, H), id(2, H), id(13, S)]);
    t.eq("non-nut flush draw", f.flush.nutFlushDraw === false && f.flush.flushDraw === true);
  })();
  (function () {
    // One heart in hand, two on flop = backdoor flush draw.
    var f = HF.extract([id(14, H), id(9, S)], [id(5, H), id(2, H), id(13, C)]);
    t.eq("backdoor flush draw on the flop", f.flush.backdoorFlushDraw === true);
  })();
  (function () {
    // Completed flush.
    var f = HF.extract([id(14, H), id(9, H)], [id(5, H), id(2, H), id(13, H)]);
    t.eq("made flush detected", f.flush.flush === true);
  })();

  t.section("Features: straight draws");
  (function () {
    // T9 on 8-7-2: open-ended (J or 6 completes).
    var f = HF.extract([id(10, S), id(9, H)], [id(8, C), id(7, D), id(2, H)]);
    t.eq("open-ended straight draw", f.straight.oesd === true);
    t.eq("OESD completes with two ranks", f.straight.completingRanks.length >= 2);
  })();
  (function () {
    // KQ on T-9-2: gutshot (needs a Jack).
    var f = HF.extract([id(13, S), id(12, H)], [id(10, C), id(9, D), id(2, H)]);
    t.eq("gutshot straight draw", f.straight.gutshot === true);
    t.eq("gutshot completes with exactly one rank (Jack)", f.straight.completingRanks.length === 1 && f.straight.completingRanks[0] === 11);
  })();
  (function () {
    // Made straight.
    var f = HF.extract([id(10, S), id(9, H)], [id(8, C), id(7, D), id(6, H)]);
    t.eq("made straight detected", f.straight.straight === true);
  })();

  t.section("Features: combo draw");
  (function () {
    // Th 9h on 8h 7c 2h: flush draw + open-ended = combo draw.
    var f = HF.extract([id(10, H), id(9, H)], [id(8, H), id(7, C), id(2, H)]);
    t.eq("combo draw (flush + straight)", f.comboDraw === true);
  })();

  t.section("Features: board texture");
  (function () {
    t.eq("monotone board", HF.boardTexture([id(5, H), id(9, H), id(13, H)]).monotone === true);
    t.eq("two-tone board", HF.boardTexture([id(5, H), id(9, H), id(13, S)]).twoTone === true);
    t.eq("rainbow board", HF.boardTexture([id(5, H), id(9, D), id(13, S)]).rainbow === true);
    t.eq("paired board", HF.boardTexture([id(5, H), id(5, D), id(13, S)]).paired === true);
    t.eq("double-paired board", HF.boardTexture([id(5, H), id(5, D), id(13, S), id(13, C)]).doublePaired === true);
    t.eq("connected board flags possible straight", HF.boardTexture([id(9, H), id(8, D), id(7, S)]).possibleStraight === true);
    t.eq("possible flush on three of a suit", HF.boardTexture([id(9, H), id(8, H), id(7, H)]).possibleFlush === true);
  })();

  t.section("Features: blockers");
  (function () {
    // Hero holds Ah on a three-heart board -> nut flush blocker.
    var b = HF.blockers([id(14, H), id(2, C)], [id(9, H), id(8, H), id(7, H)]);
    t.eq("nut flush blocker held", b.nutFlushBlocker === true);
  })();
};
