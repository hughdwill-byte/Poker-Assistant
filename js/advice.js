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
    var potKnown = pot > 0;
    var stackKnown = stack > 0;

    var potOdds = (toCall > 0 && potKnown) ? toCall / (pot + toCall) : null;
    var evCall = p * pot - (1 - p) * toCall;              // meaningful when the pot is known
    var b = (toCall > 0 && potKnown) ? pot / toCall : Infinity;
    var kelly = toCall > 0 ? (potKnown ? (p * (b + 1) - 1) / b : 2 * p - 1) : (2 * p - 1);

    var reasons = [];
    reasons.push("Your chance to win is " + pct(p) + ".");
    if (!potKnown) reasons.push("Pot size unknown - box the Pot for exact sizing/odds; using your win% for now.");

    // ---- Value-oriented sizing ---------------------------------------------
    // A value bet grows with your edge but stays in the range opponents still
    // call - about half to three-quarters of the pot, never an all-players-fold
    // overbet. Without a known pot, fall back to a modest slice of your stack.
    function betFrac() { return clamp(0.5 + (p - 0.55) * 0.7, 0.5, 0.8); } // 50%..80% of pot
    function sizeBet() {
      var raw;
      if (potKnown) raw = pot * betFrac();
      else if (stackKnown) raw = stack * clamp(0.08 + (p - 0.55) * 0.3, 0.08, 0.25);
      else return 0;
      return roundChips(stackKnown ? Math.min(raw, stack) : raw);
    }
    // A value raise: put in the call plus a pot-fraction on top (a min-raise at
    // least), capped by your stack - big enough to charge them, not a shove.
    function sizeRaise() {
      var extra = potKnown ? betFrac() * (pot + toCall) : toCall * 1.5;
      var target = toCall + Math.max(extra, toCall); // >= a min-raise (double the bet)
      if (stackKnown) target = Math.min(target, stack);
      return roundChips(Math.max(target, toCall + 1));
    }
    function fracOfPot(amt) { return potKnown ? " (~" + Math.round(amt / pot * 100) + "% of the pot)" : ""; }

    var action, amount = 0, headline, verb, tone;

    // ===== No bet to call: check or bet for value ============================
    if (toCall === 0) {
      if (p >= 0.55) {
        amount = sizeBet();
        action = "BET"; tone = "good";
        var allInB = stackKnown && amount >= stack;
        verb = allInB ? "BET ALL-IN " + money(amount) : "BET " + money(amount);
        headline = allInB ? "Bet all-in " + money(amount) : "Bet " + money(amount) + fracOfPot(amount);
        reasons.push("You're the favourite - bet for value to build the pot while they'll still call" +
          fracOfPot(amount) + ".");
        reasons.push("Sized to get paid, not to scare everyone out - bigger edge, bigger bet.");
      } else {
        action = "CHECK"; tone = "neutral"; amount = 0; verb = "CHECK"; headline = "Check";
        reasons.push("Not enough edge to bet for value - check and see the next card for free.");
      }
      return build(action, amount, headline, verb, tone, reasons,
        { equity: p, potOdds: 0, evCall: 0, kelly: kelly, breakEven: 0 });
    }

    // ===== Facing a bet: fold / call / raise ================================
    // Are we a clear enough favourite to raise for value?
    var raiseBar = potKnown ? Math.max(0.58, potOdds + 0.10) : 0.60;
    var behind = potKnown ? (p < potOdds) : (p < 0.30);

    if (potKnown) reasons.push("To call " + money(toCall) + " into " + money(pot) +
      " you need " + pct(potOdds) + " to be break-even.");

    if (behind) {
      action = "FOLD"; tone = "bad"; amount = 0; verb = "FOLD"; headline = "Fold";
      reasons.push(potKnown
        ? "Calling loses chips long-run (" + signed(evCall) + " EV): your win% is below the price."
        : "Your win% is too low to pay this off - fold.");
      return build(action, amount, headline, verb, tone, reasons,
        { equity: p, potOdds: potOdds || 0, evCall: evCall, kelly: kelly, breakEven: potOdds || 0 });
    }

    if (p >= raiseBar && stackKnown && stack > toCall) {
      amount = sizeRaise();
      action = "RAISE"; tone = "good";
      var allInR = amount >= stack;
      verb = allInR ? "RAISE ALL-IN " + money(amount) : "RAISE TO " + money(amount);
      headline = allInR ? "Raise all-in " + money(amount) : "Raise to " + money(amount);
      reasons.push("You're a clear favourite - don't just call, raise for value and charge their draws.");
      if (potKnown) reasons.push("Calling alone is already +" + roundChips(evCall) + " EV; raising wins more.");
      reasons.push("Kelly caps a value raise near " + pct(clamp(kelly, 0, 1)) + " of your stack for best long-run growth.");
      return build(action, amount, headline, verb, tone, reasons,
        { equity: p, potOdds: potOdds || 0, evCall: evCall, kelly: kelly, breakEven: potOdds || 0 });
    }

    action = "CALL"; tone = "neutral";
    amount = stackKnown ? Math.min(toCall, stack) : toCall;
    var allInC = stackKnown && amount >= stack;
    verb = allInC ? "CALL ALL-IN " + money(amount) : "CALL " + money(amount);
    headline = allInC ? "Call all-in " + money(amount) : "Call " + money(amount);
    reasons.push(potKnown
      ? "Calling is +" + roundChips(evCall) + " EV, but you're not enough of a favourite to raise."
      : "Your win% is worth a call, but not a raise.");
    return build(action, amount, headline, verb, tone, reasons,
      { equity: p, potOdds: potOdds || 0, evCall: evCall, kelly: kelly, breakEven: potOdds || 0 });
  }

  function build(action, amount, headline, verb, tone, reasons, stats) {
    return { action: action, amount: amount, headline: headline, verb: verb, tone: tone, reasons: reasons, stats: stats };
  }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }
  function signed(x) { var v = Math.round(x); return (v >= 0 ? "+" : "") + v; }
  function money(x) { return "$" + Math.round(Math.max(0, x)).toLocaleString(); }

  Poker.advise = advise;
})(typeof self !== "undefined" ? self : this);
