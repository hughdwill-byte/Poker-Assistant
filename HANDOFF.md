# Poker Assistant — Engineering Handoff

An in-depth guide to how the entire system works: the math engine, the web app,
the browser-extension HUD, and the desktop (Electron) overlay. Written for a
new engineer taking over the project.

- **Repo:** `hughdwill-byte/Poker-Assistant`
- **Default branch (a.k.a. "main"):** `claude/texas-holdem-poker-assistant-zmvna2`
  — carries the web app + browser extension.
- **Feature branch:** `claude/poker-assistant-range-upgrade-lcmpa1` — everything
  on default **plus** the `/desktop` Electron overlay (not yet merged at time of
  writing).
- **Tests:** `npm test` → **457 passed, 0 failed** (19 suites) on the feature
  branch (423 on default before the desktop suite).

---

## 0. What this is (and what it deliberately is not)

A **Texas Hold'em odds & betting advisor**. You enter (or auto-read) the cards
and the pot, and it computes your win probability and an EV-based recommendation
that updates exactly as cards appear.

**Non-negotiable design invariants** (they run through every layer — respect
them in any change):

1. **Advisory only.** Nothing clicks, bets, folds, or automates play. Every
   surface only *displays* advice.
2. **No client scraping/hooking.** No layer reads a poker site's DOM or a native
   client's process/memory. Inputs come from (a) the user typing, or (b) the
   built-in **Watch mode**, which reads *user-calibrated screen regions* via the
   browser's Screen Capture API — never the target app's internals.
3. **Exact math, single source of truth.** The evaluator and the uniform-equity
   engine are exact and must not be altered casually. Estimated/heuristic values
   are always shown **alongside** the EV recommendation, clearly labelled, and
   **never** silently override it.
4. **Nothing is called "GTO" unless it comes from the equilibrium math.** No
   unvalidated model drives a live recommendation.
5. **The web app stays buildless and dependency-free.** No bundler, no runtime
   deps. The one accepted exception is `/desktop` (Electron), whose deps are
   isolated there.
6. **Cash vs tournament money stay separate.** Rake applies only in cash mode;
   the ICM/tournament seam is disabled.

Positioning: study / play-money / practice / hand-replay. Follow the rules of
any venue.

---

## 1. The shared foundation: one namespace, three runtimes

Every engine file is a browser-style IIFE that attaches to a shared `Poker`
namespace on `self`:

```js
(function (root) {
  "use strict";
  var Poker = (root.Poker = root.Poker || {});
  // ... define things ...
  Poker.thing = thing;
})(typeof self !== "undefined" ? self : this);
```

Because of that pattern, the **exact same source** runs unchanged in three
places:

- the **browser window** (loaded via `<script>` tags in `index.html`),
- the **Web Worker** (`js/worker.js` `importScripts(...)` the same files),
- **Node** (the test harness `require(...)`s them; `test/load.js` sets
  `global.self = global` first so the IIFE attaches to the Node global).

This is why there is never a second copy of the math to keep in sync — the
extension and the desktop app both load these files *in place* (see §6–§7).

### Card encoding (memorize this)

A card is a single integer id: `id = (rank << 2) | suit`.

- **rank** 2–14 (`T=10, J=11, Q=12, K=13, A=14`)
- **suit** `clubs=0, diamonds=1, hearts=2, spades=3`
- helpers in `js/cards.js`: `makeId`, `rankOf`, `suitOf`, `cardLabel`,
  `buildRemaining(decks, removed)` (the live multiset after removing known
  cards).

### Canonical pot semantics (used everywhere EV is computed)

