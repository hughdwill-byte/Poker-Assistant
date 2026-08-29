/*
 * engine.test.js - correctness checks for the exact evaluator and the
 * uniform-equity engine. These are the original regressions, preserved
 * unchanged; the expected equities are published all-in probabilities for
 * classic Hold'em match-ups, so a passing run shows the maths agrees with
 * independent references.
 *
 * Registered on the shared harness (test/harness.js) and run by test/run.js.
 */
module.exports = function (t) {
  var P = global.Poker;
  var C = 0, D = 1, H = 2, S = 3;
  var id = function (rank, suit) { return P.makeId(rank, suit); };
  var player = function (cards, active) { return { cards: cards, active: active !== false }; };

  t.section("Evaluator");
  t.eq("royal flush", P.handName(P.evaluate7([id(14, S), id(13, S), id(12, S), id(11, S), id(10, S), id(2, C), id(3, D)])) === "Royal Flush");
  t.eq("quads category", P.unpackScore(P.evaluate7([id(9, S), id(9, C), id(9, D), id(9, H), id(2, S), id(3, D), id(14, C)])).category === P.CATEGORY.QUADS);
  var w = P.unpackScore(P.evaluate7([id(14, S), id(2, C), id(3, D), id(4, H), id(5, S), id(9, C), id(13, D)]));
  t.eq("wheel A-5 straight", w.category === P.CATEGORY.STRAIGHT && w.ranks[0] === 5);
  t.eq("full house picks best pair", P.handName(P.evaluate7([id(13, S), id(13, C), id(13, D), id(5, H), id(5, S), id(12, C), id(12, D)])) === "Full House, Kings over Queens");
  t.eq("ace-high flush beats king-high flush",
    P.evaluate7([id(14, H), id(10, H), id(8, H), id(5, H), id(3, H), id(2, C), id(2, D)]) >
    P.evaluate7([id(13, H), id(10, H), id(8, H), id(5, H), id(3, H), id(2, C), id(2, D)]));

  t.section("Uniform equity vs published references");
  t.approx("AA vs KK (AA equity ≈ 0.823)",
    P.simulate({ players: [player([id(14, S), id(14, H)]), player([id(13, S), id(13, H)])], board: [], decks: 1, trials: 150000 }).results[0].equity,
    0.823, 0.01);
  t.approx("AKs vs QQ (QQ equity ≈ 0.535)",
    P.simulate({ players: [player([id(14, S), id(13, S)]), player([id(12, H), id(12, D)])], board: [], decks: 1, trials: 150000 }).results[1].equity,
    0.535, 0.015);
  t.approx("AA vs one random hand (≈ 0.852)",
    P.simulate({ players: [player([id(14, S), id(14, H)]), player([])], board: [], decks: 1, trials: 150000 }).results[0].equity,
    0.852, 0.012);

  t.section("Deck bookkeeping");
  var r = P.simulate({ players: [player([id(14, S), id(14, H)]), player([id(13, S), id(13, H)])], board: [id(14, D), id(7, C), id(2, S)], decks: 1, trials: 1000 });
  t.eq("all-hole-known flop uses exact enumeration", r.mode === "exact");
  t.approx("AA set vs KK on A72", r.results[0].equity, 0.99, 0.02);
  t.eq("pool shrinks with known cards (52 - 7 = 45)",
    P.simulate({ players: [player([id(14, S), id(14, H)]), player([id(13, S), id(13, H)])], board: [id(2, C), id(3, D), id(4, H)], decks: 1, trials: 500 }).poolSize === 45);
  t.eq("multi-deck allows a duplicate card",
    P.simulate({ players: [player([id(14, S), id(14, S)]), player([id(13, S), id(13, H)])], board: [], decks: 2, trials: 5000 }).ok === true);
  t.eq("single deck rejects a duplicate card",
    P.simulate({ players: [player([id(14, S), id(14, S)]), player([id(13, S), id(13, H)])], board: [], decks: 1, trials: 5000 }).ok === false);

  t.section("Baseline advice");
  t.eq("fold below pot odds", P.advise({ equity: 0.15, pot: 100, toCall: 50, stack: 1000 }).action === "FOLD");
  t.eq("raise as big favourite", P.advise({ equity: 0.90, pot: 100, toCall: 20, stack: 1000 }).action === "RAISE");
  t.eq("bet when checked to", P.advise({ equity: 0.90, pot: 100, toCall: 0, stack: 1000 }).action === "BET");
  t.eq("check when weak but free", P.advise({ equity: 0.20, pot: 100, toCall: 0, stack: 1000 }).action === "CHECK");
  t.eq("call when marginally +EV", P.advise({ equity: 0.40, pot: 100, toCall: 40, stack: 1000 }).action === "CALL");

  t.section("Ties split fractionally");
  // Identical hands with a fixed board that pairs the board -> both play the
  // board, guaranteed split. Equity must be exactly 0.5 each, never a loss.
  var tie = P.simulate({
    players: [player([id(2, C), id(3, D)]), player([id(2, H), id(3, S)])],
    board: [id(14, C), id(14, D), id(13, H), id(13, S), id(12, C)], decks: 1, trials: 100,
  });
  t.approx("two-way tie gives 0.5 equity each (a)", tie.results[0].equity, 0.5, 0.001);
  t.approx("two-way tie gives 0.5 equity each (b)", tie.results[1].equity, 0.5, 0.001);
  // A pure split shows as a tie with no outright win; equity is the 0.5 share.
  t.eq("tie counted as a tie, not a win", tie.results[0].tie > 0.99 && tie.results[0].win < 0.01);
};

// Allow running this file standalone: `node test/engine.test.js`.
if (require.main === module) {
  global.self = global;
  require("../js/cards.js");
  require("../js/evaluator.js");
  require("../js/equity.js");
  require("../js/advice.js");
  var t = require("./harness").createHarness();
  module.exports(t);
  t.summary();
  process.exit(t.fail ? 1 : 0);
}
