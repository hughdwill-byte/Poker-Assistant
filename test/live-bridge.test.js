/*
 * live-bridge.test.js - pure parts of the cross-tab live bridge
 * (js/live-bridge.js): card id -> text conversion and snapshot sanitisation.
 * The transports (chrome.storage / BroadcastChannel / localStorage) need a
 * browser and are covered by the headless smoke test, not here.
 */
module.exports = function (t) {
  var LB = global.Poker.LiveBridge;

  t.section("LiveBridge.idsToText");
  (function () {
    // ids: (rank<<2)|suit ; suits c=0 d=1 h=2 s=3
    var As = (14 << 2) | 3, Kd = (13 << 2) | 1, Th = (10 << 2) | 2;
    t.equal("As", LB.idToText(As), "As");
    t.equal("Kd", LB.idToText(Kd), "Kd");
    t.equal("Th (ten -> T)", LB.idToText(Th), "Th");
    t.equal("null -> empty", LB.idToText(null), "");
    t.equal("hand joins with spaces", LB.idsToText([As, Kd]), "As Kd");
    t.equal("nulls dropped", LB.idsToText([As, null, Kd]), "As Kd");
    t.equal("empty array -> empty string", LB.idsToText([]), "");
  })();

  t.section("LiveBridge.sanitizeSnapshot");
  (function () {
    var s = LB.sanitizeSnapshot({ hero: "As Kd", board: "4d 3c 9d", players: 6, pot: 40000, toCall: 0, stack: 1000 });
    t.equal("hero preserved", s.hero, "As Kd");
    t.equal("board preserved", s.board, "4d 3c 9d");
    t.equal("players preserved", s.players, 6);
    t.equal("pot preserved", s.pot, 40000);

    var d = LB.sanitizeSnapshot({});
    t.equal("missing hero -> empty", d.hero, "");
    t.equal("players floored to 2", d.players, 2);
    t.equal("pot defaults 0", d.pot, 0);

    var clamp = LB.sanitizeSnapshot({ players: 99, pot: -50, toCall: "12", stack: "abc" });
    t.equal("players clamped to 10", clamp.players, 10);
    t.equal("negative pot floored to 0", clamp.pot, 0);
    t.equal("numeric string toCall parsed", clamp.toCall, 12);
    t.equal("non-numeric stack -> 0", clamp.stack, 0);

    var bad = LB.sanitizeSnapshot({ hero: 123, board: null });
    t.equal("non-string hero -> empty", bad.hero, "");
    t.equal("null board -> empty", bad.board, "");
  })();
};
