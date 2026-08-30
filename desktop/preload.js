/*
 * preload.js - the ONLY bridge between the overlay renderer and Electron main.
 * Runs with contextIsolation on and node integration off, exposing a tiny,
 * explicit `window.overlayAPI` surface. No Node or Electron internals leak into
 * the page, and the page cannot reach anything not listed here.
 *
 * Nothing in this bridge reads the poker client or automates play — it only
 * moves the overlay window, toggles click-through, switches displays, and
 * swaps between the HUD view and the full-app (Watch) view.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayAPI", {
  // Present only in the Electron overlay, so the shared HUD code can feature-
  // detect the desktop environment.
  isDesktop: true,

  // Click-through control: in locked mode the renderer reports whether the
  // pointer is over a HUD panel; main captures input only then.
  setHover: (over) => ipcRenderer.send("overlay:hover", !!over),

  // locked (click-through) vs interactive (whole overlay captures).
  setMode: (mode) => ipcRenderer.send("overlay:set-mode", mode),
  getMode: () => ipcRenderer.invoke("overlay:get-mode"),
  onMode: (cb) => ipcRenderer.on("overlay:mode", (_e, mode) => cb(mode)),

  // Multi-monitor.
  getDisplays: () => ipcRenderer.invoke("overlay:get-displays"),
  moveToDisplay: (id) => ipcRenderer.send("overlay:move-to-display", id),
  cycleDisplay: () => ipcRenderer.send("overlay:cycle-display"),

  // Persist the taskbar edge into the desktop config (box layout itself is kept
  // in the renderer's localStorage by the shared HUD code).
  saveEdge: (edge) => ipcRenderer.send("overlay:save-edge", edge),

  // View switching: HUD overlay <-> full Poker Assistant app (Watch mode lives
  // in the real app, reused unchanged).
  toggleAppView: () => ipcRenderer.send("overlay:toggle-app-view"),

  // Lifecycle.
  quit: () => ipcRenderer.send("overlay:quit"),
  getConfig: () => ipcRenderer.invoke("overlay:get-config"),

  // Hotkey → renderer notifications (show/hide handled in main; these let the
  // HUD reflect state such as the lock toggle).
  onHotkey: (cb) => ipcRenderer.on("overlay:hotkey", (_e, name) => cb(name)),
});
