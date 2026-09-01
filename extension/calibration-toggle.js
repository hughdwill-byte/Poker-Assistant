/*
 * calibration-toggle.js - PURE state machine for the in-HUD Calibration Mode.
 * No DOM, no Electron. The renderer drives the editing layer from this; the Node
 * harness tests it directly.
 *
 * Rules (Phase 3):
 *   - Default OFF. Calibration is never visible unless the user asks.
 *   - ENTER shows the editing layer and marks the HUD non-interactive (so edits
 *     target calibration, not the HUD panels underneath).
 *   - EXIT / SAVE_AND_HIDE hide the layer and restore HUD interactivity.
 *   - SAVE_AND_HIDE additionally signals the caller to persist the active
 *     preset's normalized values; EXIT leaves the preset untouched.
 *   - Persistence restores to OFF on a fresh launch (we persist the active
 *     preset id, never an "on" state), so users never boot into calibration.
 *
 * Attaches to Poker.CalibrationToggle.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  function initialState(activePresetId) {
    return {
      on: false,
      hudInteractive: true,
      activePresetId: activePresetId || null,
      saveRequested: false,   // one-shot: caller persists then clears via ack()
    };
  }

  function reduce(state, action) {
    var a = action || {};
    switch (a.type) {
      case "ENTER":
        return { on: true, hudInteractive: false, activePresetId: state.activePresetId, saveRequested: false };
      case "EXIT":            // exit WITHOUT saving; preset left intact
        return { on: false, hudInteractive: true, activePresetId: state.activePresetId, saveRequested: false };
      case "TOGGLE":
        return reduce(state, { type: state.on ? "EXIT" : "ENTER" });
      case "SAVE_AND_HIDE":
        return { on: false, hudInteractive: true, activePresetId: state.activePresetId, saveRequested: true };
      case "SET_PRESET":
        return { on: state.on, hudInteractive: state.hudInteractive, activePresetId: a.id, saveRequested: state.saveRequested };
      case "ACK_SAVE":        // caller has persisted; clear the one-shot flag
        return { on: state.on, hudInteractive: state.hudInteractive, activePresetId: state.activePresetId, saveRequested: false };
      default:
        return state;
    }
  }

  // Persist ONLY the active preset id (+ schema tag). Never persist `on`.
  function serialize(state) {
    return JSON.stringify({ v: 1, activePresetId: state.activePresetId || null });
  }
  // Always returns a state with on:false — a fresh launch shows the clean HUD.
  function deserialize(str) {
    var id = null;
    try {
      var o = typeof str === "string" ? JSON.parse(str) : str;
      if (o && o.activePresetId != null) id = o.activePresetId;
    } catch (e) { /* default */ }
    return initialState(id);
  }

  Poker.CalibrationToggle = {
    initialState: initialState,
    reduce: reduce,
    serialize: serialize,
    deserialize: deserialize,
  };
})(typeof self !== "undefined" ? self : this);
