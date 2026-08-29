# HUD Overlay — manual QA checklist

The HUD Overlay is a Manifest V3 browser extension (Chrome/Edge) that layers a
war-style tactical HUD over the active tab, plus an in-app **🎯 HUD** toggle on
the Poker Assistant page itself. It is **advisory only**: it reads nothing from
any underlying poker site and performs no poker action. All numbers come from
the existing equity engine, computed from inputs you type into the HUD.

There is no build step. The layout maths are covered by automated tests
(`test/hud-layout.test.js`, run via `npm test`); the items below are the
by-hand checks that need a real browser.

## A. Load the extension (Chrome / Edge)
1. Visit `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the repository root (the folder containing
   `manifest.json`).
3. Confirm the action icon (amber reticle) appears with the title
   "Toggle Poker Assistant HUD overlay".

## B. Inject & revert
- [ ] On any normal `http(s)` page, click the toolbar icon → the HUD mounts
      (Table box, Info panel, docked Taskbar).
- [ ] Click the icon again **or** press the Taskbar **✕ CLOSE** → the HUD is
      fully removed. Inspect the DOM: no `#poker-assistant-hud-root` node
      remains, and the page underneath is untouched.
- [ ] Press **Esc** while the HUD is focused → it closes the same way.
- [ ] On a restricted page (e.g. `chrome://extensions`, the Web Store) the icon
      shows a brief `n/a` badge instead of injecting — expected.

## C. In-app toggle (no extension needed)
- [ ] Serve the site (`npm start`) and open it. Click **🎯 HUD** in the top bar
      → the same HUD mounts over the app. Click again → it closes.

## D. Three panels
- [ ] **Table box**: hero cards, board, pot, seat ring render from the input
      strip; editing Hero/Board updates the felt live.
- [ ] **Info panel**: scrolls vertically (`overflow-y`) when content exceeds its
      height; shows verdict, equity vs random, break-even, EV of calling, SPR,
      recommended action, confidence, assumptions and warnings.
- [ ] **Taskbar**: docked to a border, not draggable; holds SIMPLE/ADVANCED,
      STREET, NEXT, FLIP, RESET and CLOSE.

## E. Move / resize / reflow
- [ ] Drag each box by its title bar anywhere in the viewport; it clamps to the
      screen (no edge spills off).
- [ ] Release near an edge → the box snaps flush to that border.
- [ ] Resize each box from any edge/corner handle to an arbitrary rectangle.
- [ ] Shrink a box small: its internal UI **reflows** (inputs regrid, non-
      essential chrome drops, rows stack) — content is never clipped or broken.
      At the smallest sizes it reaches the `mini` compact form.
- [ ] Keyboard: focus a box (Tab), move with Arrow keys, resize with
      **Shift+Arrow**. Focus is always visible.
- [ ] Click a partially-covered box → it comes to the front (z-order).
- [ ] Click an empty area of the overlay → the click passes through to the page
      beneath (pointer-events passthrough).

## F. Taskbar edge flip
- [ ] Click **FLIP** → the Taskbar moves between the bottom and top borders.

## G. Persistence & reset
- [ ] Move/resize both boxes and flip the Taskbar, then close and re-open the
      HUD (or reload the page and re-open) → positions, sizes and Taskbar edge
      are restored.
- [ ] Click **RESET** → the layout returns to defaults.
- [ ] (Extension) persistence uses `chrome.storage.local`; (in-app) it uses
      `localStorage`. Both survive a reload.

## H. Aesthetic & accessibility
- [ ] Dark, semi-transparent panels; corner brackets; faint scanlines; amber /
      phosphor-green accents; monospace stencil headings; status light reflects
      confidence (green go / amber hold / red warn).
- [ ] With OS **reduced-motion** enabled, glows/transitions are suppressed.
- [ ] Text meets WCAG AA contrast against the panel grounds.

## I. Safety invariants (must always hold)
- [ ] No network request or DOM read targets the underlying site.
- [ ] No button performs or automates any poker action — every control only
      changes the HUD or recomputes advice from typed inputs.
- [ ] Extension permissions remain `activeTab`, `scripting`, `storage` only
      (check `chrome://extensions` → *Details* → *Permissions*).

## Known limitations
- If a page's Content-Security-Policy blocks web workers, the equity engine
  cannot start there; the HUD still mounts and the Info panel says so. The
  layout, controls and revert all continue to work.
