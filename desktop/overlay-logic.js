/*
 * overlay-logic.js - PURE logic for the desktop (Electron) HUD overlay. No
 * Electron, no DOM, no I/O. The renderer bridge and the main process use these;
 * the Node test harness loads the exact same functions to verify them.
 *
 * Geometry shared with the browser HUD (viewport clamping, border snapping,
 * adaptive breakpoints, box persistence) already lives in Poker.HudLayout and
 * is reused verbatim. This module adds the desktop-only pieces:
 *   - pointer-over-panel hit-testing (drives Electron click-through), and
 *   - multi-monitor bounds math (which display a point is on, overlay bounds
 *     for a chosen display), and
 *   - desktop config persistence (display id + hotkeys + taskbar edge).
 *
 * Attaches to Poker.OverlayLogic so it rides the same namespace/IIFE
 * convention and can be required under test/load.js.
 */
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  var HudLayout = Poker.HudLayout || null; // present when loaded after hud-layout.js

  // ---- pointer-over-panel hit-testing (click-through control) --------------
  // A "panel rect" is { x, y, w, h } in overlay-window CSS pixels. The overlay
  // window ignores mouse events (clicks pass through) UNLESS the pointer is over
  // one of these rects, in which case the renderer asks main to capture input.
  function pointInRect(x, y, r) {
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  /** True if (x,y) is over ANY panel rect — i.e. the overlay should capture. */
  function pointerOverPanels(x, y, rects) {
    if (!rects) return false;
    for (var i = 0; i < rects.length; i++) {
      if (rects[i] && pointInRect(x, y, rects[i])) return true;
    }
    return false;
  }

  /**
   * Index of the top-most panel under (x,y), or -1. Later entries in `rects`
   * are treated as higher in the z-order (painted last), matching how the DOM
   * stacks them, so the caller passes rects in ascending z-order.
   */
  function topmostPanelAt(x, y, rects) {
    if (!rects) return -1;
    for (var i = rects.length - 1; i >= 0; i--) {
      if (rects[i] && pointInRect(x, y, rects[i])) return i;
    }
    return -1;
  }

  // ---- multi-monitor bounds math -------------------------------------------
  // A "display" mirrors Electron's shape: { id, bounds:{x,y,width,height},
  // workArea:{...} }. Coordinates are in the global virtual-screen space where
  // displays can sit at negative offsets (a monitor left of the primary).
  function rectContainsPoint(b, p) {
    return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  }

  /**
   * The display whose bounds contain `point`, else the one whose centre is
   * nearest (so a point in a gap still resolves deterministically), else null.
   */
  function displayForPoint(point, displays) {
    if (!displays || !displays.length) return null;
    for (var i = 0; i < displays.length; i++) {
      if (displays[i] && displays[i].bounds && rectContainsPoint(displays[i].bounds, point)) {
        return displays[i];
      }
    }
    var best = null, bestD = Infinity;
    for (var j = 0; j < displays.length; j++) {
      var b = displays[j] && displays[j].bounds;
      if (!b) continue;
      var cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      var d = (cx - point.x) * (cx - point.x) + (cy - point.y) * (cy - point.y);
      if (d < bestD) { bestD = d; best = displays[j]; }
    }
    return best;
  }

  /** Find a display by id, falling back to the primary/first. */
  function displayById(id, displays, primaryId) {
    if (!displays || !displays.length) return null;
    var i;
    for (i = 0; i < displays.length; i++) if (displays[i] && displays[i].id === id) return displays[i];
    if (primaryId != null) for (i = 0; i < displays.length; i++) if (displays[i] && displays[i].id === primaryId) return displays[i];
    return displays[0];
  }

  /**
   * The window bounds the overlay should take to cover a display. We cover the
   * full bounds (not just workArea) so the overlay can float over a fullscreen
   * client; the caller sets alwaysOnTop separately.
   */
  function overlayBoundsForDisplay(display) {
    var b = (display && display.bounds) || { x: 0, y: 0, width: 1280, height: 800 };
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  // ---- desktop config persistence ------------------------------------------
  // The per-box layout (position/size) persists via HudLayout.serialize in the
  // renderer's localStorage. The DESKTOP config (which display, hotkeys,
  // taskbar edge, interactive default) is owned by the main process and
  // serialized here to a JSON string it writes to userData.
  var DEFAULT_HOTKEYS = {
    toggleShow: "CommandOrControl+Shift+H",
    toggleInteractive: "CommandOrControl+Shift+L",
    cycleDisplay: "CommandOrControl+Shift+D",
    toggleCalibration: "CommandOrControl+Shift+C",
  };
  function defaultConfig() {
    return {
      version: 1,
      displayId: null,          // null -> display under the cursor at launch
      taskbarEdge: "bottom",
      interactive: false,       // start locked/click-through
      hotkeys: {
        toggleShow: DEFAULT_HOTKEYS.toggleShow,
        toggleInteractive: DEFAULT_HOTKEYS.toggleInteractive,
        cycleDisplay: DEFAULT_HOTKEYS.cycleDisplay,
        toggleCalibration: DEFAULT_HOTKEYS.toggleCalibration,
      },
    };
  }
  function validEdge(e) { return e === "top" || e === "bottom"; }

  function serializeConfig(cfg) {
    var d = defaultConfig();
    var hk = (cfg && cfg.hotkeys) || {};
    return JSON.stringify({
      version: 1,
      displayId: cfg && cfg.displayId != null ? cfg.displayId : d.displayId,
      taskbarEdge: cfg && validEdge(cfg.taskbarEdge) ? cfg.taskbarEdge : d.taskbarEdge,
      interactive: !!(cfg && cfg.interactive),
      hotkeys: {
        toggleShow: hk.toggleShow || d.hotkeys.toggleShow,
        toggleInteractive: hk.toggleInteractive || d.hotkeys.toggleInteractive,
        cycleDisplay: hk.cycleDisplay || d.hotkeys.cycleDisplay,
        toggleCalibration: hk.toggleCalibration || d.hotkeys.toggleCalibration,
      },
    });
  }

  /** Parse a stored desktop config, repairing anything missing/corrupt. */
  function deserializeConfig(str) {
    var d = defaultConfig();
    try {
      var o = typeof str === "string" ? JSON.parse(str) : str;
      if (!o || typeof o !== "object") return d;
      var hk = o.hotkeys || {};
      return {
        version: 1,
        displayId: o.displayId != null ? o.displayId : null,
        taskbarEdge: validEdge(o.taskbarEdge) ? o.taskbarEdge : d.taskbarEdge,
        interactive: !!o.interactive,
        hotkeys: {
          toggleShow: hk.toggleShow || d.hotkeys.toggleShow,
          toggleInteractive: hk.toggleInteractive || d.hotkeys.toggleInteractive,
          cycleDisplay: hk.cycleDisplay || d.hotkeys.cycleDisplay,
          toggleCalibration: hk.toggleCalibration || d.hotkeys.toggleCalibration,
        },
      };
    } catch (e) {
      return d;
    }
  }

  Poker.OverlayLogic = {
    // hit-testing
    pointInRect: pointInRect,
    pointerOverPanels: pointerOverPanels,
    topmostPanelAt: topmostPanelAt,
    // multi-monitor
    rectContainsPoint: rectContainsPoint,
    displayForPoint: displayForPoint,
    displayById: displayById,
    overlayBoundsForDisplay: overlayBoundsForDisplay,
    // config
    DEFAULT_HOTKEYS: DEFAULT_HOTKEYS,
    defaultConfig: defaultConfig,
    serializeConfig: serializeConfig,
    deserializeConfig: deserializeConfig,
    // convenience: shared geometry (present if hud-layout.js loaded first)
    HudLayout: HudLayout,
  };
})(typeof self !== "undefined" ? self : this);
