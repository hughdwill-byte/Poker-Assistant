/*
 * game-state.js - the canonical, pure Texas Hold'em game-state model.
 *
 * This module owns every piece of poker logic that must be mathematically
 * exact: positions, action order, amount-to-call, minimum legal raises, the
 * short-all-in reopen rule, legal-action generation, effective stacks, SPR,
 * canonical pot derivation and side-pot construction. None of it touches the
 * DOM - the UI reads derived values from here rather than re-deriving them in
 * event handlers.
 *
 * Card ids use the same encoding as evaluator.js:  id = (rank << 2) | suit.
 *
 * Distinct concepts are kept in distinct fields (see docs/game-state-schema.md):
 *   tableSize            seats at the table
 *   dealt-in players     players[i].dealtIn
 *   active players       not folded and dealtIn
 *   all-in players       players[i].allIn
 *   folded players       players[i].folded
 *   streetCommitted      chips put in on THIS street
 *   handCommitted        chips put in across the WHOLE hand
 *   stackBehind          chips still behind
 * A folded player keeps their seat until the hand ends.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  var SCHEMA_VERSION = 2;

  var STREETS = ["preflop", "flop", "turn", "river"];
  var STREET_BOARD = { preflop: 0, flop: 3, turn: 4, river: 5 };

  function clampNum(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  // ---- Construction --------------------------------------------------------

  /**
   * Build a fresh canonical state. All fields are given safe defaults; callers
   * override as they learn more. `tableSize` seats are created, all seated and
   * dealt in by default.
   */
  function createState(opts) {
    opts = opts || {};
    var tableSize = clampNum(opts.tableSize || 6, 2, 10);
    var game = {
      mode: opts.mode || "play-money",
      decks: opts.decks || 1,
      tableSize: tableSize,
      smallBlind: opts.smallBlind || 0,
      bigBlind: opts.bigBlind || 0,
      ante: opts.ante || 0,
      straddle: opts.straddle || 0,
      rakePercent: opts.rakePercent || 0,
      rakeCap: opts.rakeCap || 0,
      potDisplayMode: opts.potDisplayMode || "includes-current-bets",
    };
    var players = [];
    for (var i = 0; i < tableSize; i++) {
      players.push(createPlayer(i, opts.startingStack || 0));
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      handId: opts.handId || ("hand-" + Date.now()),
      heroSeat: opts.heroSeat != null ? opts.heroSeat : 0,
      buttonSeat: opts.buttonSeat != null ? opts.buttonSeat : null,
      street: opts.street || "preflop",
      streetOverride: false,
      game: game,
      board: [null, null, null, null, null],
      deadCards: [],
      displayedPot: 0,
      currentBetTo: 0,
      lastFullRaiseSize: game.bigBlind || 0,
      players: players,
      actions: [],
    };
  }

  function createPlayer(seatId, stack) {
    return {
      seatId: seatId,
      name: "Seat " + (seatId + 1),
      seated: true,
      dealtIn: true,
      active: true,
      folded: false,
      allIn: false,
      cards: [null, null],
      startingStack: stack || 0,
      stackBehind: stack || 0,
      streetCommitted: 0,
      handCommitted: 0,
      profileId: null,
      rangeSpec: null,
    };
  }

  // ---- Derived: street -----------------------------------------------------

  function boardCount(board) {
    var n = 0;
    for (var i = 0; i < board.length; i++) if (board[i] != null) n++;
    return n;
  }

  /** Street implied by the board, unless an explicit override is set. */
  function deriveStreet(state) {
    if (state.streetOverride && state.street) return state.street;
    var n = boardCount(state.board);
    if (n >= 5) return "river";
    if (n === 4) return "turn";
    if (n === 3) return "flop";
    return "preflop";
  }

  // ---- Derived: seat sets ---------------------------------------------------

  function dealtInSeats(state) {
    return state.players.filter(function (p) { return p.seated && p.dealtIn; });
  }
  /** Players still contesting the pot (dealt in, not folded). Includes all-ins. */
  function activeSeats(state) {
    return state.players.filter(function (p) {
      return p.seated && p.dealtIn && !p.folded;
    });
  }
  /** Active players who can still act (not folded, not all-in). */
  function actingSeats(state) {
    return activeSeats(state).filter(function (p) { return !p.allIn; });
  }

  // Ordered seat ids for one full rotation, starting just after `fromSeat` and
  // ending AT `fromSeat`, restricted to dealt-in seats. By default folded and
  // all-in seats are excluded (they cannot act). Position/blind assignment
  // passes includeAllIn+includeFolded so seats keep their identity for the hand.
  function orderFrom(state, fromSeat, includeAllIn, includeFolded) {
    var order = [];
    var n = state.game.tableSize;
    for (var step = 1; step <= n; step++) {
      var seat = (fromSeat + step) % n;
      var p = state.players[seat];
      if (!p || !p.seated || !p.dealtIn) continue;
      if (!includeFolded && p.folded) continue;
      if (!includeAllIn && p.allIn) continue;
      order.push(seat);
    }
    return order;
  }
  // A full dealt-in rotation that ignores fold/all-in state (positions & blinds).
  function dealtOrderFrom(state, fromSeat) {
    return orderFrom(state, fromSeat, true, true);
  }

  // ---- Derived: positions --------------------------------------------------

  var POSITION_LABELS_BY_COUNT = {
    2: ["BTN/SB", "BB"],
    3: ["BTN", "SB", "BB"],
    4: ["BTN", "SB", "BB", "UTG"],
    5: ["BTN", "SB", "BB", "UTG", "CO"],
    6: ["BTN", "SB", "BB", "UTG", "MP", "CO"],
    7: ["BTN", "SB", "BB", "UTG", "MP", "HJ", "CO"],
    8: ["BTN", "SB", "BB", "UTG", "UTG+1", "MP", "HJ", "CO"],
    9: ["BTN", "SB", "BB", "UTG", "UTG+1", "MP", "MP+1", "HJ", "CO"],
    10: ["BTN", "SB", "BB", "UTG", "UTG+1", "MP", "MP+1", "LJ", "HJ", "CO"],
  };

  /**
   * Map each dealt-in seat to a position label. Requires buttonSeat. Returns
   * { seatId: label }. Heads-up uses the BTN/SB combined blind.
   */
  function positionLabels(state) {
    var out = {};
    if (state.buttonSeat == null) return out;
    var seatsInOrder = dealtOrderFrom(state, state.buttonSeat);
    // Button itself first, then the rest in clockwise order.
    var ordered = [state.buttonSeat].concat(seatsInOrder.filter(function (s) {
      return s !== state.buttonSeat;
    }));
    var count = ordered.length;
    var labels = POSITION_LABELS_BY_COUNT[count];
    if (!labels) {
      // Fallback for odd counts: BTN, SB, BB, then UTG..CO generically.
      labels = ["BTN", "SB", "BB"];
      for (var k = 3; k < count; k++) labels.push("P" + (k + 1));
    }
    for (var i = 0; i < count; i++) out[ordered[i]] = labels[i];
    return out;
  }

  /** Seat ids for small blind and big blind given the button and dealt-in seats. */
  function blindSeats(state) {
    if (state.buttonSeat == null) return { sb: null, bb: null };
    var after = dealtOrderFrom(state, state.buttonSeat);
    var dealt = [state.buttonSeat].concat(after.filter(function (s) { return s !== state.buttonSeat; }));
    if (dealt.length === 2) {
      // Heads-up: button is the small blind, the other seat is the big blind.
      return { sb: state.buttonSeat, bb: dealt[1] };
    }
    return { sb: after[0] != null ? after[0] : null, bb: after[1] != null ? after[1] : null };
  }

  // ---- Derived: action order -----------------------------------------------

  /**
   * The seats that act on the current street, in order, restricted to players
   * who can still act. Blinds/button drive the first actor.
   */
  function actionOrder(state) {
    var street = deriveStreet(state);
    var blinds = blindSeats(state);
    var isHU = dealtInSeats(state).length === 2;
    var firstAnchor;
    if (street === "preflop") {
      if (isHU) {
        firstAnchor = state.buttonSeat; // BTN/SB acts first pre-flop heads-up
      } else {
        // First to act is the seat after the big blind (UTG).
        firstAnchor = blinds.bb != null ? blinds.bb : state.buttonSeat;
      }
    } else {
      if (isHU) {
        // Post-flop heads-up the big blind (non-button) acts first.
        firstAnchor = blinds.bb != null ? blinds.bb : state.buttonSeat;
        // orderFrom starts AFTER the anchor, so anchor on the seat before BB.
        return rotateActing(state, blinds.bb);
      }
      // Post-flop: first active seat after the button (normally the SB).
      firstAnchor = state.buttonSeat;
    }
    if (firstAnchor == null) {
      // No button known: fall back to seat order among actors.
      return actingSeats(state).map(function (p) { return p.seatId; });
    }
    if (street === "preflop" && !isHU) {
      return orderFrom(state, blinds.bb, false);
    }
    if (street !== "preflop" && !isHU) {
      return orderFrom(state, state.buttonSeat, false);
    }
    return orderFrom(state, firstAnchor === state.buttonSeat ? prevDealtSeat(state, state.buttonSeat) : firstAnchor, false);
  }

  // Build an acting order that begins AT `seat` (inclusive) if it can act.
  function rotateActing(state, seat) {
    if (seat == null) return actingSeats(state).map(function (p) { return p.seatId; });
    var start = prevDealtSeat(state, seat);
    return orderFrom(state, start, false);
  }
  function prevDealtSeat(state, seat) {
    var n = state.game.tableSize;
    for (var step = 1; step <= n; step++) {
      var s = (seat - step + n) % n;
      var p = state.players[s];
      if (p && p.seated && p.dealtIn) return s;
    }
    return seat;
  }

  // ---- Derived: betting amounts --------------------------------------------

  /** Highest street contribution among dealt-in players (the current bet-to). */
  function highestBetTo(state) {
    var hi = 0;
    state.players.forEach(function (p) {
      if (p.seated && p.dealtIn && p.streetCommitted > hi) hi = p.streetCommitted;
    });
    return Math.max(hi, state.currentBetTo || 0);
  }

  /** Chips seat `seatId` must add to call the current bet (never negative). */
  function amountToCall(state, seatId) {
    var p = state.players[seatId];
    if (!p) return 0;
    var need = highestBetTo(state) - p.streetCommitted;
    return Math.max(0, Math.min(need, p.stackBehind));
  }

  /**
   * Minimum legal raise-TO amount for the given seat. Standard rule:
   *   minRaiseTo = currentBetTo + lastFullRaiseSize
   * capped so a player who cannot cover it may still move all-in for less.
   */
  function minRaiseTo(state, seatId) {
    var p = state.players[seatId];
    var betTo = highestBetTo(state);
    var fullRaise = state.lastFullRaiseSize || state.game.bigBlind || betTo || 1;
    var target = betTo + fullRaise;
    if (!p) return target;
    var maxTo = p.streetCommitted + p.stackBehind; // hero's all-in bet-to
    if (maxTo < target) return maxTo; // short all-in exception
    return target;
  }

  /**
   * Whether a raise TO `toAmount` by `seatId` is a FULL raise (>= a full raise
   * increment over the current bet). A short all-in that is not a full raise
   * does NOT reopen the betting for players who already acted.
   */
  function isFullRaise(state, seatId, toAmount) {
    var betTo = highestBetTo(state);
    var fullRaise = state.lastFullRaiseSize || state.game.bigBlind || 1;
    return toAmount - betTo >= fullRaise - 1e-9;
  }

  // ---- Derived: legal actions ----------------------------------------------

  /**
   * Legal actions for a seat given the canonical state. Returns an array of
   * { type, toAmount?, amountAdded?, min?, max? }. Illegal or impossible
   * actions are omitted, so the UI can render buttons straight from this.
   */
  function legalActions(state, seatId) {
    var p = state.players[seatId];
    var out = [];
    if (!p || !p.seated || !p.dealtIn || p.folded || p.allIn || p.stackBehind <= 0) return out;
    var toCall = amountToCall(state, seatId);
    var betTo = highestBetTo(state);
    var behind = p.stackBehind;

    if (toCall > 0) out.push({ type: "fold" });
    if (toCall === 0) {
      out.push({ type: "check" });
    } else {
      var callAmt = Math.min(toCall, behind);
      out.push({ type: "call", amountAdded: callAmt, toAmount: p.streetCommitted + callAmt, allIn: callAmt >= behind });
    }

    // Raising / betting is only possible with chips left beyond the call.
    if (behind > toCall) {
      var minTo = minRaiseTo(state, seatId);
      var maxTo = p.streetCommitted + behind; // all-in bet-to
      if (betTo === 0) {
        // Opening bet.
        var minBet = Math.min(state.game.bigBlind || 1, behind);
        out.push({ type: "bet", min: p.streetCommitted + minBet, max: maxTo, minTo: p.streetCommitted + minBet, maxTo: maxTo });
      } else {
        out.push({ type: "raise", min: minTo, max: maxTo, minTo: minTo, maxTo: maxTo });
      }
      out.push({ type: "all-in", toAmount: maxTo, amountAdded: behind });
    }
    return out;
  }

  // ---- Derived: stacks, SPR ------------------------------------------------

  /** Effective stack between the hero and a specific opponent (total commitable). */
  function effectiveStack(state, heroSeat, oppSeat) {
    var h = state.players[heroSeat], o = state.players[oppSeat];
    if (!h || !o) return 0;
    var heroTotal = h.stackBehind + h.handCommitted;
    var oppTotal = o.stackBehind + o.handCommitted;
    return Math.min(heroTotal, oppTotal);
  }

  /** Smallest effective stack the hero faces among still-active opponents. */
  function heroEffectiveStack(state) {
    var hero = state.heroSeat;
    var eff = Infinity;
    activeSeats(state).forEach(function (p) {
      if (p.seatId === hero) return;
      eff = Math.min(eff, effectiveStack(state, hero, p.seatId));
    });
    if (eff === Infinity) {
      var h = state.players[hero];
      return h ? h.stackBehind + h.handCommitted : 0;
    }
    return eff;
  }

  /** Stack-to-pot ratio: remaining effective stack over the canonical pot. */
  function spr(state) {
    var pot = canonicalPot(state);
    if (pot <= 0) return Infinity;
    var hero = state.players[state.heroSeat];
    var behind = hero ? hero.stackBehind : 0;
    return behind / pot;
  }

  // ---- Derived: canonical pot ----------------------------------------------

  /** Sum of every player's whole-hand contribution. Always includes bets. */
  function totalCommitted(state) {
    var t = 0;
    state.players.forEach(function (p) { t += p.handCommitted; });
    return t;
  }
  /** Sum of current-street contributions. */
  function streetCommittedTotal(state) {
    var t = 0;
    state.players.forEach(function (p) { t += p.streetCommitted; });
    return t;
  }

  /**
   * Canonical pot BEFORE the hero adds new chips = every chip already in the
   * middle that the hero can win, including opponents' current-street bets but
   * excluding the hero's pending call. This is the `P` used by action-ev.js.
   *
   * If commitments are tracked we use them (authoritative). Otherwise we fall
   * back to the displayed pot interpreted by potDisplayMode.
   */
  function canonicalPot(state) {
    var tc = totalCommitted(state);
    if (tc > 0) return tc;
    return displayedToCanonical(state);
  }

  /** Convert a displayed pot to the canonical pot-before-hero-action. */
  function displayedToCanonical(state) {
    var pot = state.displayedPot || 0;
    var heroStreet = state.players[state.heroSeat] ? state.players[state.heroSeat].streetCommitted : 0;
    switch (state.game.potDisplayMode) {
      case "excludes-current-bets": {
        // Displayed pot is prior-street chips only; add opponents' street bets.
        var oppStreet = streetCommittedTotal(state) - heroStreet;
        return pot + oppStreet;
      }
      case "manual-canonical":
        return pot; // already canonical-before-hero
      case "includes-current-bets":
      default:
        // Displayed pot already contains current bets INCLUDING the hero's own
        // street contribution; remove the hero's own to avoid winning own chips.
        return Math.max(0, pot - heroStreet);
    }
  }

  // ---- Derived: side pots ---------------------------------------------------

  /**
   * Build side-pot layers from each player's whole-hand contribution. Folded
   * players' chips still form part of the pot but they are not eligible to win.
   * Returns [{ amount, contributingSeats, eligibleSeats }].
   */
  function buildSidePots(state) {
    var contribs = state.players
      .filter(function (p) { return p.seated && p.handCommitted > 0; })
      .map(function (p) { return { seatId: p.seatId, amount: p.handCommitted, folded: p.folded }; });
    if (!contribs.length) return [];
    var levels = [];
    contribs.forEach(function (c) { if (levels.indexOf(c.amount) === -1) levels.push(c.amount); });
    levels.sort(function (a, b) { return a - b; });

    var pots = [];
    var prev = 0;
    for (var i = 0; i < levels.length; i++) {
      var level = levels[i];
      var slice = level - prev;
      if (slice <= 0) { prev = level; continue; }
      var contributing = contribs.filter(function (c) { return c.amount >= level; });
      var amount = slice * contributing.length;
      var eligible = contributing
        .filter(function (c) { return !c.folded; })
        .map(function (c) { return c.seatId; });
      pots.push({
        amount: amount,
        contributingSeats: contributing.map(function (c) { return c.seatId; }),
        eligibleSeats: eligible,
      });
      prev = level;
    }
    return pots;
  }

  // ---- Validation -----------------------------------------------------------

  /**
   * Check the state for contradictions. Returns { warnings:[], errors:[] }.
   * Errors mean a calculation would be wrong; warnings are advisory.
   */
  function validate(state) {
    var warnings = [], errors = [];
    // Duplicate cards.
    var seen = {};
    var pushCard = function (id, where) {
      if (id == null) return;
      seen[id] = (seen[id] || 0) + 1;
      if (seen[id] > state.game.decks) errors.push("Card " + labelSafe(id) + " appears more than " + state.game.decks + " deck(s) allow (" + where + ").");
    };
    state.board.forEach(function (c) { pushCard(c, "board"); });
    state.deadCards.forEach(function (c) { pushCard(c, "dead"); });
    state.players.forEach(function (p) {
      p.cards.forEach(function (c) { pushCard(c, "seat " + (p.seatId + 1)); });
    });

    // Negative amounts.
    state.players.forEach(function (p) {
      if (p.stackBehind < 0) errors.push("Seat " + (p.seatId + 1) + " has a negative stack.");
      if (p.streetCommitted < 0 || p.handCommitted < 0) errors.push("Seat " + (p.seatId + 1) + " has a negative commitment.");
      if (p.streetCommitted > p.handCommitted + 1e-9) warnings.push("Seat " + (p.seatId + 1) + " street commitment exceeds hand commitment.");
    });

    // Active count.
    if (activeSeats(state).length < 1) warnings.push("No active players remain.");

    // Button required for positions.
    if (state.buttonSeat == null) warnings.push("Button seat unknown - positions and action order are unavailable.");

    // Pot-display consistency: compare tracked commitments to the displayed pot.
    if (state.displayedPot > 0 && totalCommitted(state) > 0) {
      var canon = displayedToCanonical(state);
      var tracked = canonicalPot(state);
      if (Math.abs(canon - tracked) > Math.max(2, 0.05 * tracked)) {
        warnings.push("Displayed pot (" + state.displayedPot + ") and tracked commitments (" + tracked + ") disagree - check the pot-display convention.");
      }
    }

    // Advanced range logic only supports one deck.
    if (state.game.decks > 1) warnings.push("Range modelling and advanced strategy are disabled for more than one deck - showing uniform equity only.");

    return { warnings: warnings, errors: errors };
  }

  function labelSafe(id) {
    return (Poker.cardLabel ? Poker.cardLabel(id) : ("#" + id));
  }

  // ---- Exports --------------------------------------------------------------

  Poker.GameState = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STREETS: STREETS,
    STREET_BOARD: STREET_BOARD,
    createState: createState,
    createPlayer: createPlayer,
    deriveStreet: deriveStreet,
    boardCount: boardCount,
    dealtInSeats: dealtInSeats,
    activeSeats: activeSeats,
    actingSeats: actingSeats,
    orderFrom: orderFrom,
    positionLabels: positionLabels,
    blindSeats: blindSeats,
    actionOrder: actionOrder,
    highestBetTo: highestBetTo,
    amountToCall: amountToCall,
    minRaiseTo: minRaiseTo,
    isFullRaise: isFullRaise,
    legalActions: legalActions,
    effectiveStack: effectiveStack,
    heroEffectiveStack: heroEffectiveStack,
    spr: spr,
    canonicalPot: canonicalPot,
    displayedToCanonical: displayedToCanonical,
    totalCommitted: totalCommitted,
    streetCommittedTotal: streetCommittedTotal,
    buildSidePots: buildSidePots,
    validate: validate,
  };
})(typeof self !== "undefined" ? self : this);
