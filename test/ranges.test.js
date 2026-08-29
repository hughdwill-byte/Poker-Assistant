/*
 * ranges.test.js - combo counts, notation parsing, weighted entries, blockers,
 * set operations, normalisation and validation for the one-deck range module.
 */
module.exports = function (t) {
  var P = global.Poker;
  var R = P.Ranges;
  var makeId = P.makeId;

  function countClass(token) {
    var res = R.parse(token);
    return res.ok ? res.range.length : -1;
  }

  t.section("Ranges: combo counts");
  t.eq("full one-deck range has exactly 1326 combos", R.fullRange().length === 1326);
  t.eq("pair class AA has 6 combos", countClass("AA") === 6);
  t.eq("suited class AKs has 4 combos", countClass("AKs") === 4);
  t.eq("offsuit class AKo has 12 combos", countClass("AKo") === 12);
  t.eq("AK (both) has 16 combos", countClass("AK") === 16);

  t.section("Ranges: notation");
  t.eq("QQ+ = QQ,KK,AA = 18 combos", countClass("QQ+") === 18);
  t.eq("22-66 = 5 pairs = 30 combos", countClass("22-66") === 30);
  t.eq("AJs+ = AJs,AQs,AKs = 12 combos", countClass("AJs+") === 12);
  t.eq("KQo single class = 12 combos", countClass("KQo") === 12);
  t.eq("T9s parses (10 handled)", countClass("T9s") === 4);
  t.eq("comma+space list unions", countClass("AA, KK") === 12);

  t.section("Ranges: weighted + invalid");
  (function () {
    var res = R.parse("AKs:0.5");
    t.eq("weighted entry keeps weight 0.5", res.ok && res.range.length === 4 && Math.abs(res.range[0].weight - 0.5) < 1e-9);
  })();
  t.eq("invalid token rejected", R.parse("XZ").ok === false);
  t.eq("suited pocket pair rejected", R.parse("AAs").ok === false);
  t.eq("negative weight rejected", R.parse("AA:-1").ok === false);

  t.section("Ranges: blockers");
  (function () {
    var full = R.fullRange();
    // Remove combos containing the Ace of spades: it appears in 51 combos.
    var As = makeId(14, 3);
    var blocked = R.removeBlockers(full, [As]);
    t.eq("removing one card drops 51 combos", blocked.length === 1326 - 51);
    // Known opponent cards collapse a range to exactly one combo.
    var aces = R.parse("AA").range;
    var known = R.intersect(aces, [{ c1: Math.min(makeId(14, 3), makeId(14, 2)), c2: Math.max(makeId(14, 3), makeId(14, 2)), weight: 1 }]);
    t.eq("known opponent hand collapses to one combo", known.length === 1);
  })();

  t.section("Ranges: impossible range surfaces");
  (function () {
    // AA with all four aces blocked -> empty; validate/parse must reveal it.
    var aces = R.parse("AA").range;
    var blocked = R.removeBlockers(aces, [makeId(14, 0), makeId(14, 1), makeId(14, 2), makeId(14, 3)]);
    t.eq("fully-blocked AA becomes empty", blocked.length === 0);
    t.eq("empty range has total weight 0", R.totalWeight(blocked) === 0);
    t.eq("normalising an empty range stays empty (no NaN)", R.normalise(blocked).length === 0);
  })();

  t.section("Ranges: normalisation");
  (function () {
    var r = R.parse("AA, KK, QQ").range; // 18 combos, weight 1 each
    var norm = R.normalise(r);
    var total = R.totalWeight(norm);
    t.approx("normalised weights sum to 1", total, 1, 1e-9);
    var allFinite = norm.every(function (c) { return isFinite(c.weight) && c.weight >= 0; });
    t.eq("every normalised weight finite and non-negative", allFinite);
    t.eq("validate passes on a good range", R.validate(norm).ok === true);
  })();

  t.section("Ranges: class conversion + summary");
  t.eq("comboClass identifies AKs", (function () {
    var c = R.parse("AKs").range[0];
    return R.comboClass(c.c1, c.c2) === "AKs";
  })());
  t.approx("full range is 100% of combos", R.percentOfCombos(R.fullRange()), 100, 1e-9);
};
