/*
 * strategy.js - orchestrate a structured recommendation.
 *
 * Two modes:
 *   "simple"   - equity vs uniform-random hands + pot-odds/EV fallback. Used
 *                when advanced inputs are missing or decks > 1.
 *   "range-ev" - equity vs modelled opponent ranges, with per-action EV over
 *                legal candidate sizes, fold equity and confidence.
 *
 * This module is pure poker maths (no DOM). It calls Poker.simulateRanges for
 * range-weighted equity, so it runs in the Web Worker as well as in Node.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function round(x, dp) { var m = Math.pow(10, dp || 0); return Math.round(x * m) / m; }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  // Candidate bet fractions of the pot (deduped later against legal amounts).
  var BET_FRACTIONS = [0.25, 0.33, 0.5, 0.66, 0.75, 1.0, 1.25, 1.5];

  /**
   * Simple-mode recommendation: uniform equity + pot odds. Wraps advise() and
   * maps it to the structured shape. `equity` is versus random hands.
   */
  function simpleRecommend(cfg) {
    var adv = Poker.advise({ equity: cfg.equity, pot: cfg.pot, toCall: cfg.toCall, stack: cfg.stack });
    var P = Math.max(0, cfg.pot || 0), C = Math.max(0, cfg.toCall || 0);
    var breakEven = C > 0 ? Poker.ActionEV.breakEvenEquity(P, C) : 0;
    return {
      mode: "simple",
      action: adv.action,
      amount: adv.amount,
      raiseTo: null,
      randomEquity: cfg.equity,
      modeledEquity: null,
      equityCi: null,
      potOdds: breakEven,
      evByAction: [{ action: adv.action, amount: adv.amount, ev: adv.stats ? adv.stats.evCall : null, confidence: 0.5 }],
      opponentRanges: [],
      assumptions: [
        "Equity is versus uniformly random hands (no opponent range model).",
        "Advice uses pot odds and expected value only.",
      ],
      warnings: cfg.warnings || [],
      explanation: adv.reasons || [],
    };
  }

  /**
   * Range-EV recommendation.
   * @param {Object} dc decision context:
   *   heroCards[2], board[], deadCards[]
   *   P  : canonical pot before hero acts
   *   C  : hero call cost (0 if unbet)
   *   heroStreetCommitted, heroStackBehind
   *   opponents : [{ seatId, range, source, profile }]
   *   currentBetTo, lastFullRaiseSize, bigBlind
   *   street, seed, trials, exactLimit
   *   legalTypes : optional {canRaise, canBet, canCheck}
   */
  function rangeRecommend(dc) {
    var EV = Poker.ActionEV, R = Poker.Ranges;
    var opponents = dc.opponents || [];
    var warnings = [], assumptions = [], explanation = [];
    var P = Math.max(0, dc.P || 0), C = Math.max(0, dc.C || 0);
    var multiway = opponents.length > 1;
    // Cash-game rake context; rake() returns 0 for play-money/tournament or 0%.
    var rakeCtx = { rakePercent: dc.rakePercent || 0, rakeCap: dc.rakeCap || 0, mode: dc.mode || "play-money" };
    dc._rakeCtx = rakeCtx;

    if (!dc.heroCards || dc.heroCards.length !== 2) {
      return { mode: "range-ev", error: "Hero cards are required for range strategy." };
    }
    if (!opponents.length) {
      return { mode: "range-ev", error: "At least one opponent range is required." };
    }

    // Modelled equity versus every opponent's range at once.
    var oppRanges = opponents.map(function (o) { return o.range; });
    var eqRes = Poker.simulateRanges({
      heroCards: dc.heroCards, opponentRanges: oppRanges,
      board: dc.board || [], deadCards: dc.deadCards || [],
      trials: dc.trials || 40000, seed: dc.seed != null ? dc.seed : null,
      exactLimit: dc.exactLimit != null ? dc.exactLimit : 200000,
    });
    if (!eqRes.ok) return { mode: "range-ev", error: eqRes.error };
    var e = eqRes.heroEquity;
    var ci = eqRes.heroCi || [e, e];

    var breakEven = C > 0 ? EV.breakEvenEquity(P, C) : 0;
    var evByAction = [];

    // GTO reference (pot-geometry only; reference-only, never overrides EV).
    // Facing a bet: villain bet B = C into a pot of (P - C), so MDF/alpha
    // describe the size hero faces. Unbet: references are per candidate size.
    var EQ = Poker.Equilibrium;
    var equilibrium = null;
    if (EQ && C > 0) {
      var potBeforeBet = Math.max(0, P - C);
      equilibrium = {
        facing: true,
        betFractionOfPot: potBeforeBet > 0 ? C / potBeforeBet : null,
        mdf: EQ.mdf(potBeforeBet, C),
        alpha: EQ.alpha(potBeforeBet, C),
        valueToBluff: EQ.valueToBluff(potBeforeBet, C),
        callBreakEvenEquity: EQ.reference(potBeforeBet, C).callBreakEvenEquity,
        note: "Equilibrium reference for the size faced; the recommendation itself is exploitative EV.",
      };
    } else if (EQ) {
      equilibrium = { facing: false, note: "Balanced value:bluff targets are shown per candidate bet size." };
    }

    // Model confidence: shrink with wide CIs, multiway approximation and sparse
    // opponent samples.
    var ciWidth = ci[1] - ci[0];
    var confidence = clamp01(1 - ciWidth * 3);
    if (multiway) confidence *= 0.75;

    // ---- Facing a bet: fold / call / raise --------------------------------
    if (C > 0) {
      evByAction.push({ action: "FOLD", amount: 0, raiseTo: null, ev: 0, confidence: 0.99 });
      var evc = EV.evCall(P, C, e, rakeCtx);
      evByAction.push({ action: "CALL", amount: round(Math.min(C, dc.heroStackBehind || C)), raiseTo: null, ev: round(evc, 1), confidence: confidence });
      // Raise candidates.
      if (dc.legalTypes ? dc.legalTypes.canRaise : true) {
        addRaiseCandidates(dc, opponents, P, e, evByAction, warnings, multiway, confidence);
      }
      assumptions.push("Break-even to call " + round(C) + " into " + round(P) + " is " + (breakEven * 100).toFixed(1) + "%.");
    } else {
      // ---- Unbet: check / bet ---------------------------------------------
      // Realise equity in the current pot at showdown (one-decision approx),
      // net of the rake charged on the fraction of the pot the hero wins.
      var evCheck = e * P - e * EV.rake(P, rakeCtx);
      evByAction.push({ action: "CHECK", amount: 0, raiseTo: null, ev: round(evCheck, 1), confidence: confidence });
      if (dc.legalTypes ? dc.legalTypes.canBet : true) {
        addBetCandidates(dc, opponents, P, e, evByAction, warnings, multiway, confidence);
      }
    }

    // Rank by EV and pick the best.
    evByAction.sort(function (a, b) { return (b.ev == null ? -1e9 : b.ev) - (a.ev == null ? -1e9 : a.ev); });
    var best = evByAction[0];
    var second = evByAction[1];
    best.evGap = second && best.ev != null && second.ev != null ? round(best.ev - second.ev, 1) : null;

    if (EV.rake(100, rakeCtx) > 0) assumptions.push("Cash-game rake applied to showdown pots: " + (rakeCtx.rakePercent * 100).toFixed(1) + "%" + (rakeCtx.rakeCap ? " capped at " + rakeCtx.rakeCap : " (uncapped)") + "; uncalled/fold-branch wins are not raked.");
    if (multiway) assumptions.push("Multiway aggressive-action EV uses a one-decision approximation (no future streets, single response round).");
    assumptions.push("Opponent ranges are MODELLED, not known - a modelled range, not a read on the exact cards.");
    if (eqRes.mode === "montecarlo") assumptions.push("Equity is simulated (" + (eqRes.trialsAccepted || 0) + " deals); the 95% CI is [" + (ci[0] * 100).toFixed(1) + "%, " + (ci[1] * 100).toFixed(1) + "%].");
    else assumptions.push("Equity is exact enumeration.");

    explanation.push("Modelled equity " + (e * 100).toFixed(1) + "% (random-hand equity would differ).");
    explanation.push("Best action by estimated EV: " + best.action + (best.raiseTo ? " to " + best.raiseTo : best.amount ? " " + best.amount : "") + " (EV " + best.ev + ").");

    return {
      mode: "range-ev",
      action: best.action,
      amount: best.amount || 0,
      raiseTo: best.raiseTo || null,
      randomEquity: null,
      modeledEquity: e,
      equityCi: ci,
      potOdds: breakEven,
      evByAction: evByAction,
      opponentRanges: opponents.map(function (o) {
        return { seatId: o.seatId, source: o.source || "modelled", combos: o.range.length, summary: R.summary(o.range), confidence: o.profile ? Poker.OpponentModel.stats(o.profile).sampleConfidence : 0.3 };
      }),
      assumptions: assumptions,
      warnings: warnings.concat(eqRes.warning ? [eqRes.warning] : []),
      explanation: explanation,
      equilibrium: equilibrium,
      equityDetail: eqRes,
    };
  }

  // Generate legal bet-to targets from pot fractions, capped by the stack, and
  // deduped to distinct legal amounts.
  function betTargets(dc, P) {
    var targets = [];
    var heroStreet = dc.heroStreetCommitted || 0;
    var maxTo = heroStreet + (dc.heroStackBehind || 0);
    BET_FRACTIONS.forEach(function (f) {
      var to = heroStreet + Math.round(f * P);
      if (to > heroStreet && to <= maxTo) targets.push({ to: to, label: Math.round(f * 100) + "% pot", frac: f });
    });
    // Always include all-in.
    targets.push({ to: maxTo, label: "all-in", frac: null });
    return dedupeTargets(targets);
  }

  function raiseTargets(dc, P) {
    var targets = [];
    var heroStreet = dc.heroStreetCommitted || 0;
    var betTo = dc.currentBetTo || 0;
    var fullRaise = dc.lastFullRaiseSize || dc.bigBlind || 1;
    var maxTo = heroStreet + (dc.heroStackBehind || 0);
    var minTo = Math.min(betTo + fullRaise, maxTo);
    targets.push({ to: minTo, label: "min raise", frac: null });
    // Pot-sized-raise semantics: a raise-to of currentBet + (pot after calling).
    BET_FRACTIONS.forEach(function (f) {
      // pot after hero calls = P + C; the raise adds f * that on top of the call.
      var callTo = betTo;
      var potAfterCall = P + (betTo - heroStreet);
      var to = callTo + Math.round(f * potAfterCall);
      if (to > minTo && to <= maxTo) targets.push({ to: to, label: Math.round(f * 100) + "% pot raise", frac: f });
    });
    targets.push({ to: maxTo, label: "all-in", frac: null });
    return dedupeTargets(targets);
  }

  function dedupeTargets(targets) {
    var seen = {}, out = [];
    targets.forEach(function (t) {
      var k = Math.round(t.to);
      if (k <= 0 || seen[k]) return;
      seen[k] = true; out.push(t);
    });
    out.sort(function (a, b) { return a.to - b.to; });
    return out;
  }

  function addBetCandidates(dc, opponents, P, e, evByAction, warnings, multiway, baseConf) {
    var EV = Poker.ActionEV;
    // The v1 likelihood model does not vary with bet size, so the response and
    // the called-range equity are computed once and reused across sizes.
    var resp = combinedResponse(opponents, { board: dc.board, street: dc.street, sizeFraction: 0.66 });
    var eCalled = eCalledEquity(dc, opponents, resp, "bet");
    betTargets(dc, P).forEach(function (tg) {
      var B = tg.to - (dc.heroStreetCommitted || 0);
      var ev;
      if (!multiway) {
        ev = EV.evBet(P, B, resp.fold, eCalled, dc._rakeCtx);
      } else {
        // One-decision multiway approximation: all-fold wins P (no rake, no
        // showdown); otherwise treat the called mass as a single showdown for
        // P + 2B (rake charged on the pot the hero wins).
        var potM = P + 2 * B;
        ev = resp.fold * P + (1 - resp.fold) * (eCalled * potM - B - eCalled * EV.rake(potM, dc._rakeCtx));
      }
      // Balanced (GTO reference) bluff share of the betting range at this size.
      var bluffTarget = Poker.Equilibrium ? Poker.Equilibrium.bluffFractionOfRange(P, B) : null;
      evByAction.push({ action: "BET", amount: round(B), raiseTo: round(tg.to), ev: round(ev, 1), foldEquity: round(resp.fold, 3), equityWhenCalled: round(eCalled, 3), bluffTarget: bluffTarget != null ? round(bluffTarget, 3) : null, label: tg.label, confidence: multiway ? baseConf * 0.7 : baseConf });
    });
  }

  function addRaiseCandidates(dc, opponents, P, e, evByAction, warnings, multiway, baseConf) {
    var EV = Poker.ActionEV;
    var betTo0 = dc.currentBetTo || 0;
    var resp = combinedResponse(opponents, { board: dc.board, street: dc.street, sizeFraction: 0.66 });
    var eCalled = eCalledEquity(dc, opponents, resp, "raise");
    raiseTargets(dc, P).forEach(function (tg) {
      var heroAdd = tg.to - (dc.heroStreetCommitted || 0);
      var betTo = betTo0;
      // Opponent calls by matching to tg.to. Approximate one opponent's call add.
      var oppAdd = 0;
      opponents.forEach(function (o) { oppAdd += Math.max(0, tg.to - (o.streetCommitted || betTo)); });
      if (multiway) oppAdd = oppAdd; // sum across callers (approx: all call)
      var branches = [
        { prob: resp.fold, type: "fold", oppAdditional: 0 },
        { prob: 1 - resp.fold, type: "call", heroAdditional: heroAdd, oppAdditional: oppAdd, branchEquity: eCalled },
      ];
      var ev = EV.evFromBranches(P, branches, dc._rakeCtx);
      evByAction.push({ action: "RAISE", amount: round(heroAdd), raiseTo: round(tg.to), ev: round(ev, 1), foldEquity: round(resp.fold, 3), equityWhenCalled: round(eCalled, 3), label: tg.label, confidence: multiway ? baseConf * 0.7 : baseConf });
    });
    if (!dc._reraiseModelled) warnings.push("Re-raise branch is not modelled; raise EV assumes opponents only fold or call (confidence reduced).");
  }

  // Combined fold probability across opponents (independent approximation) and a
  // representative called range (union of per-opponent calling ranges).
  function combinedResponse(opponents, ctx) {
    var EV = Poker.ActionEV, R = Poker.Ranges;
    var foldProd = 1;
    var calledRanges = [];
    opponents.forEach(function (o) {
      var rm = EV.responseModel(o.range, { board: ctx.board, street: ctx.street, profile: o.profile, sizeFraction: ctx.sizeFraction });
      foldProd *= rm.fold;
      calledRanges.push(rm.calledRange.length ? rm.calledRange : o.range);
    });
    return { fold: foldProd, calledRanges: calledRanges };
  }

  // Hero equity conditioned on being called, vs the opponents' calling ranges.
  function eCalledEquity(dc, opponents, resp, kind) {
    var res = Poker.simulateRanges({
      heroCards: dc.heroCards,
      opponentRanges: resp.calledRanges,
      board: dc.board || [], deadCards: dc.deadCards || [],
      trials: Math.min(dc.trials || 20000, 20000), seed: dc.seed != null ? dc.seed + 7 : null,
      exactLimit: dc.exactLimit != null ? dc.exactLimit : 200000,
    });
    return res.ok ? res.heroEquity : dc._fallbackEquity || 0.5;
  }

  Poker.Strategy = {
    simpleRecommend: simpleRecommend,
    rangeRecommend: rangeRecommend,
    BET_FRACTIONS: BET_FRACTIONS,
    betTargets: betTargets,
    raiseTargets: raiseTargets,
  };
})(typeof self !== "undefined" ? self : this);
