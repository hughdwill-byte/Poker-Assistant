/*
 * persistence.js - versioned local storage for opponent profiles. All data
 * stays on the device (localStorage); there is no server. Guarded so it also
 * loads under Node (tests) where localStorage is absent.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});

  var STORE_KEY = "pa_profiles_v1";
  var STORE_VERSION = 1;

  function storage() {
    try { return (typeof localStorage !== "undefined") ? localStorage : null; }
    catch (e) { return null; }
  }

  // In-memory fallback so the API works with no localStorage (Node/tests).
  var memory = { version: STORE_VERSION, profiles: {} };

  function load() {
    var s = storage();
    if (!s) return memory;
    try {
      var raw = s.getItem(STORE_KEY);
      if (!raw) return { version: STORE_VERSION, profiles: {} };
      var data = JSON.parse(raw);
      return migrate(data);
    } catch (e) {
      return { version: STORE_VERSION, profiles: {} };
    }
  }

  function save(data) {
    data.version = STORE_VERSION;
    var s = storage();
    if (!s) { memory = data; return true; }
    try { s.setItem(STORE_KEY, JSON.stringify(data)); return true; }
    catch (e) { memory = data; return false; }
  }

  function migrate(data) {
    if (!data || typeof data !== "object") return { version: STORE_VERSION, profiles: {} };
    if (!data.profiles) data.profiles = {};
    if (data.version == null) data.version = STORE_VERSION;
    // Future migrations keyed on data.version go here.
    return data;
  }

  // A stable key from site/table namespace + normalised display name, so a
  // profile follows a player across seat changes. Falls back to an explicit id.
  function keyFor(opts) {
    if (opts.profileId) return "id:" + opts.profileId;
    var ns = (opts.namespace || "table").toLowerCase().replace(/\s+/g, "-");
    var name = (opts.name || "").toLowerCase().trim().replace(/\s+/g, "-");
    if (!name) return null;
    return ns + ":" + name;
  }

  function getOrCreate(opts) {
    var data = load();
    var key = keyFor(opts) || ("id:" + (opts.profileId || Date.now()));
    if (!data.profiles[key]) {
      var prof = Poker.OpponentModel.createProfile({ key: key, name: opts.name, id: opts.profileId });
      data.profiles[key] = prof;
      save(data);
    }
    return data.profiles[key];
  }

  function put(profile) {
    var data = load();
    var key = profile.key || ("id:" + profile.id);
    profile.key = key;
    data.profiles[key] = profile;
    save(data);
    return profile;
  }

  function list() {
    var data = load();
    return Object.keys(data.profiles).map(function (k) { return data.profiles[k]; });
  }

  function remove(key) {
    var data = load();
    delete data.profiles[key];
    save(data);
  }

  function resetStats(key) {
    var data = load();
    var prof = data.profiles[key];
    if (!prof) return null;
    var fresh = Poker.OpponentModel.createProfile({ key: prof.key, name: prof.name, id: prof.id });
    data.profiles[key] = fresh;
    save(data);
    return fresh;
  }

  function exportJSON() { return JSON.stringify(load(), null, 2); }

  function importJSON(text, opts) {
    opts = opts || {};
    var incoming = migrate(JSON.parse(text));
    var data = opts.merge ? load() : { version: STORE_VERSION, profiles: {} };
    Object.keys(incoming.profiles).forEach(function (k) { data.profiles[k] = incoming.profiles[k]; });
    save(data);
    return data;
  }

  Poker.Persistence = {
    STORE_VERSION: STORE_VERSION,
    keyFor: keyFor,
    getOrCreate: getOrCreate,
    put: put,
    list: list,
    remove: remove,
    resetStats: resetStats,
    exportJSON: exportJSON,
    importJSON: importJSON,
    _loadRaw: load,
  };
})(typeof self !== "undefined" ? self : this);
