# Desktop HUD Overlay — manual QA checklist

The desktop overlay is a small **Electron** app in `/desktop` that floats the
Poker Assistant HUD in a frameless, transparent, always-on-top window over
everything on screen. It reuses the existing `js/` math modules, the equity Web
Worker, the Shadow-DOM HUD (`extension/hud.js`), and the real web app (for Watch
mode) **unchanged**.

**Positioning — read first.** Display-only and **advisory**. The overlay **does
not** hook into, scrape, or read the poker client's process or DOM, and performs
**no** poker action. All data comes from manual inputs typed into the HUD and
from the app's existing Watch-mode screen reading (which you run in the WATCH
view). Use it for practice / play-money / replay study and follow the rules of
any venue.

The pure overlay logic (hit-testing, multi-monitor bounds, clamping/snapping,
breakpoints, persistence) is covered by `npm test`
(`test/overlay-logic.test.js`, `test/hud-layout.test.js`). The items below need a
real desktop and at least one (ideally two) monitors.

## Run it (development)
```
cd desktop
npm install        # installs Electron + electron-builder into /desktop only
npm start          # launches the overlay
```
The web app stays buildless and dependency-free; these dependencies live only in
`/desktop`.

## A. Always-on-top over other apps
- [ ] With a browser maximised, the overlay's HUD panels stay visible on top.
- [ ] Put a browser (or video) into **fullscreen** — the overlay still floats
      above it (macOS: `screen-saver` level + visible on all workspaces).
- [ ] macOS: switch Spaces / desktops — the overlay follows.
- [ ] Note any app that stays above the overlay (a true exclusive-fullscreen
      DirectX game can; borderless-fullscreen clients should not).

## B. Click-through & panel capture
- [ ] In the default **LOCKED** mode, click an **empty** area of the overlay →
      the click lands on the app underneath (browser link, desktop icon).
- [ ] Move the pointer over a HUD panel → it captures input; you can type in the
      inputs and click buttons.
- [ ] Move back to an empty area → clicks pass through again.
- [ ] Press the LOCK hotkey (default **Ctrl/Cmd+Shift+L**) or the Taskbar
      **LOCKED/LIVE** button → in **LIVE** (interactive) mode the whole overlay
      captures input (no passthrough). Toggle back to LOCKED.

## C. Three panels, move / resize / reflow
- [ ] Table box (hero cards, board, pot, seats) and Info panel (equity vs
      random, break-even, EV of calling, SPR, recommendation, confidence,
      assumptions, warnings) are both present; Taskbar is docked to a border.
- [ ] Drag each box anywhere; it clamps inside the overlay and snaps to borders.
- [ ] Resize each box from any edge/corner to an arbitrary rectangle.
- [ ] Shrink a box: its UI reflows (inputs regrid, rows stack, chrome drops) and
      is never clipped; at the smallest size it reaches the compact `mini` form.
- [ ] Keyboard: Tab to a box, move with Arrows, resize with **Shift+Arrow**;
      focus is visible. **Esc** closes the HUD (the window stays; re-open with
      the show/hide hotkey or relaunch).
- [ ] Click a covered panel → it comes to the front.

## D. Taskbar controls
- [ ] **SIMPLE/ADVANCED** changes readout density.
- [ ] **STREET / NEXT** update the felt/street.
- [ ] **FLIP** moves the Taskbar between top and bottom borders.
- [ ] **RESET** restores the default layout.
- [ ] **LOCKED/LIVE** toggles click-through vs interactive.
- [ ] **DISPLAY** moves the overlay to the next monitor.
- [ ] **WATCH** opens the full Poker Assistant app (with its unchanged Watch
      mode) in the window; a **◄ HUD** button returns to the overlay.
- [ ] **✕ EXIT** quits the app and returns you to a normal desktop.

## E. Hotkeys (global)
- [ ] **Ctrl/Cmd+Shift+H** shows/hides the overlay.
- [ ] **Ctrl/Cmd+Shift+L** toggles LOCKED/LIVE.
- [ ] **Ctrl/Cmd+Shift+D** cycles the display.

## F. Multi-monitor
- [ ] With two monitors, DISPLAY / the cycle hotkey moves the overlay to the
      other monitor and it covers that whole display.
- [ ] The overlay launches on the monitor under the cursor by default.

## G. Persistence & clean exit
- [ ] Move/resize boxes, flip the Taskbar, switch display and mode, then quit and
      relaunch → box positions/sizes (renderer `localStorage`) and the display /
      Taskbar edge / mode (`overlay-config.json` in the app's userData) are
      restored.
- [ ] **RESET** returns the layout to defaults.
- [ ] **✕ EXIT** leaves no always-on-top window behind; global hotkeys are
      unregistered on quit.

## H. Aesthetic & accessibility
- [ ] Iron-Man/war HUD look: corner-bracket visor arcs at the screen corners,
      faint scanlines, amber/phosphor accents, monospace headings, a confidence
      status light. Panels use solid backing plates so text stays legible over a
      transparent background.
- [ ] With OS **reduced-motion** on, glows/scanline effects are suppressed.
- [ ] Text meets WCAG AA contrast on the panel plates.

## I. Safety invariants (must always hold)
- [ ] No network request or read targets the poker client; the app runs offline.
- [ ] No control performs or automates any poker action.
- [ ] The overlay only *displays* advice computed from manual inputs / Watch
      screen reading.

## Packaging (build installers)
```
cd desktop
npm install
npm run dist        # electron-builder → desktop/dist/
```
`electron-builder` bundles the engine (`js/`, `extension/`, `css/`, `index.html`)
alongside the app so the packaged overlay reuses it in place. **Note:** building
distributables needs a real desktop OS with the dev dependencies installed and
was **not** verified in the headless build environment — validate the produced
binary on your target OS. The **`npm start`** dev run is the verified path.

## Known limitations
- A truly exclusive-fullscreen (not borderless) DirectX/OpenGL client can render
  above all windows; use the poker client in windowed/borderless mode.
- If a display's CSP or platform blocks web workers, the equity engine can't
  start; the HUD still mounts and reports it, and layout/controls keep working.
