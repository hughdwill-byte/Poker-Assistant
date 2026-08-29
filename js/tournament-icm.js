/*
 * tournament-icm.js - DISABLED interface stub for tournament prize-money EV.
 *
 * This marks the architectural seam for the deferred tournament objective layer
 * (see docs/future-math-roadmap.md #12). It is intentionally NOT implemented and
 * NOT wired into any recommendation: cash-game chip EV must never be converted
 * through ICM, and no unvalidated tournament model may drive advice.
 *
 * `enabled` is false; every method throws until a validated ICM recursion,
 * full per-branch terminal stack vectors, and a mode gate exist. When built, it
 * belongs in a separate objective-conversion layer applied to terminal stack
 * vectors - never inside cash equity.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  Poker.TournamentICM = {
    enabled: false,
    /**
     * Would map stacks + payouts to prize-money equity (recursive ICM).
     * Reference target (once enabled): stacks [5000,2500,2500], payouts
     * [50,30,20] -> approximately [38.3333, 30.8333, 30.8333].
     */
    icmEquities: function () {
      throw new Error("TournamentICM is disabled: ICM is a deferred, unvalidated layer (see docs/future-math-roadmap.md #12).");
    },
    /** Would convert a chip-EV branch set to prize-money EV. Disabled. */
    toPrizeEV: function () {
      throw new Error("TournamentICM is disabled: prize-money EV conversion is not implemented.");
    },
  };
})(typeof self !== "undefined" ? self : this);
