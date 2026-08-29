/*
 * run.js - the single entry point for `npm test`. Loads all engine modules,
 * then runs every registered test file against one shared harness and exits
 * non-zero if anything failed.
 */
require("./load");
var t = require("./harness").createHarness();

var suites = [
  "./engine.test",
  "./game-state.test",
  "./ranges.test",
  "./hand-features.test",
  "./opponent-model.test",
  "./range-equity.test",
  "./action-ev.test",
  "./rake-and-refs.test",
  "./equilibrium.test",
  "./implied-odds.test",
  "./priors-recency.test",
  "./watch-inference.test",
];

suites.forEach(function (name) {
  var suite = require(name);
  if (typeof suite === "function") suite(t);
});

t.summary();
process.exit(t.fail ? 1 : 0);
