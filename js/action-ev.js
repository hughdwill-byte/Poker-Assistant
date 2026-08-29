/*
 * action-ev.js - expected value of poker decisions, in chips, relative to the
 * current decision (folding is the zero baseline). All pot arithmetic uses the
 * canonical convention documented in docs/math-specification.md:
 *
 *   P = canonical pot BEFORE the hero adds new chips (includes opponents'
 *       current-street bets, excludes the hero's pending call/raise).
 *   C = hero's additional call cost = max(0, currentBetTo - hero.streetCommitted)
 *   e = hero's expected fractional showdown share (split ties already included)
 *
 *   break-even equity      = C / (P + C)
 *   EV_fold                = 0
 *   EV_call                = e * (P + C) - C
 *
 * For a heads-up open bet of B:
 *   EV_bet = F * P + (1 - F) * (eCalled * (P + 2B) - B)
 * where F = P(villain folds) and eCalled = hero equity GIVEN a call.
 *
 * When an opponent folds, uncalled chips are returned: a fully-folded branch
 * returns the hero the pre-action pot P, never P plus the hero's own new chips.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  /** Break-even equity needed to call C into a pot of P. */
  function breakEvenEquity(P, C) {
    if (C <= 0) return 0;
    return C / (P + C);
  }

  /** EV of calling, relative to folding. e includes tie shares. */
  function evCall(P, C, e) {
    return e * (P + C) - C;
  }

  /**
   * EV of a heads-up open bet B (hero currently unbet, opponent unbet).
   *   F        : probability the opponent folds
   *   eCalled  : hero equity given the opponent calls
   * A fold wins the pre-action pot P; a call plays for P + 2B risking B.
   */
  function evBet(P, B, F, eCalled) {
    F = clamp01(F);
    return F * P + (1 - F) * (eCalled * (P + 2 * B) - B);
  }

  /**
   * General response-branch EV. Weight each branch by its probability.
   * branch = { prob, type: "fold"|"call"|"raise", heroAdditional, oppAdditional, branchEquity }
   *   - "fold": hero wins P plus whatever the opponent already put in this line;
   *     hero's own uncalled aggression is returned, so heroAdditional is 0 here.
   *   - "call"/"raise": showdown for (P + heroAdditional + oppAdditional),
   *     hero risks heroAdditional.
   * Returns the probability-weighted EV relative to folding now.
   */
  function evFromBranches(P, branches) {
    var ev = 0, tp = 0;
    branches.forEach(function (br) {
      var p = Math.max(0, br.prob);
      tp += p;
      if (br.type === "fold") {
        // Hero collects the pot as it stood; uncalled bet returned.
        ev += p * (P + (br.oppAdditional || 0));
      } else {
        var pot = P + (br.heroAdditional || 0) + (br.oppAdditional || 0);
        ev += p * (br.branchEquity * pot - (br.heroAdditional || 0));
      }
    });
    // Normalise if probabilities don't sum to 1 (defensive).
    if (tp > 0 && Math.abs(tp - 1) > 1e-6) ev = ev / tp;
    return ev;
  }

  /**
   * Side-pot-aware expected chips won. For each eligible pot layer the hero can
   * win, add layerAmount * heroShareInLayer. Layers the hero is not eligible for
   * contribute 0. `layers` = [{ amount, eligibleSeats }]; `shareFn(layer)`
   * returns the hero's fractional share of that layer.
   */
  function sidePotExpectation(layers, heroSeat, shareFn) {
    var total = 0;
    layers.forEach(function (layer) {
      if (layer.eligibleSeats.indexOf(heroSeat) === -1) return; // not eligible: 0
      total += layer.amount * clamp01(shareFn(layer));
    });
    return total;
  }

  /**
   * Estimate fold/call/raise probabilities for an opponent facing a bet of size
   * `betFraction` of the pot, by integrating action likelihoods across the
   * opponent's current combo range. Returns { fold, call, raise, calledRange,
   * raisedRange } where the conditioned ranges are normalised. This is the
   * heads-up building block; multiway aggregates per opponent.
   */
  function responseModel(range, ctx) {
    var OM = Poker.OpponentModel, R = Poker.Ranges;
    var foldW = 0, callW = 0, raiseW = 0, total = 0;
    var called = [], raised = [];
    for (var i = 0; i < range.length; i++) {
      var c = range[i];
      var lf = OM.actionLikelihood("fold", c.c1, c.c2, ctx);
      var lc = OM.actionLikelihood("call", c.c1, c.c2, ctx);
      var lr = OM.actionLikelihood("raise", c.c1, c.c2, ctx);
      var sum = lf + lc + lr;
      if (sum <= 0) { lf = 1; sum = 1; }
      var pf = lf / sum, pc = lc / sum, pr = lr / sum;
      foldW += c.weight * pf; callW += c.weight * pc; raiseW += c.weight * pr;
      total += c.weight;
      if (pc > 0) called.push({ c1: c.c1, c2: c.c2, weight: c.weight * pc });
      if (pr > 0) raised.push({ c1: c.c1, c2: c.c2, weight: c.weight * pr });
    }
    if (total <= 0) return { fold: 1, call: 0, raise: 0, calledRange: [], raisedRange: [] };
    return {
      fold: foldW / total,
      call: callW / total,
      raise: raiseW / total,
      calledRange: R.normalise(called),
      raisedRange: R.normalise(raised),
    };
  }

  Poker.ActionEV = {
    breakEvenEquity: breakEvenEquity,
    evCall: evCall,
    evBet: evBet,
    evFromBranches: evFromBranches,
    sidePotExpectation: sidePotExpectation,
    responseModel: responseModel,
    clamp01: clamp01,
  };
})(typeof self !== "undefined" ? self : this);
