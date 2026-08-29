/*
 * background.js - MV3 service worker for the Poker Assistant HUD Overlay.
 *
 * The only job here is to inject the HUD into the ACTIVE tab when the user
 * clicks the toolbar icon. We use `activeTab` + `scripting` so no broad host
 * permission is requested: the injection is granted transiently for the tab
 * the user just clicked on. The content script (hud.js) owns mount/toggle/
 * revert; clicking the icon again just calls its toggle().
 *
 * No tabs are queried, no URLs are inspected, no site DOM is read here.
 */
"use strict";

// Pages the browser will not let an extension script into (Chrome Web Store,
// chrome:// settings, etc.). We surface a friendly note instead of failing.
function isInjectable(url) {
  if (!url) return false;
  return /^https?:/i.test(url) || /^file:/i.test(url);
}

chrome.action.onClicked.addListener(function (tab) {
  if (!tab || tab.id == null) return;
  if (!isInjectable(tab.url)) {
    // Can't inject here; set a transient badge so the click isn't silent.
    chrome.action.setBadgeText({ tabId: tab.id, text: "n/a" });
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#a4370f" });
    setTimeout(function () {
      chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    }, 2500);
    return;
  }

  // Inject the layout maths, then the content script, then flip the HUD.
  // Files are injected in order; executeScript resolves after each runs.
  chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      files: ["extension/hud-layout.js", "extension/hud.js"],
    })
    .then(function () {
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () {
          // Runs in the page's isolated content-script world where hud.js
          // has defined window.PokerHUD.
          if (window.PokerHUD && typeof window.PokerHUD.toggle === "function") {
            window.PokerHUD.toggle();
          }
        },
      });
    })
    .catch(function (err) {
      // Injection can be denied by a page CSP or a restricted URL; log for the
      // developer console and badge briefly rather than throwing.
      console.warn("[Poker HUD] injection failed:", err && err.message);
      chrome.action.setBadgeText({ tabId: tab.id, text: "err" });
      chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#a4370f" });
      setTimeout(function () {
        chrome.action.setBadgeText({ tabId: tab.id, text: "" });
      }, 2500);
    });
});
