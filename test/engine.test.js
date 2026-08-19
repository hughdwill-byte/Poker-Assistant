/*
 * Correctness checks for the poker engine, run under Node with no dependencies.
 *   node test/engine.test.js
 *
 * The expected equities below are the published all-in probabilities for
 * classic Hold'em match-ups, so a passing run demonstrates the maths agrees
 * with independent references.
 */
global.self = global; // let the browser IIFEs attach `Poker` to a shared global
require("../js/cards.js");
require("../js/evaluator.js");
require("../js/equity.js");
require("../js/advice.js");
const P = global.Poker;

const C = 0, D = 1, H = 2, S = 3;
const id = (rank, suit) => P.makeId(rank, suit);
const player = (cards, active) => ({ cards, active: active !== false });

let pass = 0, fail = 0;
function approx(name, got, exp, tol) {
  const ok = Math.abs(got - exp) <= tol;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  got=${got.toFixed(4)} exp≈${exp} ±${tol}`);
  ok ? pass++ : fail++;
}
function eq(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  cond ? pass++ : fail++;
}

// ---- Evaluator ----
eq("royal flush", P.handName(P.evaluate7([id(14,S),id(13,S),id(12,S),id(11,S),id(10,S),id(2,C),id(3,D)])) === "Royal Flush");
eq("quads category", P.unpackScore(P.evaluate7([id(9,S),id(9,C),id(9,D),id(9,H),id(2,S),id(3,D),id(14,C)])).category === P.CATEGORY.QUADS);
{
  const w = P.unpackScore(P.evaluate7([id(14,S),id(2,C),id(3,D),id(4,H),id(5,S),id(9,C),id(13,D)]));
  eq("wheel A-5 straight", w.category === P.CATEGORY.STRAIGHT && w.ranks[0] === 5);
}
eq("full house picks best pair", P.handName(P.evaluate7([id(13,S),id(13,C),id(13,D),id(5,H),id(5,S),id(12,C),id(12,D)])) === "Full House, Kings over Queens");
eq("ace-high flush beats king-high flush",
   P.evaluate7([id(14,H),id(10,H),id(8,H),id(5,H),id(3,H),id(2,C),id(2,D)]) >
   P.evaluate7([id(13,H),id(10,H),id(8,H),id(5,H),id(3,H),id(2,C),id(2,D)]));

// ---- Equity vs published references ----
approx("AA vs KK (AA equity ≈ 0.823)",
  P.simulate({ players: [player([id(14,S),id(14,H)]), player([id(13,S),id(13,H)])], board: [], decks: 1, trials: 150000 }).results[0].equity,
  0.823, 0.01);
approx("AKs vs QQ (QQ equity ≈ 0.535)",
  P.simulate({ players: [player([id(14,S),id(13,S)]), player([id(12,H),id(12,D)])], board: [], decks: 1, trials: 150000 }).results[1].equity,
  0.535, 0.015);
approx("AA vs one random hand (≈ 0.852)",
  P.simulate({ players: [player([id(14,S),id(14,H)]), player([])], board: [], decks: 1, trials: 150000 }).results[0].equity,
  0.852, 0.012);

// ---- Deck bookkeeping ----
{
  const r = P.simulate({ players: [player([id(14,S),id(14,H)]), player([id(13,S),id(13,H)])], board: [id(14,D),id(7,C),id(2,S)], decks: 1, trials: 1000 });
  eq("all-hole-known flop uses exact enumeration", r.mode === "exact");
  approx("AA set vs KK on A72", r.results[0].equity, 0.99, 0.02);
}
eq("pool shrinks with known cards (52 - 7 = 45)",
  P.simulate({ players: [player([id(14,S),id(14,H)]), player([id(13,S),id(13,H)])], board: [id(2,C),id(3,D),id(4,H)], decks: 1, trials: 500 }).poolSize === 45);
eq("multi-deck allows a duplicate card",
  P.simulate({ players: [player([id(14,S),id(14,S)]), player([id(13,S),id(13,H)])], board: [], decks: 2, trials: 5000 }).ok === true);
eq("single deck rejects a duplicate card",
  P.simulate({ players: [player([id(14,S),id(14,S)]), player([id(13,S),id(13,H)])], board: [], decks: 1, trials: 5000 }).ok === false);

// ---- Advice ----
eq("fold below pot odds", P.advise({ equity: 0.15, pot: 100, toCall: 50, stack: 1000 }).action === "FOLD");
eq("raise as big favourite", P.advise({ equity: 0.90, pot: 100, toCall: 20, stack: 1000 }).action === "RAISE");
eq("bet when checked to", P.advise({ equity: 0.90, pot: 100, toCall: 0, stack: 1000 }).action === "BET");
eq("check when weak but free", P.advise({ equity: 0.20, pot: 100, toCall: 0, stack: 1000 }).action === "CHECK");
eq("call when marginally +EV", P.advise({ equity: 0.40, pot: 100, toCall: 40, stack: 1000 }).action === "CALL");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
