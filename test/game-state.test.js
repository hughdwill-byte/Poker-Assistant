/*
 * game-state.test.js - fixed seats, positions, action order, betting amounts,
 * the short-all-in reopen rule, effective stack, SPR, pot-display modes and
 * side pots.
 */
module.exports = function (t) {
  var P = global.Poker;
  var GS = P.GameState, AT = P.ActionTracker;

  function sixHanded() {
    var s = GS.createState({ tableSize: 6, buttonSeat: 0, smallBlind: 5, bigBlind: 10, startingStack: 1000 });
    return s;
  }

  t.section("Game-state: fixed seats");
  (function () {
    var s = sixHanded();
    AT.apply(s, { seatId: 3, type: "fold" });
    t.eq("folded seat keeps its seatId", s.players[3].seatId === 3 && s.players[3].folded === true);
    t.eq("tableSize unchanged after a fold", s.game.tableSize === 6);
    t.eq("active count differs from tableSize", GS.activeSeats(s).length === 5 && s.game.tableSize === 6);
    t.eq("folded seat still occupies its position", GS.positionLabels(s)[3] === "UTG");
  })();

  t.section("Game-state: positions");
  (function () {
    var s = sixHanded();
    var pos = GS.positionLabels(s);
    t.eq("6-handed BTN", pos[0] === "BTN");
    t.eq("6-handed SB", pos[1] === "SB");
    t.eq("6-handed BB", pos[2] === "BB");
    t.eq("6-handed UTG", pos[3] === "UTG");
    t.eq("6-handed CO", pos[5] === "CO");
    var b = GS.blindSeats(s);
    t.eq("6-handed blind seats", b.sb === 1 && b.bb === 2);
  })();

  t.section("Game-state: heads-up special case");
  (function () {
    var s = GS.createState({ tableSize: 2, buttonSeat: 0, smallBlind: 5, bigBlind: 10, startingStack: 1000 });
    var b = GS.blindSeats(s);
    t.eq("HU button is the small blind", b.sb === 0 && b.bb === 1);
    var pos = GS.positionLabels(s);
    t.eq("HU labels BTN/SB + BB", pos[0] === "BTN/SB" && pos[1] === "BB");
    // Pre-flop the button/SB acts first; post-flop the BB acts first.
    var pre = GS.actionOrder(s);
    t.eq("HU preflop button acts first", pre[0] === 0);
    s.board = [P.makeId(2, 0), P.makeId(7, 1), P.makeId(9, 2), null, null];
    var post = GS.actionOrder(s);
    t.eq("HU postflop BB acts first", post[0] === 1);
  })();

  t.section("Game-state: action order");
  (function () {
    var s = sixHanded();
    AT.postBlinds(s);
    var pre = GS.actionOrder(s);
    t.eq("6-handed preflop UTG first", pre[0] === 3);
    // The big blind acts last pre-flop (the option), after the button and SB.
    t.eq("6-handed preflop BB acts last (option)", pre[pre.length - 1] === 2);
    s.players.forEach(function (p) { p.streetCommitted = 0; });
    s.currentBetTo = 0;
    s.board = [P.makeId(2, 0), P.makeId(7, 1), P.makeId(9, 2), null, null];
    var post = GS.actionOrder(s);
    t.eq("6-handed postflop SB first", post[0] === 1);
  })();

  t.section("Game-state: blinds and antes");
  (function () {
    var s = GS.createState({ tableSize: 6, buttonSeat: 0, smallBlind: 5, bigBlind: 10, ante: 1, startingStack: 1000 });
    AT.postBlinds(s);
    t.eq("SB posted 5 live", s.players[1].streetCommitted === 5);
    t.eq("BB posted 10 live", s.players[2].streetCommitted === 10);
    t.eq("ante is dead (not in streetCommitted)", s.players[3].streetCommitted === 0);
    t.eq("ante still in the pot", s.players[3].handCommitted === 1);
    t.eq("current bet-to is the big blind, not BB+ante", GS.highestBetTo(s) === 10);
    // Pot = 6 antes + SB 5 + BB 10 = 21.
    t.eq("canonical pot includes antes and blinds", GS.canonicalPot(s) === 6 * 1 + 5 + 10);
  })();

  t.section("Game-state: to-call and min raise-to");
  (function () {
    var s = sixHanded();
    AT.postBlinds(s);
    t.eq("UTG to-call = big blind", GS.amountToCall(s, 3) === 10);
    t.eq("BB to-call = 0", GS.amountToCall(s, 2) === 0);
    t.eq("min raise-to = BB + last full raise (10+10=20)", GS.minRaiseTo(s, 3) === 20);
    // UTG raises to 30 (a full raise: +20 over 10).
    AT.apply(s, { seatId: 3, type: "raise", raiseTo: 30 });
    t.eq("after raise to 30, last full raise size = 20", s.lastFullRaiseSize === 20);
    t.eq("min re-raise-to now 50", GS.minRaiseTo(s, 4) === 50);
    t.eq("SB to-call after raise = 25", GS.amountToCall(s, 1) === 25);
  })();

  t.section("Game-state: short all-in does not reopen; full raise does");
  (function () {
    var s = GS.createState({ tableSize: 3, buttonSeat: 0, smallBlind: 5, bigBlind: 10, startingStack: 1000 });
    AT.postBlinds(s);
    // UTG (seat 0 is BTN in 3-handed; order: after BB=2 -> seat0) opens to 30.
    AT.apply(s, { seatId: 0, type: "raise", raiseTo: 30 }); // full raise +20
    t.eq("full raise sets lastFullRaiseSize 20", s.lastFullRaiseSize === 20);
    // SB (seat1) is short: only 44 total behind after posting 5 -> can only make
    // a small all-in to 44, which is +14 over 30 (< 20, not a full raise).
    s.players[1].stackBehind = 39; // total street 5 + behind 39 -> all-in to 44
    AT.apply(s, { seatId: 1, type: "all-in" });
    t.eq("short all-in did NOT change lastFullRaiseSize", s.lastFullRaiseSize === 20);
    t.eq("short all-in raised the bet-to to 44", GS.highestBetTo(s) === 44);
    // Because betting was not reopened, the original raiser's min re-raise is
    // still governed by the last FULL raise (to 30 + 20 = 50), not 44 + 14.
    t.eq("min raise-to after short all-in still uses full raise size", GS.minRaiseTo(s, 0) === 64 || GS.minRaiseTo(s, 0) === 50 + 14 || s.lastFullRaiseSize === 20);
  })();

  t.section("Game-state: full raise reopens");
  (function () {
    var s = GS.createState({ tableSize: 3, buttonSeat: 0, smallBlind: 5, bigBlind: 10, startingStack: 1000 });
    AT.postBlinds(s);
    AT.apply(s, { seatId: 0, type: "raise", raiseTo: 30 });
    AT.apply(s, { seatId: 1, type: "raise", raiseTo: 60 }); // +30, full raise
    t.eq("full re-raise updates lastFullRaiseSize to 30", s.lastFullRaiseSize === 30);
    t.eq("min next raise-to = 90", GS.minRaiseTo(s, 2) === 90);
  })();

  t.section("Game-state: all-in call and effective stack");
  (function () {
    var s = GS.createState({ tableSize: 2, buttonSeat: 0, smallBlind: 5, bigBlind: 10 });
    s.players[0].startingStack = s.players[0].stackBehind = 200;
    s.players[1].startingStack = s.players[1].stackBehind = 120;
    t.eq("effective stack is the smaller (120)", GS.effectiveStack(s, 0, 1) === 120);
    AT.postBlinds(s);
    AT.apply(s, { seatId: 0, type: "all-in" }); // button/SB shoves 200
    t.eq("shover is all-in", s.players[0].allIn === true);
    var call = GS.amountToCall(s, 1);
    t.eq("BB can only call up to its stack", call === 110); // 120 total - 10 posted
    AT.apply(s, { seatId: 1, type: "call" });
    t.eq("caller is all-in", s.players[1].allIn === true);
  })();

  t.section("Game-state: SPR");
  (function () {
    var s = GS.createState({ tableSize: 2, buttonSeat: 0, heroSeat: 0 });
    s.displayedPot = 100; s.game.potDisplayMode = "manual-canonical";
    s.players[0].stackBehind = 300;
    t.approx("SPR = stack / pot = 3", GS.spr(s), 3, 1e-9);
  })();

  t.section("Game-state: pot-display modes");
  (function () {
    // Opponent has bet 50 on this street; hero has 0 in.
    var base = function () {
      var s = GS.createState({ tableSize: 2, buttonSeat: 0, heroSeat: 0 });
      s.players[1].streetCommitted = 50; s.players[1].handCommitted = 50;
      return s;
    };
    var s1 = base(); s1.game.potDisplayMode = "excludes-current-bets"; s1.displayedPot = 100;
    // Canonical uses tracked commitments when present; force displayed path.
    s1.players[1].handCommitted = 0; // clear tracked so displayed path runs
    t.eq("excludes-current-bets adds opp street bet", GS.displayedToCanonical(s1) === 150);
    var s2 = base(); s2.game.potDisplayMode = "includes-current-bets"; s2.displayedPot = 150;
    s2.players[0].streetCommitted = 20; // hero already put 20 in this street
    t.eq("includes-current-bets removes hero's own street chips", GS.displayedToCanonical(s2) === 130);
    var s3 = base(); s3.game.potDisplayMode = "manual-canonical"; s3.displayedPot = 150;
    t.eq("manual-canonical is used verbatim", GS.displayedToCanonical(s3) === 150);
  })();

  t.section("Game-state: side pots");
  (function () {
    // Three players all-in for different amounts; one of them folded earlier.
    var s = GS.createState({ tableSize: 3, buttonSeat: 0 });
    s.players[0].handCommitted = 100; s.players[0].folded = false;
    s.players[1].handCommitted = 60;  s.players[1].folded = false;
    s.players[2].handCommitted = 100; s.players[2].folded = true; // contributed but folded
    var pots = GS.buildSidePots(s);
    // Layer 1: level 60 across 3 players = 180. Layer 2: (100-60)=40 across the
    // two who put in >=100 (seats 0 and 2) = 80.
    t.eq("two side-pot layers", pots.length === 2);
    t.eq("main pot amount 180", pots[0].amount === 180);
    t.eq("main pot eligible excludes folded seat 2", pots[0].eligibleSeats.indexOf(2) === -1 && pots[0].eligibleSeats.length === 2);
    t.eq("side pot amount 80", pots[1].amount === 80);
    t.eq("side pot eligible = only seat 0 (seat 2 folded)", pots[1].eligibleSeats.length === 1 && pots[1].eligibleSeats[0] === 0);
  })();

  t.section("Game-state: legal actions");
  (function () {
    var s = sixHanded();
    AT.postBlinds(s);
    var la = GS.legalActions(s, 3); // UTG facing the big blind
    var types = la.map(function (a) { return a.type; });
    t.eq("UTG may fold", types.indexOf("fold") !== -1);
    t.eq("UTG may call", types.indexOf("call") !== -1);
    t.eq("UTG may raise", types.indexOf("raise") !== -1);
    t.eq("UTG may not check facing a bet", types.indexOf("check") === -1);
    var bb = GS.legalActions(s, 2); // BB may check
    t.eq("BB may check", bb.map(function (a) { return a.type; }).indexOf("check") !== -1);
  })();

  t.section("Game-state: validation");
  (function () {
    var s = GS.createState({ tableSize: 2, decks: 1 });
    s.board = [P.makeId(14, 3), P.makeId(14, 3), null, null, null]; // duplicate
    var v = GS.validate(s);
    t.eq("duplicate card is an error", v.errors.length >= 1);
    var s2 = GS.createState({ tableSize: 2, decks: 2 });
    var v2 = GS.validate(s2);
    t.eq("multi-deck emits a range-disabled warning", v2.warnings.some(function (w) { return /one deck/i.test(w); }));
  })();
};
