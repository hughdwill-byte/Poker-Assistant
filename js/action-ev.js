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

  // ---- Rake ----------------------------------------------------------------
  // Pure cash-game rake: min(pot * rakePercent, rakeCap). Rake is charged to a
  // pot only when it is actually WON at showdown - never to uncalled chips that
  // are returned, and never in play-money or tournament modes. `rakeCtx` is
  // optional everywhere; omitting it (or passing a non-cash mode) leaves every
  // EV identical to the un-raked formula, so existing callers are unaffected.
  //   rakeCtx = { rakePercent, rakeCap, mode }
  function rake(pot, rakeCtx) {
    if (!rakeCtx || pot <= 0) return 0;
    if (rakeCtx.mode && rakeCtx.mode !== "cash") return 0; // no rake off play-money/tournament
    var pct = rakeCtx.rakePercent || 0;
    if (pct <= 0) return 0;
    var raw = pot * pct;
    var cap = rakeCtx.rakeCap;
    if (cap != null && cap > 0) raw = Math.min(raw, cap);
    return Math.max(0, raw);
  }

  /** Break-even equity needed to call C into a pot of P. */
  function breakEvenEquity(P, C) {
    if (C <= 0) return 0;
    return C / (P + C);
  }

  /**
   * EV of calling, relative to folding. e includes tie shares. With a rake
   * context the pot won at showdown is reduced by e * rake(P + C) (rake is only
   * paid on the fraction of the pot the hero actually collects).
   */
  function evCall(P, C, e, rakeCtx) {
    return e * (P + C) - C - e * rake(P + C, rakeCtx);
  }

  /**
   * EV of a heads-up open bet B (hero currently unbet, opponent unbet).
   *   F        : probability the opponent folds
   *   eCalled  : hero equity given the opponent calls
   * A fold wins the pre-action pot P with NO rake (uncalled, no showdown); a
   * call plays for P + 2B at showdown, where rake is charged on the pot the
   * hero wins.
   */
  function evBet(P, B, F, eCalled, rakeCtx) {
    F = clamp01(F);
    var showdownPot = P + 2 * B;
    var calledBranch = eCalled * showdownPot - B - eCalled * rake(showdownPot, rakeCtx);
    return F * P + (1 - F) * calledBranch;
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
  function evFromBranches(P, branches, rakeCtx) {
    var ev = 0, tp = 0;
    branches.forEach(function (br) {
      var p = Math.max(0, br.prob);
      tp += p;
      if (br.type === "fold") {
        // Hero collects the pot as it stood; uncalled bet returned; NO rake
        // (the pot was not contested to showdown).
        ev += p * (P + (br.oppAdditional || 0));
      } else {
        // Contested to showdown: rake is charged on the pot the hero wins.
        var pot = P + (br.heroAdditional || 0) + (br.oppAdditional || 0);
        ev += p * (br.branchEquity * pot - (br.heroAdditional || 0) - br.branchEquity * rake(pot, rakeCtx));
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

  // ---- Idealized fold-frequency reference values (spec §8) ------------------
  // These are DETERMINISTIC reference formulas, exposed for explanation and
  // testing only. They are NOT wired in to replace the opponent-model fold
  // estimate (that MDF-driven replacement is a documented, deferred item - see
  // docs/future-math-roadmap.md).

  /** Break-even fold probability for a pure bluff of B into P: B / (P + B). */
  function breakEvenFoldForBluff(P, B) {
    if (P + B <= 0) return 0;
    return B / (P + B);
  }

  /**
   * Required fold frequency for any two-branch aggression whose called-branch
   * EV is Vc (< 0) and whose fold branch wins P:  F = -Vc / (P - Vc).
   * The 4-bet reference: P = 15, Vc = -26.6 -> 26.6 / 41.6 = 0.639423.
   */
  function requiredFoldFrequency(P, Vc) {
    if (Vc >= 0) return 0; // already profitable when called
    return (-Vc) / (P - Vc);
  }

  /** Minimum defense frequency vs a bet B into pot P (idealized): P / (P + B). */
  function minDefenseFrequency(P, B) {
    if (P + B <= 0) return 0;
    return P / (P + B);
  }

  /** Idealized balanced bluff fraction of the betting range: B / (P + 2B). */
  function idealBluffFraction(P, B) {
    if (P + 2 * B <= 0) return 0;
    return B / (P + 2 * B);
  }

  Poker.ActionEV = {
    rake: rake,
    breakEvenEquity: breakEvenEquity,
    evCall: evCall,
    evBet: evBet,
    evFromBranches: evFromBranches,
    sidePotExpectation: sidePotExpectation,
    responseModel: responseModel,
    breakEvenFoldForBluff: breakEvenFoldForBluff,
    requiredFoldFrequency: requiredFoldFrequency,
    minDefenseFrequency: minDefenseFrequency,
    idealBluffFraction: idealBluffFraction,
    clamp01: clamp01,
  };
})(typeof self !== "undefined" ? self : this);