- **P** = the pot *before* the hero puts more chips in (includes opponents'
  current bets, excludes the hero's own call).
- **C** = amount to call = `max(0, currentBetTo − heroStreetCommitted)`.
- The UI's "displayed-pot convention" selector converts a table's pot box into
  this canonical P (it can include or exclude current bets, or already be the
  amount-you-can-win).

---

## 2. The math engine (`js/`)

Loaded in dependency order (see `index.html` and `test/load.js`). Grouped by
role:

### Core equity & evaluation
| File | Role |
|------|------|
| `cards.js` | Card ids, suit/rank tables, remaining-deck construction. |
| `evaluator.js` | Exact 7-card hand evaluator (hand ranking). |
| `equity.js` | `Poker.simulate(cfg)` — uniform win/tie/equity. Exact enumeration when only the board runout is unknown and small; Monte-Carlo otherwise. **This is the primary equity engine.** |
| `carddb.js` | Large precomputed card-recognition data used by Watch mode. |

**`simulate(cfg)` contract** (the one you'll reuse most):
```js
cfg = {
  players: [{ cards:[id,id], active:true }, { active:true }, ...], // hero is players[0]
  board:   [id, ...],          // 0,3,4, or 5 cards
  decks:   1,
  dead:    [id, ...],          // mucked/known-dead cards
  trials:  40000,
}
// → { ok:true, mode:"exact"|"montecarlo", trials, poolSize,
//     results:[ {win,tie,lose,equity}, ... ] }  // indexed like players[]
```

### Canonical state & actions
| File | Role |
|------|------|
| `game-state.js` | Positions, action order, legal-action generation, min-raise/reopen rules, effective stack, SPR, side pots, validation. |
| `action-tracker.js` | Apply/undo chronological actions; per-street commitments and bet-to amounts. |
| `advice.js` | Simple-mode pot-odds / EV recommendation. |

### Ranges & range-aware EV
| File | Role |
|------|------|
| `ranges.js` | 1,326-combo weighted ranges: notation parser (`QQ+, AKs, A5s-A2s, KQo:0.5`), blockers, normalise. |
| `range-presets.js` | Documented (non-GTO) prior ranges + population→style map. |
| `range-equity.js` | `simulateRanges(cfg)` — range-weighted equity with a seeded RNG, exact/MC, confidence intervals; unbiased rejection sampling for card removal. |
| `hand-features.js` | Exact made-hand / draw / board-texture features. |
| `opponent-model.js` | Beta-binomial opponent stats, action likelihood, Bayesian range updates; stake/population priors + recency (time-decay) weighting. |
| `action-ev.js` | Break-even equity, call/bet/raise EV (**rake-adjusted**), fold equity, side-pot payoffs. |
| `strategy.js` | The structured recommendation: Simple mode and Range-EV mode; threads rake context; attaches the reference layers below. |
| `draw-odds.js` | Outs / set-mining probabilities; a geometric bet-size helper (not wired into candidate generation). |

### "Phase C" — labelled GTO-reference & range-analytics layers
These are **reference-only** unless noted; they are shown next to the EV table,
never replacing it. Full status is tracked in
[`docs/future-math-roadmap.md`](docs/future-math-roadmap.md).

| File | Role |
|------|------|
| `equilibrium.js` | MDF `P/(P+B)`, alpha `B/(P+B)`, balanced bluff fraction `B/(P+2B)`, value:bluff `(P+B):B`, defense assessment, betting composition. Validated vs the spec's river reference table. |
| `implied-odds.js` | 5-branch draw EV, `simpleEV = e(P+W)−(1−e)C`, `W_min = C(1−e)/e − P`, nominal-outs mapping. Assumes no future winnings (W=0). |
| `range-vs-range.js` | Per-combo equity distribution, mean/nut/weak fractions, histogram, the hero hand's in-range percentile, range/nut advantage (heads-up). Runs off-thread via the worker `rvr` job. |
| `bet-composition.js` | Polarised value/bluff/check partition balanced to `(P+B):B`, blocker-aware bluff selection, mixed-strategy `bet X% / check Y%` for the hero hand. |
| `gto-defense.js` | Turns MDF + the hero hand's percentile into a DEFEND/FOLD verdict facing a bet; `reconcile()` compares it with the exploitative EV line (EV stays primary). The one equilibrium output that is an *action*. |
| `equity-realization.js` | Bounded realization factor `R ∈ [0.80,1.15]` (R=1 on the river). Shown beside raw equity; **not** wired into EV. |
| `tournament-icm.js` | **Disabled** ICM interface (throws until enabled). Marks the tournament seam; never feeds cash EV. |

---

## 3. The equity Web Worker (`js/worker.js`)

Keeps the UI responsive by running equity/strategy off the main thread. The
whole engine is `importScripts`-ed into the worker, so it runs the same code.

**Message protocol** — main posts `{ id, type, cfg }`; worker replies
`{ id, result }`. Only the latest job matters (callers ignore stale ids):

| `type` | Runs | Used for |
|--------|------|----------|
| `"simulate"` (or absent) | `Poker.simulate` | uniform equity vs random |
| `"range"` | `Poker.simulateRanges` | equity vs a modelled range |
| `"strategy"` | `Poker.Strategy.rangeRecommend` | full Range-EV recommendation |
| `"rvr"` | `Poker.RangeVsRange.analyze` | range-vs-range analytics |

The main thread keeps separate "pending id" channels per job type and drops
replies whose id is stale (stale-job cancellation).

---

## 4. The web app (`index.html`, `js/app.js`, `css/styles.css`)

- **`index.html`** — page shell: the poker-table felt, the advice/settings
  panel (Simple + Advanced sections), the card picker, and the mobile
  bottom-sheet UI. Loads every engine module then `app.js`, `carddb.js`,
  `watch.js`.
- **`js/app.js`** (~1,600 lines) — all UI state and wiring: the table/seat
  editor, card picker, Simple mode, Advanced (range-EV) mode, the three async
  worker channels (`pendingId`, `pendingStrategyId`, `pendingRvrId`), and
  rendering of the GTO reference / implied odds / population baseline / bet plan
  / GTO defense / realized equity cards. Also hosts the **🎯 HUD** in-app toggle
  (see §6).
- **`css/styles.css`** — poker-felt theme, desktop + iPhone layouts, plus the
  Advanced-mode card styles.

### Watch mode (`js/watch.js`, `js/watch-inference.js`, `carddb.js`)

Instead of typing, the user shares a tab/window via `getDisplayMedia`,
**calibrates screen regions once** (tracing card/board/pot boxes), and the app
reads those pixels each frame to recognise cards and infer actions.

- `watch.js` — capture, calibration UI, per-region OCR/card recognition
  (numeric K/M suffix handling included), frame loop.
- `watch-inference.js` — **pure** action inference over fixed seats (no seat
  collapse on fold; emits `reading.actives` + `reading.seats`); unit-tested.
- It reads *the shared screen the user chose*, never the poker client's
  internals, and **never acts** — it only fills in what the user would type.

---

## 5. The HUD renderer (shared by both overlays)

Two files in `extension/` are the reusable HUD, independent of how it's hosted:

### `extension/hud-layout.js` — pure layout maths (`Poker.HudLayout`)
No DOM. Unit-tested in `test/hud-layout.test.js`. Functions:
- `clampRect(rect, viewport, minW?, minH?)` — keep a box on-screen, enforce
  min size, cap to viewport.
- `snapToEdges(rect, viewport, threshold?)` — dock to a border when near it.
- `pickBreakpoint(width, table?)` — `full | compact | mini` for adaptive reflow.
- `defaultLayout(viewport)`, `clampLayout(layout, viewport)` — starting layout
  and re-clamp on viewport change.
- `serialize(layout)` / `deserialize(str, fallback)` — persistence round-trip.

### `extension/hud.js` — the Shadow-DOM HUD (`window.PokerHUD`)
Mounts a **full-viewport passthrough overlay** inside a Shadow DOM (site CSS
can't leak in; HUD CSS can't leak out). Three panels:

1. **Table box** — compact felt (hero cards, board, pot, seat ring) + an input
   strip (hero, board, players, pot, to-call, stack). Movable/resizable.
2. **Info panel** — scrollable readout: verdict, equity vs random, break-even
   (pot odds), EV of calling, EV by action, recommended action, SPR, effective
   stack, opponent-range source, confidence, assumptions, warnings.
   Movable/resizable.
3. **Taskbar** — docked top/bottom (FLIP); holds SIMPLE/ADVANCED, STREET, NEXT,
   FLIP, RESET, CLOSE.

Behaviour: pointer + keyboard drag/resize (Arrows move, Shift+Arrow resize, Esc
closes), viewport clamping, border snapping, click-to-front z-order, and
`ResizeObserver`-driven adaptive reflow (below thresholds it collapses to
compact/`mini` forms rather than clipping). Equity comes from the reused worker
(`type:"simulate"`); the odds/EV lines are the standard formulas, all labelled
advisory (one-street chip EV). Persists box layout to `chrome.storage.local`
(extension) or `localStorage` (in-app).

**Dual environment:** `hasChrome = chrome?.runtime?.getURL` decides whether to
use extension storage + `chrome.runtime.getURL('js/worker.js')`, or plain
`localStorage` + a relative `js/worker.js`.

`css` for the HUD lives in `extension/hud.css` (war-room aesthetic: corner
brackets, scanlines, amber/phosphor accents, mono headings, confidence status
light; AA-contrast plates; `prefers-reduced-motion` honoured).

---

## 6. Delivery surface A — Browser extension (Manifest V3)

Files: **`manifest.json` (at the repo ROOT)**, `extension/background.js`,
`extension/hud.js`, `extension/hud-layout.js`, `extension/hud.css`,
`extension/icons/`.

### Why the manifest is at the repo root
So the extension can load `js/` and the equity worker **in place** via
`chrome.runtime.getURL('js/worker.js')` — one source of truth, no forked copy,
no build step. Chrome's "Load unpacked" therefore points at the **repository
root** (the folder containing `manifest.json`), *not* `extension/`.

### How it works
- **Permissions:** `activeTab`, `scripting`, `storage` only. No host
  permissions — injection is granted transiently for the tab you click.
- `background.js` (service worker): on toolbar-icon click it
  `chrome.scripting.executeScript`s `hud-layout.js` + `hud.js` into the active
  tab, then calls `window.PokerHUD.toggle()`. Badges `n/a`/`err` on pages it
  can't inject into.
- The HUD mounts over whatever page is open; `js/worker.js` is created from the
  extension URL and `importScripts` the engine (listed in
  `web_accessible_resources`).
- **In-app toggle:** the web app's **🎯 HUD** button lazy-loads the same
  `hud-layout.js` + `hud.js` over the app page itself (no extension needed) —
  `chrome.*` is absent there, so it falls back to `localStorage` + relative
  worker URL.

### Install (developer / unpacked)
`chrome://extensions` → **Developer mode** → **Load unpacked** → select the repo
root → click the amber reticle icon on any page to toggle the HUD. See
[`docs/hud-overlay-qa.md`](docs/hud-overlay-qa.md).

**Limitation:** on a page whose CSP blocks web workers the equity engine can't
start there; the HUD still mounts and says so, and layout/controls/revert keep
working.

---

## 7. Delivery surface B — Desktop overlay (`/desktop`, Electron)

A frameless, transparent, **always-on-top** window that floats the HUD over
everything — browser, native client, or fullscreen. Electron deps are isolated
to `/desktop`; the web app stays dependency-free.

| File | Role |
|------|------|
| `desktop/main.js` | Main process: window flags, always-on-top level, click-through, global hotkeys, multi-monitor, config persistence, WATCH view. |
| `desktop/preload.js` | The only bridge: a minimal `window.overlayAPI` (contextIsolation on, nodeIntegration off). |
| `desktop/overlay.html` | Renderer. `<base href="../">` so it reuses the repo engine/worker/HUD **in place**; loads the Shadow-DOM HUD. |
| `desktop/overlay-bridge.js` | Mounts the reused HUD, adds desktop Taskbar buttons (LOCK, DISPLAY, WATCH, EXIT), and does pointer hit-testing to drive click-through. |
| `desktop/overlay-logic.js` | **Pure** desktop logic (`Poker.OverlayLogic`): hit-testing, multi-monitor bounds math, config serialize/deserialize. Unit-tested. |
| `desktop/overlay.css` | Iron-Man "visor" framing + transparent body (decorative, `pointer-events:none`). |
| `desktop/package.json` | `electron` + `electron-builder`; `start`/`dist` scripts + builder config. |

### Always-on-top over fullscreen
`setAlwaysOnTop(true, 'screen-saver')` + `setVisibleOnAllWorkspaces(true,
{ visibleOnFullScreen: true })`. Re-asserted after any bounds move. A true
*exclusive*-fullscreen DirectX client can still stay above any window — use the
poker client in windowed/borderless mode (documented in the QA checklist).

### Click-through hit-testing
The window starts with `setIgnoreMouseEvents(true, { forward:true })` so clicks
pass through empty areas. `forward:true` still delivers `mousemove` to the
renderer; `overlay-bridge.js` gathers the panel rectangles (inflated to include
resize handles) and calls `OverlayLogic.pointerOverPanels(x, y, rects)`. When
the pointer is over a panel it IPCs `overlay:hover true` and main calls
`setIgnoreMouseEvents(false)` so the panel captures input; off a panel it
reverts to click-through. A **LOCKED ⇄ LIVE** hotkey/button switches between
"panels-only capture" and "whole overlay captures" (for setup).

### Hotkeys, displays, persistence
- Global hotkeys (registered in main): `Ctrl/Cmd+Shift+H` show/hide,
  `…+Shift+L` lock toggle, `…+Shift+D` cycle display.
- Multi-monitor: launches on the display under the cursor; DISPLAY/hotkey move
  it and cover the whole chosen display (`OverlayLogic.displayForPoint` /
  `overlayBoundsForDisplay`, which handle negative-offset monitors).
- Persistence: box layout in the renderer's `localStorage`; display id, taskbar
  edge, mode and hotkeys in `overlay-config.json` in the app's `userData`
  (via `OverlayLogic.serializeConfig`). RESET restores defaults; EXIT quits and
  unregisters hotkeys.
- **WATCH view** loads the *unchanged* full web app (which contains Watch mode);
  a "◄ HUD" button (injected by main) returns to the overlay.

### Run / build
```bash
cd desktop
npm install     # electron + electron-builder, here only
npm start       # run the overlay
npm run dist    # build installers (dmg/zip · nsis/zip · AppImage/zip)
```
`electron-builder` nests the desktop files under `desktop/` and copies `js/`,
`extension/`, `css/`, `index.html` to the app root so `<base href="../">`
resolves in both dev and packaged builds. `npm start` is the verified path; GUI
packaging must be validated on a real desktop OS. See
[`desktop/README.md`](desktop/README.md) and
[`docs/desktop-overlay-qa.md`](docs/desktop-overlay-qa.md).

---

## 8. Data flow (end to end)

```
            ┌──────────────────────────────────────────────┐
 inputs ──▶ │  manual entry  |  Watch mode (screen regions) │
            └───────────────┬──────────────────────────────┘
                            ▼
                  canonical game state (P, C, board, seats)
                            ▼
        ┌───────────────────────────────────────────────┐
        │  equity Web Worker (js/worker.js)              │
        │   simulate | simulateRanges | strategy | rvr   │
        │   → runs the exact js/ engine off-thread       │
        └───────────────┬───────────────────────────────┘
                        ▼
     EV recommendation  +  labelled reference layers (GTO/implied/RvR/...)
                        ▼
        ┌───────────────┴───────────────┐
        │ web app cards │ HUD Info panel │   (extension HUD or desktop overlay)
        └───────────────────────────────┘
```

No arrow ever points *from* a poker client *into* this system. The overlays
only render advice computed from the user's own inputs / Watch reading.

---

## 9. Testing

- **Harness:** `test/harness.js` — a tiny zero-dependency assertion harness
  (`eq/ok/equal/approx/throws/section/summary`).
- **Loader:** `test/load.js` — requires every engine module (plus
  `extension/hud-layout.js` and `desktop/overlay-logic.js`) into the shared
  `Poker` global.
- **Runner:** `test/run.js` — aggregates all `*.test.js` suites and
  `process.exit(fail ? 1 : 0)`.
- **Run:** `npm test` (root). Current: **457 passed, 0 failed**, 19 suites.

Notable suites: `engine`, `game-state`, `ranges`, `range-equity`,
`range-vs-range`, `action-ev`, `rake-and-refs`, `equilibrium`,
`bet-composition`, `mixed-strategy`, `gto-defense`, `equity-realization`,
`implied-odds`, `opponent-model`, `priors-recency`, `hand-features`,
`watch-inference`, **`hud-layout`** (browser HUD geometry), **`overlay-logic`**
(desktop hit-testing / multi-monitor / config).

The GUI-dependent behaviour (real screen, multiple monitors, always-on-top,
click-through) is covered by the two manual QA checklists in `docs/`. The HUD
renderer was additionally smoke-tested headless with Playwright/Chromium.

---

## 10. Where to extend (and where not to)

**Safe, common extension points**
- New reference metric → new pure module in `js/` attaching to `Poker`, add a
  test suite, surface it in `app.js` / the HUD Info panel *next to* the EV
  table.
- New worker job → add a `type` branch in `js/worker.js` and a pending channel
  in `app.js`.
- New HUD control → add a button in the Taskbar (`extension/hud.js`); for
  desktop-only controls, add them from `desktop/overlay-bridge.js` so the
  shared HUD stays untouched.
- Layout/geometry changes → `extension/hud-layout.js` (keep it pure + tested).

**Do not, without explicit sign-off**
- Alter the evaluator or `simulate`/`simulateRanges` math.
- Add a runtime dependency or a build step to the web app (Electron deps stay in
  `/desktop`).
- Wire any labelled/heuristic value *into* the EV so it overrides raw equity.
- Add any read of a poker client's DOM/process, or any automated action.
- Enable the ICM/tournament seam or mix cash and tournament money.

**Roadmap of deferred factors** (multi-street tree, joint multiway sampling,
ICM, Nash push/fold, trained opponent model, etc.) with hooks and prerequisites:
[`docs/future-math-roadmap.md`](docs/future-math-roadmap.md). Formula-level spec:
[`docs/math-specification.md`](docs/math-specification.md).

---

## 11. File map (quick reference)

```
index.html               Web app shell
manifest.json            MV3 extension manifest (at ROOT so js/ is reused in place)
package.json             Web app (test script only; no runtime deps)
README.md                User-facing docs (features, install, math)
HANDOFF.md               This document

js/                      The engine (27 modules) + worker + app + watch
  cards, evaluator, equity, advice ............ core equity
  game-state, action-tracker .................. canonical state/actions
  ranges, range-presets, range-equity ......... ranges + range equity
  hand-features, opponent-model, action-ev .... features / model / EV
  strategy .................................... the recommendation
  equilibrium, implied-odds, range-vs-range,
    bet-composition, gto-defense,
    equity-realization, draw-odds, tournament-icm .. Phase C reference layers
  worker ...................................... off-thread engine host
  app ......................................... web UI + state
  watch, watch-inference, carddb .............. Watch mode

extension/               Browser-extension HUD (+ the reusable HUD)
  background .................................. MV3 service worker (inject/toggle)
  hud ......................................... Shadow-DOM 3-panel HUD (window.PokerHUD)
  hud-layout .................................. pure layout maths (Poker.HudLayout)
  hud.css, icons/ ............................. styling + action icons

desktop/                 Electron always-on-top overlay
  main, preload ............................... window flags, click-through, hotkeys, IPC
  overlay.html, overlay.css ................... renderer + visor chrome
  overlay-bridge .............................. mounts HUD, hit-testing, desktop taskbar
  overlay-logic ............................... pure hit-test/multi-monitor/config
  package.json, README.md ..................... Electron deps + run/build docs

test/                    Node harness + 19 suites (npm test)
docs/                    math-specification, future-math-roadmap,
                         hud-overlay-qa, desktop-overlay-qa, opponent-model
```

---

## 12. Getting started as the new owner

1. `git clone` the repo; the default branch has the web app + extension. For the
   desktop overlay, check out `claude/poker-assistant-range-upgrade-lcmpa1` (or
   merge it).
2. `npm test` — expect all suites green.
3. Web app: open `index.html` (or `python3 -m http.server 8080` and browse).
4. Extension: `chrome://extensions` → Developer mode → Load unpacked → repo root.
5. Desktop: `cd desktop && npm install && npm start`.
6. Read `docs/math-specification.md` for the formulas, then this file's §2 and
   §10 before changing engine code.
