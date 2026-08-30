/*
 * overlay-bridge.js - desktop renderer glue. Mounts the reused Shadow-DOM HUD
 * (extension/hud.js), augments its Taskbar with desktop-only controls, and
 * connects it to the Electron main process:
 *
 *   - pointer-over-panel hit-testing → main toggles click-through so empty
 *     areas pass clicks through and panels capture input;
 *   - LOCK (click-through ⇄ interactive), DISPLAY (switch monitor), WATCH
 *     (open the full app with its unchanged Watch mode), EXIT (quit);
 *   - persists the Taskbar edge into the desktop config.
 *
 * This file is desktop-only; the shared HUD (hud.js / hud-layout.js) is
 * untouched, so the browser extension and web toggle keep working as-is.
 */
(function () {
  "use strict";
  var api = window.overlayAPI || null;              // exposed by preload.js
  var OL = self.Poker && self.Poker.OverlayLogic;
  var HUD_ID = "poker-assistant-hud-root";
  var HANDLE_MARGIN = 10;                            // include resize handles
  var mode = "locked";

  function root() {
    var host = document.getElementById(HUD_ID);
    return host ? host.shadowRoot : null;
  }

  // ---- mount the reused HUD, then wire the desktop bits --------------------
  function start() {
    if (!window.PokerHUD) { setTimeout(start, 30); return; }
    if (!window.PokerHUD.isMounted()) window.PokerHUD.mount();
    // mount() builds the shadow DOM synchronously; augment on the next frame so
    // the taskbar exists.
    requestAnimationFrame(function () {
      augmentTaskbar();
      watchTaskbarEdge();
      if (api) {
        api.getMode().then(function (m) { mode = m || "locked"; reflectMode(); });
        api.onMode(function (m) { mode = m; reflectMode(); });
      }
      startHitTesting();
    });
  }

  // ---- desktop taskbar controls -------------------------------------------
  function augmentTaskbar() {
    var r = root();
    if (!r) return;
    var btns = r.querySelector(".hud-taskbar-btns");
    if (!btns) return;

    // Scoped styles for the desktop-only buttons, injected into the shadow root
    // so the shared hud.css stays untouched.
    if (!r.getElementById("overlay-desktop-style")) {
      var st = document.createElement("style");
      st.id = "overlay-desktop-style";
      st.textContent =
        ".hud-btn-desktop{border-color:#243b30}" +
        ".hud-btn-desktop:hover{border-color:#57ff9a;color:#57ff9a}" +
        ".hud-btn-live{border-color:#57ff9a;color:#0a0e0c;background:#57ff9a}" +
        ".hud-btn-live:hover{background:#7dffb3;color:#0a0e0c}";
      r.appendChild(st);
    }

    // Repurpose the HUD's CLOSE (which unmounts) into a desktop EXIT so the
    // user never lands on an empty transparent window. Cloning drops the old
    // unmount listener.
    var close = r.querySelector(".hud-btn-close");
    if (close) {
      var exit = close.cloneNode(true);
      exit.textContent = "✕ EXIT";
      exit.title = "Quit the overlay and return to the desktop";
      exit.setAttribute("aria-label", exit.title);
      exit.addEventListener("click", function () { if (api) api.quit(); });
      close.parentNode.replaceChild(exit, close);
    }

    lockBtn = mkBtn("LOCKED", "Toggle click-through (LOCKED) vs interactive", function () {
      var next = mode === "locked" ? "interactive" : "locked";
      if (api) api.setMode(next);
      mode = next; reflectMode();
    });
    mkBtn("DISPLAY", "Move the overlay to the next monitor", function () {
      if (api) api.cycleDisplay();
    });
    mkBtn("CALIB", "Toggle Calibration Mode (edit the table anchor + regions)", function () {
      if (window.PokerCalibration) window.PokerCalibration.toggle();
    });
    mkBtn("WATCH", "Open the full app (with Watch-mode screen reading)", function () {
      if (api) api.toggleAppView();
    });

    // Insert LOCK/DISPLAY/WATCH before EXIT for a logical order.
    var exitBtn = r.querySelector(".hud-btn-close");
    if (exitBtn) desktopBtns.forEach(function (b) { btns.insertBefore(b, exitBtn); });
    else desktopBtns.forEach(function (b) { btns.appendChild(b); });
  }

  var desktopBtns = [];
  var lockBtn = null;
  function mkBtn(label, title, fn) {
    var r = root();
    var b = document.createElement("button");
    b.className = "hud-btn hud-btn-desktop";
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", fn);
    desktopBtns.push(b);
    return b;
  }

  function reflectMode() {
    if (lockBtn) {
      lockBtn.textContent = mode === "locked" ? "LOCKED" : "LIVE";
      lockBtn.classList.toggle("hud-btn-live", mode !== "locked");
    }
  }

  // Persist taskbar edge to the desktop config whenever the HUD flips it.
  function watchTaskbarEdge() {
    var r = root();
    if (!r) return;
    var bar = r.querySelector(".hud-taskbar");
    if (!bar || !api) return;
    var mo = new MutationObserver(function () {
      api.saveEdge(bar.getAttribute("data-edge") === "top" ? "top" : "bottom");
    });
    mo.observe(bar, { attributes: true, attributeFilter: ["data-edge"] });
  }

  // ---- click-through hit-testing ------------------------------------------
  // Even while the window ignores mouse events, forward:true still delivers
  // mousemove here, so we can decide when to capture.
  function panelRects() {
    var r = root();
    if (!r) return [];
    var rects = [];
    // Boxes (inflated to include their external resize handles) + taskbar.
    r.querySelectorAll(".hud-box").forEach(function (el) {
      var b = el.getBoundingClientRect();
      rects.push({ x: b.left - HANDLE_MARGIN, y: b.top - HANDLE_MARGIN,
                   w: b.width + HANDLE_MARGIN * 2, h: b.height + HANDLE_MARGIN * 2 });
    });
    var bar = r.querySelector(".hud-taskbar");
    if (bar) { var bb = bar.getBoundingClientRect(); rects.push({ x: bb.left, y: bb.top, w: bb.width, h: bb.height }); }
    return rects;
  }

  var pending = false, lastX = 0, lastY = 0, lastOver = null;
  function onMove(e) {
    lastX = e.clientX; lastY = e.clientY;
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      if (mode !== "locked") return;                 // interactive captures all
      var over = OL ? OL.pointerOverPanels(lastX, lastY, panelRects())
                    : false;
      if (over !== lastOver) { lastOver = over; if (api) api.setHover(over); }
    });
  }
  function startHitTesting() {
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("pointermove", onMove, true);
    // If the pointer leaves the window entirely, drop capture.
    window.addEventListener("mouseleave", function () {
      lastOver = false; if (api && mode === "locked") api.setHover(false);
    }, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
