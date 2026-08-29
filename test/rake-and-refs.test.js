/*
 * rake-and-refs.test.js - rake-adjusted EV (Part A item 3) plus the
 * deterministic reference formulas from the specification: outs probabilities
 * (§4.1 / T08, T09), set-mining (§9.3 / T18), pure-bluff and two-branch fold
 * thresholds (§8.1, §8.3 / T13, T14, T15), MDF (§8.4) and the geometric size
 * helper (§10.3 / T17).
 */
module.exports = function (t) {
  var P = global.Poker;
  var EV = P.ActionEV, DO = P.DrawOdds;

  t.section("Rake: pure rake(pot) = min(pot*pct, cap), gated by mode");
  (function () {
    var cash = { rakePercent: 0.05, rakeCap: 0, mode: "cash" };
    t.approx("5% of 200 = 10 (uncapped)", EV.rake(200, cash), 10, 1e-9);
    var capped = { rakePercent: 0.05, rakeCap: 4, mode: "cash" };
    t.approx("cap limits rake to 4", EV.rake(200, capped), 4, 1e-9);
    t.eq("play-money is never raked", EV.rake(200, { rakePercent: 0.05, mode: "play-money" }) === 0);
    t.eq("tournament is never raked", EV.rake(200, { rakePercent: 0.05, mode: "tournament" }) === 0);
    t.eq("no rake context = 0", EV.rake(200) === 0);
    t.eq("zero percent = 0", EV.rake(200, { rakePercent: 0, mode: "cash" }) === 0);
  })();

  t.section("Rake: EV reduced only on the won pot; zero-rake path unchanged");
  (function () {
    // Zero-rake path identical to the plain formula.
    t.approx("EV_call unchanged with no rake", EV.evCall(100, 50, 0.40), 10, 1e-9);
    // Cash rake nets e * rake(P+C) off the call EV.
    var cash = { rakePercent: 0.05, rakeCap: 0, mode: "cash" };
    // EV_call = 0.40*(150) - 50 - 0.40*rake(150); rake(150)=7.5 -> 10 - 3 = 7.
    t.approx("EV_call reduced by e*rake(P+C)", EV.evCall(100, 50, 0.40, cash), 7, 1e-9);
    // Bet example: P=100,B=50,F=0.5,eCalled=0.6 -> 85 with no rake.
    t.approx("EV_bet unchanged with no rake", EV.evBet(100, 50, 0.5, 0.6), 85, 1e-9);
    // With rake: fold branch (wins P=100) is NOT raked; called branch pot=200,
    // rake(200)=10, netted as eCalled*rake -> 0.6*10 = 6 off the called branch.
    // EV = 0.5*100 + 0.5*(0.6*200 - 50 - 0.6*10) = 50 + 0.5*(120-50-6)=50+32=82.
    t.approx("EV_bet rakes only the called showdown pot", EV.evBet(100, 50, 0.5, 0.6, cash), 82, 1e-9);
  })();

  t.section("Rake: uncalled/fold-branch winnings are not raked");
  (function () {
    var cash = { rakePercent: 0.10, rakeCap: 0, mode: "cash" };
    // All-fold branch: hero wins P=100, no showdown -> no rake.
    var foldOnly = [{ prob: 1, type: "fold", oppAdditional: 0 }];
    t.approx("all-fold branch returns full P (no rake)", EV.evFromBranches(100, foldOnly, cash), 100, 1e-9);
    // Called branch is raked: pot=200, equity 0.6 -> 0.6*200 - 50 - 0.6*20 = 58.
    var called = [{ prob: 1, type: "call", heroAdditional: 50, oppAdditional: 50, branchEquity: 0.6 }];
    t.approx("called branch nets equity*rake(pot)", EV.evFromBranches(100, called, cash), 0.6 * 200 - 50 - 0.6 * 20, 1e-9);
  })();

  t.section("Draw odds: outs probabilities (§4.1)");
  t.approx("9 outs, next card only = 9/47 = 19.1489%", DO.hitOnTurnFromFlop(9), 0.19148936, 1e-6);
  t.approx("9 clean outs by river all-in = 34.9676%", DO.hitByRiverFromFlop(9), 0.34967622, 1e-6);
  t.approx("9 outs on the turn = 9/46 = 19.5652%", DO.hitOnRiverFromTurn(9), 9 / 46, 1e-9);
  t.approx("8 outs next card = 17.0213%", DO.hitOnTurnFromFlop(8), 0.17021277, 1e-6);

  t.section("Draw odds: set-mining (§9.3) and geometric (§10.3)");
  t.approx("pocket pair flops a set = 11.7551%", DO.flopSetProbability(), 0.11755102, 1e-6);
  (function () {
    // Geometric: bet fraction b then simulate n bet-call streets, reconstruct S.
    var pot = 10, stack = 90, n = 3;
    var b = DO.geometricBetFraction(pot, stack, n);
    // Simulate: each street hero bets b*pot, opponent calls; pot grows by (1+2b).
    var invest = 0, p = pot;
    for (var s = 0; s < n; s++) { var bet = b * p; invest += bet; p += 2 * bet; }
    t.approx("geometric sizing reconstructs the stack (T17)", invest, stack, 1e-6);
  })();

  t.section("Fold thresholds: pure bluff (§8.1 / T13, T14)");
  t.approx("half-pot bluff needs 33.333% folds", EV.breakEvenFoldForBluff(1, 0.5), 1 / 3, 1e-6);
  t.approx("pot-sized bluff needs 50% folds", EV.breakEvenFoldForBluff(1, 1), 0.5, 1e-9);

  t.section("Fold thresholds: two-branch aggression (§8.3 / T15 4-bet)");
  t.approx("4-bet: fold +15, called -26.6 -> 63.9423% folds",
    EV.requiredFoldFrequency(15, -26.6), 26.6 / 41.6, 1e-6);
  t.eq("already-profitable called branch needs 0 folds", EV.requiredFoldFrequency(100, 20) === 0);

  t.section("MDF and ideal bluff fraction (§8.4)");
  t.approx("MDF vs half-pot bet = 66.667%", EV.minDefenseFrequency(1, 0.5), 2 / 3, 1e-6);
  t.approx("MDF vs pot bet = 50%", EV.minDefenseFrequency(1, 1), 0.5, 1e-9);
  t.approx("ideal bluff fraction vs pot bet = 33.333%", EV.idealBluffFraction(1, 1), 1 / 3, 1e-6);
  t.approx("ideal bluff fraction vs half-pot = 25%", EV.idealBluffFraction(1, 0.5), 0.25, 1e-9);

  t.section("Deferred: ICM interface is disabled (not wired into advice)");
  t.eq("ICM stub reports disabled", P.TournamentICM.enabled === false);
  t.throws("ICM equities throw until validated", function () { P.TournamentICM.icmEquities([5000, 2500, 2500], [50, 30, 20]); });
};
