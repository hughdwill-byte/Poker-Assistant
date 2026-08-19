/*
 * cards.js - card id helpers and deck (multiset) construction.
 * Shared by the window and the Web Worker via the `Poker` namespace.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  // Display order for the picker.
  var RANKS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  var SUITS = [3, 2, 1, 0]; // spades, hearts, diamonds, clubs
  var SUIT_SYMBOL = { 0: "♣", 1: "♦", 2: "♥", 3: "♠" }; // ♣ ♦ ♥ ♠
  var SUIT_NAME = { 0: "clubs", 1: "diamonds", 2: "hearts", 3: "spades" };
  var SUIT_COLOR = { 0: "black", 1: "red", 2: "red", 3: "black" };
  var RANK_LABEL = {
    14: "A", 13: "K", 12: "Q", 11: "J", 10: "10",
    9: "9", 8: "8", 7: "7", 6: "6", 5: "5", 4: "4", 3: "3", 2: "2",
  };

  function makeId(rank, suit) { return (rank << 2) | suit; }
  function rankOf(id) { return id >> 2; }
  function suitOf(id) { return id & 3; }

  // The 52 distinct card ids of a single deck.
  var FULL_DECK = [];
  for (var ri = 0; ri < RANKS.length; ri++) {
    for (var si = 0; si < SUITS.length; si++) {
      FULL_DECK.push(makeId(RANKS[ri], SUITS[si]));
    }
  }

  function cardLabel(id) { return RANK_LABEL[rankOf(id)] + SUIT_SYMBOL[suitOf(id)]; }

  /**
   * Build the remaining deck as a flat array of card ids.
   * @param {number} decks         number of full decks in play
   * @param {number[]} removed     ids already visible/dealt/dead (each removes one copy)
   * @returns {number[]} flat multiset of the cards still live
   */
  function buildRemaining(decks, removed) {
    var counts = {}; // id -> copies remaining
    var i, id;
    for (i = 0; i < FULL_DECK.length; i++) counts[FULL_DECK[i]] = decks;
    for (i = 0; i < removed.length; i++) {
      id = removed[i];
      if (counts[id] > 0) counts[id]--;
    }
    var pool = [];
    for (id in counts) {
      var n = counts[id];
      var num = +id;
      for (var k = 0; k < n; k++) pool.push(num);
    }
    return pool;
  }

  Poker.RANKS = RANKS;
  Poker.SUITS = SUITS;
  Poker.SUIT_SYMBOL = SUIT_SYMBOL;
  Poker.SUIT_NAME = SUIT_NAME;
  Poker.SUIT_COLOR = SUIT_COLOR;
  Poker.RANK_LABEL = RANK_LABEL;
  Poker.FULL_DECK = FULL_DECK;
  Poker.makeId = makeId;
  Poker.rankOf = rankOf;
  Poker.suitOf = suitOf;
  Poker.cardLabel = cardLabel;
  Poker.buildRemaining = buildRemaining;
})(typeof self !== "undefined" ? self : this);
