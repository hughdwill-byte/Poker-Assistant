/*
 * calibration-toggle.test.js - the Calibration Mode state machine
 * (desktop/calibration-toggle.js): default OFF, enter/exit interactivity,
 * save-and-hide persistence semantics, and fresh-launch restore to OFF.
 */
module.exports = function (t) {
  var CT = global.Poker.CalibrationToggle;

  t.section("CalibrationToggle: default and enter/exit");
  (function () {
    var s0 = CT.initialState("presetA");
    t.equal("default OFF", s0.on, false);
    t.equal("HUD interactive by default", s0.hudInteractive, true);
    t.equal("active preset carried", s0.activePresetId, "presetA");

    var on = CT.reduce(s0, { type: "ENTER" });
    t.equal("ENTER turns it on", on.on, true);
    t.equal("ENTER marks HUD non-interactive", on.hudInteractive, false);

    var off = CT.reduce(on, { type: "EXIT" });
    t.equal("EXIT turns it off", off.on, false);
    t.equal("EXIT restores HUD interactivity", off.hudInteractive, true);
    t.equal("EXIT does not request a save", off.saveRequested, false);

    var toggled = CT.reduce(s0, { type: "TOGGLE" });
    t.equal("TOGGLE from off -> on", toggled.on, true);
    t.equal("TOGGLE from on -> off", CT.reduce(toggled, { type: "TOGGLE" }).on, false);
  })();

  t.section("CalibrationToggle: save & hide vs exit-without-save");
  (function () {
    var on = CT.reduce(CT.initialState("p1"), { type: "ENTER" });
    var saved = CT.reduce(on, { type: "SAVE_AND_HIDE" });
    t.equal("SAVE_AND_HIDE hides", saved.on, false);
    t.equal("SAVE_AND_HIDE restores interactivity", saved.hudInteractive, true);
    t.equal("SAVE_AND_HIDE requests a persist", saved.saveRequested, true);
    t.equal("ACK clears the one-shot save flag", CT.reduce(saved, { type: "ACK_SAVE" }).saveRequested, false);

    var exited = CT.reduce(on, { type: "EXIT" });
    t.equal("EXIT never requests a persist (preset intact)", exited.saveRequested, false);
  })();

  t.section("CalibrationToggle: preset selection");
  (function () {
    var s = CT.reduce(CT.initialState("p1"), { type: "SET_PRESET", id: "p2" });
    t.equal("SET_PRESET updates active id", s.activePresetId, "p2");
    t.equal("SET_PRESET does not toggle on", s.on, false);
  })();

  t.section("CalibrationToggle: persistence restores to OFF on fresh launch");
  (function () {
    var onState = CT.reduce(CT.initialState("p9"), { type: "ENTER" });
    // Even if we serialize while ON, deserialize (fresh launch) must be OFF.
    var restored = CT.deserialize(CT.serialize(onState));
    t.equal("fresh launch is OFF regardless of prior on-state", restored.on, false);
    t.equal("active preset id survives a launch", restored.activePresetId, "p9");
    t.equal("garbage -> default OFF", CT.deserialize("{nope").on, false);
    t.equal("garbage -> null preset", CT.deserialize("{nope").activePresetId, null);
  })();
};
