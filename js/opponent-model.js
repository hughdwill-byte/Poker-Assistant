/*
 * opponent-model.js - a transparent, inspectable model of an opponent, plus a
 * Bayesian update of a weighted combo range from an observed action.
 *
 *   posteriorWeight(combo) = priorWeight(combo) * likelihood(action | combo, ...)
 *   then normalise.
 *
 * The likelihood model is an explicit heuristic (v1); a real trained model can
 * replace `actionLikelihood` later behind the same interface (see the disabled
 * `TrainedModel` hook). Every likelihood stays in [0,1], every posterior weight
 * stays non-negative, and every distribution normalises. Value hands AND
 * draws/bluffs both remain possible where appropriate, so a modelled range is
 * labelled "modelled", never "known".
 *
 * Player statistics use beta-binomial (shrinkage) priors so a handful of hands
 * cannot overwhelm a sensible population prior.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  var HF = Poker.HandFeatures;
  var rankOf = Poker.rankOf, suitOf = Poker.suitOf;

  var PROFILE_SCHEMA = 1;

  // Population priors (alpha, beta) for beta-binomial rate estimates. These are
  // conventional 6-max defaults, kept here as data.
  var STAT_PRIORS = {
    vpip: { a: 6, b: 18 },       // ~25%
    pfr: { a: 4, b: 20 },        // ~17%
    threeBet: { a: 1, b: 15 },   // ~6%
    foldToThreeBet: { a: 5, b: 5 },
    cbet: { a: 6, b: 4 },        // ~60%
    foldToCbet: { a: 5, b: 5 },
  };

  function newCounter() { return { opp: 0, hits: 0 }; }

  function createProfile(opts) {
    opts = opts || {};
    return {
      schemaVersion: PROFILE_SCHEMA,
      id: opts.id || ("prof-" + Date.now() + "-" + Math.floor(Math.random() * 1e6)),
      key: opts.key || null,
      name: opts.name || "Unnamed",
      style: opts.style || "unknown",
      hands: 0,
      vpip: newCounter(),
      pfr: newCounter(),
      threeBet: newCounter(),
      foldToThreeBet: newCounter(),
      cbet: { flop: newCounter(), turn: newCounter(), river: newCounter() },
      foldToCbet: { flop: newCounter(), turn: newCounter(), river: newCounter() },
      aggression: { bets: 0, raises: 0, calls: 0 },
      showdowns: 0,
      sizeByStreet: { preflop: [], flop: [], turn: [], river: [] },
      recent: [],
    };
  }

  // Beta-binomial rate with shrinkage toward the population prior.
  function rate(counter, prior) {
    prior = prior || { a: 1, b: 1 };
    return (counter.hits + prior.a) / (counter.opp + prior.a + prior.b);
  }

  function stats(profile) {
    return {
      hands: profile.hands,
      vpip: rate(profile.vpip, STAT_PRIORS.vpip),
      pfr: rate(profile.pfr, STAT_PRIORS.pfr),
      threeBet: rate(profile.threeBet, STAT_PRIORS.threeBet),
      foldToThreeBet: rate(profile.foldToThreeBet, STAT_PRIORS.foldToThreeBet),
      cbetFlop: rate(profile.cbet.flop, STAT_PRIORS.cbet),
      aggressionFactor: profile.aggression.calls > 0
        ? (profile.aggression.bets + profile.aggression.raises) / profile.aggression.calls
        : (profile.aggression.bets + profile.aggression.raises),
      sampleConfidence: profile.hands / (profile.hands + 25), // 0..1, 25-hand half-weight
    };
  }

  // Record one opportunity/result for a counter.
  function observe(counter, hit) { counter.opp++; if (hit) counter.hits++; }

  // ---- Combo strength ------------------------------------------------------

  // Preflop strength in [0,1] from the two hole cards (heuristic, documented).
  function preflopStrength(c1, c2) {
    var r1 = rankOf(c1), r2 = rankOf(c2), hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    var suited = suitOf(c1) === suitOf(c2);
    var s;
    if (hi === lo) {
      // Pairs: 22 -> ~0.5, AA -> ~1.0.
      s = 0.5 + (hi - 2) / 12 * 0.5;
    } else {
      var highPart = (hi - 2) / 12 * 0.55 + (lo - 2) / 12 * 0.2;
      var gap = hi - lo;
      var connect = gap === 1 ? 0.08 : gap === 2 ? 0.04 : gap === 3 ? 0.02 : 0;
      s = 0.12 + highPart + connect + (suited ? 0.06 : 0);
      s = Math.min(s, 0.72); // an unpaired hand never scores as high as a big pair
    }
    return Math.max(0, Math.min(1, s));
  }

  // Postflop made-hand strength (0..1) and a draw score (0..1).
  var CAT_STRENGTH = {};
  (function () {
    var C = Poker.CATEGORY;
    CAT_STRENGTH[C.HIGH_CARD] = 0.08;
    CAT_STRENGTH[C.PAIR] = 0.33;
    CAT_STRENGTH[C.TWO_PAIR] = 0.60;
    CAT_STRENGTH[C.TRIPS] = 0.72;
    CAT_STRENGTH[C.STRAIGHT] = 0.82;
    CAT_STRENGTH[C.FLUSH] = 0.88;
    CAT_STRENGTH[C.FULL_HOUSE] = 0.94;
    CAT_STRENGTH[C.QUADS] = 0.98;
    CAT_STRENGTH[C.STRAIGHT_FLUSH] = 1.0;
    CAT_STRENGTH[C.FIVE_KIND] = 1.0;
  })();

  function postflopStrength(c1, c2, board) {
    var f = HF.extract([c1, c2], board);
    var s = CAT_STRENGTH[f.made ? f.made.category : 0] || 0.08;
    // Refine a bare pair by its position.
    if (f.made && f.made.category === Poker.CATEGORY.PAIR) {
      if (f.pair === "overpair") s += 0.12;
      else if (f.pair === "top-pair") s += 0.08;
      else if (f.pair === "middle-pair") s += 0.02;
      else if (f.pair === "underpair" || f.pair === "bottom-pair") s -= 0.02;
    }
    var d = 0;
    if (f.flush.flushDraw) d = Math.max(d, f.flush.nutFlushDraw ? 0.55 : 0.45);
    if (f.straight.oesd || f.straight.doubleGutshot) d = Math.max(d, 0.45);
    else if (f.straight.gutshot) d = Math.max(d, 0.22);
    if (f.comboDraw) d = Math.max(d, 0.65);
    if (f.flush.backdoorFlushDraw) d = Math.max(d, 0.12);
    return { made: Math.max(0, Math.min(1, s)), draw: d, features: f };
  }

  function comboStrength(c1, c2, board) {
    if (!board || board.length < 3) {
      return { made: preflopStrength(c1, c2), draw: 0, features: null };
    }
    return postflopStrength(c1, c2, board);
  }

  // ---- Action likelihoods ---------------------------------------------------

  function smooth(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }
  // A bump peaking at `center` with half-width `w`.
  function bump(x, center, w) {
    var z = (x - center) / w;
    return Math.exp(-z * z);
  }

  /**
   * P(action | combo, context) as a heuristic likelihood in [0,1].
   * ctx: { board, street, profile, sizeFraction, aggression }
   */
  function actionLikelihood(action, c1, c2, ctx) {
    ctx = ctx || {};
    var st = comboStrength(c1, c2, ctx.board);
    var s = st.made, d = st.draw;
    var profStats = ctx.profile ? stats(ctx.profile) : null;
    var aggr = profStats ? Math.max(0.4, Math.min(2.5, profStats.aggressionFactor || 1)) : 1;
    var bluffiness = profStats ? 0.5 + 0.5 * Math.min(1, (profStats.aggressionFactor || 1) / 2) : 0.6;

    switch (action) {
      case "raise":
      case "bet": {
        // Value: increases steeply with made strength above a threshold, so a
        // raise range is value-weighted on average.
        var value = smooth((s - 0.45) / 0.35);
        // Bluff: weak made hands can still raise - more so with a draw - but the
        // bluff weight is deliberately small so value dominates. Draws get a
        // larger share than pure air; pure air keeps a little weight so bluffs
        // remain possible (never a purely value range).
        var airOrDraw = (1 - s);
        var bluff = 0.10 * bluffiness * airOrDraw * (0.35 + 1.3 * d);
        var L = Math.min(1, value + bluff);
        // Aggressive players raise a touch wider.
        return Math.max(0, Math.min(1, L * (0.75 + 0.25 * aggr)));
      }
      case "call": {
        // Medium made hands and drawing hands call; the very top raises, pure
        // air folds. This makes the call range distinct from a raise range.
        var mediumMade = bump(s, 0.5, 0.22);
        var drawCall = 0.6 * d * (1 - smooth((s - 0.7) / 0.3)); // draws call unless already strong
        var thinValue = 0.15 * bump(s, 0.62, 0.14);
        var L2 = Math.max(mediumMade, drawCall) + thinValue;
        return Math.max(0, Math.min(1, L2));
      }
      case "check": {
        // Checking: weak-to-medium hands without a strong bet incentive.
        return Math.max(0, Math.min(1, 0.5 * (1 - smooth((s - 0.55) / 0.3)) + 0.2 * (1 - d)));
      }
      case "fold": {
        // Fold weak, low-equity hands; strong hands and good draws rarely fold.
        var weak = 1 - smooth((s - 0.15) / 0.35);
        var L3 = weak * (1 - 0.7 * d);
        return Math.max(0, Math.min(1, L3));
      }
      default:
        return 0.5; // neutral for unknown actions
    }
  }

  /**
   * Update a weighted range by one observed action. Returns a NEW normalised
   * range. Weights only ever multiply by a likelihood in [0,1], so they stay
   * non-negative; the result is renormalised to sum to 1. If every combo gets
   * ~0 likelihood the update is rejected (returns the prior + a warning).
   */
  function updateRange(prior, action, ctx) {
    var R = Poker.Ranges;
    var out = [];
    var total = 0;
    for (var i = 0; i < prior.length; i++) {
      var c = prior[i];
      var L = actionLikelihood(action, c.c1, c.c2, ctx);
      var w = c.weight * L;
      out.push({ c1: c.c1, c2: c.c2, weight: w });
      total += w;
    }
    if (total <= 1e-12) {
      return { range: R.normalise(prior), warning: "Action likelihood collapsed the range; kept the prior.", degenerate: true };
    }
    return { range: R.normalise(out), warning: null, degenerate: false };
  }

  // ---- Observation recording (for profiles) --------------------------------

  function recordAction(profile, obs) {
    // obs: { street, type, sizeFraction, faced }
    profile.recent.push(obs);
    if (profile.recent.length > 50) profile.recent.shift();
    if (obs.type === "bet") profile.aggression.bets++;
    else if (obs.type === "raise") profile.aggression.raises++;
    else if (obs.type === "call") profile.aggression.calls++;
    if (obs.sizeFraction != null && profile.sizeByStreet[obs.street]) {
      profile.sizeByStreet[obs.street].push(obs.sizeFraction);
    }
    return profile;
  }

  // Disabled trained-model hook: interface only, refuses until a real artefact,
  // feature schema and validation exist (never fabricate precision).
  var TrainedModel = {
    enabled: false,
    predict: function () { throw new Error("Trained opponent model is not enabled: no validated artefact."); },
  };

  Poker.OpponentModel = {
    PROFILE_SCHEMA: PROFILE_SCHEMA,
    STAT_PRIORS: STAT_PRIORS,
    createProfile: createProfile,
    stats: stats,
    rate: rate,
    observe: observe,
    recordAction: recordAction,
    comboStrength: comboStrength,
    preflopStrength: preflopStrength,
    actionLikelihood: actionLikelihood,
    updateRange: updateRange,
    TrainedModel: TrainedModel,
  };
})(typeof self !== "undefined" ? self : this);
