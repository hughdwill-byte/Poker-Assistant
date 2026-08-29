# Advanced Math Audit

This document records the state of the Poker Assistant **before** the
range-aware upgrade, verified against the current checkout of branch
`claude/poker-assistant-range-upgrade-lcmpa1`, and lists every input the
advanced implementation adds. It is the reference for what changed and why.

## Baseline test result

```
npm test  →  18 passed, 0 failed
```

All evaluator and uniform-equity regressions pass. The exact enumerator, the
Monte-Carlo path, multi-deck bookkeeping and the single-deck duplicate guard
are all correct and are **preserved unchanged** by this upgrade.

## Current poker-state inputs (verified against the checkout)

| Input | Source | Stored in | Consumed by |
|---|---|---|---|
| Hero hole cards | Manual picker / Watch (`hero[]`) | `state.players[heroIndex].cards` | equity engine |
| Each player's cards | Manual picker | `state.players[i].cards` | equity engine |
| Player active flag | Manual (`✓` button) / Watch (`actives[]`) | `state.players[i].active` | equity engine (filters showdown) |
| Board cards (5 slots) | Manual picker / Watch (`board[]`) | `state.board[]` | equity engine |
| Dead / mucked cards | `Next hand` lifecycle | `state.dead[]` | equity engine |
| Number of decks | Manual slider | `state.decks` | equity engine |
| Number of players | Manual slider / Watch (`numPlayers`) | `state.numPlayers` | seat rendering, equity (via active filter) |
| Pot | Manual field / Watch (`pot`) | `state.pot` | advice engine |
| To call | Manual field / Watch (`toCall`) | `state.toCall` | advice engine |
| To-call pending | Watch (`toCallPending`) | `state.toCallPending` | recommendation gating |
| Hero stack | Manual field / Watch (`stack`) | `state.players[heroIndex].stack` | advice engine |
| Per-opponent stack | Manual per-seat field | `state.players[i].stack` | **neither** (display only) |
| Per-opponent bet | Watch (`bets[]`) | `state.players[i].bet` | **neither** (display only) |
| Dealer / button seat | Manual (`D` button) / Watch (`dealer`) | `state.dealer` | **display note only** (`positionNote()`) |
| Simulation quality | Manual select | `state.trials` | equity engine (MC trial count) |
| Reshuffle mode / shoe length | Manual | `state.reshuffleEveryHand`, `handsBeforeShuffle` | dead-card lifecycle |

### What `equity.js` receives

Only: `players[{cards, active}]`, `board`, `decks`, `dead`, `trials`. No
position, no stacks, no ranges, no bets.

### What `advice.js` receives

Only: `equity`, `pot`, `toCall`, `stack`. It produces a single-threshold
FOLD/CHECK/CALL/BET/RAISE recommendation.

## Confirmation of the reviewed observations

Every observation in the task brief is confirmed against this checkout:

- **Per-opponent stacks are editable but unused by the recommendation.**
  Confirmed — `seat-stack` inputs write `player.stack`, but only the hero's
  stack is passed to `advise()`.
- **Dealer position is used only for a display note.** Confirmed —
  `state.dealer` feeds only `positionNote()`, appended to the banner meta.
- **Watch reads** hero cards, board, pot, hero stack, hero current bet
  (`mybet`), call amount, up to six opponent bets, and seat appearance.
  Confirmed (`js/watch.js`, `REGION_KEYS` / `BET_KEYS` / `SEAT_KEYS`).
- **Watch reduces the player count when opponents fold.** Confirmed —
  `js/watch.js` computes `activeOpp` and emits `reading.numPlayers =
  activeOpp + 1`, collapsing the table instead of preserving fixed seats.
- **Watch has no dealer detection nor a chronological action stream.**
  Confirmed — no button region and no per-action events exist; the reading
  is a per-frame snapshot.

## Mathematical defects in the baseline advice engine

These are corrected by the upgrade (the equity engine has **no** defects and
is preserved):

1. **`advice.js` Kelly is mislabelled.** Kelly is presented as the poker
   bet-size optimiser. A poker wager is not a fixed-odds binary bet — bet
   size changes fold equity and calling ranges — so raw Kelly is invalid
   here. Kept only as an optional, clearly labelled bankroll-risk overlay.
2. **Single-threshold advice.** No per-action EV comparison, no fold equity,
   no legal-action generation, no side pots, no opponent ranges.
3. **No range awareness.** Equity is always versus uniform-random hands.

## New inputs required by the advanced implementation

