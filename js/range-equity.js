/*
 * range-equity.js - equity of a known hero hand against one or more opponents
 * represented as weighted combination ranges (one deck only).
 *
 * Method
 * ------
 * The target is the hero's expected showdown share under the independent-combo
 * prior: each opponent's hand is drawn from its own weighted range, assignments
 * that reuse a card are impossible (weight 0), and the board runs out uniformly
 * from the remaining stub. Ties split fractionally.
 *
 *   - EXACT enumeration when the number of leaves (surviving combo assignments x
 *     board completions) is below `exactLimit`: the result is the true expected
 *     share, weighted by the product of combo weights.
 *   - MONTE CARLO otherwise: sample one combo per opponent, reject the whole
 *     assignment on any card collision (this preserves the intended joint
 *     distribution - a naive conditional sampler would bias it), then deal the
 *     board. A per-trial safeguard caps rejection loops on narrow, colliding
 *     ranges and reports the acceptance problem.
 *
 * A deterministic seeded RNG (mulberry32) is used when a seed is supplied so
 * tests are reproducible; production uses Math.random by default.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  var evaluate7 = Poker.evaluate7;
  var Ranges = Poker.Ranges;

  // ---- Seeded RNG -----------------------------------------------------------

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var tt = Math.imul(a ^ (a >>> 15), 1 | a);
      tt = (tt + Math.imul(tt ^ (tt >>> 7), 61 | tt)) ^ tt;
      return ((tt ^ (tt >>> 14)) >>> 0) / 4294967296;
    };
  }
  Poker.makeRng = function (seed) {
    return (seed == null) ? Math.random : mulberry32(seed);
  };

  // ---- Showdown scoring -----------------------------------------------------

  // Add one showdown's fractional shares into `shares` (length = nPlayers).
  function tally(scores, shares, weight) {
    var best = -1, winners = 0, i;
    for (i = 0; i < scores.length; i++) {
      if (scores[i] > best) { best = scores[i]; winners = 1; }
      else if (scores[i] === best) winners++;
    }
    var frac = 1 / winners;
    for (i = 0; i < scores.length; i++) {
      if (scores[i] === best) shares[i] += frac * weight;
    }
  }

  // ---- Core -----------------------------------------------------------------

  /**
   * @param {Object} cfg
   *   heroCards       : [id,id]                     (both known)
   *   opponentRanges  : [ range, range, ... ]       (weighted combos each)
   *   board           : [id...]                     (0..5 known)
   *   deadCards       : [id...]
   *   trials          : number                      (MC trials, default 40000)
   *   seed            : number|null                 (deterministic if set)
   *   exactLimit      : number                      (max leaves for exact)
   *   targetCiHalfWidth : number|null               (convergence stop)
   *   maxAttemptsFactor : number                    (reject-loop safeguard)
   * @returns {Object} results per player + diagnostics
   */
  function simulateRanges(cfg) {
    var hero = (cfg.heroCards || []).slice();
    if (hero.length !== 2) return { ok: false, error: "Range equity needs both hero cards." };
    var board = (cfg.board || []).filter(function (c) { return c != null; });
    var dead = (cfg.deadCards || []).slice();
    var trials = cfg.trials || 40000;
    var exactLimit = cfg.exactLimit != null ? cfg.exactLimit : 200000;
    var target = cfg.targetCiHalfWidth != null ? cfg.targetCiHalfWidth : null;
    var maxAttemptsFactor = cfg.maxAttemptsFactor || 200;
    var rng = Poker.makeRng(cfg.seed);

    var fixed = hero.concat(board).concat(dead);

    // Prepare opponent ranges: strip blockers for the fixed known cards, then
    // normalise. An empty range after blockers is a hard, visible failure.
    var ranges = [];
    for (var o = 0; o < cfg.opponentRanges.length; o++) {
      var r = Ranges.removeBlockers(cfg.opponentRanges[o], fixed);
      if (!r.length) return { ok: false, error: "Opponent " + (o + 1) + "'s range is empty after removing known cards." };
      ranges.push(Ranges.normalise(r));
    }
    var nOpp = ranges.length;
    var nPlayers = nOpp + 1; // hero is index 0

    var neededBoard = 5 - board.length;

    // Base used-map for known cards (single deck: ids 8..59).
    var baseUsed = new Uint8Array(64);
    fixed.forEach(function (id) { baseUsed[id] = 1; });

    // Full deck ids for building runout pools.
    var deck = Poker.FULL_DECK;

    var shares = new Array(nPlayers).fill(0);
    var sumSq = new Array(nPlayers).fill(0); // for hero variance we track index 0
    var wins = new Array(nPlayers).fill(0);
    var ties = new Array(nPlayers).fill(0);
    var accepted = 0, rejected = 0;

    // Reusable buffers.
    var samplers = ranges.map(function (rr) { return Ranges.makeSampler(rr); });
    var fullBoard = new Array(5);
    var seven = new Array(7);

    var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());

    // ---- Exact enumeration path ------------------------------------------
    // Estimate leaves = product(range sizes) * C(remaining, neededBoard). Only
    // attempt when small and there is at most a couple of opponents.
    var estAssignments = 1;
    for (var e = 0; e < nOpp; e++) estAssignments *= ranges[e].length;
    var remainingApprox = deck.length - fixed.length - 2 * nOpp;
    var boardCombos = Poker.nCk(Math.max(0, remainingApprox), neededBoard);
    var estLeaves = estAssignments * Math.max(1, boardCombos);
    var mode;

    if (estLeaves > 0 && estLeaves <= exactLimit) {
      mode = "exact";
      enumerateExact();
      var totalW = 0;
      // In exact mode `accepted` accumulates total weight.
      totalW = accepted;
      var results0 = finish(totalW, true);
      results0.mode = "exact";
      results0.ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
      return results0;
    }

    // ---- Monte Carlo path -------------------------------------------------
    mode = "montecarlo";
    var maxAttempts = trials * maxAttemptsFactor;
    var attempts = 0;
    var checkEvery = Math.max(2000, (trials / 20) | 0);
    var used = new Uint8Array(64);
    var oppCards = new Array(nOpp * 2);

    while (accepted < trials && attempts < maxAttempts) {
      attempts++;
      // Fresh used map from the fixed known cards.
      used.set(baseUsed);
      var ok = true;
      for (var i = 0; i < nOpp; i++) {
        var combo = samplers[i](rng);
        if (!combo || used[combo.c1] || used[combo.c2]) { ok = false; break; }
        used[combo.c1] = 1; used[combo.c2] = 1;
        oppCards[2 * i] = combo.c1; oppCards[2 * i + 1] = combo.c2;
      }
      if (!ok) { rejected++; continue; }

      // Deal the board runout from the unused stub.
      for (var b = 0; b < board.length; b++) fullBoard[b] = board[b];
      var drawn = 0;
      // Partial sampling without replacement over the unused deck.
      var need = neededBoard;
      if (need > 0) {
        // Reservoir-free: pick `need` distinct unused cards.
        var picks = pickUnused(deck, used, need, rng);
        if (!picks) { rejected++; continue; }
        for (var d = 0; d < need; d++) fullBoard[board.length + d] = picks[d];
      }

      scoreShowdown(hero, oppCards, nOpp, fullBoard, shares, sumSq, wins, ties, 1);
      accepted++;

      if (target != null && accepted >= 4000 && accepted % checkEvery === 0) {
        var half = heroCiHalfWidth(shares[0], sumSq[0], accepted);
        if (half <= target) break;
      }
    }

    var out = finish(accepted, false);
    out.mode = "montecarlo";
    out.attempts = attempts;
    out.acceptanceRate = attempts ? accepted / attempts : 0;
    out.ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    if (accepted === 0) { out.ok = false; out.error = "Ranges collide on every deal - no valid assignment."; }
    else if (out.acceptanceRate < 0.02) out.warning = "Very narrow/colliding ranges: acceptance " + (out.acceptanceRate * 100).toFixed(1) + "%.";
    return out;

    // ---- helpers (closures over the accumulators) ------------------------

    function scoreShowdown(heroC, oppC, nO, fb, sh, sq, wn, ts, weight) {
      var scores = new Array(nO + 1);
      // Hero.
      seven[0] = heroC[0]; seven[1] = heroC[1];
      for (var k = 0; k < 5; k++) seven[2 + k] = fb[k];
      scores[0] = evaluate7(seven);
      for (var p = 0; p < nO; p++) {
        seven[0] = oppC[2 * p]; seven[1] = oppC[2 * p + 1];
        for (var kk = 0; kk < 5; kk++) seven[2 + kk] = fb[kk];
        scores[p + 1] = evaluate7(seven);
      }
      // Per-share tally, and track hero win/tie + squared share for variance.
      var best = -1, winners = 0, m;
      for (m = 0; m < scores.length; m++) {
        if (scores[m] > best) { best = scores[m]; winners = 1; }
        else if (scores[m] === best) winners++;
      }
      var frac = 1 / winners;
      for (m = 0; m < scores.length; m++) {
        if (scores[m] === best) {
          sh[m] += frac * weight;
          if (winners === 1) wn[m] += weight; else ts[m] += weight;
        }
      }
      var heroShare = (scores[0] === best) ? frac : 0;
      sq[0] += heroShare * heroShare * weight;
    }

    function enumerateExact() {
      var chosen = new Array(nOpp * 2);
      var exUsed = new Uint8Array(64); exUsed.set(baseUsed);
      recurseOpp(0, 1);

      function recurseOpp(oi, weightSoFar) {
        if (oi === nOpp) { enumBoard(weightSoFar); return; }
        var rr = ranges[oi];
        for (var c = 0; c < rr.length; c++) {
          var combo = rr[c];
          if (exUsed[combo.c1] || exUsed[combo.c2]) continue;
          exUsed[combo.c1] = 1; exUsed[combo.c2] = 1;
          chosen[2 * oi] = combo.c1; chosen[2 * oi + 1] = combo.c2;
          recurseOpp(oi + 1, weightSoFar * combo.weight);
          exUsed[combo.c1] = 0; exUsed[combo.c2] = 0;
        }
      }
      function enumBoard(weight) {
        if (weight <= 0) return;
        // Build the pool of unused cards.
        var pool = [];
        for (var i = 0; i < deck.length; i++) if (!exUsed[deck[i]]) pool.push(deck[i]);
        var fb = new Array(5);
        for (var b = 0; b < board.length; b++) fb[b] = board[b];
        var need = neededBoard;
        (function combos(start, depth) {
          if (depth === need) {
            accepted += weight; // exact "accepted" holds total weight
            scoreShowdown(hero, chosen, nOpp, fb, shares, sumSq, wins, ties, weight);
            return;
          }
          for (var s = start; s <= pool.length - (need - depth); s++) {
            fb[board.length + depth] = pool[s];
            combos(s + 1, depth + 1);
          }
        })(0, 0);
      }
    }

    function finish(denom, exact) {
      var results = [];
      for (var p = 0; p < nPlayers; p++) {
        var eq = denom > 0 ? shares[p] / denom : 0;
        var res = {
          win: denom > 0 ? wins[p] / denom : 0,
          tie: denom > 0 ? ties[p] / denom : 0,
          lose: denom > 0 ? 1 - shares[p] / denom : 0,
          equity: eq,
        };
        if (p === 0) {
          if (exact) {
            res.variance = 0; res.stdError = 0; res.ci = [eq, eq];
          } else {
            var mean = eq;
            var variance = denom > 1 ? Math.max(0, (sumSq[0] / denom) - mean * mean) : 0;
            var se = denom > 0 ? Math.sqrt(variance / denom) : 0;
            res.variance = variance; res.stdError = se;
            res.ci = [Math.max(0, mean - 1.96 * se), Math.min(1, mean + 1.96 * se)];
          }
        }
        results.push(res);
      }
      return {
        ok: true,
        results: results,
        heroEquity: results[0].equity,
        heroCi: results[0].ci,
        trials: exact ? undefined : accepted,
        trialsAccepted: exact ? undefined : accepted,
        rejected: exact ? 0 : rejected,
        exactWeight: exact ? denom : undefined,
      };
    }
  }

  // Pick `need` distinct unused card ids uniformly (partial Fisher-Yates over a
  // scratch list of the unused deck). Returns array or null if too few remain.
  function pickUnused(deck, used, need, rng) {
    var pool = [];
    for (var i = 0; i < deck.length; i++) if (!used[deck[i]]) pool.push(deck[i]);
    if (pool.length < need) return null;
    var out = new Array(need);
    for (var k = 0; k < need; k++) {
      var j = k + ((rng() * (pool.length - k)) | 0);
      var tmp = pool[k]; pool[k] = pool[j]; pool[j] = tmp;
      out[k] = pool[k];
    }
    return out;
  }

  function heroCiHalfWidth(shareSum, sqSum, n) {
    if (n < 2) return 1;
    var mean = shareSum / n;
    var variance = Math.max(0, (sqSum / n) - mean * mean);
    return 1.96 * Math.sqrt(variance / n);
  }

  Poker.simulateRanges = simulateRanges;
})(typeof self !== "undefined" ? self : this);
