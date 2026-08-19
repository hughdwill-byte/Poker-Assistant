/*
 * equity.js - win/tie/equity computation for a Texas Hold'em situation.
 *
 * Two engines, picked automatically:
 *   - EXACT enumeration when every player's hole cards are known and only the
 *     board runout is unknown and the number of combinations is small. The
 *     result is then the true probability, not an estimate.
 *   - MONTE CARLO otherwise: deal the unknown cards uniformly at random from
 *     the *actual remaining deck* (known cards removed, multi-deck aware) many
 *     times and average. Error shrinks like 1/sqrt(trials).
 *
 * The remaining deck is always built from what could still be in the stub:
 * every visible/known/dead card is removed, so probabilities update exactly as
 * cards appear - which is what the request asks for.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  var evaluate7 = Poker.evaluate7;
  var buildRemaining = Poker.buildRemaining;

  var EXACT_COMBO_LIMIT = 200000; // enumerate exactly below this many runouts

  function nCk(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    var r = 1;
    for (var i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  }

  // Partial Fisher-Yates: draw `count` cards from `pool` (mutated in place,
  // stays a valid permutation for the next call) into `out`.
  function drawInto(pool, count, out) {
    var len = pool.length;
    for (var i = 0; i < count; i++) {
      var j = i + ((Math.random() * (len - i)) | 0);
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      out[i] = pool[i];
    }
  }

  // Tally one showdown into the accumulators.
  function score(activeHands, wins, ties, equity) {
    var best = -1, winners = 0, i;
    for (i = 0; i < activeHands.length; i++) {
      var s = activeHands[i];
      if (s > best) { best = s; winners = 1; }
      else if (s === best) winners++;
    }
    if (winners === 1) {
      for (i = 0; i < activeHands.length; i++) {
        if (activeHands[i] === best) { wins[i]++; equity[i] += 1; break; }
      }
    } else {
      var share = 1 / winners;
      for (i = 0; i < activeHands.length; i++) {
        if (activeHands[i] === best) { ties[i]++; equity[i] += share; }
      }
    }
  }

  /**
   * @param {Object} cfg
   *   players : [{ cards:number[], active:boolean }]   (cards: 0..2 known ids)
   *   board   : number[]                                (0..5 known ids)
   *   decks   : number
   *   dead    : number[]                                (extra removed cards)
   *   trials  : number                                  (Monte Carlo trials)
   * @returns {Object} { ok, mode, trials, results:[{win,tie,lose,equity}], error }
   */
  function simulate(cfg) {
    var players = cfg.players || [];
    var board = (cfg.board || []).slice();
    var decks = cfg.decks || 1;
    var dead = cfg.dead || [];
    var trials = cfg.trials || 50000;

    var activeIdx = [];
    var i, p;
    for (i = 0; i < players.length; i++) {
      if (players[i].active !== false) activeIdx.push(i);
    }
    if (activeIdx.length < 2) {
      return { ok: false, error: "Need at least two active players." };
    }

    // Cards removed from the deck: every known hole card + board + dead cards.
    var removed = board.slice().concat(dead);
    for (i = 0; i < players.length; i++) {
      removed = removed.concat(players[i].cards || []);
    }

    // Detect impossible duplicates for the given number of decks.
    var seen = {};
    for (i = 0; i < removed.length; i++) {
      seen[removed[i]] = (seen[removed[i]] || 0) + 1;
      if (seen[removed[i]] > decks) {
        return { ok: false, error: "The card " + Poker.cardLabel(removed[i]) +
          " is used more times than " + decks + " deck(s) allow." };
      }
    }

    var pool = buildRemaining(decks, removed);

    var neededBoard = 5 - board.length;
    var perPlayerNeed = [];
    var totalNeeded = neededBoard;
    var allHoleKnown = true;
    for (i = 0; i < activeIdx.length; i++) {
      p = players[activeIdx[i]];
      var need = 2 - (p.cards ? p.cards.length : 0);
      perPlayerNeed.push(need);
      totalNeeded += need;
      if (need > 0) allHoleKnown = false;
    }

    if (pool.length < totalNeeded) {
      return { ok: false, error: "Not enough cards remain in the deck for this setup." };
    }

    var nActive = activeIdx.length;
    var wins = new Array(nActive).fill(0);
    var ties = new Array(nActive).fill(0);
    var equity = new Array(nActive).fill(0);

    // Reusable buffers.
    var fullBoard = new Array(5);
    var hands = new Array(nActive);       // packed scores this showdown
    var handBuf = [];                     // 7-card buffer per player
    for (i = 0; i < nActive; i++) handBuf.push(new Array(7));

    function runOneWithDraw(drawn) {
      // Assemble the board.
      for (var b = 0; b < board.length; b++) fullBoard[b] = board[b];
      var idx = 0;
      for (b = board.length; b < 5; b++) fullBoard[b] = drawn[idx++];
      // Assemble each active player's 7 cards and score.
      for (var a = 0; a < nActive; a++) {
        var pl = players[activeIdx[a]];
        var known = pl.cards || [];
        var h = handBuf[a];
        var c = 0;
        for (var kk = 0; kk < known.length; kk++) h[c++] = known[kk];
        for (var nn = 0; nn < perPlayerNeed[a]; nn++) h[c++] = drawn[idx++];
        for (var bb = 0; bb < 5; bb++) h[c++] = fullBoard[bb];
        hands[a] = evaluate7(h);
      }
      score(hands, wins, ties, equity);
    }

    var mode, total;

    // EXACT path: only the board is unknown and the runout is small.
    if (allHoleKnown && neededBoard >= 0 &&
        nCk(pool.length, neededBoard) <= EXACT_COMBO_LIMIT) {
      mode = "exact";
      total = 0;
      var drawn = new Array(neededBoard);
      // Enumerate every board completion.
      (function combos(start, depth) {
        if (depth === neededBoard) {
          total++;
          runOneWithDraw(drawn);
          return;
        }
        for (var s = start; s <= pool.length - (neededBoard - depth); s++) {
          drawn[depth] = pool[s];
          combos(s + 1, depth + 1);
        }
      })(0, 0);
    } else {
      mode = "montecarlo";
      total = trials;
      var buf = new Array(totalNeeded);
      for (var t = 0; t < trials; t++) {
        drawInto(pool, totalNeeded, buf);
        runOneWithDraw(buf);
      }
    }

    var results = [];
    for (i = 0; i < players.length; i++) {
      results.push(null);
    }
    for (i = 0; i < nActive; i++) {
      results[activeIdx[i]] = {
        win: wins[i] / total,
        tie: ties[i] / total,
        lose: 1 - equity[i] / total,
        equity: equity[i] / total,
      };
    }

    return { ok: true, mode: mode, trials: total, poolSize: pool.length, results: results };
  }

  Poker.simulate = simulate;
  Poker.nCk = nCk;
})(typeof self !== "undefined" ? self : this);
