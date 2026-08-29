/*
 * gto-defense.test.js - equilibrium defense verdict (Phase C, Wave 1.5, #5).
 */
module.exports = function (t) {
  var GD = global.Poker.GtoDefense;

  t.section("GTO defense: MDF threshold vs hero percentile");
  (function () {
    // Villain bets pot: C into (P-C) with C = P-C -> P = 2C. Use C=50, P=100.
    // MDF = (P-C)/P = 50/100 = 0.5; defend the top 50% (percentile >= 0.5).
    var strong = GD.defenseVerdict({ P: 100, C: 50, heroPercentile: 0.70 });
    t.approx("pot-bet MDF = 0.5", strong.mdf, 0.5, 1e-9);
    t.approx("defend threshold percentile = 0.5", strong.thresholdPercentile, 0.5, 1e-9);
    t.eq("top-of-range hand defends", strong.verdict === "defend");
    var weak = GD.defenseVerdict({ P: 100, C: 50, heroPercentile: 0.30 });
    t.eq("bottom-of-range hand folds", weak.verdict === "fold");
    t.approx("margin is percentile - threshold", weak.margin, 0.30 - 0.5, 1e-9);
  })();

  t.section("GTO defense: smaller bet -> defend wider (lower threshold)");
  (function () {
    // Half-pot bet: villain bets C = 0.5*(P-C). Take C=50 -> P-C=100 -> P=150.
    // MDF = 100/150 = 0.6667; threshold = 0.3333 (defend the top 66.7%).
    var v = GD.defenseVerdict({ P: 150, C: 50, heroPercentile: 0.40 });
    t.approx("half-pot MDF = 2/3", v.mdf, 2 / 3, 1e-6);
    t.approx("half-pot threshold = 1/3", v.thresholdPercentile, 1 / 3, 1e-6);
    t.eq("a 40th-percentile hand defends vs half-pot", v.verdict === "defend");
    // ...but folds vs a pot-sized bet (threshold 0.5).
    t.eq("same hand folds vs pot-sized bet", GD.defenseVerdict({ P: 150, C: 100, heroPercentile: 0.40 }).verdict === "fold");
  })();

  t.section("GTO defense: not facing a bet -> null");
  t.eq("no bet -> null verdict", GD.defenseVerdict({ P: 100, C: 0, heroPercentile: 0.5 }) === null);
  t.eq("no percentile -> null", GD.defenseVerdict({ P: 100, C: 50 }) === null);

  t.section("GTO defense: reconcile with the EV action");
  (function () {
    var defendV = GD.defenseVerdict({ P: 100, C: 50, heroPercentile: 0.7 }); // defend
    t.eq("agree when EV also calls", GD.reconcile(defendV, "CALL").agree === true);
    var d = GD.reconcile(defendV, "FOLD");
    t.eq("disagree flagged when MDF defends but EV folds", d.agree === false && /under-bluffing|over-fold/i.test(d.note));
    var foldV = GD.defenseVerdict({ P: 100, C: 50, heroPercentile: 0.2 }); // fold
    t.eq("agree when EV also folds", GD.reconcile(foldV, "FOLD").agree === true);
    t.eq("disagree flagged when MDF folds but EV calls", GD.reconcile(foldV, "CALL").agree === false);
    t.eq("null verdict reconciles to neutral", GD.reconcile(null, "CALL").agree === null);
  })();
};
