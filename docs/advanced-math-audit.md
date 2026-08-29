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