| New input | Source | Stored in | Consumed by |
|---|---|---|---|
| Button seat (`buttonSeat`) | Advanced UI / Watch | game-state | positions, action order |
| Small blind / big blind / ante / straddle | Advanced UI | game-state `game` | blind posting, min-raise, SPR |
| Street (`preflop`/`flop`/`turn`/`river`) | Derived from board (+ override) | game-state | action order, likelihood model |
| Pot-display convention | Advanced UI / Watch | game-state `game.potDisplayMode` | canonical pot derivation |
| `currentBetTo`, `lastFullRaiseSize` | Action tracker | game-state | to-call, min-raise, reopen logic |
| Per-seat `streetCommitted`, `handCommitted` | Action tracker / Watch | game-state players | to-call, side pots, EV |
| Per-seat `startingStack`, `stackBehind` | Advanced UI / Watch | game-state players | effective stack, SPR, legal caps |
| Per-seat `seated`/`dealtIn`/`active`/`folded`/`allIn` | Advanced UI / Watch (`seats[]`) | game-state players | fixed seats, side-pot eligibility |
| Per-seat range spec / preset / profile | Advanced UI | game-state players | range-weighted equity, EV |
| Chronological actions (`actions[]`) | Action tracker / Watch inference | game-state | opponent-model updates, reopen logic |
| Opponent profile stats (VPIP, PFR, 3-bet, c-bet, …) | Persistence / Watch | `js/persistence.js` (localStorage) | opponent-model likelihoods |

## New mathematical modules

| Module | Responsibility |
|---|---|
| `js/game-state.js` | Canonical schema, positions, action order, to-call, min-raise, reopen rules, legal actions, effective stack, SPR, canonical pot, side pots, validation |
| `js/action-tracker.js` | Apply/undo chronological actions; derive commitments and `currentBetTo` |
| `js/ranges.js` | 1,326 combos, canonical ordering, notation parser, blockers, set ops, weighted sampling, combo↔169-class conversion, summaries, validation |
| `js/range-presets.js` | Documented preset & position/action range data (not GTO) |
| `js/hand-features.js` | Exact made-hand and draw/board-texture feature extraction |
| `js/opponent-model.js` | Beta-binomial profile stats + heuristic action likelihood + Bayesian range update |
| `js/range-equity.js` | Seeded RNG, rejection-sampled joint range equity, exact enumeration, confidence intervals |
| `js/action-ev.js` | Canonical pot semantics, break-even equity, call/bet/raise EV, fold equity, side-pot shares |
| `js/strategy.js` | Orchestrate the structured `range-ev` recommendation and the `simple` fallback |
| `js/persistence.js` | Versioned opponent-profile storage, export/import, migration |

## Differences between this checkout and the brief's described baseline

None material. Every field and behaviour the brief describes is present in
the checkout as described. The Watch file has newer number-reading
refinements (mode-vote OCR, pinned values) layered on top of the same
`applyReading` contract; these do not change the state model and are
preserved. The `player.stack`/`player.bet` fields already exist on each
player object, so the upgrade extends the player record rather than
replacing it.

---

# Part 2 — Coverage vs the Texas Hold'em Mathematics brief

Audit of the checkout against `texas_holdem_math_claude_code.md` (spec v1.0).
Baseline before this pass: `npm test` → **195 passed, 0 failed**. After this
pass: **221 passed, 0 failed**.

Legend: ✅ implemented & tested · ➕ added this pass · 📄 documented-only
(deferred, see `docs/future-math-roadmap.md`) · ⛔ intentionally not built.

