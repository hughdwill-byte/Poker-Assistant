/*
 * action-tracker.js - apply a chronological stream of poker actions to a
 * canonical game-state, keeping every commitment, the current bet-to and the
 * last full raise size correct. All mutations are recorded so they can be
 * undone. This is the single place that changes commitments; the UI never
 * edits them directly.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  var GS = Poker.GameState;

  function nextSeq(state) {
    return state.actions.length ? state.actions[state.actions.length - 1].sequence + 1 : 1;
  }

  // Move `amount` from a player's stack into the pot, updating commitments.
  function commit(state, player, amount) {
    amount = Math.max(0, Math.min(amount, player.stackBehind));
    player.stackBehind -= amount;
    player.streetCommitted += amount;
    player.handCommitted += amount;
    if (player.stackBehind <= 1e-9) { player.stackBehind = 0; player.allIn = true; }
    return amount;
  }

  // Post "dead" money (antes): it enters the pot (handCommitted) but does NOT
  // count as a live bet that others must match, so it never touches
  // streetCommitted or the current bet-to.
  function commitDead(state, player, amount) {
    amount = Math.max(0, Math.min(amount, player.stackBehind));
    player.stackBehind -= amount;
    player.handCommitted += amount;
    if (player.stackBehind <= 1e-9) { player.stackBehind = 0; player.allIn = true; }
    return amount;
  }

  /**
   * Apply one action. `action` = { seatId, type, amount?, raiseTo?, source?,
   * confidence? }. For "bet"/"raise" pass a raiseTo (preferred) OR an amount
   * that is a "raise by" increment; `raiseByMeans` selects interpretation for
   * ambiguous callers. Returns the recorded action or { error }.
   */
  function apply(state, action) {
    var p = state.players[action.seatId];
    if (!p) return { error: "No such seat." };
    var street = GS.deriveStreet(state);
    var betTo = GS.highestBetTo(state);
    var potBefore = GS.canonicalPot(state);
    var stackBefore = p.stackBehind;
    var added = 0, toAmount = p.streetCommitted;
    var type = action.type;

    switch (type) {
      case "fold":
        p.folded = true; p.active = false; break;

      case "check":
        if (GS.amountToCall(state, action.seatId) > 0) return { error: "Cannot check facing a bet." };
        break;

      case "call": {
        var need = GS.amountToCall(state, action.seatId);
        added = commit(state, p, need);
        toAmount = p.streetCommitted;
        break;
      }

      case "post-ante": {
        // Dead money: into the pot, but not part of the bet to match.
        added = commitDead(state, p, Math.max(0, action.amount || 0));
        toAmount = p.streetCommitted;
        break;
      }

      case "post-blind":
      case "post-straddle": {
        added = commit(state, p, Math.max(0, action.amount || 0));
        toAmount = p.streetCommitted;
        if (toAmount > (state.currentBetTo || 0)) {
          state.currentBetTo = toAmount;
          if (type === "post-blind" && toAmount >= state.game.bigBlind) {
            state.lastFullRaiseSize = state.game.bigBlind || toAmount;
          }
          if (type === "post-straddle") state.lastFullRaiseSize = (toAmount - betTo) || toAmount;
        }
        break;
      }

      case "bet":
      case "raise":
      case "all-in": {
        var target;
        if (type === "all-in") {
          target = p.streetCommitted + p.stackBehind;
        } else if (action.raiseTo != null) {
          target = action.raiseTo;
        } else if (action.amount != null) {
          // "raise by" increment over the current bet-to, or an opening bet size.
          target = (betTo > 0 ? betTo : p.streetCommitted) + action.amount;
        } else {
          return { error: "Bet/raise needs a size." };
        }
        var maxTo = p.streetCommitted + p.stackBehind;
        target = Math.min(target, maxTo);
        if (target <= betTo && type !== "all-in") return { error: "Raise must exceed the current bet." };
        var isFull = GS.isFullRaise(state, action.seatId, target);
        added = commit(state, p, target - p.streetCommitted);
        toAmount = p.streetCommitted;
        // A full raise resets the last-full-raise size and reopens betting.
        if (toAmount > betTo) {
          if (isFull) state.lastFullRaiseSize = toAmount - betTo;
          state.currentBetTo = Math.max(state.currentBetTo || 0, toAmount);
        }
        break;
      }

      default:
        return { error: "Unknown action type: " + type };
    }

    var rec = {
      sequence: nextSeq(state),
      street: street,
      seatId: action.seatId,
      type: type,
      amountAdded: added,
      toAmount: toAmount,
      potBefore: potBefore,
      stackBefore: stackBefore,
      source: action.source || "manual",
      confidence: action.confidence != null ? action.confidence : 1,
      timestamp: action.timestamp || Date.now(),
    };
    state.actions.push(rec);
    return rec;
  }

  /** Post blinds and antes for the current button. Idempotent-ish helper. */
  function postBlinds(state) {
    var blinds = GS.blindSeats(state);
    var g = state.game;
    if (g.ante > 0) {
      GS.dealtInSeats(state).forEach(function (p) {
        apply(state, { seatId: p.seatId, type: "post-ante", amount: g.ante });
      });
    }
    if (blinds.sb != null && g.smallBlind > 0) apply(state, { seatId: blinds.sb, type: "post-blind", amount: g.smallBlind });
    if (blinds.bb != null && g.bigBlind > 0) apply(state, { seatId: blinds.bb, type: "post-blind", amount: g.bigBlind });
    state.lastFullRaiseSize = g.bigBlind || state.lastFullRaiseSize;
    return state;
  }

  /** Advance to the next street: reset street commitments and the bet line. */
  function nextStreet(state) {
    state.players.forEach(function (p) { p.streetCommitted = 0; });
    state.currentBetTo = 0;
    state.lastFullRaiseSize = state.game.bigBlind || 0;
    var order = GS.STREETS.indexOf(GS.deriveStreet(state));
    if (state.streetOverride && order < GS.STREETS.length - 1) {
      state.street = GS.STREETS[order + 1];
    }
    return state;
  }

  /** Undo the most recent action by replaying the stream on a fresh copy. */
  function undo(state) {
    if (!state.actions.length) return state;
    state.actions.pop();
    return state;
  }

  Poker.ActionTracker = {
    apply: apply,
    postBlinds: postBlinds,
    nextStreet: nextStreet,
    undo: undo,
    commit: commit,
  };
})(typeof self !== "undefined" ? self : this);
