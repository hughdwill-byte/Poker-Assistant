/*
 * load.js - load every browser IIFE module into a shared Node global so the
 * pure poker maths can be tested without a DOM. Order matters: dependencies
 * first. Modules attach to `Poker` on the shared global.
 */
global.self = global;               // browser modules attach to `self`
if (typeof global.window === "undefined") global.window = global;

require("../js/cards.js");
require("../js/evaluator.js");
require("../js/equity.js");
require("../js/advice.js");
require("../js/game-state.js");
require("../js/action-tracker.js");
require("../js/ranges.js");
require("../js/range-presets.js");
require("../js/hand-features.js");
require("../js/opponent-model.js");
require("../js/range-equity.js");
require("../js/range-vs-range.js");
require("../js/action-ev.js");
require("../js/draw-odds.js");
require("../js/equilibrium.js");
require("../js/bet-composition.js");
require("../js/gto-defense.js");
require("../js/equity-realization.js");
require("../js/implied-odds.js");
require("../js/tournament-icm.js");
require("../js/strategy.js");
require("../js/watch-inference.js");
require("../js/persistence.js");

// HUD Overlay layout maths (extension/) — pure functions, no DOM, so they load
// and test under the same harness as the engine modules.
require("../extension/hud-layout.js");

module.exports = global.Poker;
