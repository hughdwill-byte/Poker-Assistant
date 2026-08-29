/*
 * equilibrium.test.js - GTO reference math (Phase C, Wave 0).
 *
 * Validated against the specification's idealized river reference table (§8.4):
 *
 *   Bet size | pure-bluff folds | MDF     | balanced bluff fraction
 *   1/4 pot  | 20.00%           | 80.00%  | 16.67%
 *   1/3 pot  | 25.00%           | 75.00%  | 20.00%
 *   1/2 pot  | 33.33%           | 66.67%  | 25.00%
 *   2/3 pot  | 40.00%           | 60.00%  | 28.57%
 *   3/4 pot  | 42.86%           | 57.14%  | 30.00%
 *   1 pot    | 50.00%           | 50.00%  | 33.33%
 *   1.5 pot  | 60.00%           | 40.00%  | 37.50%
 *   2 pot    | 66.67%           | 33.33%  | 40.00%
 */
module.exports = function (t) {
  var EQ = global.Poker.Equilibrium;

  // Reference rows: [betFractionOfPot, alpha, mdf, bluffFraction].
  var rows = [
    [0.25, 0.2000, 0.8000, 0.166667],
    [1 / 3, 0.2500, 0.7500, 0.200000],
    [0.5, 0.333333, 0.666667, 0.250000],
    [2 / 3, 0.4000, 0.6000, 0.285714],
    [0.75, 0.428571, 0.571429, 0.300000],
    [1.0, 0.5000, 0.5000, 0.333333],
    [1.5, 0.6000, 0.4000, 0.375000],
    [2.0, 0.666667, 0.333333, 0.400000],
  ];

  t.section("Equilibrium: MDF / alpha / bluff fraction vs spec §8.4 table");
  rows.forEach(function (r) {
    var b = r[0]; // bet as a fraction of the pot -> P = 1, B = b
    t.approx("alpha (pure-bluff folds) @ " + b.toFixed(3) + " pot", EQ.alpha(1, b), r[1], 1e-4);
    t.approx("MDF @ " + b.toFixed(3) + " pot", EQ.mdf(1, b), r[2], 1e-4);
    t.approx("bluff fraction @ " + b.toFixed(3) + " pot", EQ.bluffFractionOfRange(1, b), r[3], 1e-4);
  });

  t.section("Equilibrium: identities");
  t.approx("alpha = 1 - MDF (pot bet)", EQ.alpha(1, 1), 1 - EQ.mdf(1, 1), 1e-12);
  t.approx("value:bluff at pot bet is 2:1", EQ.valueToBluff(1, 1), 2, 1e-9);
  t.approx("value:bluff at half pot is 3:1", EQ.valueToBluff(1, 0.5), 3, 1e-9);
  t.approx("value + bluff fractions sum to 1", EQ.valueFractionOfRange(1, 0.75) + EQ.bluffFractionOfRange(1, 0.75), 1, 1e-12);
  // A bluff-catcher's break-even equity facing a bet equals the balanced bluff
  // fraction: B / (P + 2B).
  t.approx("call break-even equity = B/(P+2B)", EQ.reference(100, 50).callBreakEvenEquity, 50 / 200, 1e-9);
  // Ratio-invariance: chips vs pot-fractions give the same references.
  t.approx("ratio-invariant MDF (chips)", EQ.mdf(200, 100), EQ.mdf(1, 0.5), 1e-12);

  t.section("Equilibrium: two-branch required fold frequency (4-bet reference)");
  t.approx("fold +15, called -26.6 -> 63.9423%", EQ.requiredFoldFrequency(15, -26.6), 26.6 / 41.6, 1e-6);

  t.section("Equilibrium: defense assessment");
  (function () {
    // Facing a pot-sized bet, MDF = 50%.
    var under = EQ.defenseAssessment(1, 1, 0.35);
    t.eq("defending below MDF flags over-folding", under.status === "over-folding" && under.exploitable);
    var over = EQ.defenseAssessment(1, 1, 0.70);
    t.eq("defending above MDF flags over-defending", over.status === "over-defending");
    var bal = EQ.defenseAssessment(1, 1, 0.50);
    t.eq("defending at MDF is balanced", bal.status === "balanced" && !bal.exploitable);
    t.approx("delta is defend - mdf", EQ.defenseAssessment(1, 1, 0.40).delta, -0.10, 1e-9);
  })();

  t.section("Equilibrium: betting composition bundle");
  (function () {
    var c = EQ.bettingComposition(1, 1); // pot-sized
    t.approx("pot-bet bluff fraction 33.33%", c.bluffFraction, 1 / 3, 1e-6);
    t.approx("pot-bet value fraction 66.67%", c.valueFraction, 2 / 3, 1e-6);
    t.approx("pot-bet opponent MDF 50%", c.opponentMdf, 0.5, 1e-9);
  })();

  t.section("Equilibrium: reference-only (does not exist on the EV engine)");
  t.eq("equilibrium is a separate module, not wired into ActionEV.evCall", typeof global.Poker.ActionEV.evCall === "function" && global.Poker.ActionEV.evCall(100, 50, 0.4) === 10);
};
