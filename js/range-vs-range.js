/*
 * range-vs-range.js - hero-range analytics (Phase C, Wave 1.1).
 *
 * Point equity (one hero hand vs an opponent range) hides how the WHOLE hero
 * range performs on a board. This module computes the equity of every combo in
 * a range against the opponent range(s) and the board runout, producing an
 * equity DISTRIBUTION (mean, nut/weak shares, a histogram) and - given the
 * hero's actual hand - where that hand ranks inside its own range. Two
 * distributions combine into range-advantage and nut-advantage metrics.
 *
 * It reuses `simulateRanges` (the collision-rejecting, exact/Monte-Carlo joint
 * equity engine) once per combo, so it inherits correct tie handling and card
 * removal. Cost is O(combos) simulations, so a `maxCombos` guard caps the work
 * and reports truncation rather than hanging on a 1,326-combo pre-flop range.
 *
 * Reference/analysis layer: it explains a spot; it does not by itself change the
 * EV recommendation.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function comboKey(c) { return c.c1 + "_" + c.c2; }

  // Seeded shuffle (Fisher-Yates) for reproducible truncation/subsampling.
  function seededShuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  /**
   * Equity distribution of `range` vs `opponentRanges` on a board.
   * @param {Object} cfg
   *   range           : hero combos [{c1,c2,weight}]
   *   opponentRanges  : [ range, ... ]
   *   board, deadCards
   *   trials          : per-combo Monte-Carlo trials (default 3000)
   *   seed            : deterministic if set
   *   exactLimit      : per-combo exact-enumeration leaf cap
   *   maxCombos       : cap on hero combos evaluated (default 200)
   *   nutThreshold    : equity at/above which a combo is "nutted" (default 0.75)
   *   weakThreshold   : equity at/below which a combo is "weak" (default 0.33)
   *   buckets         : histogram bins (default 10)
   *   heroActual      : [c1,c2] to locate the hero's real hand in the range
   * @returns {Object} distribution + diagnostics
   */
  function equityDistribution(cfg) {
    var Ranges = Poker.Ranges;
    var board = (cfg.board || []).filter(function (c) { return c != null; });
    var dead = (cfg.deadCards || []).slice();
    var fixed = board.concat(dead);
    var trials = cfg.trials || 3000;
    var exactLimit = cfg.exactLimit != null ? cfg.exactLimit : 200000;
    var maxCombos = cfg.maxCombos || 200;
    var nutThreshold = cfg.nutThreshold != null ? cfg.nutThreshold : 0.75;
    var weakThreshold = cfg.weakThreshold != null ? cfg.weakThreshold : 0.33;
    var nBuckets = cfg.buckets || 10;
    var rng = Poker.makeRng(cfg.seed);

    // Hero combos can't use board/dead cards.
    var hero = Ranges.removeBlockers(cfg.range || [], fixed).filter(function (c) { return c.weight > 0; });
    if (!hero.length) return { ok: false, error: "Hero range is empty after removing board/dead cards." };

    var truncated = false;
    if (hero.length > maxCombos) {
      hero = seededShuffle(hero, rng).slice(0, maxCombos);
      truncated = true;
    }

    var results = [];
    var skipped = 0, idx = 0;
    hero.forEach(function (c) {
      var res = Poker.simulateRanges({
        heroCards: [c.c1, c.c2],
        opponentRanges: cfg.opponentRanges,
        board: board, deadCards: dead,
        trials: trials, seed: cfg.seed != null ? cfg.seed + 1 + idx : null,
        exactLimit: exactLimit,
      });
      idx++;
      if (!res.ok) { skipped++; return; } // e.g. this combo empties an opponent range
      results.push({ c1: c.c1, c2: c.c2, weight: c.weight, equity: res.heroEquity });
    });

    if (!results.length) return { ok: false, error: "No hero combo produced a valid match-up (blockers)." };

    var totalW = 0, sumEq = 0, nutW = 0, weakW = 0;
    var buckets = new Array(nBuckets).fill(0);
    results.forEach(function (r) {
      totalW += r.weight;
      sumEq += r.equity * r.weight;
      if (r.equity >= nutThreshold) nutW += r.weight;
      if (r.equity <= weakThreshold) weakW += r.weight;
      var bi = Math.min(nBuckets - 1, Math.floor(r.equity * nBuckets));
      buckets[bi] += r.weight;
    });
    var meanEquity = sumEq / totalW;

    // Locate the hero's actual hand within the range.
    var heroActual = null;
    if (cfg.heroActual && cfg.heroActual.length === 2 && cfg.heroActual[0] != null && cfg.heroActual[1] != null) {
      var a = cfg.heroActual[0], b = cfg.heroActual[1];
      var key = Math.min(a, b) + "_" + Math.max(a, b);
      var found = null;
      for (var i = 0; i < results.length; i++) {
        if (comboKey(results[i]) === key) { found = results[i]; break; }
      }
      var eq;
      if (found) { eq = found.equity; }
      else {
        var r2 = Poker.simulateRanges({ heroCards: [a, b], opponentRanges: cfg.opponentRanges, board: board, deadCards: dead, trials: trials, seed: cfg.seed != null ? cfg.seed + 777 : null, exactLimit: exactLimit });
        eq = r2.ok ? r2.heroEquity : null;
      }
      if (eq != null) {
        var below = 0;
        results.forEach(function (r) { if (r.equity < eq) below += r.weight; });
        heroActual = { equity: eq, percentile: below / totalW };
      }
    }

    // Normalise the histogram to fractions.
    var bucketFractions = buckets.map(function (w) { return w / totalW; });

    return {
      ok: true,
      meanEquity: meanEquity,
      nutFraction: nutW / totalW,
      weakFraction: weakW / totalW,
      buckets: bucketFractions,
      bucketWidth: 1 / nBuckets,
      combos: results,
      heroActual: heroActual,
      combosEvaluated: results.length,
      truncated: truncated,
      skipped: skipped,
      nutThreshold: nutThreshold,
      weakThreshold: weakThreshold,
    };
  }

  /**
   * Range advantage and nut advantage from two distributions on the same board.
   * @param {Object} heroDist result of equityDistribution for the hero range
   * @param {Object} oppDist  result of equityDistribution for the opponent range
   * @returns {Object} { equityEdge, nutAdvantage, heroMean, oppMean }
   *   equityEdge > 0 means the hero range is ahead on this board on average;
   *   nutAdvantage > 0 means the hero range holds more of the very strong combos.
   */
  function rangeAdvantage(heroDist, oppDist) {
    if (!heroDist || !heroDist.ok || !oppDist || !oppDist.ok) return null;
    return {
      equityEdge: heroDist.meanEquity - oppDist.meanEquity,
      nutAdvantage: heroDist.nutFraction - oppDist.nutFraction,
      heroMean: heroDist.meanEquity,
      oppMean: oppDist.meanEquity,
    };
  }

  /**
   * One-call analysis for the UI: the hero-range distribution vs the opponents,
   * and (heads-up only, where it is exact and meaningful) the opponent-range
   * distribution and the resulting range/nut advantage.
   * @param {Object} cfg
   *   heroRange, opponentRanges[], board, deadCards, trials, seed, exactLimit,
   *   maxCombos, heroActual, opponentRange (the single range for advantage)
   */
  function analyze(cfg) {
    var heroDist = equityDistribution({
      range: cfg.heroRange, opponentRanges: cfg.opponentRanges,
      board: cfg.board, deadCards: cfg.deadCards, trials: cfg.trials,
      seed: cfg.seed, exactLimit: cfg.exactLimit, maxCombos: cfg.maxCombos,
      heroActual: cfg.heroActual,
    });
    if (!heroDist.ok) return { ok: false, error: heroDist.error };
    var oppDist = null, advantage = null;
    if (cfg.opponentRange) {
      oppDist = equityDistribution({
        range: cfg.opponentRange, opponentRanges: [cfg.heroRange],
        board: cfg.board, deadCards: cfg.deadCards, trials: cfg.trials,
        seed: cfg.seed != null ? cfg.seed + 5000 : null, exactLimit: cfg.exactLimit,
        maxCombos: cfg.maxCombos,
      });
      if (oppDist.ok) advantage = rangeAdvantage(heroDist, oppDist);
    }
    return { ok: true, heroDist: heroDist, oppDist: oppDist, advantage: advantage };
  }

  Poker.RangeVsRange = {
    equityDistribution: equityDistribution,
    rangeAdvantage: rangeAdvantage,
    analyze: analyze,
  };
})(typeof self !== "undefined" ? self : this);
