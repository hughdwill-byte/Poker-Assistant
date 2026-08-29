/*
 * watch-inference.js - infer discrete poker actions from stable per-seat state
 * changes between Watch frames, WITHOUT collapsing the table when players fold.
 *
 * This is pure logic: it takes frames (already OCR'd elsewhere) and emits
 * events. Seats are FIXED - a fold flips a seat's `folded` flag; it never
 * removes the seat or renumbers the table. Only reliably-inferable events are
 * emitted; a check (which looks identical to "no change" in the chip counts)
 * requires an explicit action label or manual confirmation. Low-confidence
 * frames are surfaced for confirmation rather than silently updating anything.
 *
 * A frame:
 *   {
 *     handId, street, buttonSeat, currentBetTo,
 *     seats: [{ seatId, occupied, dealtIn, active, folded, allIn,
 *               stackBehind, streetCommitted, actionLabel?, confidence }]
 *   }
 * Every emitted event carries source, confidence, timestamp, prev and next.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function createTracker(opts) {
    opts = opts || {};
    var confThreshold = opts.confidenceThreshold != null ? opts.confidenceThreshold : 0.6;
    var stableFrames = opts.stableFrames != null ? opts.stableFrames : 1;

    var prev = null;         // last committed frame
    var handId = null;
    var street = null;
    var seq = 0;
    var pending = [];        // low-confidence readings awaiting confirmation
    var stableCount = {};    // seatId -> consecutive identical raw frames

    function seatMap(frame) {
      var m = {};
      frame.seats.forEach(function (s) { m[s.seatId] = s; });
      return m;
    }
    function maxBet(frame, exceptSeat) {
      var hi = 0;
      frame.seats.forEach(function (s) {
        if (s.seatId === exceptSeat) return;
        if (!s.folded && s.streetCommitted > hi) hi = s.streetCommitted;
      });
      return hi;
    }

    function apply(frame) {
      var events = [];
      var ts = frame.timestamp || Date.now();

      // New hand: reset baselines, keep seats fixed, emit a reset event.
      if (handId !== null && frame.handId !== handId) {
        events.push(mk("new-hand", null, ts, { handId: handId }, { handId: frame.handId }, 1));
        prev = null; street = null; pending = []; stableCount = {};
      }
      handId = frame.handId;

      // Button movement (dealer detection).
      if (prev && prev.buttonSeat != null && frame.buttonSeat != null && frame.buttonSeat !== prev.buttonSeat) {
        events.push(mk("button-move", null, ts, { buttonSeat: prev.buttonSeat }, { buttonSeat: frame.buttonSeat }, 1));
      }

      // Street change resets street commitments; don't infer bets from the reset.
      var streetChanged = street !== null && frame.street !== street;
      street = frame.street;

      if (!prev) { prev = cloneFrame(frame); return { events: events, pending: pending.slice() }; }

      var pm = seatMap(prev), nm = seatMap(frame);

      // Iterate seats in seat order for deterministic action ordering.
      var ids = frame.seats.map(function (s) { return s.seatId; }).sort(function (a, b) { return a - b; });
      ids.forEach(function (id) {
        var was = pm[id], now = nm[id];
        if (!now) return;
        // Fixed seats: a seat never disappears; if it was dealt in and is now
        // folded, that is a fold, not a table-size change.
        if (was && !was.folded && now.folded) {
          emit(events, "fold", id, ts, was, now, now.confidence);
          return;
        }
        if (!was) return;
        if (streetChanged) return; // baseline reset; skip contribution deltas

        var delta = (now.streetCommitted || 0) - (was.streetCommitted || 0);
        if (delta <= 0) {
          // No chips added. A check cannot be distinguished from inaction by
          // chips alone - require an explicit label.
          if (now.actionLabel === "check" && was.streetCommitted === now.streetCommitted) {
            emit(events, "check", id, ts, was, now, now.confidence);
          }
          return;
        }

        // Chips increased: classify against the bet-to that stood before this
        // seat acted (from the previous frame).
        var betBefore = maxBet(prev, id);
        var type;
        if (betBefore <= 0) type = "bet";
        else if (Math.abs(now.streetCommitted - betBefore) < 1e-9) type = "call";
        else if (now.streetCommitted > betBefore) type = "raise";
        else type = "call"; // partial (short) call
        if (now.allIn || now.stackBehind === 0) type = "all-in";
        emit(events, type, id, ts, was, now, now.confidence, { amountAdded: delta, toAmount: now.streetCommitted });
      });

      prev = cloneFrame(frame);
      return { events: events, pending: pending.slice() };
    }

    function emit(events, type, seatId, ts, was, now, confidence, extra) {
      confidence = confidence == null ? 1 : confidence;
      // Debounce identical repeated readings for this seat.
      var sig = type + ":" + (now.streetCommitted || 0) + ":" + (now.folded ? "F" : "");
      if (stableCount[seatId] === sig) return; // duplicate frame -> no new event
      stableCount[seatId] = sig;

      if (confidence < confThreshold) {
        pending.push({ type: type, seatId: seatId, confidence: confidence, prev: snap(was), next: snap(now), needsConfirmation: true, timestamp: ts });
        return;
      }
      var ev = mk(type, seatId, ts, snap(was), snap(now), confidence);
      if (extra) Object.keys(extra).forEach(function (k) { ev[k] = extra[k]; });
      events.push(ev);
    }

    function mk(type, seatId, ts, prevState, nextState, confidence) {
      return {
        sequence: ++seq, type: type, seatId: seatId,
        source: "watch", confidence: confidence, timestamp: ts,
        prev: prevState, next: nextState,
      };
    }
    function snap(s) {
      if (!s) return null;
      return { folded: s.folded, allIn: s.allIn, streetCommitted: s.streetCommitted, stackBehind: s.stackBehind, active: s.active };
    }
    function cloneFrame(f) {
      return { handId: f.handId, street: f.street, buttonSeat: f.buttonSeat, currentBetTo: f.currentBetTo, seats: f.seats.map(function (s) { return Object.assign({}, s); }) };
    }

    return {
      apply: apply,
      confirmPending: function (index) {
        var p = pending[index];
        if (p) pending.splice(index, 1);
        return p;
      },
      getPending: function () { return pending.slice(); },
      reset: function () { prev = null; handId = null; street = null; pending = []; stableCount = {}; },
    };
  }

  Poker.WatchInference = { createTracker: createTracker };
})(typeof self !== "undefined" ? self : this);
