/*
 * advice.js - turn equity into a betting recommendation.
 *
 * All numbers shown to the player are derived here so the maths is auditable.
 *
 * Definitions (chips):
 *   pot     : chips already in the middle (before your action)
 *   toCall  : chips you must put in to call the current bet (0 if you can check)
 *   stack   : your remaining chips
 *   p       : your equity - probability of winning the pot, ties counted as
 *             their fractional share (this is exactly what the simulator returns)
 *
 * Pot odds: to call you risk `toCall` to win `pot`, so you need
 *   p >= toCall / (pot + toCall)          (the break-even equity)
 *
 * EV of calling (assuming no further betting) in chips:
 *   EV = p * pot - (1 - p) * toCall
 *
 * Kelly criterion (bankroll-growth optimal fraction of stack to commit):
 *   with net odds b = pot / toCall,   f* = p - (1 - p) / b = (p(b+1) - 1)/b
 * Kelly answers "bet to maximise long-run winnings", which is what the
 * request asks for. We size value bets/raises toward the Kelly fraction,
 * always capped by the stack.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function roundChips(x) { return Math.max(0, Math.round(x)); }

  /**
   * @param {Object} cfg { equity, pot, toCall, stack, minBet }
   * @returns {Object} recommendation
   */
  function advise(cfg) {
    var p = clamp(cfg.equity, 0, 1);
    var pot = Math.max(0, cfg.pot || 0);
    var toCall = Math.max(0, cfg.toCall || 0);
    var stack = Math.max(0, cfg.stack || 0);
    var minBet = Math.max(1, cfg.minBet || Math.max(1, Math.round(pot * 0.5)) || 1);

    var potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    var evCall = p * pot - (1 - p) * toCall;
    var b = toCall > 0 ? pot / toCall : Infinity;
    var kelly = toCall > 0 ? (p * (b + 1) - 1) / b : (2 * p - 1); // fraction of stack

    var action, amount = 0, headline, tone, reasons = [];

    reasons.push("Your equity is " + pct(p) + ".");

    if (toCall === 0) {
      // We can check for free. Decide whether to bet for value / protection.
      reasons.push("No bet to call - checking is free.");
      var valueThreshold = 0.55;
      if (p >= valueThreshold) {
        // Size the value bet: from half-pot at the threshold up to pot-sized
        // when we are a big favourite, capped by the stack.
        var frac = clamp(0.5 + (p - valueThreshold) / (1 - valueThreshold) * 0.75, 0.5, 1.25);
        amount = roundChips(clamp(pot > 0 ? pot * frac : minBet, minBet, stack));
        action = "BET";
        tone = "good";
        headline = "Bet " + amount + " for value";
        reasons.push("You are a favourite, so bet to build the pot. Suggested size ~" +
          Math.round(frac * 100) + "% of the pot.");
        if (amount >= stack) reasons.push("This commits your whole stack (all-in).");
      } else {
        action = "CHECK";
        tone = "neutral";
        amount = 0;
        headline = "Check";
        reasons.push("Not enough of an edge to bet - take the free card.");
      }
      return build(action, amount, headline, tone, reasons, {
        equity: p, potOdds: potOdds, evCall: evCall, kelly: kelly, breakEven: potOdds,
      });
    }

    // There is a bet to call.
    reasons.push("Pot odds require at least " + pct(potOdds) + " equity to call.");

    if (p < potOdds) {
      action = "FOLD";
      tone = "bad";
      amount = 0;
      headline = "Fold";
      reasons.push("Calling is -EV (" + signed(evCall) + " chips): your equity is below the pot odds.");
      return build(action, amount, headline, tone, reasons, {
        equity: p, potOdds: potOdds, evCall: evCall, kelly: kelly, breakEven: potOdds,
      });
    }

    // Calling is at least break-even. Raise when we are a clear favourite.
    var raiseThreshold = Math.max(0.58, potOdds + 0.12);
    if (p >= raiseThreshold && stack > toCall) {
      // Target committing the Kelly fraction of the stack; translate into a
      // raise-to amount, bounded by a pot-sized raise and the stack.
      var targetCommit = clamp(kelly, 0, 1) * stack;
      var potRaise = toCall + (pot + toCall); // classic pot-sized raise
      var raiseTo = clamp(Math.max(targetCommit, toCall * 2, potRaise * 0.6),
                          toCall + minBet, stack);
      amount = roundChips(raiseTo);
      action = "RAISE";
      tone = "good";
      headline = "Raise to " + amount;
      reasons.push("You are a clear favourite - raise for value (+" +
        roundChips(evCall) + " chips just by calling, more by raising).");
      reasons.push("Kelly suggests committing up to " + pct(clamp(kelly, 0, 1)) +
        " of your stack for maximum long-run growth.");
      if (amount >= stack) reasons.push("This is effectively all-in.");
      return build(action, amount, headline, tone, reasons, {
        equity: p, potOdds: potOdds, evCall: evCall, kelly: kelly, breakEven: potOdds,
      });
    }

    action = "CALL";
    tone = "neutral";
    amount = Math.min(toCall, stack);
    headline = amount >= stack ? "Call all-in (" + amount + ")" : "Call " + amount;
    reasons.push("Calling is +EV (" + signed(evCall) + " chips) but you are not a big enough favourite to raise.");
    return build(action, amount, headline, tone, reasons, {
      equity: p, potOdds: potOdds, evCall: evCall, kelly: kelly, breakEven: potOdds,
    });
  }

  function build(action, amount, headline, tone, reasons, stats) {
    return { action: action, amount: amount, headline: headline, tone: tone, reasons: reasons, stats: stats };
  }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }
  function signed(x) { var v = Math.round(x); return (v >= 0 ? "+" : "") + v; }

  Poker.advise = advise;
})(typeof self !== "undefined" ? self : this);
