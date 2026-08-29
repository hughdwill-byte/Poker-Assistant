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

    // Pick bluffs from the LOWEST-equity air upward until the target is met.
    var airAsc = rest.filter(function (c) { return c.equity <= bluffMaxEquity; })
      .sort(function (a, b) { return a.equity - b.equity; });
    var bluff = [], acc = 0;
    for (var i = 0; i < airAsc.length && acc < targetBluffWeight - 1e-12; i++) {
      // Take the whole combo; if it would overshoot a lot we still take it (a
      // combo is atomic here) - the actual fraction is reported for honesty.
      bluff.push(airAsc[i]); acc += airAsc[i].weight;
    }
    var bluffKeys = {}; bluff.forEach(function (c) { bluffKeys[keyOf(c)] = true; });

    // Everything not value and not chosen as bluff -> check.
    var check = [];
    rest.forEach(function (c) { if (!bluffKeys[keyOf(c)]) check.push(c); });

    var bluffWeight = sumW(bluff), checkWeight = sumW(check);
    var betWeight = valueWeight + bluffWeight;
    var totalWeight = valueWeight + bluffWeight + checkWeight;

    // Where does the hero's actual hand play?
    var heroRole = null;
    if (cfg.heroActual && cfg.heroActual.length === 2 && cfg.heroActual[0] != null && cfg.heroActual[1] != null) {
      var hk = Math.min(cfg.heroActual[0], cfg.heroActual[1]) + "_" + Math.max(cfg.heroActual[0], cfg.heroActual[1]);
      var inList = function (list) { for (var j = 0; j < list.length; j++) if (keyOf(list[j]) === hk) return true; return false; };
      if (inList(value)) heroRole = "value";
      else if (inList(bluff)) heroRole = "bluff";
      else if (inList(check)) heroRole = "check";
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
      P: P, B: B,
    };
  }

  Poker.BetComposition = { plan: plan };
})(typeof self !== "undefined" ? self : this);
