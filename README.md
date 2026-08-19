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
- **Best / worst outlook.** For your hand it shows the strongest and weakest
  five-card hand you can still finish with by the river — your ceiling and
  floor — found by enumerating every remaining board runout from the unseen
  deck (e.g. *Best: Royal Flush · Worst: Ace high*).
- **Betting recommendation.** Combines your equity with the pot, the price to
  call and your stack to recommend an action and a **bet size**, using **pot
  odds**, **expected value (EV)** and the **Kelly criterion** (the bet fraction
  that maximises long-run winnings). All the numbers are shown so you can check
  the maths.
- **Fully customisable game.** Number of players (2–10), number of decks (1–8),
  and how many hands are dealt before the deck is shuffled — dealt cards stay
  removed from the odds across a shoe.
- **Built for speed.** The simulation runs in a Web Worker so the interface
  never freezes; a full recalculation typically takes **under 100 ms**.
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

## 🧮 The maths (and why it's trustworthy)

Let `p` be your equity — your probability of winning the pot, with ties counted
as their fractional share (exactly what the simulator returns).

| Concept | Formula | Meaning |
| --- | --- | --- |
| **Pot odds (break-even equity)** | `toCall / (pot + toCall)` | the minimum `p` at which a call is not losing |
| **EV of calling** | `p · pot − (1 − p) · toCall` | expected chips gained/lost by calling |
| **Kelly stake** | `p − (1 − p)·toCall/pot` | fraction of your stack to commit for maximum long-run growth |

The recommendation logic:

- **Fold** when `p` is below the pot odds (a call is −EV).
- **Call / Check** when calling is +EV but you are not a clear favourite.
- **Raise / Bet** when you are a clear favourite, sizing toward the Kelly
  fraction and capping at your stack.

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
...
18 passed, 0 failed
```

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
js/evaluator.js     7-card hand evaluator (exact hand ranking)
js/equity.js        Win/tie/equity engine (exact enumeration + Monte-Carlo)
js/advice.js        Pot odds, EV and Kelly betting recommendation
js/worker.js        Runs the simulation off the main thread
js/app.js           UI, state and the poker-table view
test/engine.test.js Dependency-free correctness suite (npm test)
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
