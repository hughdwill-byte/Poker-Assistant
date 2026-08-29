/*
 * hand-features.js - exact, combinatorial made-hand and draw/board-texture
 * features from a hero's hole cards and the board.
 *
 * These features are explanatory and drive opponent-likelihood reasoning. They
 * are NOT a substitute for equity - never treat "top pair" as a win
 * probability. Everything is derived from the actual card ids, not a heuristic
 * score.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  var rankOf = Poker.rankOf, suitOf = Poker.suitOf, evaluate7 = Poker.evaluate7;
  var CATEGORY = Poker.CATEGORY;

  function rankMask(cards) {
    var m = 0;
    for (var i = 0; i < cards.length; i++) m |= 1 << rankOf(cards[i]);
    return m;
  }
  function straightHigh(mask) {
    var m = mask;
    if (m & (1 << 14)) m |= (1 << 1);
    for (var hi = 14; hi >= 5; hi--) {
      var need = (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) | (1 << (hi - 3)) | (1 << (hi - 4));
      if ((m & need) === need) return hi;
    }
    return 0;
  }
  function suitCounts(cards) {
    var s = [0, 0, 0, 0];
    for (var i = 0; i < cards.length; i++) s[suitOf(cards[i])]++;
    return s;
  }
  function rankCounts(cards) {
    var c = {};
    for (var i = 0; i < cards.length; i++) { var r = rankOf(cards[i]); c[r] = (c[r] || 0) + 1; }
    return c;
  }
  function distinctRanksDesc(cards) {
    var seen = {}, out = [];
    cards.forEach(function (c) { seen[rankOf(c)] = true; });
    for (var r = 14; r >= 2; r--) if (seen[r]) out.push(r);
    return out;
  }

  // ---- Made hand -----------------------------------------------------------

  function madeHand(hole, board) {
    if (hole.length < 2 || board.length < 3) return null;
    var score = evaluate7(hole.concat(board));
    return { score: score, category: Poker.unpackScore(score).category, name: Poker.handName(score) };
  }

  // Classify a pair the hero holds relative to the board.
  function pairPosition(hole, board) {
    if (hole.length < 2 || board.length < 3) return null;
    var boardRanks = distinctRanksDesc(board);
    var h0 = rankOf(hole[0]), h1 = rankOf(hole[1]);
    var pocket = h0 === h1;
    var boardMax = boardRanks[0];

    if (pocket) {
      if (h0 > boardMax) return "overpair";
      if (boardRanks.indexOf(h0) !== -1) return "set"; // pocket pair matches a board rank
      return "underpair";
    }
    // Non-pocket: does a hole rank pair the board?
    var hits = [];
    if (boardRanks.indexOf(h0) !== -1) hits.push(h0);
    if (boardRanks.indexOf(h1) !== -1) hits.push(h1);
    if (!hits.length) return "none";
    var paired = Math.max.apply(null, hits);
    if (paired === boardRanks[0]) return "top-pair";
    if (paired === boardRanks[boardRanks.length - 1]) return "bottom-pair";
    return "middle-pair";
  }

  function kickerStrength(hole) {
    // Higher of the two hole cards as a coarse kicker indicator (0..1).
    var hi = Math.max(rankOf(hole[0]), rankOf(hole[1]));
    return (hi - 2) / 12;
  }

  function overcards(hole, board) {
    if (board.length < 3) return 0;
    var boardMax = Math.max.apply(null, board.map(rankOf));
    var n = 0;
    hole.forEach(function (c) { if (rankOf(c) > boardMax) n++; });
    return n;
  }

  // ---- Flush features ------------------------------------------------------

  function flushFeatures(hole, board) {
    var all = hole.concat(board);
    var sc = suitCounts(all);
    var holeSuits = suitCounts(hole);
    var out = { flush: false, flushDraw: false, backdoorFlushDraw: false, nutFlushDraw: false, flushSuit: -1 };
    for (var s = 0; s < 4; s++) {
      if (sc[s] >= 5) { out.flush = true; out.flushSuit = s; }
      else if (sc[s] === 4 && holeSuits[s] >= 1 && board.length < 5) { out.flushDraw = true; out.flushSuit = s; }
      else if (sc[s] === 3 && holeSuits[s] >= 1 && board.length === 3) { out.backdoorFlushDraw = true; }
    }
    if (out.flushDraw && out.flushSuit >= 0) {
      // Nut flush draw: hero holds the highest card of the suit not yet visible.
      var suit = out.flushSuit;
      var onBoardOrHole = {};
      board.concat(hole).forEach(function (c) { if (suitOf(c) === suit) onBoardOrHole[rankOf(c)] = true; });
      var holeRanksInSuit = hole.filter(function (c) { return suitOf(c) === suit; }).map(rankOf);
      // The nut is the highest suit rank not already on the board; check hero holds it.
      for (var r = 14; r >= 2; r--) {
        var onBoard = board.some(function (c) { return suitOf(c) === suit && rankOf(c) === r; });
        if (onBoard) continue;
        out.nutFlushDraw = holeRanksInSuit.indexOf(r) !== -1;
        break;
      }
    }
    return out;
  }

  // ---- Straight features ---------------------------------------------------

  function straightFeatures(hole, board) {
    var all = hole.concat(board);
    var mask = rankMask(all);
    var out = { straight: straightHigh(mask) !== 0, oesd: false, gutshot: false, doubleGutshot: false, straightOuts: 0, completingRanks: [] };
    if (out.straight) return out;
    var completing = [];
    for (var cr = 2; cr <= 14; cr++) {
      if (mask & (1 << cr)) continue;
      if (straightHigh(mask | (1 << cr))) completing.push(cr);
    }
    out.completingRanks = completing;
    out.straightOuts = completing.length * 4; // approx card outs (ranks x 4)
    if (completing.length === 1) { out.gutshot = true; }
    else if (completing.length >= 2) {
      // OESD if four consecutive ranks are present (draw open on both ends);
      // otherwise two separate gaps -> double gutshot (both give ~8 outs).
      var fourRun = false;
      for (var hi = 14; hi >= 5; hi--) {
        var run = (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) | (1 << (hi - 3));
        // include ace-low
        var m2 = mask; if (m2 & (1 << 14)) m2 |= (1 << 1);
        if ((m2 & run) === run) { fourRun = true; break; }
      }
      if (fourRun) out.oesd = true; else out.doubleGutshot = true;
    }
    return out;
  }

  // ---- Board texture (board only) ------------------------------------------

  function boardTexture(board) {
    var b = board.filter(function (c) { return c != null; });
    var out = {
      count: b.length, rainbow: false, twoTone: false, monotone: false,
      paired: false, doublePaired: false, trips: false,
      connectivity: 0, possibleFlush: false, possibleStraight: false,
    };
    if (!b.length) return out;
    var sc = suitCounts(b);
    var maxSuit = Math.max.apply(null, sc);
    var suitsPresent = sc.filter(function (x) { return x > 0; }).length;
    out.monotone = maxSuit >= 3 && suitsPresent === 1;
    out.twoTone = suitsPresent === 2;
    out.rainbow = suitsPresent >= 3;
    out.possibleFlush = maxSuit >= 3;

    var rc = rankCounts(b);
    var pairs = 0, hasTrips = false;
    Object.keys(rc).forEach(function (r) { if (rc[r] === 2) pairs++; if (rc[r] >= 3) hasTrips = true; });
    out.paired = pairs >= 1 || hasTrips;
    out.doublePaired = pairs >= 2;
    out.trips = hasTrips;

    var ranks = distinctRanksDesc(b);
    out.connectivity = ranks.length > 1 ? ranks[0] - ranks[ranks.length - 1] : 0;
    // Possible straight if any 5-window contains >=3 board ranks.
    var mask = rankMask(b);
    var m2 = mask; if (m2 & (1 << 14)) m2 |= (1 << 1);
    for (var hi = 14; hi >= 5; hi--) {
      var need = 0, present = 0;
      for (var k = 0; k < 5; k++) { var bit = 1 << (hi - k); need++; if (m2 & bit) present++; }
      if (present >= 3) { out.possibleStraight = true; break; }
    }
    return out;
  }

  // ---- Blocker / nut potential ---------------------------------------------

  function blockers(hole, board) {
    // Does the hero hold cards that block opponents' nut hands?
    var out = { nutFlushBlocker: false, topSetBlocker: false, straightBlockers: [] };
    var tex = boardTexture(board);
    if (tex.possibleFlush) {
      // Find the flushing suit; hero blocks the nut flush if holding the Ace.
      var sc = suitCounts(board);
      for (var s = 0; s < 4; s++) {
        if (sc[s] >= 3) {
          var aceOfSuit = Poker.makeId(14, s);
          if (hole.indexOf(aceOfSuit) !== -1) out.nutFlushBlocker = true;
        }
      }
    }
    return out;
  }

  /** Full feature bundle for a hero situation. */
  function extract(hole, board) {
    hole = (hole || []).filter(function (c) { return c != null; });
    board = (board || []).filter(function (c) { return c != null; });
    return {
      made: madeHand(hole, board),
      pair: pairPosition(hole, board),
      kicker: hole.length === 2 ? kickerStrength(hole) : 0,
      overcards: overcards(hole, board),
      flush: flushFeatures(hole, board),
      straight: straightFeatures(hole, board),
      texture: boardTexture(board),
      blockers: blockers(hole, board),
      comboDraw: (function () {
        var f = flushFeatures(hole, board), s = straightFeatures(hole, board);
        return f.flushDraw && (s.oesd || s.gutshot || s.doubleGutshot);
      })(),
    };
  }

  Poker.HandFeatures = {
    extract: extract,
    madeHand: madeHand,
    pairPosition: pairPosition,
    flushFeatures: flushFeatures,
    straightFeatures: straightFeatures,
    boardTexture: boardTexture,
    blockers: blockers,
    overcards: overcards,
    kickerStrength: kickerStrength,
  };
})(typeof self !== "undefined" ? self : this);
