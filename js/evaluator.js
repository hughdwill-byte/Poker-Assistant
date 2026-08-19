/*
 * evaluator.js - 7-card Texas Hold'em hand evaluator.
 *
 * Works in both the main window and inside a Web Worker (loaded via
 * importScripts). Everything is attached to the shared `Poker` namespace on
 * `self` so there is a single source of truth for the maths.
 *
 * Card encoding
 * -------------
 * A card is a single integer id:  id = (rank << 2) | suit
 *   rank : 2..14  (11=J, 12=Q, 13=K, 14=A)
 *   suit : 0..3   (0=clubs, 1=diamonds, 2=hearts, 3=spades)
 * so id ranges 8..59. rank = id >> 2, suit = id & 3.
 *
 * Hand score encoding
 * -------------------
 * evaluate7() returns a single integer where a larger number is a strictly
 * stronger hand. The value packs a category and up to five ordered rank
 * tie-breakers in base 16:
 *   score = ((((category*16 + r1)*16 + r2)*16 + r3)*16 + r4)*16 + r5
 * Because the category sits in the most significant position it always
 * dominates the comparison, and within a category every hand emits the same
 * number of tie-breakers so the ordering is exact. This is the standard,
 * provably-correct way to totally order poker hands.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  // Hand categories (index = strength, higher is better).
  var CATEGORY = {
    HIGH_CARD: 0,
    PAIR: 1,
    TWO_PAIR: 2,
    TRIPS: 3,
    STRAIGHT: 4,
    FLUSH: 5,
    FULL_HOUSE: 6,
    QUADS: 7,
    STRAIGHT_FLUSH: 8,
    FIVE_KIND: 9, // only reachable with multi-deck play
  };
  Poker.CATEGORY = CATEGORY;

  var CATEGORY_NAME = [
    "High Card",
    "Pair",
    "Two Pair",
    "Three of a Kind",
    "Straight",
    "Flush",
    "Full House",
    "Four of a Kind",
    "Straight Flush",
    "Five of a Kind",
  ];

  var RANK_NAME = {
    2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
    10: "10", 11: "Jack", 12: "Queen", 13: "King", 14: "Ace",
  };
  var RANK_NAME_PLURAL = {
    2: "2s", 3: "3s", 4: "4s", 5: "5s", 6: "6s", 7: "7s", 8: "8s", 9: "9s",
    10: "10s", 11: "Jacks", 12: "Queens", 13: "Kings", 14: "Aces",
  };

  function popcount(x) {
    var c = 0;
    while (x) { x &= x - 1; c++; }
    return c;
  }

  // Highest card of the best straight contained in a rank bit-mask, else 0.
  // Handles the wheel (A-2-3-4-5) by mirroring the Ace as a low card.
  function straightHigh(mask) {
    var m = mask;
    if (m & (1 << 14)) m |= (1 << 1); // Ace plays low
    for (var hi = 14; hi >= 5; hi--) {
      var need =
        (1 << hi) | (1 << (hi - 1)) | (1 << (hi - 2)) |
        (1 << (hi - 3)) | (1 << (hi - 4));
      if ((m & need) === need) return hi;
    }
    return 0;
  }

  // Top `count` set ranks (descending) from a rank bit-mask.
  function topRanks(mask, count) {
    var out = [];
    for (var r = 14; r >= 2 && out.length < count; r--) {
      if (mask & (1 << r)) out.push(r);
    }
    return out;
  }

  // Highest `count` ranks with at least one card, skipping `exclude` ranks.
  function kickers(rankCount, exclude, count) {
    var out = [];
    for (var r = 14; r >= 2 && out.length < count; r--) {
      if (rankCount[r] > 0 && exclude.indexOf(r) === -1) out.push(r);
    }
    return out;
  }

  function pack(category, ranks) {
    var score = category;
    for (var i = 0; i < 5; i++) score = score * 16 + (ranks[i] || 0);
    return score;
  }

  /**
   * Evaluate the best 5-card hand from 5, 6 or 7 cards.
   * @param {number[]} cards integer card ids
   * @returns {number} packed comparable score
   */
  function evaluate7(cards) {
    var rankCount = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    var suitMask = [0, 0, 0, 0]; // rank bit-mask per suit
    var distinct = 0;
    var i, c, r, s;

    for (i = 0; i < cards.length; i++) {
      c = cards[i];
      r = c >> 2;
      s = c & 3;
      rankCount[r]++;
      suitMask[s] |= 1 << r;
      distinct |= 1 << r;
    }

    // Flush suit (if any).
    var flushSuit = -1;
    for (s = 0; s < 4; s++) {
      if (popcount(suitMask[s]) >= 5) { flushSuit = s; break; }
    }

    // Straight flush.
    if (flushSuit >= 0) {
      var sfHigh = straightHigh(suitMask[flushSuit]);
      if (sfHigh) return pack(CATEGORY.STRAIGHT_FLUSH, [sfHigh]);
    }

    // Five of a kind (multi-deck only).
    for (r = 14; r >= 2; r--) {
      if (rankCount[r] >= 5) return pack(CATEGORY.FIVE_KIND, [r]);
    }

    // Four of a kind.
    for (r = 14; r >= 2; r--) {
      if (rankCount[r] === 4) {
        return pack(CATEGORY.QUADS, [r].concat(kickers(rankCount, [r], 1)));
      }
    }

    // Collect trips and pairs (descending).
    var trips = [], pairs = [];
    for (r = 14; r >= 2; r--) {
      if (rankCount[r] === 3) trips.push(r);
      else if (rankCount[r] === 2) pairs.push(r);
    }

    // Full house (trips + best remaining pair, or a second set of trips).
    if (trips.length >= 1 && (trips.length >= 2 || pairs.length >= 1)) {
      var t = trips[0];
      var pairPart = Math.max(
        trips.length >= 2 ? trips[1] : 0,
        pairs.length >= 1 ? pairs[0] : 0
      );
      return pack(CATEGORY.FULL_HOUSE, [t, pairPart]);
    }

    // Flush.
    if (flushSuit >= 0) {
      return pack(CATEGORY.FLUSH, topRanks(suitMask[flushSuit], 5));
    }

    // Straight.
    var stHigh = straightHigh(distinct);
    if (stHigh) return pack(CATEGORY.STRAIGHT, [stHigh]);

    // Three of a kind.
    if (trips.length >= 1) {
      return pack(CATEGORY.TRIPS, [trips[0]].concat(kickers(rankCount, [trips[0]], 2)));
    }

    // Two pair.
    if (pairs.length >= 2) {
      var p1 = pairs[0], p2 = pairs[1];
      return pack(CATEGORY.TWO_PAIR, [p1, p2].concat(kickers(rankCount, [p1, p2], 1)));
    }

    // One pair.
    if (pairs.length === 1) {
      return pack(CATEGORY.PAIR, [pairs[0]].concat(kickers(rankCount, [pairs[0]], 3)));
    }

    // High card.
    return pack(CATEGORY.HIGH_CARD, kickers(rankCount, [], 5));
  }

  // Decode a packed score into { category, ranks[] }.
  function unpack(score) {
    var ranks = [];
    for (var i = 0; i < 5; i++) {
      ranks.unshift(score % 16);
      score = Math.floor(score / 16);
    }
    return { category: score, ranks: ranks };
  }

  // Human-readable description of a packed score.
  function handName(score) {
    var u = unpack(score);
    var r = u.ranks;
    switch (u.category) {
      case CATEGORY.FIVE_KIND:
        return "Five of a Kind, " + RANK_NAME_PLURAL[r[0]];
      case CATEGORY.STRAIGHT_FLUSH:
        return r[0] === 14
          ? "Royal Flush"
          : "Straight Flush, " + RANK_NAME[r[0]] + " high";
      case CATEGORY.QUADS:
        return "Four of a Kind, " + RANK_NAME_PLURAL[r[0]];
      case CATEGORY.FULL_HOUSE:
        return "Full House, " + RANK_NAME_PLURAL[r[0]] + " over " + RANK_NAME_PLURAL[r[1]];
      case CATEGORY.FLUSH:
        return "Flush, " + RANK_NAME[r[0]] + " high";
      case CATEGORY.STRAIGHT:
        return "Straight, " + RANK_NAME[r[0]] + " high";
      case CATEGORY.TRIPS:
        return "Three of a Kind, " + RANK_NAME_PLURAL[r[0]];
      case CATEGORY.TWO_PAIR:
        return "Two Pair, " + RANK_NAME_PLURAL[r[0]] + " and " + RANK_NAME_PLURAL[r[1]];
      case CATEGORY.PAIR:
        return "Pair of " + RANK_NAME_PLURAL[r[0]];
      default:
        return RANK_NAME[r[0]] + " high";
    }
  }

  Poker.evaluate7 = evaluate7;
  Poker.handName = handName;
  Poker.handCategoryName = function (score) { return CATEGORY_NAME[unpack(score).category]; };
  Poker.unpackScore = unpack;
})(typeof self !== "undefined" ? self : this);
