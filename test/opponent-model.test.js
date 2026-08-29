/*
 * opponent-model.test.js - non-negative weights, normalisation, distinct
 * raise/call shapes, blocker correctness, beta-binomial shrinkage.
 */
module.exports = function (t) {
  var P = global.Poker;
  var OM = P.OpponentModel;
  var R = P.Ranges;
  var id = P.makeId;
  var C = 0, D = 1, H = 2, S = 3;

  // A dry-ish flop for postflop reasoning.
  var flop = [id(13, C), id(8, D), id(3, S)]; // K 8 3 rainbow
  // A realistic prior never contains cards already on the board.
  function cleanPrior() { return R.normalise(R.removeBlockers(R.fullRange(), flop)); }

  function avgStrength(range, board) {
    var tot = 0, sw = 0;
    range.forEach(function (c) {
      var s = OM.comboStrength(c.c1, c.c2, board).made;
      sw += s * c.weight; tot += c.weight;
    });
    return tot > 0 ? sw / tot : 0;
  }
  function weightOfClass(range, token) {
    var want = {};
    R.parse(token).range.forEach(function (c) { want[c.c1 + "_" + c.c2] = true; });
    var w = 0;
    range.forEach(function (c) { if (want[c.c1 + "_" + c.c2]) w += c.weight; });
    return w;
  }

  t.section("Opponent model: non-negative weights & normalisation");
  (function () {
    var prior = cleanPrior();
    var res = OM.updateRange(prior, "raise", { board: flop });
    var allNonNeg = res.range.every(function (c) { return c.weight >= 0 && isFinite(c.weight); });
    t.eq("posterior weights non-negative and finite", allNonNeg);
    t.approx("posterior normalises to 1", R.totalWeight(res.range), 1, 1e-9);
  })();

  t.section("Opponent model: repeated actions never go negative");
  (function () {
    var range = cleanPrior();
    var ok = true;
    for (var k = 0; k < 5; k++) {
      range = OM.updateRange(range, k % 2 ? "call" : "raise", { board: flop }).range;
      if (range.some(function (c) { return c.weight < 0 || !isFinite(c.weight); })) ok = false;
    }
    t.eq("weights stay non-negative across repeated updates", ok);
    t.approx("still normalised after repeats", R.totalWeight(range), 1, 1e-9);
  })();

  t.section("Opponent model: a raise shifts toward value AND keeps bluffs/draws");
  (function () {
    var prior = cleanPrior();
    var post = OM.updateRange(prior, "raise", { board: flop }).range;
    // Value: top set (KK) weight should rise vs prior.
    var priorKK = weightOfClass(prior, "KK"), postKK = weightOfClass(post, "KK");
    t.eq("raise increases weight on strong value (sets)", postKK > priorKK);
    // Bluff/draw region stays possible: a straight-draw hand like T9 keeps
    // meaningful (non-zero) weight rather than being purged.
    var t9 = weightOfClass(post, "T9s");
    t.eq("raise keeps some draw/bluff combos (T9s > 0)", t9 > 0);
    // Average made strength of a raise range exceeds the prior's.
    t.eq("raise range is stronger on average than prior", avgStrength(post, flop) > avgStrength(prior, flop));
  })();

  t.section("Opponent model: a call range is distinct, not a weaker raise range");
  (function () {
    var prior = cleanPrior();
    var raiseR = OM.updateRange(prior, "raise", { board: flop }).range;
    var callR = OM.updateRange(prior, "call", { board: flop }).range;
    // Bucket posterior weight by made strength: medium band vs top band.
    function bandMass(range, lo, hi) {
      var w = 0;
      range.forEach(function (c) {
        var s = OM.comboStrength(c.c1, c.c2, flop).made;
        if (s >= lo && s < hi) w += c.weight;
      });
      return w;
    }
    // The call range should be weaker on average than the raise range...
    t.eq("call range weaker on average than raise range", avgStrength(callR, flop) < avgStrength(raiseR, flop));
    // ...but concentrate RELATIVELY more weight on medium-strength made hands.
    t.eq("call holds more medium-strength weight than raise", bandMass(callR, 0.35, 0.6) > bandMass(raiseR, 0.35, 0.6));
    // The very top (sets/monsters) is a larger share of raise than of call.
    t.eq("top value concentrated in raise, not call", bandMass(raiseR, 0.7, 1.01) > bandMass(callR, 0.7, 1.01));
  })();

  t.section("Opponent model: blocker correctness");
  (function () {
    // Remove all cards on the board + hero; posterior must not contain them.
    var prior = R.normalise(R.removeBlockers(R.fullRange(), flop.concat([id(14, S), id(14, H)])));
    var post = OM.updateRange(prior, "raise", { board: flop }).range;
    var usesBlocked = post.some(function (c) {
      return flop.indexOf(c.c1) !== -1 || flop.indexOf(c.c2) !== -1 || c.c1 === id(14, S) || c.c2 === id(14, S);
    });
    t.eq("posterior never contains blocked cards", !usesBlocked);
  })();

  t.section("Opponent model: beta-binomial shrinkage");
  (function () {
    var prior = OM.stats(OM.createProfile()).vpip; // no data -> population prior ~0.25
    // Small sample near the prior.
    var few = OM.createProfile();
    for (var i = 0; i < 3; i++) OM.observe(few.vpip, true);
    few.hands = 3;
    var fewRate = OM.stats(few).vpip;
    // Large sample dominates the prior.
    var many = OM.createProfile();
    for (var j = 0; j < 200; j++) OM.observe(many.vpip, true);
    many.hands = 200;
    var manyRate = OM.stats(many).vpip;
    t.eq("small sample stays closer to the prior than a large sample", Math.abs(fewRate - prior) < Math.abs(manyRate - prior));
    t.eq("large all-play sample pushes VPIP high", manyRate > 0.9);
    t.eq("rates always in [0,1]", fewRate >= 0 && fewRate <= 1 && manyRate >= 0 && manyRate <= 1);
    t.eq("sample confidence grows with hands", OM.stats(many).sampleConfidence > OM.stats(few).sampleConfidence);
  })();

  t.section("Opponent model: trained hook disabled");
  t.throws("trained model refuses until a real artefact exists", function () { OM.TrainedModel.predict({}); });
};
