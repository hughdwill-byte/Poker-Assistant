/*
 * ranges.js - one-deck weighted combination ranges for Texas Hold'em.
 *
 * A range is a list of weighted exact two-card combinations:
 *     [{ c1: cardId, c2: cardId, weight: number }, ...]
 * with c1 < c2 (canonical order) and weight >= 0. For a single deck there are
 * exactly C(52,2) = 1,326 combinations.
 *
 * Notation (documented in docs/opponent-model.md):
 *   AA            a pocket-pair class          (6 combos)
 *   AKs           a suited class               (4 combos)
 *   AKo           an offsuit class             (12 combos)
 *   AK            both suited and offsuit       (16 combos)
 *   QQ+           QQ, KK, AA
 *   22-66         22,33,44,55,66
 *   AJs+          AJs, AQs, AKs
 *   KQo           a single offsuit class
 *   AKs:0.5       a weighted entry (weight 0.5)
 * Tokens are comma- or whitespace-separated. Invalid or ambiguous tokens are
 * rejected with an explicit error rather than silently ignored.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  var makeId = Poker.makeId, rankOf = Poker.rankOf, suitOf = Poker.suitOf;

  var RANK_ORDER = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  var RANK_CHAR = { 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "T", 11: "J", 12: "Q", 13: "K", 14: "A" };
  var CHAR_RANK = {};
  Object.keys(RANK_CHAR).forEach(function (r) { CHAR_RANK[RANK_CHAR[r]] = +r; });
  CHAR_RANK["10"] = 10;

  // ---- Combination enumeration ---------------------------------------------

  var ALL_COMBOS = null; // cached [{c1,c2}] for a single deck, canonical order

  function allCombos() {
    if (ALL_COMBOS) return ALL_COMBOS;
    var deck = Poker.FULL_DECK.slice().sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < deck.length; i++) {
      for (var j = i + 1; j < deck.length; j++) {
        out.push({ c1: deck[i], c2: deck[j] });
      }
    }
    ALL_COMBOS = out;
    return out;
  }

  /** A fresh full uniform range: all 1,326 combos, weight 1. */
  function fullRange() {
    return allCombos().map(function (c) { return { c1: c.c1, c2: c.c2, weight: 1 }; });
  }

  function canonCombo(a, b) {
    return a < b ? { c1: a, c2: b, weight: 1 } : { c1: b, c2: a, weight: 1 };
  }

  function clone(range) {
    return range.map(function (c) { return { c1: c.c1, c2: c.c2, weight: c.weight }; });
  }

  // ---- 169-class helpers ----------------------------------------------------

  /** Class key for a combo, e.g. "AA", "AKs", "AKo". */
  function comboClass(c1, c2) {
    var r1 = rankOf(c1), s1 = suitOf(c1), r2 = rankOf(c2), s2 = suitOf(c2);
    var hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    if (hi === lo) return RANK_CHAR[hi] + RANK_CHAR[lo];
    var suited = s1 === s2;
    return RANK_CHAR[hi] + RANK_CHAR[lo] + (suited ? "s" : "o");
  }

  /** All combos belonging to a 169-class token like "AA","AKs","AKo","AK". */
  function combosForClass(hiRank, loRank, suitedness) {
    // suitedness: "s" | "o" | "any"
    var out = [];
    if (hiRank === loRank) {
      // Pocket pair: choose 2 of the 4 suits.
      for (var a = 0; a < 4; a++) for (var b = a + 1; b < 4; b++) {
        out.push(canonCombo(makeId(hiRank, a), makeId(loRank, b)));
      }
      return out;
    }
    for (var sh = 0; sh < 4; sh++) {
      for (var sl = 0; sl < 4; sl++) {
        var suited = sh === sl;
        if (suitedness === "s" && !suited) continue;
        if (suitedness === "o" && suited) continue;
        out.push(canonCombo(makeId(hiRank, sh), makeId(loRank, sl)));
      }
    }
    return out;
  }

  // ---- Notation parser ------------------------------------------------------

  function parseRankPair(token) {
    // token like "AK", "T9", "A5" -> [hi, lo] ranks or null.
    var chars = token.toUpperCase().replace("10", "T").split("");
    if (chars.length !== 2) return null;
    var r1 = CHAR_RANK[chars[0]], r2 = CHAR_RANK[chars[1]];
    if (!r1 || !r2) return null;
    return [Math.max(r1, r2), Math.min(r1, r2)];
  }

  /**
   * Parse a single range token into combos, or throw. Handles weights (":w"),
   * plus-notation ("QQ+","AJs+") and dash-ranges ("22-66","AQs-ATs").
   */
  function parseToken(token) {
    token = token.trim();
    if (!token) return [];
    var weight = 1;
    var wi = token.indexOf(":");
    if (wi >= 0) {
      weight = parseFloat(token.slice(wi + 1));
      if (!isFinite(weight) || weight < 0) throw new Error("Bad weight in '" + token + "'");
      token = token.slice(0, wi).trim();
    }

    var combos = [];
    var hasPlus = /\+$/.test(token);
    var body = token.replace(/\+$/, "");

    // Dash range, e.g. 22-66, AQs-ATs, KQo-K9o.
    if (body.indexOf("-") >= 0 && !hasPlus) {
      combos = parseDashRange(body);
    } else if (hasPlus) {
      combos = parsePlusRange(body);
    } else {
      combos = parseSingle(body);
    }
    combos.forEach(function (c) { c.weight = weight; });
    return combos;
  }

  function classify(body) {
    // Returns { hi, lo, suitedness } or throws.
    var suitedness = "any";
    var core = body;
    var suff = body.slice(-1).toLowerCase();
    if (suff === "s" || suff === "o") { suitedness = suff; core = body.slice(0, -1); }
    var pair = parseRankPair(core);
    if (!pair) throw new Error("Unrecognised hand '" + body + "'");
    if (pair[0] === pair[1] && suitedness !== "any") {
      throw new Error("A pocket pair cannot be suited/offsuit: '" + body + "'");
    }
    return { hi: pair[0], lo: pair[1], suitedness: suitedness };
  }

  function parseSingle(body) {
    var c = classify(body);
    return combosForClass(c.hi, c.lo, c.suitedness);
  }

  function parsePlusRange(body) {
    var c = classify(body);
    var out = [];
    if (c.hi === c.lo) {
      // Pocket pairs from this rank up to AA: e.g. QQ+ = QQ,KK,AA.
      for (var r = c.hi; r <= 14; r++) out = out.concat(combosForClass(r, r, "any"));
    } else {
      // Same high card, kicker from lo up to hi-1: AJs+ = AJs,AQs,AKs.
      for (var k = c.lo; k < c.hi; k++) out = out.concat(combosForClass(c.hi, k, c.suitedness));
    }
    return out;
  }

  function parseDashRange(body) {
    var parts = body.split("-");
    if (parts.length !== 2) throw new Error("Bad range '" + body + "'");
    var a = classify(parts[0]), b = classify(parts[1]);
    var out = [];
    if (a.hi === a.lo && b.hi === b.lo) {
      var lo = Math.min(a.hi, b.hi), hi = Math.max(a.hi, b.hi);
      for (var r = lo; r <= hi; r++) out = out.concat(combosForClass(r, r, "any"));
      return out;
    }
    if (a.hi === b.hi && a.suitedness === b.suitedness) {
      var loK = Math.min(a.lo, b.lo), hiK = Math.max(a.lo, b.lo);
      for (var k = loK; k <= hiK; k++) out = out.concat(combosForClass(a.hi, k, a.suitedness));
      return out;
    }
    throw new Error("Unsupported dash range '" + body + "'");
  }

  /**
   * Parse a full range string. Later tokens override earlier weights for the
   * same combo. Returns { ok, range, error }.
   */
  function parse(text) {
    if (!text || !text.trim()) return { ok: true, range: [] };
    var tokens = text.split(/[\s,]+/).filter(Boolean);
    var byKey = {};
    try {
      tokens.forEach(function (tok) {
        parseToken(tok).forEach(function (c) {
          byKey[c.c1 + "_" + c.c2] = c;
        });
      });
    } catch (e) {
      return { ok: false, error: e.message, range: [] };
    }
    var range = Object.keys(byKey).map(function (k) { return byKey[k]; });
    return { ok: true, range: range };
  }

  // ---- Blockers, set ops, normalisation ------------------------------------

  /** Remove every combo that uses any blocked card id. Returns a new range. */
  function removeBlockers(range, blocked) {
    if (!blocked || !blocked.length) return clone(range);
    var set = {};
    blocked.forEach(function (id) { if (id != null) set[id] = true; });
    return range.filter(function (c) { return !set[c.c1] && !set[c.c2]; })
      .map(function (c) { return { c1: c.c1, c2: c.c2, weight: c.weight }; });
  }

  function key(c) { return c.c1 + "_" + c.c2; }

  /** Intersection: keep combos in both, weights multiplied. */
  function intersect(a, b) {
    var mb = {};
    b.forEach(function (c) { mb[key(c)] = c.weight; });
    var out = [];
    a.forEach(function (c) {
      if (mb[key(c)] != null) out.push({ c1: c.c1, c2: c.c2, weight: c.weight * mb[key(c)] });
    });
    return out;
  }

  /** Union: combos in either, weights added (capped is caller's choice). */
  function union(a, b) {
    var m = {};
    a.forEach(function (c) { m[key(c)] = { c1: c.c1, c2: c.c2, weight: c.weight }; });
    b.forEach(function (c) {
      var k = key(c);
      if (m[k]) m[k].weight += c.weight; else m[k] = { c1: c.c1, c2: c.c2, weight: c.weight };
    });
    return Object.keys(m).map(function (k) { return m[k]; });
  }

  /** Total weight of a range. */
  function totalWeight(range) {
    var t = 0;
    for (var i = 0; i < range.length; i++) t += range[i].weight;
    return t;
  }

  /** Normalise weights to sum to 1. Returns a new range (empty stays empty). */
  function normalise(range) {
    var total = totalWeight(range);
    if (total <= 0) return [];
    return range.map(function (c) { return { c1: c.c1, c2: c.c2, weight: c.weight / total }; });
  }

  // ---- Weighted sampling ----------------------------------------------------

  /**
   * Build a cumulative-weight sampler over a range. `rng` returns [0,1).
   * Returns a function that yields a combo, or null if the range is empty.
   */
  function makeSampler(range) {
    var cum = [], total = 0;
    for (var i = 0; i < range.length; i++) {
      total += Math.max(0, range[i].weight);
      cum.push(total);
    }
    return function (rng) {
      if (total <= 0 || !range.length) return null;
      var x = rng() * total;
      // Binary search for the first cumulative weight > x.
      var lo = 0, hi = cum.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cum[mid] <= x) lo = mid + 1; else hi = mid;
      }
      return range[lo];
    };
  }

  // ---- Class summary --------------------------------------------------------

  /** Percentage of all 1,326 combos this range covers (by weight, uniform=100%). */
  function percentOfCombos(range) {
    // Count of combos with positive weight, relative to 1326.
    var n = 0;
    for (var i = 0; i < range.length; i++) if (range[i].weight > 0) n++;
    return (n / allCombos().length) * 100;
  }

  /** Group a range by 169-class with summed weights, for display. */
  function classSummary(range) {
    var m = {};
    range.forEach(function (c) {
      var cls = comboClass(c.c1, c.c2);
      m[cls] = (m[cls] || 0) + c.weight;
    });
    return m;
  }

  /** Short human-readable summary string. */
  function summary(range) {
    var n = range.filter(function (c) { return c.weight > 0; }).length;
    return n + " combos (" + percentOfCombos(range).toFixed(1) + "% of all hands)";
  }

  // ---- Validation -----------------------------------------------------------

  function validate(range) {
    var errors = [];
    for (var i = 0; i < range.length; i++) {
      var c = range[i];
      if (c.c1 == null || c.c2 == null) { errors.push("combo missing a card"); continue; }
      if (c.c1 >= c.c2) errors.push("combo not in canonical order");
      if (!(c.weight >= 0) || !isFinite(c.weight)) errors.push("combo has an invalid weight");
    }
    return { ok: errors.length === 0, errors: errors };
  }

  Poker.Ranges = {
    RANK_CHAR: RANK_CHAR,
    allCombos: allCombos,
    fullRange: fullRange,
    clone: clone,
    comboClass: comboClass,
    combosForClass: combosForClass,
    parse: parse,
    parseToken: parseToken,
    removeBlockers: removeBlockers,
    intersect: intersect,
    union: union,
    totalWeight: totalWeight,
    normalise: normalise,
    makeSampler: makeSampler,
    percentOfCombos: percentOfCombos,
    classSummary: classSummary,
    summary: summary,
    validate: validate,
  };
})(typeof self !== "undefined" ? self : this);
