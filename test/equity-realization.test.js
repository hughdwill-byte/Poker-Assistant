/*
 * equity-realization.test.js - raw vs realized equity heuristic
 * (Phase C, Wave 1.6, #1). Tests monotonic behaviour and bounds, not a
 * "magic number".
 */
module.exports = function (t) {
  var ER = global.Poker.EquityRealization;

  t.section("Realization: river realises fully (R = 1)");
  (function () {
    t.approx("river R = 1 (OOP, draw, deep - all irrelevant)", ER.factor({ street: "river", inPosition: false, draw: true, spr: 10 }), 1, 1e-12);
    var r = ER.realizedEquity(0.6, { street: "river", inPosition: false });
    t.approx("river realized == raw", r.realized, 0.6, 1e-12);
  })();

  t.section("Realization: in position realises more than out of position");
  (function () {
    var ip = ER.factor({ street: "flop", inPosition: true, spr: 5 });
    var oop = ER.factor({ street: "flop", inPosition: false, spr: 5 });
    t.eq("IP factor > 1 > OOP factor", ip > 1 && oop < 1);
    t.eq("IP realises more than OOP", ip > oop);
  })();

  t.section("Realization: initiative helps");
  (function () {
    var withInit = ER.factor({ street: "flop", inPosition: true, hasInitiative: true, spr: 5 });
    var without = ER.factor({ street: "flop", inPosition: true, hasInitiative: false, spr: 5 });
    t.eq("having initiative realises more", withInit > without);
  })();

  t.section("Realization: shallow SPR is closer to raw than deep SPR");
  (function () {
    var deepOOP = ER.factor({ street: "flop", inPosition: false, spr: 10 });
    var shallowOOP = ER.factor({ street: "flop", inPosition: false, spr: 1 });
    // Both are < 1 (OOP), but the shallow one deviates less from 1.
    t.eq("shallow SPR closer to 1 than deep SPR (OOP)", Math.abs(1 - shallowOOP) < Math.abs(1 - deepOOP));
  })();

  t.section("Realization: draws realise worse, especially OOP");
  (function () {
    var drawOOP = ER.factor({ street: "flop", inPosition: false, draw: true, spr: 5 });
    var madeOOP = ER.factor({ street: "flop", inPosition: false, draw: false, spr: 5 });
    t.eq("a draw OOP realises less than a made hand OOP", drawOOP < madeOOP);
    var drawIP = ER.factor({ street: "flop", inPosition: true, draw: true, spr: 5 });
    t.eq("a draw IP realises more than the same draw OOP", drawIP > drawOOP);
  })();

  t.section("Realization: earlier streets deviate more than later ones");
  (function () {
    var flopOOP = ER.factor({ street: "flop", inPosition: false, spr: 5 });
    var turnOOP = ER.factor({ street: "turn", inPosition: false, spr: 5 });
    t.eq("flop deviates from 1 more than the turn (more streets to be denied)", Math.abs(1 - flopOOP) > Math.abs(1 - turnOOP));
  })();

  t.section("Realization: bounds and clamped realized equity");
  (function () {
    var extreme = ER.factor({ street: "preflop", inPosition: false, hasInitiative: false, draw: true, spr: 100 });
    t.eq("factor never below R_MIN", extreme >= ER.R_MIN - 1e-12);
    var extremeUp = ER.factor({ street: "preflop", inPosition: true, hasInitiative: true, spr: 100 });
    t.eq("factor never above R_MAX", extremeUp <= ER.R_MAX + 1e-12);
    var r = ER.realizedEquity(0.98, { street: "flop", inPosition: true, hasInitiative: true, spr: 100 });
    t.eq("realized equity clamped to <= 1", r.realized <= 1);
    t.eq("neutral (unknown position) leaves R ~ 1", Math.abs(ER.factor({ street: "flop", spr: 5 }) - 1) < 1e-9);
  })();
};
