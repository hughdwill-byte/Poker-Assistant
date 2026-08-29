# ♠ Poker Assistant — Texas Hold'em Odds & Betting Advisor

A fast, zero-install web app that shows your **real chance of winning** a Texas
Hold'em hand and tells you whether to **bet, call, raise, check or fold** — and
how much. Enter the cards you can see, and the odds update **exactly** with
what's still live in the deck.

Everything runs in the browser (no server, no tracking, no build step), so you
can host it for free on **GitHub Pages** and use it live at the table.

![Main screen](docs/images/screenshot-main.png)

---

## ✨ Features

- **Poker-table interface.** Every seat is drawn like a real seat with face-up
  or face-down cards, the community cards in the middle, the pot, and a **live
  win-probability bar for every player**.
- **Exact, self-updating odds.** Unknown cards are always drawn from the
  *actual remaining deck* — your hole cards, the board and mucked cards are
  removed first — so probabilities change precisely as cards appear.
  - When only the board runout is unknown, the result is the **true
    probability** from full enumeration of every possible runout.
  - Otherwise a fast **Monte-Carlo simulation** (10k–300k deals) is used.
- **Watch mode (beta).** Read a shared browser tab or window **live** and fill
  your cards and the board automatically, so you barely type anything. Uses the
  Screen Capture API — it can watch a *different* site than this app. Desktop
  only, and intended for play-money / practice / replay use.
- **Best / worst outlook.** For your hand it shows the strongest and weakest
  five-card hand you can still finish with by the river — your ceiling and
  floor — found by enumerating every remaining board runout from the unseen
  deck (e.g. *Best: Royal Flush · Worst: Ace high*).
- **Betting recommendation (Simple mode).** Combines your equity with the pot,
  the price to call and your stack to recommend an action and a **bet size**,
  using **pot odds** and **expected value (EV)**. All the numbers are shown so
  you can check the maths.
- **Range-aware EV strategy (Advanced mode, one deck).** Models each active
  opponent as a **weighted range of exact two-card combinations** (all 1,326 of
  them), computes your equity **against those ranges** with confidence
  intervals, and compares the **expected value of every legal action and bet
  size** — fold, call, and a ladder of bet/raise sizes — ranking them by EV with
  fold equity and equity-when-called shown. Simple mode keeps working unchanged;
  Advanced mode is opt-in and clearly separated.
