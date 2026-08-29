/*
 * implied-odds.js - implied and reverse-implied odds (Phase C, Wave 0.2).
 *
 * Direct pot odds only value the current pot. Implied odds add chips that may be
 * won on later streets after a draw improves; reverse-implied odds add chips
 * that may be lost when an "improvement" is second best or cannot be realised.
 * This module is deterministic; the *future-win* magnitude it consumes is a
 * labelled assumption supplied by the caller (default 0 collapses to pure pot
 * odds), never an invented multiplier - the spec explicitly warns against a
 * single magic implied-odds number.
 *
 * Notation (spec §9): P = pot before hero's call, C = the call, e = probability
 * of reaching the defined winning outcome (the DRAW hit probability, NOT the
 * full showdown equity), W = additional net won from opponents after success.
 *
 * All EV is measured from the current decision point (folding = 0), so a losing
 * branch costs only the new call C, never the hero's sunk chips.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  /** Simple hit-or-miss EV: e·(P + W) − (1 − e)·C. Reduces to EV_call when W=0. */
  function simpleEV(P, C, e, W) {
    W = W || 0;
    return e * (P + W) - (1 - e) * C;
  }

  /**
   * Minimum future net win to break even on the call: W_min = C(1−e)/e − P.
   * W_min ≤ 0 means direct pot odds already justify the call.
   */
  function wMin(P, C, e) {
    if (e <= 0) return Infinity;
    return (C * (1 - e)) / e - P;
  }

  /** Does the immediate price justify the call on pot odds alone? */
  function justifiedNow(P, C, e) { return wMin(P, C, e) <= 0; }

  /**
   * General branch EV. branches = [{ prob, net, label? }], net measured from the
   * current decision point. Returns { ev, totalProb, ok }. Probabilities should
   * sum to 1; a tolerance flags a malformed set rather than silently rescaling.
   */
  function branchEV(branches, tol) {
    tol = tol == null ? 1e-6 : tol;
    var ev = 0, tp = 0;
    for (var i = 0; i < branches.length; i++) {
      var b = branches[i];
      var p = Math.max(0, b.prob || 0);
      ev += p * (b.net || 0);
      tp += p;
    }
    return { ev: ev, totalProb: tp, ok: Math.abs(tp - 1) <= tol };
  }

  /**
   * Structured draw EV with implied and reverse-implied branches. All branch
   * probabilities and payoffs are derived explicitly so the tree is inspectable.
   *
   * @param {Object} p
   *   P, C            pot before call, call cost
   *   hitProb (e)     probability the draw completes (one-card unless all-in)
   *   winGivenHit     P(hero's completed hand is best | hit)      default 1
   *   futureWinProb   P(win extra bets | hit and best)           default 0
   *   futureWin (W)   net extra won in that sub-branch            default 0
   *   futureLoss      net extra lost when hit-but-behind          default 0
   *   realizeProb     P(hero gets to see the card | miss path)   default 1
   * @returns {Object} { ev, wMin, justifiedNow, branches }
   */
  function drawEV(p) {
    var P = Math.max(0, p.P || 0), C = Math.max(0, p.C || 0);
    var e = Math.max(0, Math.min(1, p.hitProb || 0));
    var winGivenHit = clamp01(p.winGivenHit == null ? 1 : p.winGivenHit);
    var futureWinProb = clamp01(p.futureWinProb || 0);
    var W = p.futureWin || 0;
    var futureLoss = Math.max(0, p.futureLoss || 0);
    var realizeProb = clamp01(p.realizeProb == null ? 1 : p.realizeProb);

    var branches = [];
    // Hit and best.
    var pHitBest = e * winGivenHit;
    // ... and win future bets.
    branches.push({ label: "hit, best, win extra", prob: pHitBest * futureWinProb, net: P + W });
    // ... and win no extra.
    branches.push({ label: "hit, best, no extra", prob: pHitBest * (1 - futureWinProb), net: P });
    // Hit but second best / redraw (reverse implied): lose the call, maybe more.
    branches.push({ label: "hit, second best (reverse implied)", prob: e * (1 - winGivenHit), net: -(C + futureLoss) });
    // Miss and give up. Split by whether equity is realised (saw the card) or the
    // hand was forced off before the card - both simply lose the call here.
    var pMiss = 1 - e;
    branches.push({ label: "miss, realised", prob: pMiss * realizeProb, net: -C });
    branches.push({ label: "miss, forced off (unrealised)", prob: pMiss * (1 - realizeProb), net: -C });

    var res = branchEV(branches);
    return {
      ev: res.ev,
      branches: branches,
      totalProb: res.totalProb,
      wMin: wMin(P, C, e),
      justifiedNow: justifiedNow(P, C, e),
    };
  }

  // Nominal (undiscounted) outs from detected draws - spec §4.2. These are a
  // reference count; real outs may be "dirty" (pair the board into a boat,
  // complete a higher flush, make a dominated straight). Overcard outs are
  // deliberately excluded here as too speculative for a break-even reference.
  function nominalOuts(features) {
    if (!features) return 0;
    var f = features.flush || {}, s = features.straight || {};
    if (f.flush || s.straight) return 0; // already made - not a draw
    var straightOuts = s.oesd || s.doubleGutshot ? 8 : (s.gutshot ? 4 : 0);
    if (f.flushDraw) {
      if (straightOuts === 8) return 15;   // flush + open-ender
      if (straightOuts === 4) return 12;   // flush + gutshot
      return 9;                            // bare flush draw
    }
    if (f.backdoorFlushDraw && straightOuts === 0) return 0; // backdoor alone: negligible next-card
    return straightOuts;
  }

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  Poker.ImpliedOdds = {
    simpleEV: simpleEV,
    wMin: wMin,
    justifiedNow: justifiedNow,
    branchEV: branchEV,
    drawEV: drawEV,
    nominalOuts: nominalOuts,
  };
})(typeof self !== "undefined" ? self : this);
