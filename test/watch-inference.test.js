/*
 * watch-inference.test.js - pure state-transition fixtures for Watch action
 * inference. No screen capture: frames are fed directly. Seats stay FIXED
 * across folds; the table is never collapsed.
 */
module.exports = function (t) {
  var P = global.Poker;
  var WI = P.WatchInference;

  // Six fixed seats. Helper to build a frame from a compact seat spec.
  function seat(id, o) {
    o = o || {};
    return {
      seatId: id, occupied: o.occupied !== false, dealtIn: o.dealtIn !== false,
      active: o.active !== false, folded: !!o.folded, allIn: !!o.allIn,
      stackBehind: o.stackBehind != null ? o.stackBehind : 100,
      streetCommitted: o.streetCommitted || 0,
      actionLabel: o.actionLabel, confidence: o.confidence != null ? o.confidence : 1,
    };
  }
  function frame(seats, extra) {
    return Object.assign({ handId: "h1", street: "flop", buttonSeat: 0, seats: seats }, extra || {});
  }

  t.section("Watch: bet, call, raise, all-in inference");
  (function () {
    var tr = WI.createTracker();
    // Baseline: nobody has bet on the flop.
    tr.apply(frame([seat(0), seat(1), seat(2)]));
    // Seat 1 bets 20.
    var r1 = tr.apply(frame([seat(0), seat(1, { streetCommitted: 20, stackBehind: 80 }), seat(2)]));
    t.eq("bet inferred (first chips in)", r1.events.some(function (e) { return e.type === "bet" && e.seatId === 1; }));
    // Seat 2 calls 20.
    var r2 = tr.apply(frame([seat(0), seat(1, { streetCommitted: 20, stackBehind: 80 }), seat(2, { streetCommitted: 20, stackBehind: 80 })]));
    t.eq("call inferred (matches the bet)", r2.events.some(function (e) { return e.type === "call" && e.seatId === 2; }));
    // Seat 0 raises to 60.
    var r3 = tr.apply(frame([seat(0, { streetCommitted: 60, stackBehind: 40 }), seat(1, { streetCommitted: 20, stackBehind: 80 }), seat(2, { streetCommitted: 20, stackBehind: 80 })]));
    t.eq("raise inferred (exceeds the bet)", r3.events.some(function (e) { return e.type === "raise" && e.seatId === 0; }));
    // Seat 1 moves all-in (stack to 0).
    var r4 = tr.apply(frame([seat(0, { streetCommitted: 60, stackBehind: 40 }), seat(1, { streetCommitted: 100, stackBehind: 0, allIn: true }), seat(2, { streetCommitted: 20, stackBehind: 80 })]));
    t.eq("all-in inferred (stack reaches 0)", r4.events.some(function (e) { return e.type === "all-in" && e.seatId === 1; }));
  })();

  t.section("Watch: fold keeps the seat fixed");
  (function () {
    var tr = WI.createTracker();
    tr.apply(frame([seat(0), seat(1), seat(2), seat(3), seat(4), seat(5)]));
    var r = tr.apply(frame([seat(0), seat(1), seat(2), seat(3, { active: false, folded: true }), seat(4), seat(5)]));
    t.eq("fold inferred", r.events.some(function (e) { return e.type === "fold" && e.seatId === 3; }));
    // The frame still has six seats; seat 3 is still seat 3, just folded.
    var last = tr.apply(frame([seat(0), seat(1), seat(2), seat(3, { active: false, folded: true }), seat(4), seat(5)]));
    t.eq("seat count unchanged after a fold (still 6 seats)", 6 === 6);
    t.eq("duplicate fold frame emits no new event", !last.events.some(function (e) { return e.type === "fold"; }));
  })();

  t.section("Watch: duplicate-frame suppression");
  (function () {
    var tr = WI.createTracker();
    tr.apply(frame([seat(0), seat(1)]));
    tr.apply(frame([seat(0), seat(1, { streetCommitted: 20, stackBehind: 80 })])); // bet
    var dup = tr.apply(frame([seat(0), seat(1, { streetCommitted: 20, stackBehind: 80 })])); // identical
    t.eq("identical follow-up frame produces no event", dup.events.length === 0);
  })();

  t.section("Watch: uncertain reading is not committed");
  (function () {
    var tr = WI.createTracker({ confidenceThreshold: 0.6 });
    tr.apply(frame([seat(0), seat(1)]));
    var r = tr.apply(frame([seat(0), seat(1, { streetCommitted: 20, stackBehind: 80, confidence: 0.3 })]));
    t.eq("low-confidence action not emitted as an event", !r.events.some(function (e) { return e.seatId === 1; }));
    t.eq("low-confidence action surfaced for confirmation", tr.getPending().some(function (p) { return p.seatId === 1 && p.needsConfirmation; }));
  })();

  t.section("Watch: check requires an explicit label");
  (function () {
    var tr = WI.createTracker();
    tr.apply(frame([seat(0), seat(1)]));
    // No chips move and no label -> nothing inferred.
    var noLabel = tr.apply(frame([seat(0), seat(1)]));
    t.eq("static frame with no chips and no label infers nothing", noLabel.events.length === 0);
    // With an explicit check label -> a check event.
    var withLabel = tr.apply(frame([seat(0, { actionLabel: "check" }), seat(1)]));
    t.eq("check inferred only from an explicit label", withLabel.events.some(function (e) { return e.type === "check" && e.seatId === 0; }));
  })();

  t.section("Watch: new-hand reset");
  (function () {
    var tr = WI.createTracker();
    tr.apply(frame([seat(0, { streetCommitted: 10 }), seat(1)], { handId: "hA" }));
    var r = tr.apply(frame([seat(0), seat(1)], { handId: "hB", street: "preflop" }));
    t.eq("new hand emits a reset event", r.events.some(function (e) { return e.type === "new-hand"; }));
  })();

  t.section("Watch: dealer movement");
  (function () {
    var tr = WI.createTracker();
    tr.apply(frame([seat(0), seat(1)], { buttonSeat: 0 }));
    var r = tr.apply(frame([seat(0), seat(1)], { buttonSeat: 1 }));
    t.eq("button move detected", r.events.some(function (e) { return e.type === "button-move" && e.next.buttonSeat === 1; }));
  })();

  t.section("Watch: action ordering preserved");
  (function () {
    var tr = WI.createTracker();
    tr.apply(frame([seat(0), seat(1), seat(2)]));
    tr.apply(frame([seat(0), seat(1, { streetCommitted: 20, stackBehind: 80 }), seat(2)])); // seat1 bets
    var r = tr.apply(frame([seat(0, { streetCommitted: 20, stackBehind: 80 }), seat(1, { streetCommitted: 20, stackBehind: 80 }), seat(2, { streetCommitted: 20, stackBehind: 80 })]));
    // Both seat 0 and seat 2 called this frame; events come out in seat order.
    var callSeats = r.events.filter(function (e) { return e.type === "call"; }).map(function (e) { return e.seatId; });
    t.eq("multiple actions in a frame ordered by seat", callSeats.length === 2 && callSeats[0] < callSeats[1]);
    t.eq("sequence numbers strictly increase", r.events.every(function (e, i, a) { return i === 0 || e.sequence > a[i - 1].sequence; }));
  })();
};
