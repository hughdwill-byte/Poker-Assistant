# Poker Assistant — Desktop HUD Overlay (Electron)

A frameless, transparent, **always-on-top** desktop overlay that floats the
Poker Assistant HUD over everything on screen — your browser, a native poker
client, or a fullscreen app — so you see the table and all the assistant's
numbers at once. Iron-Man/war-room aesthetic.

> **Display-only and advisory.** This overlay does **not** hook into, scrape, or
> read the poker client's process or DOM, and performs **no** poker action. All
> data comes from inputs you type into the HUD and from the app's existing
> Watch-mode screen reading. It's for practice / play-money / replay study —
> follow the rules of any venue you use it on.

## Run (development)
```bash
cd desktop
npm install     # Electron + electron-builder, installed ONLY in /desktop
npm start
```
The overlay opens on the monitor under your cursor. The web app itself stays
buildless and dependency-free — these dependencies are isolated to `/desktop`.

## Controls
| Where | Control | Action |
|-------|---------|--------|
| Global hotkey | `Ctrl/Cmd+Shift+H` | Show / hide the overlay |
| Global hotkey | `Ctrl/Cmd+Shift+L` | Toggle **LOCKED** (click-through) ⇄ **LIVE** (interactive) |
| Global hotkey | `Ctrl/Cmd+Shift+D` | Move to the next monitor |
| Taskbar | SIMPLE/ADVANCED · STREET · NEXT · FLIP · RESET | HUD readout + layout |
| Taskbar | LOCKED/LIVE | Same as the lock hotkey |
| Taskbar | DISPLAY | Move to the next monitor |
| Taskbar | WATCH | Open the full app (with unchanged Watch mode); **◄ HUD** returns |
| Taskbar | ✕ EXIT | Quit and return to the desktop |
| Box focus | Arrows / **Shift+Arrow** | Move / resize a panel by keyboard |
| Anywhere in HUD | **Esc** | Close the HUD |

In **LOCKED** mode, clicks on empty overlay areas pass through to the app
beneath; the overlay captures input only while the pointer is over a HUD panel.
**LIVE** mode captures the whole overlay for setup.

## How it works
- `main.js` — creates the frameless/transparent/always-on-top window
  (`setAlwaysOnTop(true,'screen-saver')`, `setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})`),
  manages click-through (`setIgnoreMouseEvents(true,{forward:true})`), global
  hotkeys, multi-monitor placement, and config persistence
  (`overlay-config.json` in the app's userData).
- `preload.js` — a minimal `window.overlayAPI` bridge (contextIsolation on,
  nodeIntegration off).
- `overlay.html` — sets `<base href="../">` so it reuses the repo's `js/`,
  `extension/`, and worker **in place**; loads the Shadow-DOM HUD.
- `overlay-bridge.js` — mounts the reused HUD, adds the desktop Taskbar buttons,
  and does pointer-over-panel hit-testing to drive click-through.
- `overlay-logic.js` — pure, unit-tested logic (hit-testing, multi-monitor
  bounds math, config serialize/deserialize); shares `Poker.HudLayout` geometry
  with the browser HUD.
- Equity is computed by the existing `js/worker.js` Web Worker, reused unchanged.
  Everything runs offline.

## Build installers
```bash
cd desktop
npm run dist     # → desktop/dist/  (dmg/zip on macOS, nsis/zip on Windows, AppImage/zip on Linux)
```
`electron-builder` bundles the engine alongside the app. Building distributables
requires a real desktop OS with the dev dependencies installed; the `npm start`
dev run is the verified path (see `../docs/desktop-overlay-qa.md`).

## Tests
The pure overlay logic runs under the repo's Node harness:
```bash
cd ..        # repo root
npm test     # includes test/overlay-logic.test.js and test/hud-layout.test.js
```
