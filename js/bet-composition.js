/*
 * bet-composition.js - polarised bet-range construction (Phase C, Wave 1.2, #7).
 *
 * Given the hero's range as combos with their equity vs the opponent's range on
 * a board, partition it into VALUE bets, BLUFFs and CHECKs for a chosen bet size
 * so the betting range is balanced: on the river a polarised range at size B
 * into pot P should be value:bluff = (P + B) : B, i.e. bluffs are B/(P+B) of the
 * value weight and B/(P+2B) of the whole betting range (the equilibrium ratios
 * in equilibrium.js / spec §8.4).
 *
 * Value hands are the strongest combos (equity above a threshold - ahead of a
 * calling range); bluffs are chosen from the LOWEST-equity air up to the
 * balanced count; the medium combos check (bluff-catchers / thin showdown value
 * that does not want to bet or fold). Blocker-aware bluff selection among the
 * air candidates is a later step (#15).
 *
 * This is a balanced-range (GTO-approximation) plan surfaced ALONGSIDE the EV
 * recommendation; it is cheap (a sort + partition over combos, no simulation)
 * and pure.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function sumW(list) { var t = 0; for (var i = 0; i < list.length; i++) t += list[i].weight; return t; }
  function keyOf(c) { return Math.min(c.c1, c.c2) + "_" + Math.max(c.c1, c.c2); }

  /**
   * Blocker score of a candidate hand {a,b} against the opponent's range
   * (Wave 1.3, #15). A good BLUFF blocks the opponent's value/continuing combos
   * (so they hold fewer calls) and does NOT block their folding combos (so it
   * removes fewer folds). Each opponent combo that uses card a or b adds its
   * weight when it is a continue (equity ≥ contThreshold) and subtracts its
   * weight when it is a fold (equity ≤ foldThreshold). A higher score = a better
   * blocker bluff.
   *
   * @param {number} a,b hero candidate's two cards
   * @param {Array} oppCombos [{c1,c2,weight,equity}] opponent range with equities
   * @param {Object} [opts] { contThreshold=0.5, foldThreshold=0.35 }
   */
  function blockerScore(a, b, oppCombos, opts) {
    if (!oppCombos || !oppCombos.length) return 0;
    opts = opts || {};
    var cont = opts.contThreshold != null ? opts.contThreshold : 0.5;
    var fold = opts.foldThreshold != null ? opts.foldThreshold : 0.35;
    var score = 0;
    for (var i = 0; i < oppCombos.length; i++) {
      var oc = oppCombos[i];
      if (oc.c1 === a || oc.c2 === a || oc.c1 === b || oc.c2 === b) {
        if (oc.equity >= cont) score += oc.weight;
        else if (oc.equity <= fold) score -= oc.weight;
      }
    }
    return score;
  }

  /**
   * @param {Object} cfg
   *   combos        : [{ c1, c2, weight, equity }]  hero range with equities
   *   P, B          : pot before the bet, and the bet size (same units)
   *   valueThreshold: equity at/above which a combo is a value bet (default 0.55)
   *   bluffMaxEquity: max equity a combo may have to be a bluff candidate (0.35)
   *   heroActual    : [c1,c2] to report the hero hand's role
   * @returns {Object} partition + balance diagnostics
   */
  function plan(cfg) {
    var combos = (cfg.combos || []).slice();
    var P = Math.max(0, cfg.P || 0), B = Math.max(0, cfg.B || 0);
    var valueThreshold = cfg.valueThreshold != null ? cfg.valueThreshold : 0.55;
    var bluffMaxEquity = cfg.bluffMaxEquity != null ? cfg.bluffMaxEquity : 0.35;
    if (!combos.length || B <= 0) {
      return { ok: false, error: "Need combos with equities and a positive bet size." };
    }

    // Strongest first for value, weakest first for bluff selection.
    combos.sort(function (a, b) { return b.equity - a.equity; });

    var value = [], rest = [];
    combos.forEach(function (c) { (c.equity >= valueThreshold ? value : rest).push(c); });
    var valueWeight = sumW(value);

    // Balanced bluff weight from the value:bluff ratio (P+B):B -> bluff/value = B/(P+B).
    var targetBluffWeight = valueWeight * (B / (P + B));

    // Air candidates (low showdown value) are the bluff pool.
    var air = rest.filter(function (c) { return c.equity <= bluffMaxEquity; });
    var blockerAware = !!(cfg.opponentCombos && cfg.opponentCombos.length);
    if (blockerAware) {
      // Prefer air that BLOCKS the opponent's value and unblocks their folds
      // (#15); break ties toward the lowest showdown equity.
      air.forEach(function (c) { c._bs = blockerScore(c.c1, c.c2, cfg.opponentCombos, cfg); });
      air.sort(function (a, b) { return (b._bs - a._bs) || (a.equity - b.equity); });
    } else {
      // No opponent range given: pick the lowest-equity air.
      air.sort(function (a, b) { return a.equity - b.equity; });
    }
    var bluff = [], acc = 0;
    for (var i = 0; i < air.length && acc < targetBluffWeight - 1e-12; i++) {
      // A combo is atomic; the actual fraction achieved is reported for honesty.
      bluff.push(air[i]); acc += air[i].weight;
    }
    var bluffKeys = {}; bluff.forEach(function (c) { bluffKeys[keyOf(c)] = true; });

    // Everything not value and not chosen as bluff -> check.
    var check = [];
    rest.forEach(function (c) { if (!bluffKeys[keyOf(c)]) check.push(c); });

    var bluffWeight = sumW(bluff), checkWeight = sumW(check);
    var betWeight = valueWeight + bluffWeight;
    var totalWeight = valueWeight + bluffWeight + checkWeight;

    var airWeight = sumW(air);

    // Where does the hero's actual hand play, and at what FREQUENCY (#6)?
    // A value hand bets every time. Air is a mixed bluff: when there is more air
    // than the balance needs, each air combo bluffs at the indifference
    // frequency targetBluffWeight / airWeight and checks the rest of the time
    // (blocker-preferred air sits at the higher end of that mix). Medium hands
    // with showdown value check (or bluff-catch).
    var heroRole = null, heroMix = null;
    if (cfg.heroActual && cfg.heroActual.length === 2 && cfg.heroActual[0] != null && cfg.heroActual[1] != null) {
      var hk = Math.min(cfg.heroActual[0], cfg.heroActual[1]) + "_" + Math.max(cfg.heroActual[0], cfg.heroActual[1]);
      var inList = function (list) { for (var j = 0; j < list.length; j++) if (keyOf(list[j]) === hk) return true; return false; };
      var heroEq = null;
      for (var m = 0; m < combos.length; m++) { if (keyOf(combos[m]) === hk) { heroEq = combos[m].equity; break; } }
      if (inList(value)) heroRole = "value";
      else if (inList(bluff)) heroRole = "bluff";
      else if (inList(check)) heroRole = "check";
      if (heroRole === "value") {
        heroMix = { kind: "value", betFreq: 1, checkFreq: 0 };
      } else if (heroRole && heroEq != null && heroEq <= bluffMaxEquity) {
        var f = airWeight > 0 ? Math.min(1, targetBluffWeight / airWeight) : 0;
        heroMix = { kind: "bluff", betFreq: f, checkFreq: 1 - f };
      } else if (heroRole) {
        heroMix = { kind: "showdown", betFreq: 0, checkFreq: 1 };
      }
    }

    var EQ = Poker.Equilibrium;
    return {
      ok: true,
      value: value, bluff: bluff, check: check,
      valueWeight: valueWeight, bluffWeight: bluffWeight, checkWeight: checkWeight,
      betRangeWeight: betWeight,
      betFractionOfRange: totalWeight > 0 ? betWeight / totalWeight : 0,
      // Targets (equilibrium) vs what the range can actually supply.
      targetBluffToValue: B / (P + B),
      targetBluffFractionOfBets: EQ ? EQ.bluffFractionOfRange(P, B) : B / (P + 2 * B),
      actualBluffFractionOfBets: betWeight > 0 ? bluffWeight / betWeight : 0,
      bluffShortfall: Math.max(0, targetBluffWeight - bluffWeight), // not enough air to balance
      valueToBluff: bluffWeight > 0 ? valueWeight / bluffWeight : Infinity,
      heroRole: heroRole,
      heroMix: heroMix,
      airWeight: airWeight,
      targetBluffWeight: targetBluffWeight,
      blockerAware: blockerAware,
      P: P, B: B,
    };
  }

  Poker.BetComposition = { plan: plan, blockerScore: blockerScore };
})(typeof self !== "undefined" ? self : this);
