/*
 * equilibrium.js - GTO reference layer (Phase C, Wave 0).
 *
 * Deterministic indifference mathematics for no-limit betting: minimum defense
 * frequency, alpha, balanced value:bluff composition, and simple over/under-
 * defense assessments. These are the equilibrium REFERENCE values implied by
 * pot geometry alone (heads-up, one street, no rake, polarised bettor vs
 * bluff-catcher) - the idealized model from the specification (§8.4).
 *
 * IMPORTANT: this is a reference layer. It is surfaced ALONGSIDE the
 * exploitative EV recommendation; it does NOT override the EV engine, the
 * opponent model's fold estimate, or legal-action generation. Wiring an
 * equilibrium solver into live advice (mixed strategies, MDF-driven defense) is
 * a later Wave - see docs/future-math-roadmap.md #5, #6, #7. Everything here is
 * pure and unit-tested against the spec's reference table.
 *
 * Conventions
 * -----------
 * P and B may be given in the same units (chips) or as pot-fractions (pass
 * P = 1 and B = the fraction). Every formula is ratio-invariant. B is the bet
 * size into pot P on the current street.
 *
 * These base formulas mirror the reference helpers in action-ev.js
 * (minDefenseFrequency, idealBluffFraction, breakEvenFoldForBluff); they are
 * consolidated and extended here as the named GTO layer.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function ok(P, B) { return P >= 0 && B > 0 && (P + B) > 0; }

  /**
   * Minimum defense frequency: the fraction of the defender's range that must
   * continue (call or raise) so a pure bluff at size B is not automatically
   * profitable.  MDF = P / (P + B).
   */
  function mdf(P, B) { return ok(P, B) ? P / (P + B) : 1; }

  /**
   * Alpha: the bettor's risk fraction and the defender's maximum fold
   * frequency at indifference.  alpha = B / (P + B) = 1 - MDF.  It is also the
   * fold probability at which a pure bluff of B into P exactly breaks even.
   */
  function alpha(P, B) { return ok(P, B) ? B / (P + B) : 0; }

  /**
   * Balanced bluff fraction OF THE BETTING RANGE on the river: the share of a
   * polarised betting range that should be bluffs so a bluff-catcher is
   * indifferent.  bluffFraction = B / (P + 2B).
   */
  function bluffFractionOfRange(P, B) {
    if (!ok(P, B)) return 0;
    return B / (P + 2 * B);
  }

  /** Value fraction of the betting range = 1 - bluffFraction. */
  function valueFractionOfRange(P, B) { return 1 - bluffFractionOfRange(P, B); }

  /**
   * Value-to-bluff ratio of a balanced betting range at size B: (P + B) : B.
   * Returns the number of value combos per one bluff combo.
   */
  function valueToBluff(P, B) {
    if (!ok(P, B)) return Infinity;
    return (P + B) / B;
  }

  /** Break-even fold probability for a pure bluff of B into P (= alpha). */
  function pureBluffBreakEvenFold(P, B) { return alpha(P, B); }

  /**
   * Required fold frequency for a two-branch aggressive line whose called-branch
   * EV is Vc (< 0) and whose fold branch wins P:  F = -Vc / (P - Vc).
   * (Mirrors action-ev.js requiredFoldFrequency; kept here so the equilibrium
   * layer is self-contained.)
   */
  function requiredFoldFrequency(P, Vc) {
    if (Vc >= 0) return 0;
    return (-Vc) / (P - Vc);
  }

  /**
   * Assess a defender's continue frequency against MDF.
   * @param {number} P pot before the bet
   * @param {number} B bet size
   * @param {number} defendFreq the defender's actual continue frequency [0,1]
   * @returns {Object} { mdf, defend, delta, status, exploitable }
   *   status: "over-folding" (defends < MDF, bluffs print),
   *           "over-defending" (defends > MDF, value prints / bluffs unneeded),
   *           "balanced" (within tolerance).
   */
  function defenseAssessment(P, B, defendFreq, tol) {
    tol = tol == null ? 0.03 : tol;
    var m = mdf(P, B);
    var d = Math.max(0, Math.min(1, defendFreq));
    var delta = d - m;
    var status = Math.abs(delta) <= tol ? "balanced" : (delta < 0 ? "over-folding" : "over-defending");
    return {
      mdf: m,
      defend: d,
      delta: delta,
      status: status,
      // Over-folding is exploitable by more bluffs; over-defending by more value / fewer bluffs.
      exploitable: status !== "balanced",
    };
  }

  /**
   * Balanced betting composition at size B and the MDF the opponent should use
   * facing it. Reference only.
   */
  function bettingComposition(P, B) {
    return {
      bluffFraction: bluffFractionOfRange(P, B),
      valueFraction: valueFractionOfRange(P, B),
      valueToBluff: valueToBluff(P, B),
      opponentMdf: mdf(P, B),
      alpha: alpha(P, B),
    };
  }

  /**
   * One convenience bundle of the pot-geometry references for a bet of B into P.
   */
  function reference(P, B) {
    return {
      pot: P,
      bet: B,
      betFractionOfPot: P > 0 ? B / P : null,
      mdf: mdf(P, B),
      alpha: alpha(P, B),
      bluffFractionOfRange: bluffFractionOfRange(P, B),
      valueToBluff: valueToBluff(P, B),
      // The break-even equity a bluff-catcher needs to call (pot odds): B / (P + 2B)?
      // No - facing a bet B, the caller risks B to win P + B, so needs
      // B / (P + 2B). This equals the balanced bluff fraction, the classic
      // indifference identity.
      callBreakEvenEquity: bluffFractionOfRange(P, B),
    };
  }

  Poker.Equilibrium = {
    mdf: mdf,
    alpha: alpha,
    bluffFractionOfRange: bluffFractionOfRange,
    valueFractionOfRange: valueFractionOfRange,
    valueToBluff: valueToBluff,
    pureBluffBreakEvenFold: pureBluffBreakEvenFold,
    requiredFoldFrequency: requiredFoldFrequency,
    defenseAssessment: defenseAssessment,
    bettingComposition: bettingComposition,
    reference: reference,
  };
})(typeof self !== "undefined" ? self : this);
