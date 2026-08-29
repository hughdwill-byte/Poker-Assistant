/*
 * harness.js - a tiny zero-dependency assertion harness shared by every test
 * file. Each test module exports `function (t) { ... }` and registers checks on
 * the harness `t`. test/run.js aggregates them and sets the exit code.
 */
function createHarness() {
  var state = { pass: 0, fail: 0, failures: [] };

  function record(ok, name, detail) {
    if (ok) { state.pass++; }
    else { state.fail++; state.failures.push(name + (detail ? "  " + detail : "")); }
    console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
  }

  var t = {
    eq: function (name, cond) { record(!!cond, name); },
    ok: function (name, cond) { record(!!cond, name); },
    equal: function (name, got, exp) {
      record(got === exp, name, "got=" + JSON.stringify(got) + " exp=" + JSON.stringify(exp));
    },
    approx: function (name, got, exp, tol) {
      var ok = typeof got === "number" && Math.abs(got - exp) <= tol;
      record(ok, name, "got=" + (typeof got === "number" ? got.toFixed(4) : got) + " exp≈" + exp + " ±" + tol);
    },
    throws: function (name, fn) {
      var threw = false;
      try { fn(); } catch (e) { threw = true; }
      record(threw, name);
    },
    section: function (label) { console.log("\n-- " + label + " --"); },
    get pass() { return state.pass; },
    get fail() { return state.fail; },
    summary: function () {
      console.log("\n" + state.pass + " passed, " + state.fail + " failed");
      if (state.failures.length) {
        console.log("Failures:");
        state.failures.forEach(function (f) { console.log("  - " + f); });
      }
    },
  };
  return t;
}

module.exports = { createHarness: createHarness };
