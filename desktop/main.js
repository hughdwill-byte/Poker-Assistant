/*
 * main.js - Electron main process for the Poker Assistant desktop HUD Overlay.
 *
 * Creates a frameless, transparent, always-on-top window sized to cover a
 * chosen display, floating the assistant's HUD over everything — browser,
 * native poker client, or a fullscreen app. The overlay is DISPLAY-ONLY: it
 * never hooks, scrapes or reads the poker client, and never automates any
 * action. All data comes from the app's manual inputs and its existing Watch
 * mode (the real web app, reused unchanged, reachable via the WATCH view).
 *
 * Always-on-top over fullscreen:
 *   - macOS: setAlwaysOnTop(true, 'screen-saver') + setVisibleOnAllWorkspaces
 *     (true, { visibleOnFullScreen: true }).
 *   - Windows/Linux: 'screen-saver' maps to the top-most band Electron exposes;
 *     a borderless top-most window floats over a borderless-fullscreen client.
 *     A truly exclusive-fullscreen DirectX client can still stay above any
 *     window — that OS limitation is documented in docs/desktop-overlay-qa.md.
 *
 * Click-through: the window starts ignoring mouse events with { forward: true }
 * so clicks pass through to whatever is underneath; the renderer reports when
 * the pointer is over a HUD panel and we capture input just for that moment.
 */
"use strict";
const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require("electron");
const path = require("path");
const fs = require("fs");

// Pure, testable overlay logic (multi-monitor math + config (de)serialize).
// overlay-logic.js is a browser-style IIFE that attaches to `self.Poker`; in
// Node `self` isn't defined, so point it at the global before requiring.
global.self = global.self || global;
require("./overlay-logic.js");
const OL = global.Poker.OverlayLogic;

const CONFIG_PATH = () => path.join(app.getPath("userData"), "overlay-config.json");

let win = null;
let mode = "locked";          // 'locked' (click-through) | 'interactive'
let appView = false;          // false = HUD overlay, true = full app (Watch)
let config = OL.defaultConfig();

// ---- config persistence ----------------------------------------------------
function loadConfig() {
  try { config = OL.deserializeConfig(fs.readFileSync(CONFIG_PATH(), "utf8")); }
  catch (e) { config = OL.defaultConfig(); }
  mode = config.interactive ? "interactive" : "locked";
}
function saveConfig() {
  try {
    config.interactive = mode === "interactive";
    fs.writeFileSync(CONFIG_PATH(), OL.serializeConfig(config));
  } catch (e) { /* best-effort; overlay still works without a saved config */ }
}

// ---- display helpers -------------------------------------------------------
function electronDisplays() {
  return screen.getAllDisplays().map((d) => ({
    id: d.id, bounds: d.bounds, workArea: d.workArea,
  }));
}
function chosenDisplay() {
  const displays = electronDisplays();
  if (config.displayId != null) {
    return OL.displayById(config.displayId, displays, screen.getPrimaryDisplay().id);
  }
  // Default: the display under the cursor at launch.
  const pt = screen.getCursorScreenPoint();
  return OL.displayForPoint(pt, displays) || displays[0];
}
function coverDisplay(display) {
  if (!win || !display) return;
  const b = OL.overlayBoundsForDisplay(display);
  win.setBounds(b);
  config.displayId = display.id;
  // Re-assert the top-most level after any bounds move.
  win.setAlwaysOnTop(true, "screen-saver");
}

// ---- mouse capture ---------------------------------------------------------
function applyHover(over) {
  if (!win || mode !== "locked") return;
  // In locked mode, capture only while over a panel; otherwise pass through.
  if (over) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
}
function applyMode() {
  if (!win) return;
  if (mode === "interactive") {
    win.setIgnoreMouseEvents(false);           // whole overlay captures
  } else {
    win.setIgnoreMouseEvents(true, { forward: true }); // click-through until hover
  }
  win.webContents.send("overlay:mode", mode);
}

// ---- window ----------------------------------------------------------------
function overlayFileURL() { return path.join(__dirname, "overlay.html"); }
function appFileURL() { return path.join(__dirname, "..", "index.html"); }

