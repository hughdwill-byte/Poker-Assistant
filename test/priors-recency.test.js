/*
 * priors-recency.test.js - stake/population baseline priors and recency-weighted
 * (time-decayed) opponent stats (Phase C, Wave 0.3).
 */
module.exports = function (t) {
  var OM = global.Poker.OpponentModel;
  var RP = global.Poker.RangePresets;

  t.section("Population priors: zero-data baseline reflects the pool");
  (function () {
    var blank = OM.createProfile();
    var def = OM.stats(blank).vpip;                        // ~0.25 default
    var micro = OM.stats(blank, { population: "micro" }).vpip; // looser
    var high = OM.stats(blank, { population: "high" }).vpip;   // tighter
    t.eq("micro baseline VPIP looser than default", micro > def);
    t.eq("high baseline VPIP tighter than default", high < def);
    t.eq("all baselines in (0,1)", def > 0 && def < 1 && micro < 1 && high > 0);
    // 3-bet prior: high stakes 3-bets more than micro.
    t.eq("high-stakes 3-bet prior > micro", OM.stats(blank, { population: "high" }).threeBet > OM.stats(blank, { population: "micro" }).threeBet);
    // Unknown population falls back to the default prior set.
    t.approx("unknown population -> default prior", OM.stats(blank, { population: "nope" }).vpip, def, 1e-12);
  })();

  t.section("Population priors: backward compatible (no opts == default)");
  (function () {
    var p = OM.createProfile();
    for (var i = 0; i < 10; i++) OM.observe(p.vpip, i < 6); // 6/10 play
    p.hands = 10;
    t.approx("stats() with no opts equals default-population stats", OM.stats(p).vpip, OM.stats(p, { population: "default" }).vpip, 1e-12);
  })();

  t.section("Recency: a half-life-old event weighs exactly 0.5");
  (function () {
    // decayedRate against a flat prior {a:0,b:0} isolates the weighting.
    var flat = { a: 0, b: 0 };
    var now = 1000000;
    var half = 100000;
    var counter = { opp: 0, hits: 0, events: [] };
    // One hit now (weight 1), one miss a half-life ago (weight 0.5).
    counter.events.push({ h: 1, t: now });
    counter.events.push({ h: 0, t: now - half });
    // weighted hits = 1*1 + 0*0.5 = 1 ; weighted opp = 1 + 0.5 = 1.5 -> 2/3.
    t.approx("recency weight halves at one half-life", OM.decayedRate(counter, flat, half, now), 1 / 1.5, 1e-6);
  })();

  t.section("Recency: recent behaviour dominates stale behaviour");
  (function () {
    var now = 10 * 3600 * 1000; // 10 hours in ms
    var halfLife = 3600 * 1000; // 1 hour
    // Old: 20 folds long ago (>>1 half-life). Recent: 5 calls just now.
    var p = OM.createProfile();
    for (var i = 0; i < 20; i++) OM.observe(p.vpip, false, now - 6 * 3600 * 1000); // 6h ago, folds
    for (var j = 0; j < 5; j++) OM.observe(p.vpip, true, now - 60 * 1000);          // 1min ago, plays
    p.hands = 25;
    var decayed = OM.stats(p, { halfLifeMs: halfLife, now: now }).vpip;
    var flat = OM.stats(p).vpip; // count-based, no decay
    // Count-based: 5/25 plays -> ~low VPIP after prior. Decayed: recent plays dominate -> higher.
    t.eq("recency-weighted VPIP higher than count-based here", decayed > flat);
    t.eq("decayed rate stays in (0,1)", decayed > 0 && decayed < 1);
  })();

  t.section("Recency: no timestamps -> falls back to counts (no crash)");
  (function () {
    var p = OM.createProfile();
    for (var i = 0; i < 8; i++) OM.observe(p.vpip, i < 4); // no timestamp
    p.hands = 8;
    var decayed = OM.stats(p, { halfLifeMs: 3600000, now: Date.now() }).vpip;
    var counts = OM.stats(p).vpip;
    t.approx("decay with no events equals count-based", decayed, counts, 1e-12);
  })();

  t.section("Recency: small sample stays near the baseline prior");
  (function () {
    var now = Date.now(), half = 3600000;
    var few = OM.createProfile();
    OM.observe(few.vpip, true, now); OM.observe(few.vpip, true, now); few.hands = 2;
    var base = OM.stats(OM.createProfile()).vpip;
    var fewRate = OM.stats(few, { halfLifeMs: half, now: now }).vpip;
    var many = OM.createProfile();
    for (var i = 0; i < 200; i++) OM.observe(many.vpip, true, now);
    many.hands = 200;
    var manyRate = OM.stats(many, { halfLifeMs: half, now: now }).vpip;
    t.eq("few decayed obs stay closer to prior than many", Math.abs(fewRate - base) < Math.abs(manyRate - base));
    t.eq("no negative rates", fewRate >= 0 && manyRate >= 0);
  })();

  t.section("Population styles seed a baseline range style");
  (function () {
    t.eq("micro baseline is a calling station", RP.styleForPopulation("micro") === "calling_station");
    t.eq("high baseline is tight", RP.styleForPopulation("high") === "tight");
    t.eq("unknown population -> unknown style", RP.styleForPopulation("???") === "unknown");
  })();
};
