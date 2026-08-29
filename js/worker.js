/*
 * worker.js - runs equity and strategy off the main thread so the UI stays
 * responsive. The whole pure engine is loaded here (the same source the window
 * uses) so both simple uniform equity and range-aware strategy run in the
 * worker.
 *
 * Protocol: main posts { id, type, cfg }.
 *   type "simulate" (or absent) -> Poker.simulate(cfg)      (uniform equity)
 *   type "range"                -> Poker.simulateRanges(cfg) (range equity)
 *   type "strategy"             -> Poker.Strategy.rangeRecommend(cfg)
 * Worker replies { id, result }. Only the latest job matters; the app ignores
 * stale ids (stale-job cancellation).
 */
importScripts(
  "cards.js", "evaluator.js", "equity.js", "advice.js",
  "game-state.js", "action-tracker.js", "ranges.js", "range-presets.js",
  "hand-features.js", "opponent-model.js", "range-equity.js",
  "action-ev.js", "strategy.js"
);

self.onmessage = function (e) {
  var msg = e.data || {};
  var start = Date.now();
  var result;
  try {
    if (msg.type === "range") result = self.Poker.simulateRanges(msg.cfg || {});
    else if (msg.type === "strategy") result = self.Poker.Strategy.rangeRecommend(msg.cfg || {});
    else result = self.Poker.simulate(msg.cfg || {});
  } catch (err) {
    result = { ok: false, error: String(err && err.message || err) };
  }
  if (result && typeof result === "object") result.ms = Date.now() - start;
  self.postMessage({ id: msg.id, result: result });
};