function createWindow() {
  const display = chosenDisplay();
  const b = OL.overlayBoundsForDisplay(display);
  config.displayId = display ? display.id : null;

  win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: true,
    movable: true,
    hasShadow: false,
    skipTaskbar: false,
    fullscreenable: false,
    alwaysOnTop: true,
    // Keep it out of Mission Control / app switching noise where possible.
    type: process.platform === "darwin" ? "panel" : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // Float above fullscreen apps and follow the user across Spaces/workspaces.
  win.setAlwaysOnTop(true, "screen-saver");
  if (typeof win.setVisibleOnAllWorkspaces === "function") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // Start click-through.
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(overlayFileURL());
  win.on("closed", () => { win = null; });

  win.webContents.on("did-finish-load", () => {
    // When showing the full app for Watch, inject a small "Return to HUD"
    // control so the user can get back without a hotkey. The app itself is
    // loaded unchanged.
    if (appView) injectReturnButton();
    else applyMode();
  });
}

function injectReturnButton() {
  const js = `(() => {
    if (document.getElementById('overlay-return-hud')) return;
    const b = document.createElement('button');
    b.id = 'overlay-return-hud';
    b.textContent = '◄ HUD';
    b.title = 'Return to the HUD overlay';
    b.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;'
      + 'background:#0c1712;color:#ffb02e;border:1px solid #1c2a22;border-radius:3px;'
      + 'font:12px monospace;letter-spacing:.1em;padding:8px 12px;cursor:pointer;';
    b.addEventListener('click', () => window.overlayAPI && window.overlayAPI.toggleAppView());
    document.body.appendChild(b);
  })();`;
  win.webContents.executeJavaScript(js).catch(() => {});
}

function toggleAppView() {
  appView = !appView;
  if (appView) {
    // Full app needs a normal, interactive, opaque window.
    mode = "interactive";
    win.setIgnoreMouseEvents(false);
    win.loadFile(appFileURL());
  } else {
    mode = config.interactive ? "interactive" : "locked";
    win.loadFile(overlayFileURL());
  }
  saveConfig();
}

// ---- hotkeys ---------------------------------------------------------------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = config.hotkeys;
  const tryReg = (accel, fn) => { try { globalShortcut.register(accel, fn); } catch (e) {} };
  tryReg(hk.toggleShow, () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else { win.show(); win.setAlwaysOnTop(true, "screen-saver"); }
  });
  tryReg(hk.toggleInteractive, () => {
    mode = mode === "locked" ? "interactive" : "locked";
    applyMode();
    saveConfig();
  });
  tryReg(hk.cycleDisplay, () => cycleDisplay());
  tryReg(hk.toggleCalibration, () => {
    // The renderer owns the calibration editing layer; just notify it.
    if (win && !appView) win.webContents.send("overlay:hotkey", "calibration");
  });
}

function cycleDisplay() {
  const displays = electronDisplays();
  if (displays.length < 2) return;
  let idx = displays.findIndex((d) => d.id === config.displayId);
  idx = (idx + 1) % displays.length;
  coverDisplay(displays[idx]);
  saveConfig();
}

// ---- IPC -------------------------------------------------------------------
function wireIpc() {
  ipcMain.on("overlay:hover", (_e, over) => applyHover(over));
  ipcMain.on("overlay:set-mode", (_e, m) => { mode = m === "interactive" ? "interactive" : "locked"; applyMode(); saveConfig(); });
  ipcMain.handle("overlay:get-mode", () => mode);
  ipcMain.handle("overlay:get-displays", () => ({
    displays: electronDisplays(),
    currentId: config.displayId,
    primaryId: screen.getPrimaryDisplay().id,
  }));
  ipcMain.on("overlay:move-to-display", (_e, id) => {
    const d = OL.displayById(id, electronDisplays(), screen.getPrimaryDisplay().id);
    coverDisplay(d); saveConfig();
  });
  ipcMain.on("overlay:cycle-display", () => cycleDisplay());
  ipcMain.on("overlay:save-edge", (_e, edge) => { config.taskbarEdge = edge === "top" ? "top" : "bottom"; saveConfig(); });
  ipcMain.on("overlay:toggle-app-view", () => toggleAppView());
  ipcMain.handle("overlay:get-config", () => config);
  ipcMain.on("overlay:quit", () => { app.quit(); });
}

// ---- app lifecycle ---------------------------------------------------------
app.whenReady().then(() => {
  loadConfig();
  wireIpc();
  createWindow();
  registerHotkeys();

  // Keep covering the right display when monitors change.
  screen.on("display-added", () => { if (win && !appView) coverDisplay(chosenDisplay()); });
  screen.on("display-removed", () => { if (win && !appView) coverDisplay(chosenDisplay()); });

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
// The overlay is a single-window utility; quit when it closes on all platforms.
app.on("window-all-closed", () => app.quit());
