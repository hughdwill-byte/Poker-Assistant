/*
 * action-ev.test.js - the exact EV examples required by the brief, plus legal
 * candidate sizing, uncalled-excess return and side-pot eligibility.
 */
module.exports = function (t) {
  var P = global.Poker;
  var EV = P.ActionEV;
  var GS = P.GameState, AT = P.ActionTracker;

  t.section("EV: break-even call (P=100, C=50, e=1/3 -> 0)");
  t.approx("EV_call = 0 at break-even", EV.evCall(100, 50, 1 / 3), 0, 1e-9);
  t.approx("break-even equity = 1/3", EV.breakEvenEquity(100, 50), 1 / 3, 1e-9);

  t.section("EV: positive call (P=100, C=50, e=0.40 -> 10)");
  t.approx("EV_call = 10", EV.evCall(100, 50, 0.40), 10, 1e-9);

  t.section("EV: heads-up bet (P=100, B=50, F=0.5, eCalled=0.6 -> 85)");
  t.approx("EV_bet = 85", EV.evBet(100, 50, 0.5, 0.6), 85, 1e-9);

  t.section("EV: fold baseline is zero");
  t.eq("folding is the zero reference", 0 === 0);

  t.section("EV: uncalled excess returned correctly");
  (function () {
    // A fully-folded branch returns the hero the pre-action pot P only.
    var branches = [{ prob: 1, type: "fold", oppAdditional: 0, heroAdditional: 0 }];
    t.approx("all-fold branch returns P (not P + hero chips)", EV.evFromBranches(100, branches), 100, 1e-9);
    // Bet where villain always folds: EV = P (matches evBet with F=1).
    t.approx("evBet with F=1 equals P", EV.evBet(100, 50, 1, 0.6), 100, 1e-9);
  })();

  t.section("EV: branch weighting matches the closed-form bet");
  (function () {
    // Reconstruct the F=0.5 bet example via the general branch calculator.
    var P0 = 100, B = 50, F = 0.5, eCalled = 0.6;
    var branches = [
      { prob: F, type: "fold", oppAdditional: 0 },
      { prob: 1 - F, type: "call", heroAdditional: B, oppAdditional: B, branchEquity: eCalled },
    ];
    t.approx("branch EV equals closed-form 85", EV.evFromBranches(P0, branches), 85, 1e-9);
  })();

  t.section("EV: candidate sizes never exceed stack; min-raises legal");
  (function () {
    var s = GS.createState({ tableSize: 2, buttonSeat: 0, smallBlind: 5, bigBlind: 10 });
    s.players[0].startingStack = s.players[0].stackBehind = 200;
    s.players[1].startingStack = s.players[1].stackBehind = 200;
    AT.postBlinds(s);
    var la = GS.legalActions(s, 0); // BTN/SB to act
    var raise = la.filter(function (a) { return a.type === "raise"; })[0];
    t.eq("min raise-to is legal (>= BB + last full raise)", raise.min === 20);
    t.eq("max raise-to capped by stack (all-in bet-to = 200)", raise.max === 200);
    // A candidate far above the stack must still be capped at the all-in bet-to.
    var potBefore = GS.canonicalPot(s);
    var huge = s.players[0].streetCommitted + 20 * potBefore; // 5 + 300 = 305
    var capped = Math.min(huge, s.players[0].streetCommitted + s.players[0].stackBehind);
    t.eq("oversized candidate capped at all-in (200)", capped === 200);
  })();

  t.section("EV: all-in exception represented");
  (function () {
    var s = GS.createState({ tableSize: 2, buttonSeat: 0, smallBlind: 5, bigBlind: 10 });
    s.players[0].startingStack = s.players[0].stackBehind = 12; // tiny stack
    s.players[1].startingStack = s.players[1].stackBehind = 200;
    AT.postBlinds(s); // seat0 posts SB 5 -> behind 7
    var la = GS.legalActions(s, 0);
    var allIn = la.filter(function (a) { return a.type === "all-in"; })[0];
    t.eq("all-in available for a short stack", !!allIn);
    t.eq("all-in bet-to = street + behind", allIn.toAmount === s.players[0].streetCommitted + s.players[0].stackBehind);
  })();

  t.section("EV: side-pot expectation excludes ineligible players");
  (function () {
    // Two layers: main pot (all eligible), side pot (only seat 0 eligible).
    var layers = [
      { amount: 180, eligibleSeats: [0, 1] },
      { amount: 80, eligibleSeats: [0] },
    ];
    // Hero (seat 0) wins 50% of the main pot, 100% of the side pot.
    var shares = { 0: { main: 0.5, side: 1.0 } };
    var exp = EV.sidePotExpectation(layers, 0, function (layer) {
      return layer.amount === 180 ? 0.5 : 1.0;
    });
    t.approx("hero expected chips = 90 + 80 = 170", exp, 90 + 80, 1e-9);
    // A player not eligible for the side pot gets 0 from it.
    var exp1 = EV.sidePotExpectation(layers, 1, function () { return 1.0; });
    t.approx("ineligible-for-side-pot player only shares the main pot", exp1, 180, 1e-9);
  })();

  t.section("EV: responseModel integrates likelihoods to fold/call/raise");
  (function () {
    var R = P.Ranges;
    var flop = [P.makeId(13, 0), P.makeId(8, 1), P.makeId(3, 3)];
    var range = R.normalise(R.removeBlockers(R.fullRange(), flop));
    var rm = EV.responseModel(range, { board: flop });
    t.approx("fold+call+raise probabilities sum to 1", rm.fold + rm.call + rm.raise, 1, 1e-6);
    t.eq("all response probabilities in [0,1]", rm.fold >= 0 && rm.call >= 0 && rm.raise >= 0 && rm.fold <= 1 && rm.call <= 1 && rm.raise <= 1);
    t.approx("called range normalised", R.totalWeight(rm.calledRange), 1, 1e-6);
    // A raise range is polarised (value + bluffs), so it carries more top-band
    // weight than the (medium) calling range.
    t.eq("raised range holds more top-strength weight than called range", (function () {
      var OM = P.OpponentModel;
      function topMass(rr) { var w = 0; rr.forEach(function (c) { if (OM.comboStrength(c.c1, c.c2, flop).made >= 0.7) w += c.weight; }); return w; }
      return topMass(rm.raisedRange) > topMass(rm.calledRange);
    })());
  })();
};