- **GTO reference & range analytics (Advanced mode).** Shown *alongside* the EV
  recommendation — never overriding it, always labelled — a suite of
  equilibrium and range tools: **minimum-defense-frequency / α / value:bluff**
  references for the size faced; **implied & reverse-implied odds** (`W_min`) for
  a drawing hand; **range-vs-range** analysis of your whole range (range equity,
  nutted share, your hand's in-range percentile, and range/nut advantage); a
  **balanced bet plan** (which of your hands value-bet / bluff / check, at
  frequencies, with **blocker-aware** bluff selection); an **equilibrium
  defense verdict** (defend/fold vs a bet, reconciled with the EV line); a
  **realized-equity estimate** (raw × a bounded position/SPR heuristic); and
  **stake/population baseline priors** with recency-weighted opponent stats.
  See [docs/math-specification.md](docs/math-specification.md) and the
  [deferred-factor roadmap](docs/future-math-roadmap.md).
- **Fully customisable game.** Number of players (2–10) and number of decks
  (1–8). By default the deck is **reshuffled every hand** (a full, fresh deck
  each deal); turn that option off to track a multi-hand **shoe**, choosing how
  many hands are dealt before the shuffle — dealt cards then stay removed from
  the odds across the shoe.
- **Built for speed.** The simulation runs in a Web Worker so the interface
  never freezes. Simple mode stays fast and light; Advanced range work is
  heavier but stays off the main thread, with stale jobs ignored and
  convergence-based stopping once the confidence interval is tight enough.
- **First-class iPhone experience.** A dedicated mobile layout built to Apple
  HIG standards: safe-area (notch / home-indicator) aware, no zoom-on-focus,
  a thumb-reachable recommendation bar, an iOS-style bottom sheet for advice
  and settings, and a two-step card picker with large tap targets. Add it to
  your Home Screen and it launches full-screen like a native app.
- **Works offline & on mobile.** Responsive layout, plain HTML/CSS/JS.

---

## 🚀 Use it

### Option A — GitHub Pages (recommended)
1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source = Deploy from a branch**,
   pick your branch and the **`/ (root)`** folder, and save.
4. Open the published URL (e.g. `https://<you>.github.io/Poker-Assistant/`).

### Option B — Run locally
No dependencies are required. Any static file server works:

```bash
npm start          # serves on http://localhost:8080
# or:  python3 -m http.server 8080
```

Then open <http://localhost:8080>.

> Tip: opening `index.html` straight from the file system also works — the app
> automatically falls back to computing on the main thread if the Web Worker
> can't load over `file://`.

---

## 🕹️ How to use it

1. **Mark your seat.** Click the `⌂` button on the seat that is you (it gets a
   gold **YOU** tag).
2. **Enter cards.** Click any card slot to open the picker and choose a rank and
   suit. Your own cards and the community cards are face-up; opponents you can't
   see stay face-down (their hands are simulated).
3. **Enter the money.** Fill in the **pot**, the **amount to call**, and your
   **stack**.
4. **Read the advice.** The panel shows the recommended action, a suggested
   size, each player's win %, and the supporting maths.
5. **Between hands.** Use **Next hand** to muck the current cards (they stay
   dead in the shoe until a shuffle) or **Shuffle** to return everything to the
   deck.

![Heads-up example — pocket Aces](docs/images/screenshot-headsup.png)

### On iPhone

The whole tool is rebuilt for small screens: the felt fits the seats, the
always-visible bar at the bottom shows the current call (in the thumb zone),
and tapping it opens a native-style sheet with the full advice and settings.
The card picker becomes a two-step suit → rank selector with large targets.

<p>
  <img src="docs/images/mobile-main.png" alt="iPhone table view" width="270" />
  &nbsp;&nbsp;
  <img src="docs/images/mobile-picker.png" alt="iPhone card picker" width="270" />
</p>

**Install to Home Screen (iOS):** open the site in Safari → Share → *Add to
Home Screen*. It then launches full-screen with its own icon (a web app
manifest and Apple touch icon are included).

---

## 👁 Watch mode — read the table automatically (beta)

Instead of typing cards, let the app **read them off another window**. It uses
the browser's Screen Capture API (`getDisplayMedia`), so it can watch a
different site/tab than the app itself and update the odds live.

![Watch mode](docs/images/watch-mode.png)

**How to use it** (desktop Chrome / Edge / Firefox):
1. Click **👁 Watch**, then **Share a tab / window** and pick your poker window.
2. **Calibrate once:** click a box below the preview (e.g. *Your card 1*), then
   **trace it one straight edge at a time** — click each corner, and click the
   first point again (it turns green) to close. This lets you draw a tight,
   angled outline that follows a card even when it's partly behind another and
   leaves out the felt and any neighbouring card. A **magnifier loupe** follows
   your cursor for precise corners; Backspace undoes a point and Esc cancels. Do
   this for your two cards, the five board spots, and optionally the **Pot** and
   **My-stack** numbers. Boxes are saved, and the best-fit card is shown the
   moment you finish a trace.
3. Click **Start watching.** The **whole 52-card deck is recognised out of the
   box** from a built-in database of the site's card art — it matches on the
   number, suit and colour and ignores the green table, so it doesn't need to
   see the whole card. You normally teach *nothing*. If it ever meets a mark it
   doesn't know it shows the exact crop (magnified) and asks you to label it
   **once**. If the recogniser has mislabelled what it found (say it
   asks for a *suit* but you're looking at a *rank*), use the **Rank / Suit**
   switch; if the crop is cut off or grabbing the wrong thing, hit
   **↻ Re-box** to redraw that one box.
4. **Fix any card in one click.** The live strip shows every card it read —
   click one to open a full 52-card picker, set the true card, and it both
   corrects the table **and learns** that card for next time. This works for
   your hole cards *and* the board.
5. **Close the panel with ✕** — it shrinks to a small **live dock** (bottom-left) and keeps watching, so you can
   see the main table update live:
   your cards, the board, the pot, and your stack all fill in, and a big
   **action banner** under your cards shows FOLD / CHECK / CALL / BET. (Click a
   card in the dock to expand and correct it.)
6. Mark the **dealer** with the **D** button on a seat and the advice shows your
   table position (button / blinds / cutoff …).

**Your call & opponents' bets.** Box the **amount on your call button** (over
just the number, e.g. the `100K` in "CALL 100K") — that becomes the price to
call and the recommendation updates; a plain **CHECK** button (no number there)
reads as 0. You can also box **each opponent's bet** in front of their seat — the
**highest** is the current bet, and it sets the price to call if you haven't
boxed the button. The action banner then tells you **FOLD / CHECK / CALL / RAISE**
and a size. (Digits are shared with the Pot/Stack, so you only teach a number
once.)

**Two boxes per card (most reliable).** Each card has an optional second box —
its **· suit** box. Box the number in the card box and the suit in the suit box,
and it reads each directly with no guessing about where the suit is. This is the
steadiest mode, especially for a card that's partly hidden behind another. One
box still works (it auto-splits the number and suit); the suit box is there when
you want the extra certainty.

**Players in & out (two seat boxes, colour rules).** Set **Opponent seats** to
how many opponents are at your table (1–6; you're the last player). For each,
box the **empty-spot** box (where the blue **＋** shows) and the **cards** box
(where their two cards sit). Then: a **blue cross** = **empty**; the cards box
showing **table felt (green)** = **folded** (cards mucked); **no felt** = **in
the hand**. Two sliders tune the blue-cross and felt sensitivity. Click a seat in
the strip to force a state (it sticks until that seat changes). Only in-hand
opponents (+ you) count toward the odds, and the seat count sets the table size
immediately.

**Matching against the card database.** A bundled database (`js/carddb.js`)
holds the number and suit shapes of all 52 cards taken from the site's own card
art. On every box the app trims to just the **red and black marks** (ignoring
the green felt and any snipped edges), splits the number from the suit, and
picks the closest-fitting card in the database by shape **and** colour — so it
recognises a card from its index alone without seeing the whole thing. A card it
still can't place (or gets wrong) is one tap on the live strip to set and teach.

Numbers are read with a decimal point, so **1.2M** is read as 1,200,000 (not
12,000,000), and **K** / **M** suffixes and thousands separators are handled.

**Honest limits.** Recognition is template matching against the card database,
not a trained model: it's accurate on a clean, well-traced box but can misread —
glance at the live strip and one-click any card to fix and teach it. It reads
**your cards, the board, the pot and your stack** (the numbers that drive the
maths). Seats are now **fixed**: when an opponent folds, that seat is marked
inactive and sits out of the odds — the table is **not** collapsed or
renumbered, so a six-seat hand with three players left stays a six-seat hand.
Action inference (bet / call / raise / all-in / fold) is derived from **stable
state changes** with a confidence level; a **check** cannot be told from
inaction by chips alone, so it needs an explicit label or a one-tap
confirmation, and **low-confidence readings are surfaced for confirmation
instead of silently updating** anything (see
[docs/opponent-model.md](docs/opponent-model.md) and
`js/watch-inference.js`). It needs a desktop browser (iOS Safari can't
screen-share) and it **never acts for you** — it only fills in what you'd
otherwise type. Use it for play-money, practice, or hand-replay study, and
follow the rules of any site you're on.

---

## 🎯 HUD Overlay mode (browser extension)

A **war-style tactical HUD** you can float over any tab — a study window, a
play-money table, or a hand replayer — instead of keeping the app in a separate
window. It ships as a **Manifest V3 extension** (Chrome/Edge) and is also
reachable in-app via the **🎯 HUD** button in the top bar (no install needed
when you're already on the Poker Assistant page).

**Positioning — read this first.** The HUD is for **practice, play-money, and
hand-replay study**. It is **advisory only**: it **reads nothing** from the
underlying site's DOM and performs **no poker action of any kind**. Every number
it shows is computed by the *existing* equity engine from inputs **you type into
the HUD** — exactly the same manual inputs the main app takes. It does not
scrape live tables and it never clicks, bets, or folds for you. Follow the rules
of any site you use it on.

### The three panels
1. **Table box** — a compact visual felt (hero cards, board, pot, seat ring)
   with a small input strip for your hand, the board, player count, pot, to-call
   and stack. Freely movable and resizable.
2. **Info panel** — a scrollable readout: verdict, equity vs random opponents,
   break-even (pot odds), EV of calling, EV by action, recommended action, SPR,
   effective stack, opponent-range source, confidence, assumptions and warnings.
   Freely movable and resizable.
3. **Taskbar** — docked to the top or bottom border (flip with **FLIP**); holds
   all controls: SIMPLE/ADVANCED density, STREET, NEXT hand, RESET layout, and
   **✕ CLOSE**, which removes the HUD cleanly and restores the page.

### Interaction & adaptive layout
- Both boxes drag anywhere and resize to any rectangle via edge/corner handles;
  they **clamp** inside the viewport and **snap** to borders. Clicking a panel
  brings it to the front.
- **Keyboard-operable:** focus a box and move it with the Arrow keys, resize with
  **Shift+Arrow**; **Esc** closes the HUD. Focus rings are always visible and
  panels carry ARIA roles/labels.
- **Adaptive reflow:** a `ResizeObserver` drives container-style breakpoints, so
  each box's internal UI regrids and condenses as it shrinks and is **never
  clipped** — below a threshold it collapses to a compact `mini` form.
- Positions, sizes and the Taskbar edge **persist** (`chrome.storage.local` in
  the extension, `localStorage` in-app) and **RESET** restores defaults.

### War-room aesthetic & accessibility
Dark, semi-transparent panels with corner-bracket framing, faint scanlines,
amber / phosphor-green accents, monospace stencil headings, and a confidence
status-light. It honours **`prefers-reduced-motion`** and keeps text at **WCAG
AA** contrast.

### Install & architecture
- `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the repo
  root (the folder with `manifest.json`). Click the amber reticle icon on any
  page to toggle the HUD.
- Minimal permissions: **`activeTab`, `scripting`, `storage`** — no host
  permissions, so it only injects into the tab you click on.
- The HUD mounts inside a **Shadow DOM** (site CSS can't leak in, HUD CSS can't
  leak out) as a full-viewport passthrough layer (empty areas pass clicks
  through to the page). It reuses the existing equity **Web Worker** via
  `chrome.runtime.getURL` and the **unchanged** `js/` math modules.
- No build step, no bundler, no new runtime dependencies. Layout maths live in
  `extension/hud-layout.js` and are unit-tested (`test/hud-layout.test.js`).
- **Limitation:** on a page whose Content-Security-Policy blocks web workers the
  equity engine can't start there; the HUD still mounts and says so, and layout,
  controls and revert keep working.

See **[docs/hud-overlay-qa.md](docs/hud-overlay-qa.md)** for the full manual QA
checklist.

---

## 🧮 The maths (and why it's trustworthy)

Let `e` be your equity — your probability of winning the pot, with ties counted
as their fractional share (exactly what the simulator returns). `P` is the
**canonical pot before you add chips** (it includes opponents' current bets but
excludes your pending call — see [pot semantics](docs/math-specification.md#1-pot-semantics-the-canonical-convention)),
and `C` is your additional call cost.

| Concept | Formula | Meaning |
| --- | --- | --- |
| **Break-even equity** | `C / (P + C)` | the minimum `e` at which a call is not losing |
| **EV of calling** | `e · (P + C) − C` | expected chips vs folding |
| **Fold equity** | `F = P(villain folds)` | how often a bet takes it down uncontested |
| **EV of a bet `B`** | `F·P + (1−F)·(eCalled·(P + 2B) − B)` | value of betting, folds + called |
| **Effective stack** | `min(hero, opponent)` total chips | how deep the decision really is |
| **SPR** | `stackBehind / P` | stack-to-pot ratio |
| **Rake (cash only)** | `min(pot·%, cap)` on the **won** pot | reduces call/bet/raise EV; 0 in play-money/tournament |

Worked numbers (all in [`test/action-ev.test.js`](test/action-ev.test.js)):
`P=100, C=50, e=1/3 → EV_call = 0`; `e=0.40 → EV_call = 10`;
`P=100, B=50, F=0.5, eCalled=0.6 → EV_bet = 85`.

The recommendation logic:

- **Simple mode:** fold below the break-even equity; call/check when +EV but not
  a clear favourite; bet/raise for value when ahead.
- **Advanced mode:** every legal action and candidate bet size is scored by
  estimated EV and **ranked** — the top one is the recommendation, with the EV
  gap to the next-best, fold equity, equity-when-called and a confidence level.

### Why **not** Kelly for the bet size

Classic Kelly assumes a fixed binary wager where changing the stake leaves the
win probability and payoff odds unchanged. A poker bet breaks all of that: size
changes fold equity, calling ranges, future streets and pot geometry. So Kelly
is **not** used to choose the poker bet — bet sizes are compared by estimated EV
instead. Kelly is retained only as an optional, clearly labelled **bankroll-risk
statistic** (fractional Kelly), with the tournament stack kept distinct from a
bankroll. See [the math spec](docs/math-specification.md#10-why-kelly-is-not-the-bet-size-optimiser).

### Why this is **not** a GTO solver

The opponent ranges and action likelihoods are transparent heuristics and
Bayesian updates, not equilibrium-solver output. The **recommendation** is a
**range/EV** and **showdown-equity** recommendation — never labelled "GTO". The
Advanced mode does show a labelled **GTO reference** layer (MDF/α/value:bluff,
a balanced bet plan, an equilibrium defend/fold verdict) computed from
deterministic indifference maths — but it is shown *alongside* the EV
recommendation for comparison and **never silently overrides it**. Everything a
model estimates rather than derives exactly is marked as such, with its
assumptions and (for simulations) a confidence interval.

### Random-opponent vs range-adjusted equity

Simple mode's equity is versus **uniformly random** hands. Advanced mode's
equity is versus the **modelled ranges** — a modelled range, not a read on the
exact cards. Both are shown so you can see the difference. Advanced range
modelling is **one-deck only**; with more than one deck the app falls back to
uniform equity and says so.

### Exact vs Monte Carlo, and confidence intervals

When the number of unknown-card combinations is small the result is **exact
enumeration** (the true probability). Otherwise a **Monte-Carlo** simulation is
used and every range result carries a **95% confidence interval**, standard
error, and accepted/rejected sample counts. Outputs are rounded to the precision
the interval supports — the app never claims accuracy the CI does not justify.

### Rake (cash games)

In **Advanced mode** you can set the game type to *cash* and enter a rake
percentage and cap. Rake is `min(pot·%, cap)`, charged **only on a pot actually
won at showdown** — never on uncalled chips or a fold-branch win — and netted
out of every call/bet/raise EV. It is **0 in play-money and tournament** modes,
so the default behaviour is unchanged. See
[docs/math-specification.md §6a](docs/math-specification.md).

Full derivations: [docs/math-specification.md](docs/math-specification.md),
[docs/game-state-schema.md](docs/game-state-schema.md),
[docs/opponent-model.md](docs/opponent-model.md), the pre-upgrade + brief-coverage
[audit](docs/advanced-math-audit.md), and the deferred-factor
[roadmap](docs/future-math-roadmap.md).

### Verified against known probabilities

The engine ships with a dependency-free test suite that checks the evaluator
and compares computed equities to the **published all-in match-up
probabilities** (see the
[reference table](https://www.pokerstrategy.com/strategy/various-poker/texas-holdem-probabilities/)):

```bash
npm test
```

```
PASS AA vs KK (AA equity ≈ 0.823)   got=0.8269
PASS AKs vs QQ (QQ equity ≈ 0.535)  got=0.5376
PASS AA vs one random hand (≈ 0.852) got=0.8511
... game-state, ranges, hand-features, opponent-model, range-equity,
    action-EV, rake, equilibrium, implied-odds, range-vs-range,
    bet-composition, GTO-defense, realization and Watch-inference suites ...
382 passed, 0 failed
```

The suite (run by `test/run.js`) covers the exact evaluator and uniform equity,
the canonical game-state (fixed seats, positions, action order, min-raise, the
short-all-in reopen rule, side pots), the 1,326-combo ranges and notation
parser, hand/board features, the opponent model (non-negative weights,
normalisation, distinct raise/call ranges, beta-binomial shrinkage), range
equity (determinism, collision-free sampling, exact/MC agreement, confidence
intervals), the EV formulas, and pure Watch action-inference fixtures.

The 7-card hand evaluator ranks hands with a provably-correct total ordering
(category + ordered tie-breakers packed into one integer), and even handles the
five-of-a-kind case that only multi-deck play can produce.

---

## 🗂️ Project structure

```
index.html            Page shell and layout
manifest.webmanifest  PWA manifest (Home-Screen install)
css/styles.css        Poker-felt theme, desktop + iPhone layouts
js/cards.js           Card encoding + remaining-deck construction
js/evaluator.js       7-card hand evaluator (exact hand ranking)
js/equity.js          Uniform win/tie/equity engine (exact + Monte-Carlo)
js/advice.js          Simple-mode pot-odds / EV recommendation
js/game-state.js      Canonical state: positions, action order, legal actions,
                      min-raise/reopen, effective stack, SPR, side pots, validation
js/action-tracker.js  Apply/undo chronological actions; commitments & bet-to
js/ranges.js          1,326-combo weighted ranges, notation parser, blockers
js/range-presets.js   Documented (non-GTO) prior range data
js/hand-features.js   Exact made-hand / draw / board-texture features
js/opponent-model.js  Beta-binomial stats + likelihood + Bayesian range update
js/range-equity.js    Range-weighted equity (seeded RNG, exact/MC, CI)
js/range-vs-range.js  Hero-range equity distributions + range/nut advantage
js/action-ev.js       Break-even, call/bet/raise EV (+rake), fold equity, side pots
js/draw-odds.js       Outs / set-mining probabilities, geometric size helper
js/equilibrium.js     GTO reference: MDF, alpha, value:bluff, defense assessment
js/bet-composition.js Polarised value/bluff/check plan, blocker-aware bluffs, mix
js/gto-defense.js     Equilibrium defend/fold verdict, reconciled with EV
js/equity-realization.js  Raw x bounded realization factor (heuristic reference)
js/implied-odds.js    Implied / reverse-implied odds, W_min, draw branches
js/tournament-icm.js  Disabled ICM interface (tournaments deferred)
js/strategy.js        Structured Simple / Range-EV recommendation
js/watch-inference.js Pure Watch action inference (fixed seats, no collapse)
js/persistence.js     Versioned local opponent-profile storage
js/worker.js          Runs equity + strategy off the main thread
js/app.js             UI, state, Simple + Advanced modes, the poker-table view
js/watch.js           Watch mode: live screen-capture card recognition
test/run.js           Test runner (npm test) aggregating all suites below
test/*.test.js        Focused correctness suites (dependency-free)

manifest.json             MV3 extension manifest (activeTab/scripting/storage)
extension/background.js   Service worker: toolbar click injects & toggles the HUD
extension/hud.js          HUD content script (Shadow DOM, panels, drag/resize, revert)
extension/hud-layout.js   Pure layout maths: clamp / snap / breakpoints / persistence
extension/hud.css         Shadow-scoped war-style HUD styling
extension/icons/          Toolbar action icons (16/48/128)
test/hud-layout.test.js   Unit tests for the HUD layout maths
docs/hud-overlay-qa.md    HUD Overlay manual QA checklist
```

The engine files attach to a shared `Poker` namespace and run **unchanged** in
the browser, the Web Worker, and Node (for the tests) — one source of truth for
the maths.

---

## ⚠️ Notes

- This is a decision-support and learning tool. It assumes the equities you
  enter are the full picture; it does not model opponents' betting tendencies,
  bluffing, or future-street implied odds beyond the transparent formulas above.
- Please follow the rules of any venue you play in regarding electronic aids.

## License

MIT — see below. Use it, fork it, improve it.
