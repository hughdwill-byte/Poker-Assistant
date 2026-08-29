/*
 * range-presets.js - documented, editable prior-range data.
 *
 * IMPORTANT: these are transparent, conventional heuristic ranges for a first
 * release. They are NOT solver output and must never be labelled "GTO". Every
 * value lives here as data, not buried in control flow, so it can be inspected
 * and edited. Percentages are approximate opening frequencies.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  // Conventional ~full-ring / 6-max opening (RFI) ranges by position. Wider in
  // late position, tighter up front. These are starting priors only.
  var RFI = {
    UTG: "22+, ATs+, KTs+, QTs+, JTs, T9s, AJo+, KQo",
    "UTG+1": "22+, A9s+, KTs+, QTs+, JTs, T9s, 98s, ATo+, KJo+",
    MP: "22+, A8s+, K9s+, QTs+, J9s+, T9s, 98s, ATo+, KJo+, QJo",
    "MP+1": "22+, A7s+, K9s+, Q9s+, J9s+, T8s+, 98s, 87s, A9o+, KTo+, QJo",
    LJ: "22+, A5s+, K8s+, Q9s+, J9s+, T8s+, 97s+, 87s, 76s, A8o+, KTo+, QTo+, JTo",
    HJ: "22+, A2s+, K7s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 76s, 65s, A7o+, K9o+, Q9o+, JTo",
    CO: "22+, A2s+, K5s+, Q7s+, J8s+, T7s+, 96s+, 86s+, 75s+, 65s, 54s, A4o+, K8o+, Q9o+, J9o+, T9o",
    BTN: "22+, A2s+, K2s+, Q4s+, J6s+, T6s+, 95s+, 85s+, 74s+, 64s+, 53s+, 43s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o",
    SB: "22+, A2s+, K5s+, Q7s+, J8s+, T7s+, 96s+, 86s+, 75s+, 65s, 54s, A5o+, K9o+, Q9o+, J9o+, T9o",
    BB: "22+, A2s+, K2s+, Q2s+, J4s+, T6s+, 95s+, 85s+, 74s+, 63s+, 53s+, 43s, A2o+, K5o+, Q7o+, J8o+, T8o+, 97o+, 87o, 76o",
  };

  // A tight 3-bet / continue-vs-raise value-and-bluff prior.
  var THREE_BET = {
    value: "QQ+, AKs, AKo, AQs",
    bluff: "A5s, A4s, KJs, QJs, JTs, T9s, 76s",
  };

  // Broad opponent-profile multipliers applied to a base prior. A "loose" player
  // widens (more combos survive), a "tight" player narrows.
  var PROFILE_ADJUST = {
    unknown: { widthMultiplier: 1.0 },
    tight: { widthMultiplier: 0.7 },
    loose: { widthMultiplier: 1.4 },
    aggressive: { widthMultiplier: 1.15 },
    passive: { widthMultiplier: 0.9 },
    nit: { widthMultiplier: 0.55 },
    maniac: { widthMultiplier: 1.9 },
    calling_station: { widthMultiplier: 1.6 },
  };

  /**
   * Build a prior range for a position/action, returning parsed combos or a
   * uniform full range as a documented fallback. Never invents precision.
   */
  function priorFor(opts) {
    opts = opts || {};
    var R = Poker.Ranges;
    var source = "uniform (versus random hands)";
    var text = null;
    if (opts.action === "3bet-value") { text = THREE_BET.value; source = "heuristic 3-bet value prior"; }
    else if (opts.action === "3bet") { text = THREE_BET.value + ", " + THREE_BET.bluff; source = "heuristic 3-bet prior"; }
    else if (opts.position && RFI[opts.position]) { text = RFI[opts.position]; source = "heuristic open-raise prior (" + opts.position + ")"; }

    if (!text) return { range: R.fullRange(), source: source };
    var parsed = R.parse(text);
    if (!parsed.ok || !parsed.range.length) return { range: R.fullRange(), source: "uniform (preset parse failed)" };
    return { range: parsed.range, source: source };
  }

  Poker.RangePresets = {
    RFI: RFI,
    THREE_BET: THREE_BET,
    PROFILE_ADJUST: PROFILE_ADJUST,
    priorFor: priorFor,
    listPositions: function () { return Object.keys(RFI); },
  };
})(typeof self !== "undefined" ? self : this);
