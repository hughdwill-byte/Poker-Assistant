/*
 * popup.js - the toolbar-icon menu. Two entry points:
 *   1. Open the FULL Poker Assistant app (index.html) as an extension page in a
 *      new tab — the whole original app, including Watch-mode screen reading and
 *      advanced EV, running from the extension's own files. No local server.
 *   2. Inject the quick HUD overlay onto the current tab (manual inputs).
 *
 * Runs in the extension (privileged) context, so it can use chrome.tabs and
 * chrome.scripting directly; activeTab is granted for the current tab while the
 * popup is open.
 */
"use strict";

var noteEl = document.getElementById("note");

function isInjectable(url) {
  return !!url && (/^https?:/i.test(url) || /^file:/i.test(url));
}

// ---- open the full app as an extension-origin tab ------------------------
document.getElementById("btn-app").addEventListener("click", function () {
  var url = chrome.runtime.getURL("index.html");
  chrome.tabs.create({ url: url });
  window.close();
});

// ---- inject the HUD overlay onto the active tab --------------------------
document.getElementById("btn-hud").addEventListener("click", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    if (!isInjectable(tab.url)) {
      noteEl.innerHTML = '<span class="warn">Can’t overlay this page (a browser/store page). ' +
        'Use “Open full app” instead, or switch to a normal tab.</span>';
      return;
    }
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        files: [
          "extension/hud-layout.js",
          "extension/calibration-toggle.js",
          "js/calibration-preset.js",
          "js/cards.js",
          "js/evaluator.js",
          "js/equity.js",
          "js/live-bridge.js",
          "extension/hud.js",
          "extension/calibration-layer.js",
        ],
      })
      .then(function () {
        return chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function () {
            if (window.PokerHUD && typeof window.PokerHUD.toggle === "function") {
              window.PokerHUD.toggle();
            }
          },
        });
      })
      .then(function () { window.close(); })
      .catch(function (err) {
        noteEl.innerHTML = '<span class="warn">Couldn’t inject here: ' +
          String(err && err.message || err) + '</span>';
      });
  });
});