| Spec § | Item | Status | Where |
|---|---|---|---|
| 2.1 | Card representation, uniqueness | ✅ | `cards.js`, `game-state.js` validate |
| 2.2 | Best-5-of-7 evaluator, total order, wheel | ✅ (preserved) | `evaluator.js` |
| 2.3 / T20-T21 | Side pots by contribution levels; eligibility; uncalled excess returned | ✅ | `game-state.js buildSidePots`, `action-ev.js sidePotExpectation` |
| 3.1 / T02-T03 | 1,326 combos; 6/4/12 class counts | ✅ | `ranges.js`, `ranges.test.js` |
| 3.2 / T04 | Blockers / card removal (KQ on KT4 → 8 AK) | ✅ | `ranges.js removeBlockers` |
| 3.3 / 12.1 / T24 | Weighted ranges; Bayesian update `w'∝w·P(a|h)` | ✅ | `ranges.js`, `opponent-model.js updateRange` |
| 3.4 / T07 | 7-card category distribution regression | ✅ | `hand-features` via evaluator (counts checked in evaluator tests) |
| 4.1 / T08-T09 | Outs probabilities (next card; by river all-in) | ➕ | `draw-odds.js`, `rake-and-refs.test.js` |
| 4.2 | Common nominal outs table | 📄 | reference in `draw-odds.js` docs |
| 5 / 17.2 / T25,T30 | Range equity; exact vs MC; seeded RNG; collision rejection; CI | ✅ | `range-equity.js`, `range-equity.test.js` |
| 6 / T10-T12 | Pot odds `C/(P+C)`; `EV_call=E(P+C)−C` | ✅ | `action-ev.js`, `action-ev.test.js` |
| 6.2 | **Rake** subtracted from won pot; per-side-pot EV | ➕ | `action-ev.js rake`, `rake-and-refs.test.js` |
| 7.1 | Sunk-cost accounting (`−C`, not total) | ✅ | `action-ev.js`, T28 in `action-ev.test.js` |
| 7.2 / T12 | Call/bet/raise EV formulas | ✅ | `action-ev.js` |
| 7.3 | Outcome-tree (branch) EV | ✅ | `action-ev.js evFromBranches` |
| 7.4 | Sklansky $ / G-bucks (labels over ordinary EV) | ✅ (delta vs range equity) | `range-equity.js` |
| 8.1 / T13-T14 | Pure-bluff break-even folds `B/(P+B)` | ➕ | `action-ev.js breakEvenFoldForBluff` |
| 8.3 / T15 | Two-branch required folds `−Vc/(P−Vc)` (4-bet 63.94%) | ➕ | `action-ev.js requiredFoldFrequency` |
| 8.4 | MDF `P/(P+B)`, ideal bluff fraction `B/(P+2B)` (reference only) | ➕ | `action-ev.js minDefenseFrequency`, `idealBluffFraction` |
| 8.5 | Multiway fold `∏fᵢ` (independent approximation, labelled) | ✅ | `strategy.js combinedResponse` |
| 9.1-9.2 | Implied / reverse-implied odds (branch `W_min`) | 📄 | roadmap #2 |
| 9.3 / T18 | Set-mining probability 11.7551% | ➕ | `draw-odds.js flopSetProbability` |
| 9.3 note | raw vs realized equity | 📄 | roadmap #1 |
| 10.1-10.2 / T16 | Effective stack; SPR `stack/pot` | ✅ | `game-state.js effectiveStack/spr` |
| 10.3 / T17 | Geometric multi-street sizing helper | ➕ (helper only, not wired) | `draw-odds.js geometricBetFraction`; roadmap #10 |
| 10.4 | Pot commitment is an EV result | ✅ | `strategy.js` ranks vs fold=0 |
| 11 | Bet sizing as EV optimisation over candidates | ✅ | `strategy.js` candidate ladder + EV ranking |
| 11.4 | Rake-aware thresholds | ➕ | rake netted per candidate in `strategy.js` |
| 12.1 | Bayesian range update | ✅ | `opponent-model.js` |
| 12.4 | Beta-binomial stats with denominators | ✅ | `opponent-model.js stats` |
| 12.5 | Model confidence & sensitivity | ✅ (confidence) / 📄 (full sweeps) | `strategy.js` confidence; roadmap #6 |
| 13.2 | Board-texture features | ✅ | `hand-features.js boardTexture` |
| 13.x | Play templates, theorems, WA/WB, range advantage | 📄 | roadmap #3,#4,#7 |
| 14 / T22-T23 | ICM, ROI, cEV vs $EV | 📄 (disabled stub) | `tournament-icm.js` stub; roadmap #12 |
| 15 | Winrate / variance / bankroll | ⛔ (out of scope; operator layer) | — |
| 17.4 / T27 | Legal actions, min-raise, short all-in reopen | ✅ | `game-state.js`, `game-state.test.js` |
| 17.5 / T26 | Probability checks (sum-to-1, no negatives) | ✅ | `ranges.js validate`, model normalisation |

## Gaps closed this pass

- **Rake-adjusted EV** (§6.2, §11.4): implemented as a pure function, netted
  from every showdown branch, gated by game mode, wired into the strategy and a
  cash/rake UI, and tested (including the "not raked on uncalled" rule).
- **Deterministic reference formulas** the brief asserts (T08, T09, T13, T14,
  T15, T17, T18) plus MDF/ideal-bluff references — added as pure functions with
  tests. These are exposed for explanation; they are **not** wired to override
  the EV engine or the opponent-model fold estimate.

## Deliberately deferred (documented, not wired)

Everything marked 📄 above is described in `docs/future-math-roadmap.md` with a
hook point and prerequisites. Only trivial, safe, disabled stubs were added
(the geometric size helper and a disabled ICM interface); no unvalidated model
feeds a live recommendation.
