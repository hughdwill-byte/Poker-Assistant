/*
 * range-equity.test.js - determinism, collision-free sampling, delta-range and
 * uniform-range reproduction, tie shares, exact/MC agreement, confidence
 * intervals and rejection safeguards.
 */
module.exports = function (t) {
  var P = global.Poker;
  var R = P.Ranges;
  var id = P.makeId;
  var C = 0, D = 1, H = 2, S = 3;

  function combo(a, b) { return a < b ? { c1: a, c2: b, weight: 1 } : { c1: b, c2: a, weight: 1 }; }
  function deltaRange(a, b) { return [combo(a, b)]; }

  t.section("Range equity: determinism");
  (function () {
    var cfg = {
      heroCards: [id(14, S), id(14, H)],
      opponentRanges: [R.fullRange()],
      board: [], trials: 8000, seed: 12345, exactLimit: 1,
    };
    var a = P.simulateRanges(cfg);
    var b = P.simulateRanges(cfg);
    t.eq("same seed -> identical hero equity", a.ok && b.ok && a.heroEquity === b.heroEquity);
    t.eq("hero equity in (0,1)", a.heroEquity > 0 && a.heroEquity < 1);
  })();

  t.section("Range equity: shares sum to 1 (no lost/double-counted mass)");
  (function () {
    var res = P.simulateRanges({
      heroCards: [id(14, S), id(14, H)],
      opponentRanges: [deltaRange(id(13, S), id(13, H))],
      board: [id(2, C), id(7, D), id(9, S)], seed: 7, exactLimit: 500000,
    });
    var sum = res.results.reduce(function (a, r) { return a + r.equity; }, 0);
    t.approx("hero+opp equity sums to 1", sum, 1, 1e-6);
  })();

  t.section("Range equity: delta range == known-hand equity (exact)");
  (function () {
    // AA vs a single KK combo on a fixed flop: both engines enumerate the same
    // runouts, so the exact range path must match the exact uniform engine.
    var board = [id(2, C), id(7, D), id(9, S)];
    var rng = P.simulateRanges({
      heroCards: [id(14, S), id(14, H)],
      opponentRanges: [deltaRange(id(13, S), id(13, H))],
      board: board, exactLimit: 5000000,
    });
    var uni = P.simulate({
      players: [{ cards: [id(14, S), id(14, H)], active: true }, { cards: [id(13, S), id(13, H)], active: true }],
      board: board, decks: 1, trials: 1000,
    });
    t.eq("range path used exact enumeration", rng.mode === "exact");
    t.eq("uniform path used exact enumeration", uni.mode === "exact");
    t.approx("delta-range equity equals known-hand equity", rng.heroEquity, uni.results[0].equity, 1e-9);
  })();

  t.section("Range equity: uniform range ≈ uniform-random equity");
  (function () {
    var res = P.simulateRanges({
      heroCards: [id(14, S), id(14, H)],
      opponentRanges: [R.fullRange()],
      board: [], trials: 60000, seed: 99, exactLimit: 1,
    });
    // AA vs one random hand ≈ 0.852.
    t.approx("AA vs uniform range ≈ 0.852", res.heroEquity, 0.852, 0.02);
  })();

  t.section("Range equity: tie shares");
  (function () {
    // Both hands play the board (a fixed AA-KK-Q board), guaranteed split.
    var res = P.simulateRanges({
      heroCards: [id(2, C), id(3, D)],
      opponentRanges: [deltaRange(id(2, H), id(3, S))],
      board: [id(14, C), id(14, D), id(13, H), id(13, S), id(12, C)], exactLimit: 10,
    });
    t.approx("tie gives hero exactly 0.5", res.heroEquity, 0.5, 1e-9);
    t.eq("tie recorded as a tie not a win", res.results[0].tie > 0.99);
  })();

  t.section("Range equity: exact and Monte Carlo agree");
  (function () {
    var common = {
      heroCards: [id(12, S), id(12, H)],
      opponentRanges: [R.parse("AKs, AKo, QQ+").range],
      board: [id(2, C), id(7, D), id(9, S)],
    };
    var exact = P.simulateRanges(Object.assign({}, common, { exactLimit: 50000000 }));
    var mc = P.simulateRanges(Object.assign({}, common, { exactLimit: 1, trials: 40000, seed: 4 }));
    t.eq("exact path taken", exact.mode === "exact");
    t.eq("mc path taken", mc.mode === "montecarlo");
    // Agree within a few MC standard errors.
    t.eq("exact within MC 95% CI", exact.heroEquity >= mc.heroCi[0] - 0.005 && exact.heroEquity <= mc.heroCi[1] + 0.005);
  })();

  t.section("Range equity: confidence interval sensible");
  (function () {
    var res = P.simulateRanges({
      heroCards: [id(14, S), id(13, S)],
      opponentRanges: [R.parse("QQ+").range],
      board: [], trials: 20000, seed: 3, exactLimit: 1,
    });
    var ci = res.heroCi;
    t.eq("CI is finite", isFinite(ci[0]) && isFinite(ci[1]));
    t.eq("CI ordered and brackets estimate", ci[0] <= res.heroEquity && res.heroEquity <= ci[1]);
    t.eq("CI within [0,1]", ci[0] >= 0 && ci[1] <= 1);
    t.eq("standard error positive for MC", res.results[0].stdError > 0);
  })();

  t.section("Range equity: rejection safeguard");
  (function () {
    // Two opponents whose only combo is the identical pair of cards: every
    // assignment collides, so no valid deal exists and it must fail loudly.
    var same = deltaRange(id(14, S), id(13, S));
    var res = P.simulateRanges({
      heroCards: [id(2, C), id(3, D)],
      opponentRanges: [same, R.clone(same)],
      board: [], trials: 1000, seed: 1, exactLimit: 1,
    });
    t.eq("colliding ranges reported, not silently averaged", res.ok === false && /collide/i.test(res.error || ""));
  })();

  t.section("Range equity: empty-after-blockers surfaces");
  (function () {
    var res = P.simulateRanges({
      heroCards: [id(14, S), id(14, H)],
      opponentRanges: [R.parse("AA").range], // hero holds two aces -> AA nearly dead
      board: [id(14, D), id(14, C), id(2, S)], // the other two aces on board
      exactLimit: 1, trials: 100,
    });
    t.eq("range emptied by blockers reported", res.ok === false && /empty/i.test(res.error || ""));
  })();
};
