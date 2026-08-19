/*
 * worker.js - runs the equity simulation off the main thread so the UI stays
 * responsive and can keep up with a live game.
 *
 * Protocol: main thread posts { id, cfg }. Worker replies with
 * { id, result } where result is the object returned by Poker.simulate.
 * Only the latest job matters, so an older job's result is ignored by the app.
 */
importScripts("cards.js", "evaluator.js", "equity.js");

self.onmessage = function (e) {
  var msg = e.data || {};
  var start = Date.now();
  var result = self.Poker.simulate(msg.cfg || {});
  result.ms = Date.now() - start;
  self.postMessage({ id: msg.id, result: result });
};
