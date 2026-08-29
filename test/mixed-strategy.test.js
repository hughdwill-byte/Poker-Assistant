/*
 * mixed-strategy.test.js - per-hand frequency output (Phase C, Wave 1.4, #6).
 * A value hand bets every time; surplus air bluffs at the indifference
 * frequency targetBluffWeight / airWeight; medium hands check.
 */
module.exports = function (t) {
  var P = global.Poker;
  var BC = P.BetComposition;
  var id = P.makeId;

  function combo(a, b, eq, w) { return { c1: Math.min(a, b), c2: Math.max(a, b), weight: w == null ? 1 : w, equity: eq }; }

  // 4 value (0.9), 2 medium (0.45), 8 air (0.05..0.20).
  function range() {
    var r = [
      combo(id(14, 3), id(14, 2), 0.90),
      combo(id(13, 3), id(13, 2), 0.88),
      combo(id(12, 3), id(12, 2), 0.86),
      combo(id(11, 3), id(11, 2), 0.84),
      combo(id(9, 3), id(9, 2), 0.45),
      combo(id(8, 3), id(8, 2), 0.45),
    ];
    for (var i = 0; i < 8; i++) r.push(combo(id(7, 3) - i, id(2, 2) + i, 0.05 + i * 0.01));
    return r;
  }

  t.section("Mixed strategy: value bets 100%");
  (function () {
    var res = BC.plan({ combos: range(), P: 100, B: 100, heroActual: [id(14, 3), id(14, 2)] });
    t.eq("value hand mix kind = value", res.heroMix && res.heroMix.kind === "value");
    t.approx("value bets every time", res.heroMix.betFreq, 1, 1e-9);
    t.approx("value never checks", res.heroMix.checkFreq, 0, 1e-9);
  })();

  t.section("Mixed strategy: surplus air bluffs at the indifference frequency");
  (function () {
    var res = BC.plan({ combos: range(), P: 100, B: 100, heroActual: [id(7, 3), id(2, 2)] });
    // valueWeight = 4, pot bet -> targetBluffWeight = 4 * 100/200 = 2. air = 8.
    // indifference bluff freq = 2/8 = 0.25.
    t.eq("air hand mix kind = bluff", res.heroMix && res.heroMix.kind === "bluff");
    t.approx("targetBluffWeight = 2", res.targetBluffWeight, 2, 1e-9);
    t.approx("airWeight = 8", res.airWeight, 8, 1e-9);
    t.approx("bluff frequency = target/air = 0.25", res.heroMix.betFreq, 0.25, 1e-9);
    t.approx("bet + check freq sum to 1", res.heroMix.betFreq + res.heroMix.checkFreq, 1, 1e-9);
  })();

  t.section("Mixed strategy: bigger bet bluffs more often");
  (function () {
    var half = BC.plan({ combos: range(), P: 100, B: 50, heroActual: [id(7, 3), id(2, 2)] });
    var pot = BC.plan({ combos: range(), P: 100, B: 100, heroActual: [id(7, 3), id(2, 2)] });
    t.eq("pot-sized bet bluffs this air more often than half-pot", pot.heroMix.betFreq > half.heroMix.betFreq);
  })();

  t.section("Mixed strategy: scarce air bluffs 100%");
  (function () {
    // Only ONE air combo, but target bluff weight is 2 -> it must always bluff.
    var combos = [
      combo(id(14, 3), id(14, 2), 0.9), combo(id(13, 3), id(13, 2), 0.9),
      combo(id(12, 3), id(12, 2), 0.9), combo(id(11, 3), id(11, 2), 0.9),
      combo(id(2, 3), id(3, 2), 0.05),
    ];
    var res = BC.plan({ combos: combos, P: 100, B: 100, heroActual: [id(2, 3), id(3, 2)] });
    t.approx("scarce air bluffs every time", res.heroMix.betFreq, 1, 1e-9);
  })();

  t.section("Mixed strategy: medium hand checks");
  (function () {
    var res = BC.plan({ combos: range(), P: 100, B: 100, heroActual: [id(9, 3), id(9, 2)] });
    t.eq("medium hand mix kind = showdown", res.heroMix && res.heroMix.kind === "showdown");
    t.approx("medium checks (never bets here)", res.heroMix.betFreq, 0, 1e-9);
  })();
};
