/*
 * draw-odds.js - deterministic outs / draw / set-mining probabilities and a
 * geometric bet-sizing helper, straight from the specification (sections 4, 9.3
 * and 10.3).
 *
 * These are EXACT combinatorial functions - not models or heuristics. They are
 * exposed for explanation and as regression fixtures. The geometric helper is a
 * candidate-sizing generator only; it is NOT wired into live recommendations
 * (multi-street geometric sizing is a documented, deferred item - see
 * docs/future-math-roadmap.md).
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function nCk(n, k) {
    if (k < 0 || k > n) return 0;
    k = Math.min(k, n - k);
    var r = 1;
    for (var i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  }

  /**
   * Probability of hitting one of O clean outs.
   * @param {number} outs   clean outs
   * @param {number} unseen unseen cards (47 after the flop, 46 after the turn)
   * @param {number} cards  1 = next card only; 2 = by the river with both cards
   *                        to come and no further betting decision (all-in).
   */
  function outsProbability(outs, unseen, cards) {
    cards = cards || 1;
    if (outs <= 0 || unseen <= 0) return 0;
    if (cards === 1) return outs / unseen;
    // Two cards to come, drawn without replacement.
    var missBoth = ((unseen - outs) / unseen) * ((unseen - 1 - outs) / (unseen - 1));
    return 1 - missBoth;
  }

  /** After the flop: P(hit on the turn) = O/47. */
  function hitOnTurnFromFlop(outs) { return outsProbability(outs, 47, 1); }
  /** After the flop, all-in: P(hit by the river) = 1 - (47-O)/47 * (46-O)/46. */
  function hitByRiverFromFlop(outs) { return outsProbability(outs, 47, 2); }
  /** On the turn: P(hit on the river) = O/46. */
  function hitOnRiverFromTurn(outs) { return outsProbability(outs, 46, 1); }

  /**
   * Probability a pocket pair flops at least a set: 1 - C(48,3)/C(50,3).
   * Two cards of the pair's rank remain among 50 unseen cards.
   */
  function flopSetProbability() {
    return 1 - nCk(48, 3) / nCk(50, 3);
  }

  /**
   * Geometric equal pot-fraction that puts the effective stack in over `streets`
   * bet-call streets (spec §10.3):  b = ((1 + 2S/P)^(1/n) - 1) / 2.
   * Candidate-sizing generator only.
   */
  function geometricBetFraction(pot, stack, streets) {
    if (pot <= 0 || stack < 0 || streets <= 0) return null;
    return (Math.pow(1 + 2 * stack / pot, 1 / streets) - 1) / 2;
  }

  Poker.DrawOdds = {
    nCk: nCk,
    outsProbability: outsProbability,
    hitOnTurnFromFlop: hitOnTurnFromFlop,
    hitByRiverFromFlop: hitByRiverFromFlop,
    hitOnRiverFromTurn: hitOnRiverFromTurn,
    flopSetProbability: flopSetProbability,
    geometricBetFraction: geometricBetFraction,
  };
})(typeof self !== "undefined" ? self : this);
