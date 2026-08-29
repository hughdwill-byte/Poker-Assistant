/*
 * bet-composition.test.js - polarised value/bluff/check construction
 * (Phase C, Wave 1.2, #7).
 */
module.exports = function (t) {
  var P = global.Poker;
  var BC = P.BetComposition;
  var EQ = P.Equilibrium;
  var id = P.makeId;

  // Build synthetic combos with controlled equities. c1/c2 just need to be
  // distinct valid ids per combo; the partition only reads equity + weight.
  function combo(a, b, eq, w) { return { c1: Math.min(a, b), c2: Math.max(a, b), weight: w == null ? 1 : w, equity: eq }; }

  // A polarised-friendly range: strong value, medium bluff-catchers, pure air.
  function sampleRange() {
    return [
      combo(id(14, 3), id(14, 2), 0.92), // nut value
      combo(id(13, 3), id(13, 2), 0.85), // value
      combo(id(12, 3), id(12, 2), 0.78), // value
      combo(id(11, 3), id(11, 2), 0.70), // value
      combo(id(9, 3), id(9, 2), 0.50),   // medium (check)
      combo(id(8, 3), id(8, 2), 0.45),   // medium (check)
      combo(id(7, 3), id(6, 2), 0.20),   // air (bluff candidate)
      combo(id(5, 3), id(4, 2), 0.12),   // air
      combo(id(4, 3), id(3, 2), 0.08),   // air
      combo(id(3, 3), id(2, 2), 0.05),   // air (weakest -> first bluff)
    ];
  }

  t.section("Bet composition: value = strong, bluff = weakest air, check = middle");
  (function () {
    var res = BC.plan({ combos: sampleRange(), P: 100, B: 100, valueThreshold: 0.55, bluffMaxEquity: 0.35 });
    t.eq("ok", res.ok === true);
    // 4 value combos (>=0.55).
    t.eq("value weight = 4 combos", Math.abs(res.valueWeight - 4) < 1e-9);
    // Pot-sized bet: bluff/value = B/(P+B) = 0.5 -> target bluff weight = 2.
    t.approx("target bluff:value = B/(P+B) = 0.5", res.targetBluffToValue, 0.5, 1e-9);
    t.eq("2 bluffs chosen (weight 2)", Math.abs(res.bluffWeight - 2) < 1e-9);
    // The two chosen bluffs are the LOWEST-equity combos (0.05 and 0.08).
    var eqs = res.bluff.map(function (c) { return c.equity; }).sort(function (a, b) { return a - b; });
    t.eq("bluffs are the weakest air", eqs[0] === 0.05 && eqs[1] === 0.08);
    // Medium hands (0.50, 0.45) and the un-used air check.
    t.eq("mediums check, not bet", res.check.some(function (c) { return c.equity === 0.50; }));
  })();

  t.section("Bet composition: balanced bluff fraction matches equilibrium");
  (function () {
    // Provide plenty of air so the target can be met exactly, then compare the
    // actual bluff fraction of the betting range to B/(P+2B).
    var combos = [];
    for (var i = 0; i < 10; i++) combos.push(combo(id(14, 3) - i * 4, id(14, 2) - i * 4, 0.9 - i * 0.001)); // 10 value ~0.9
    for (var j = 0; j < 40; j++) combos.push(combo(id(9, 3) - j, id(2, 2) + j, 0.05)); // 40 air
    var res = BC.plan({ combos: combos, P: 100, B: 100 });
    t.approx("bluff fraction of bets = B/(P+2B) = 1/3", res.actualBluffFractionOfBets, EQ.bluffFractionOfRange(100, 100), 1e-6);
    t.approx("value:bluff = 2:1 at pot bet", res.valueToBluff, 2, 1e-6);
    t.eq("no shortfall when air is plentiful", res.bluffShortfall < 1e-9);
  })();

  t.section("Bet composition: smaller bets want fewer bluffs");
  (function () {
    var r1 = BC.plan({ combos: sampleRange(), P: 100, B: 50 });   // 1/2 pot
    var r2 = BC.plan({ combos: sampleRange(), P: 100, B: 150 });  // 1.5 pot
    // Half-pot bluff:value = 50/150 = 1/3; 1.5-pot = 150/250 = 0.6.
    t.approx("half-pot target bluff:value = 1/3", r1.targetBluffToValue, 1 / 3, 1e-9);
    t.eq("bigger bet allows more bluffs", r2.targetBluffToValue > r1.targetBluffToValue);
  })();

  t.section("Bet composition: hero role detection");
  (function () {
    var range = sampleRange();
    var res = BC.plan({ combos: range, P: 100, B: 100, heroActual: [id(14, 3), id(14, 2)] });
    t.eq("AA is a value bet", res.heroRole === "value");
    var res2 = BC.plan({ combos: range, P: 100, B: 100, heroActual: [id(3, 3), id(2, 2)] });
    t.eq("weakest air is a bluff", res2.heroRole === "bluff");
    var res3 = BC.plan({ combos: range, P: 100, B: 100, heroActual: [id(9, 3), id(9, 2)] });
    t.eq("medium hand checks", res3.heroRole === "check");
  })();

  t.section("Bet composition: bluff shortfall when the range is value-heavy");
  (function () {
    // All strong, no air -> can't balance; shortfall > 0, bluffWeight small.
    var combos = [combo(id(14, 3), id(14, 2), 0.9), combo(id(13, 3), id(13, 2), 0.85), combo(id(12, 3), id(12, 2), 0.8)];
    var res = BC.plan({ combos: combos, P: 100, B: 100 });
    t.eq("no air -> zero bluffs", res.bluffWeight === 0);
    t.eq("shortfall reported", res.bluffShortfall > 0);
    t.eq("value:bluff is infinite (pure value)", res.valueToBluff === Infinity);
  })();
};
