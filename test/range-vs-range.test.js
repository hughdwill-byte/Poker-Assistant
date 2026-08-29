/*
 * range-vs-range.test.js - hero-range equity distributions and range/nut
 * advantage (Phase C, Wave 1.1).
 */
module.exports = function (t) {
  var P = global.Poker;
  var RVR = P.RangeVsRange;
  var R = P.Ranges;
  var id = P.makeId;
  var C = 0, D = 1, H = 2, S = 3;

  // High exactLimit keeps every per-combo match-up exact -> deterministic.
  var EXACT = 5000000;

  t.section("RvR: distribution aggregates per-combo equity");
  (function () {
    // Hero range {AA, KK} vs a single opponent combo QsQh on a dry flop.
    var board = [id(7, C), id(4, D), id(2, S)];
    var opp = [{ c1: Math.min(id(12, S), id(12, H)), c2: Math.max(id(12, S), id(12, H)), weight: 1 }];
    var dist = RVR.equityDistribution({
      range: R.parse("AA, KK").range, opponentRanges: [opp], board: board, exactLimit: EXACT,
    });
    t.eq("distribution ok", dist.ok === true);
    t.eq("evaluated all 12 combos (6 AA + 6 KK)", dist.combosEvaluated === 12);
    // Every combo (AA or KK overpair) crushes QQ on 742 -> mean equity high.
    t.eq("overpair range mean equity > 0.8 vs QQ", dist.meanEquity > 0.8);
    t.approx("bucket fractions sum to 1", dist.buckets.reduce(function (a, b) { return a + b; }, 0), 1, 1e-9);
    t.eq("nut fraction is the whole range here", dist.nutFraction > 0.99);
  })();

  t.section("RvR: range advantage & nut advantage");
  (function () {
    var board = [id(13, S), id(8, D), id(3, C)]; // K 8 3 rainbow
    var heroSets = R.parse("KK, 88, 33").range;   // flopped sets (blockers applied inside)
    var oppWeak = R.parse("QJ, T9, 76s").range;   // overcards / draws / air
    var heroDist = RVR.equityDistribution({ range: heroSets, opponentRanges: [oppWeak], board: board, exactLimit: EXACT });
    var oppDist = RVR.equityDistribution({ range: oppWeak, opponentRanges: [heroSets], board: board, exactLimit: EXACT });
    t.eq("both distributions ok", heroDist.ok && oppDist.ok);
    var adv = RVR.rangeAdvantage(heroDist, oppDist);
    t.eq("hero sets have a positive equity edge", adv.equityEdge > 0.3);
    t.eq("hero sets have a positive nut advantage", adv.nutAdvantage > 0.5);
    t.eq("hero mean and opp mean roughly sum to 1 (heads-up)", Math.abs(adv.heroMean + adv.oppMean - 1) < 0.05);
    t.eq("rangeAdvantage null on bad input", RVR.rangeAdvantage(null, oppDist) === null);
  })();

  t.section("RvR: hero's actual hand percentile within its range");
  (function () {
    // River board with no pairs/flush for hero; opponent holds KK.
    var board = [id(3, C), id(6, D), id(9, H), id(11, S), id(12, D)];
    var opp = [{ c1: Math.min(id(13, H), id(13, D)), c2: Math.max(id(13, H), id(13, D)), weight: 1 }];
    var heroRange = R.parse("AA, 72o").range; // AA crushes KK; 72o loses to KK
    var aa = R.parse("AA").range[0];
    var junk = R.parse("72o").range[0];
    var withAA = RVR.equityDistribution({ range: heroRange, opponentRanges: [opp], board: board, exactLimit: EXACT, heroActual: [aa.c1, aa.c2] });
    var withJunk = RVR.equityDistribution({ range: heroRange, opponentRanges: [opp], board: board, exactLimit: EXACT, heroActual: [junk.c1, junk.c2] });
    t.eq("AA locates high in the range", withAA.heroActual && withAA.heroActual.percentile > 0.5);
    t.eq("72o locates at the bottom of the range", withJunk.heroActual && withJunk.heroActual.percentile < 0.01);
    t.eq("AA equity ~1 vs KK on this board", withAA.heroActual.equity > 0.99);
    t.eq("72o equity ~0 vs KK on this board", withJunk.heroActual.equity < 0.01);
  })();

  t.section("RvR: determinism under Monte Carlo");
  (function () {
    var board = [id(13, S), id(8, D), id(3, C)];
    var cfg = { range: R.parse("AK, QQ+").range, opponentRanges: [R.parse("22+, A2s+").range], board: board, exactLimit: 1, trials: 3000, seed: 99 };
    var a = RVR.equityDistribution(cfg);
    var b = RVR.equityDistribution(cfg);
    t.eq("same seed -> identical mean equity", a.ok && b.ok && a.meanEquity === b.meanEquity);
  })();

  t.section("RvR: truncation guard on a huge range");
  (function () {
    var board = [id(13, S), id(8, D), id(3, C)];
    var dist = RVR.equityDistribution({ range: R.fullRange(), opponentRanges: [R.parse("QQ+").range], board: board, exactLimit: 1, trials: 400, seed: 7, maxCombos: 20 });
    t.eq("truncated flag set", dist.ok && dist.truncated === true);
    t.eq("evaluated at most maxCombos", dist.combosEvaluated <= 20);
  })();

  t.section("RvR: empty-after-blockers surfaces");
  (function () {
    // Hero range AA but all four aces are on the board/dead -> empty.
    var board = [id(14, C), id(14, D), id(14, H)];
    var dist = RVR.equityDistribution({ range: R.parse("AA").range, opponentRanges: [R.parse("KK").range], board: board, deadCards: [id(14, S)], exactLimit: EXACT });
    t.eq("empty hero range reported", dist.ok === false && /empty/i.test(dist.error || ""));
  })();
};
