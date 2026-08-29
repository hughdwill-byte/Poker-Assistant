/*
 * equity-realization.js - raw vs realized equity (Phase C, Wave 1.6, #1).
 *
 * Raw showdown equity is what the hand wins if the hand always reached showdown.
 * A hand realizes LESS of that out of position, without initiative, or when it
 * can be bet off later; and slightly MORE in position with initiative. This
 * module returns a transparent, BOUNDED realization factor R and an estimated
 * realized equity raw*R.
 *
 * Honesty boundary (the spec explicitly warns against a "magic multiplier"):
 * this is a documented HEURISTIC, not solver-validated, and it is shown ONLY as
 * a reference beside the raw equity. The EV recommendation continues to use raw
 * showdown equity. The preferred exact method is a multi-street action tree
 * (roadmap #8); R is a fast approximation with stated assumptions, and on the
 * river (no streets left) R = 1 exactly - realized equity equals raw.
 *
 * Every effect is monotonic and the result is clamped to [0.80, 1.15], so R can
 * never invent a large edge.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  var R_MIN = 0.80, R_MAX = 1.15;

  function streetsRemaining(street) {
    switch (street) {
      case "river": return 0;
      case "turn": return 1;
      case "flop": return 2;
      case "preflop": return 3;
      default: return 2;
    }
  }

  /**
   * @param {Object} ctx
   *   street       : "preflop"|"flop"|"turn"|"river"
   *   inPosition   : true | false | null (unknown -> neutral)
   *   hasInitiative: true | false | null
   *   spr          : stack-to-pot ratio (deeper -> position/initiative matter more)
   *   draw         : true if the hand is primarily a draw (realizes worse OOP)
   *   madeStrong   : true for a strong made hand (protects better, small OOP tax)
   * @returns {number} realization factor R in [0.80, 1.15]
   */
  function factor(ctx) {
    ctx = ctx || {};
    var left = streetsRemaining(ctx.street);
    if (left <= 0) return 1; // river: equity is realised at showdown
    var streetScale = left / 3;               // more streets left -> more deviation
    var sprFactor = Math.min(1, Math.max(0, (ctx.spr != null ? ctx.spr : 3) / 5)); // deep -> more effect

    var posEff = ctx.inPosition === true ? 0.08 : (ctx.inPosition === false ? -0.08 : 0);
    var initEff = ctx.hasInitiative === true ? 0.05 : (ctx.hasInitiative === false ? -0.04 : 0);
    var drawEff = ctx.draw ? (ctx.inPosition === false ? -0.06 : -0.02) : 0;
    var madeEff = (ctx.madeStrong && ctx.inPosition === false) ? -0.02 : 0;

    var R = 1 + streetScale * sprFactor * (posEff + initEff + drawEff + madeEff);
    return Math.max(R_MIN, Math.min(R_MAX, R));
  }

  /**
   * Realized-equity estimate. Returns raw, R, realized (clamped to [0,1]) and
   * the assumptions behind R so the UI can label it honestly.
   */
  function realizedEquity(rawEquity, ctx) {
    var R = factor(ctx);
    var realized = Math.max(0, Math.min(1, rawEquity * R));
    var assumptions = [];
    if (ctx && ctx.street === "river") assumptions.push("River: equity is realised at showdown (R = 1).");
    else {
      assumptions.push("Heuristic realization factor (not solver-validated); the EV recommendation uses RAW showdown equity.");
      if (ctx && ctx.inPosition === false) assumptions.push("Out of position: realises less of its raw equity.");
      if (ctx && ctx.inPosition === true) assumptions.push("In position: realises a little more.");
      if (ctx && ctx.hasInitiative == null) assumptions.push("Initiative unknown (neutral).");
      if (ctx && ctx.draw) assumptions.push("Drawing hand: can be bet off, so realises less.");
    }
    return { raw: rawEquity, R: R, realized: realized, assumptions: assumptions };
  }

  Poker.EquityRealization = {
    R_MIN: R_MIN, R_MAX: R_MAX,
    streetsRemaining: streetsRemaining,
    factor: factor,
    realizedEquity: realizedEquity,
  };
})(typeof self !== "undefined" ? self : this);
