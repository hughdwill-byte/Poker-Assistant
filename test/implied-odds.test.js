/*
 * implied-odds.test.js - implied / reverse-implied odds (Phase C, Wave 0.2).
 */
module.exports = function (t) {
  var P = global.Poker;
  var IO = P.ImpliedOdds;
  var HF = P.HandFeatures;
  var id = P.makeId;
  var H = 2, S = 3, C = 0, D = 1;

  t.section("Implied odds: simpleEV reduces to EV_call when W=0");
  // e(P+C)-C == e(P) - (1-e)C ; check against ActionEV.evCall.
  t.approx("simpleEV(100,50,0.40,0) == evCall(100,50,0.40)", IO.simpleEV(100, 50, 0.40), P.ActionEV.evCall(100, 50, 0.40), 1e-9);
  t.approx("break-even call: simpleEV(100,50,1/3,0)=0", IO.simpleEV(100, 50, 1 / 3), 0, 1e-9);

  t.section("Implied odds: W_min = C(1-e)/e - P");
  // Set-mining example: call 10 into 40 with ~11.76% to flop a set.
  (function () {
    var e = 0.1176, P0 = 40, C0 = 10;
    var w = IO.wMin(P0, C0, e);
    // C(1-e)/e - P = 10*0.8824/0.1176 - 40 ≈ 75.03 - 40 ≈ 35.03
    t.approx("set-mine W_min ≈ 35", w, (C0 * (1 - e)) / e - P0, 1e-9);
    t.eq("W_min positive -> pot odds alone do not justify", w > 0 && !IO.justifiedNow(P0, C0, e));
  })();
  (function () {
    // A big pot, small call: pot odds already justify -> W_min <= 0.
    var e = 0.35, w = IO.wMin(200, 20, e);
    t.eq("cheap call with strong draw: W_min <= 0, justified now", w <= 0 && IO.justifiedNow(200, 20, e));
  })();

  t.section("Implied odds: adding future winnings turns a -EV call +EV");
  (function () {
    // e=0.20, P=100, C=50 -> pure EV = 0.20*150-50 = -20. Need W to break even.
    var pureEv = IO.simpleEV(100, 50, 0.20);
    t.approx("pure call is -20", pureEv, -20, 1e-9);
    var w = IO.wMin(100, 50, 0.20); // = 50*0.8/0.2 - 100 = 200-100 = 100
    t.approx("W_min = 100", w, 100, 1e-9);
    t.approx("adding exactly W_min future win breaks even", IO.simpleEV(100, 50, 0.20, w), 0, 1e-9);
    t.eq("adding more than W_min is +EV", IO.simpleEV(100, 50, 0.20, w + 40) > 0);
  })();

  t.section("Implied odds: reverse-implied branch lowers EV");
  (function () {
    var noReverse = IO.drawEV({ P: 100, C: 50, hitProb: 0.35, winGivenHit: 1.0 });
    var withReverse = IO.drawEV({ P: 100, C: 50, hitProb: 0.35, winGivenHit: 0.7, futureLoss: 30 });
    t.eq("reverse-implied risk reduces draw EV", withReverse.ev < noReverse.ev);
    t.approx("draw branch probabilities sum to 1", withReverse.totalProb, 1, 1e-9);
    t.eq("branch set is inspectable (5 branches)", withReverse.branches.length === 5);
  })();

  t.section("Implied odds: general branchEV validates probabilities");
  (function () {
    var good = IO.branchEV([{ prob: 0.4, net: 100 }, { prob: 0.6, net: -50 }]);
    t.approx("branch EV = 0.4*100 + 0.6*-50 = 10", good.ev, 10, 1e-9);
    t.eq("well-formed branch set ok", good.ok === true);
    var bad = IO.branchEV([{ prob: 0.4, net: 100 }, { prob: 0.4, net: 100 }, { prob: 0.3, net: 0 }]);
    t.eq("branch probs 1.1 flagged not ok", bad.ok === false);
  })();

  t.section("Implied odds: nominal outs from features");
  (function () {
    // Flush draw only (two hearts + two on board) = 9 outs.
    var fd = HF.extract([id(14, H), id(9, H)], [id(5, H), id(2, H), id(13, S)]);
    t.eq("flush draw -> 9 outs", IO.nominalOuts(fd) === 9);
    // Open-ended straight draw (T9 on 8-7-2) = 8.
    var oesd = HF.extract([id(10, S), id(9, H)], [id(8, C), id(7, D), id(2, H)]);
    t.eq("OESD -> 8 outs", IO.nominalOuts(oesd) === 8);
    // Gutshot (KQ on T-9-2, needs a jack) = 4.
    var gut = HF.extract([id(13, S), id(12, H)], [id(10, C), id(9, D), id(2, H)]);
    t.eq("gutshot -> 4 outs", IO.nominalOuts(gut) === 4);
    // Combo draw (flush + OESD): Th9h on 8h 7c 2h = 15.
    var combo = HF.extract([id(10, H), id(9, H)], [id(8, H), id(7, C), id(2, H)]);
    t.eq("flush + open-ender -> 15 outs", IO.nominalOuts(combo) === 15);
    // A made flush is not a draw -> 0.
    var made = HF.extract([id(14, H), id(9, H)], [id(5, H), id(2, H), id(13, H)]);
    t.eq("made flush -> 0 draw outs", IO.nominalOuts(made) === 0);
  })();

  t.section("Implied odds: outs -> one-card hit prob composes with draw-odds");
  (function () {
    var fd = HF.extract([id(14, H), id(9, H)], [id(5, H), id(2, H), id(13, S)]);
    var outs = IO.nominalOuts(fd);
    // Facing a flop bet, use the NEXT-card probability (spec §4.1): 9/47.
    var hit = P.DrawOdds.hitOnTurnFromFlop(outs);
    t.approx("flush draw one-card hit = 9/47", hit, 9 / 47, 1e-9);
    // W_min for calling 30 into 60 with that hit prob.
    var w = IO.wMin(60, 30, hit);
    t.approx("W_min matches formula", w, (30 * (1 - hit)) / hit - 60, 1e-9);
  })();
};
