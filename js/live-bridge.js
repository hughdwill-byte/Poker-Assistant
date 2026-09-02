/*
 * live-bridge.js - a tiny cross-context channel that carries the current table
 * "reading" from a publisher (the Watch app auto-reading cards) to any number of
 * subscribers (the overlay HUD), across DIFFERENT TABS AND MONITORS.
 *
 * Transport, best available first:
 *   1. chrome.storage.local  - shared across ALL tabs of the extension (the two
 *      ends can be on different monitors / different origins). This is the path
 *      used by the extension: the full-app tab publishes, the content-script HUD
 *      on the poker tab subscribes.
 *   2. BroadcastChannel      - same-origin tabs (e.g. two web-app tabs).
 *   3. localStorage 'storage' events - same-origin fallback + last-value cache.
 *
 * A "snapshot" is plain, already-formatted data the HUD can drop straight into
 * its inputs: { hero:"As Kd", board:"4d 3c 9d", players, pot, toCall, stack, ts }.
 * No card ids, no engine coupling. Nothing here reads a poker site.
 *
 * Attaches to Poker.LiveBridge (browser IIFE convention; loads in the app, the
 * content-script HUD, and the Node test harness).
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  var KEY = "pokerHud.live";

  var RANK = { 14: "A", 13: "K", 12: "Q", 11: "J", 10: "T", 9: "9", 8: "8", 7: "7", 6: "6", 5: "5", 4: "4", 3: "3", 2: "2" };
  var SUIT = { 0: "c", 1: "d", 2: "h", 3: "s" };

  // Card id -> "As" text (the HUD's input format). null/undefined -> "".
  function idToText(id) {
    if (id == null) return "";
    return (RANK[id >> 2] || "?") + (SUIT[id & 3] || "?");
  }
  // Array of ids (may contain nulls) -> "As Kd" (nulls dropped).
  function idsToText(ids) {
    return (ids || []).filter(function (x) { return x != null; }).map(idToText).join(" ");
  }

  function num(v, d) { v = +v; return isFinite(v) ? v : (d || 0); }

  // Validate/normalize a snapshot from any source into the canonical shape.
  function sanitizeSnapshot(o) {
    o = o || {};
    return {
      hero: typeof o.hero === "string" ? o.hero : "",
      board: typeof o.board === "string" ? o.board : "",
      players: Math.max(2, Math.min(10, (o.players | 0) || 2)),
      pot: Math.max(0, num(o.pot, 0)),
      toCall: Math.max(0, num(o.toCall, 0)),
      stack: Math.max(0, num(o.stack, 0)),
      ts: num(o.ts, 0),
    };
  }

  // ---- transports ----------------------------------------------------------
  function chromeStore() {
    try { return (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) ? chrome.storage : null; }
    catch (e) { return null; }
  }
  var bc = null;
  try { if (typeof BroadcastChannel !== "undefined") bc = new BroadcastChannel("pokerHudLive"); } catch (e) { bc = null; }

  function publish(snapshot) {
    var snap = sanitizeSnapshot(snapshot);
    snap.ts = Date.now();
    var cs = chromeStore();
    if (cs) { try { var o = {}; o[KEY] = snap; cs.local.set(o); } catch (e) {} }
    if (bc) { try { bc.postMessage(snap); } catch (e) {} }
    try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(snap)); } catch (e) {}
    return snap;
  }

  // cb(snapshot) on every update from any transport. Returns an unsubscribe fn.
  function subscribe(cb) {
    var subs = [];
    var cs = chromeStore();
    if (cs && cs.onChanged) {
      var onChg = function (changes, area) {
        if (area === "local" && changes[KEY] && changes[KEY].newValue) cb(sanitizeSnapshot(changes[KEY].newValue));
      };
      try { cs.onChanged.addListener(onChg); subs.push(function () { try { cs.onChanged.removeListener(onChg); } catch (e) {} }); } catch (e) {}
    }
    if (bc) {
      var onMsg = function (e) { cb(sanitizeSnapshot(e.data)); };
      try { bc.addEventListener("message", onMsg); subs.push(function () { try { bc.removeEventListener("message", onMsg); } catch (e) {} }); } catch (e) {}
    }
    if (typeof window !== "undefined" && window.addEventListener) {
      var onStorage = function (e) {
        if (e.key === KEY && e.newValue) { try { cb(sanitizeSnapshot(JSON.parse(e.newValue))); } catch (x) {} }
      };
      window.addEventListener("storage", onStorage);
      subs.push(function () { window.removeEventListener("storage", onStorage); });
    }
    return function unsubscribe() { subs.forEach(function (f) { try { f(); } catch (e) {} }); subs = []; };
  }

  // Read the last-published snapshot (async chrome.storage, or sync fallback).
  function getLatest(cb) {
    var cs = chromeStore();
    if (cs) {
      try { cs.local.get([KEY], function (o) { cb(o && o[KEY] ? sanitizeSnapshot(o[KEY]) : null); }); return; }
      catch (e) {}
    }
    try {
      var s = (typeof localStorage !== "undefined") ? localStorage.getItem(KEY) : null;
      cb(s ? sanitizeSnapshot(JSON.parse(s)) : null); return;
    } catch (e) {}
    cb(null);
  }

  Poker.LiveBridge = {
    KEY: KEY,
    idToText: idToText,
    idsToText: idsToText,
    sanitizeSnapshot: sanitizeSnapshot,
    publish: publish,
    subscribe: subscribe,
    getLatest: getLatest,
  };
})(typeof self !== "undefined" ? self : this);
