/*
 * gto-defense.js - equilibrium defense verdict (Phase C, Wave 1.5, #5).
 *
 * This is the first place the equilibrium layer produces an ACTION for the hero
 * rather than just a reference number. Facing a bet, minimum-defense-frequency
 * (MDF) says a defender must continue with the top P/(P+B) of their range so a
 * pure bluff is not automatically profitable. Given where the hero's actual
 * hand ranks within the hero range (its percentile from range-vs-range), this
 * yields a DEFEND / FOLD verdict at equilibrium.
 *
 * It is presented as a labelled equilibrium verdict ALONGSIDE the exploitative
 * EV recommendation - not a silent override. When the two disagree that is
 * expected and informative: MDF assumes a balanced bettor, while the EV line
 * exploits an unbalanced one. Both are shown; `reconcile()` explains the gap.
 *
 * Notation: P = pot before the hero's call (includes the villain's bet), C =
 * the call. The villain bet C into a pot of (P − C), so the defender's MDF is
 * (P − C)/P and the hero must be in the top MDF fraction of its range to defend.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  /**
   * @param {Object} cfg { P, C, heroPercentile }  heroPercentile in [0,1] is the
   *        fraction of the hero range weaker than the hero's actual hand.
   * @returns {Object|null} verdict, or null when not facing a bet.
   */
  function defenseVerdict(cfg) {
    var P = cfg.P, C = cfg.C, pct = cfg.heroPercentile;
    if (!(C > 0) || !(P > 0) || pct == null) return null;
    var potBeforeBet = Math.max(0, P - C);
    var mdf = potBeforeBet + C > 0 ? potBeforeBet / (potBeforeBet + C) : 1; // (P−C)/P
    // Defend the top MDF fraction of the range: percentile ≥ 1 − MDF.
    var thresholdPercentile = 1 - mdf;
    var p = clamp01(pct);
    var defend = p >= thresholdPercentile - 1e-9;
    return {
      mdf: mdf,
      alpha: 1 - mdf,
      thresholdPercentile: thresholdPercentile,
      heroPercentile: p,
      verdict: defend ? "defend" : "fold",
      // How far the hand is above (+) or below (−) the defend cutoff, in range %.
      margin: p - thresholdPercentile,
      betFractionOfPot: potBeforeBet > 0 ? C / potBeforeBet : null,
    };
  }

  /**
   * Reconcile the equilibrium verdict with the exploitative EV action.
   * @param {Object} gto  result of defenseVerdict
   * @param {string} evAction  "FOLD" | "CALL" | "RAISE" | ...
   * @returns {Object} { agree, note }
   */
  function reconcile(gto, evAction) {
    if (!gto || !evAction) return { agree: null, note: "" };
    var evDefends = /CALL|RAISE|BET|CHECK/i.test(evAction);
    var gtoDefends = gto.verdict === "defend";
    if (evDefends === gtoDefends) {
      return { agree: true, note: "Exploitative EV and the equilibrium (MDF) verdict agree." };
    }
    if (gtoDefends && !evDefends) {
      return { agree: false, note: "MDF would defend this hand, but the EV line folds - it reads the opponent as under-bluffing (over-folding to a bet is only correct if they rarely bluff)." };
    }
    return { agree: false, note: "MDF would fold this hand, but the EV line continues - it reads the opponent as over-bluffing or the price as good enough to exploit." };
  }

  Poker.GtoDefense = { defenseVerdict: defenseVerdict, reconcile: reconcile };
})(typeof self !== "undefined" ? self : this);
