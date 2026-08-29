# Game-State Schema (v2)

The canonical model lives in `js/game-state.js`. It keeps every distinct poker
concept in its own field so no value stands for two things at once. All logic
that must be exact (positions, action order, to-call, min-raise, reopen rules,
legal actions, effective stack, SPR, canonical pot, side pots, validation) is a
pure derived function of this state — never re-derived inside a UI handler.

```
{
  schemaVersion: 2,
  handId: string,
  heroSeat: number,
  buttonSeat: number | null,
  street: "preflop" | "flop" | "turn" | "river",
  streetOverride: boolean,          // if true, `street` wins over the board count

  game: {
    mode: "play-money" | "cash" | "tournament",
    decks: number,
    tableSize: number,
    smallBlind, bigBlind, ante, straddle: number,
    rakePercent, rakeCap: number,
    potDisplayMode:
      "includes-current-bets" | "excludes-current-bets" | "manual-canonical"
  },

  board: [cardId | null, ...5],
  deadCards: cardId[],

  displayedPot: number,             // raw input, interpreted by potDisplayMode
  currentBetTo: number,             // highest street bet-to
  lastFullRaiseSize: number,        // drives the minimum legal raise

  players: [{
    seatId: number,                 // FIXED for the life of the hand
    name: string,
    seated, dealtIn, active, folded, allIn: boolean,
    cards: [cardId | null, cardId | null],
    startingStack, stackBehind: number,
    streetCommitted: number,        // chips in THIS street
    handCommitted: number,          // chips across the WHOLE hand
    profileId: string | null,
    rangeSpec: string | null
  }],

  actions: [{
    sequence, street, seatId,
    type: "post-blind"|"post-ante"|"post-straddle"|"check"|"fold"|"call"|"bet"|"raise"|"all-in",
    amountAdded, toAmount, potBefore, stackBefore,
    source: "manual"|"watch"|"inferred",
    confidence: number, timestamp: number
  }]
}
```

## Distinct concepts (never conflated)

| Concept | Field |
|---|---|
| Seats at the table | `game.tableSize` |
| Players dealt into the hand | `players[i].dealtIn` |
| Players still active | `!folded && dealtIn` |
| Players all-in | `players[i].allIn` |
| Players folded | `players[i].folded` |
| Current-street contribution | `streetCommitted` |
| Total hand contribution | `handCommitted` |
| Remaining stack | `stackBehind` |

**A folded player keeps its seat until the hand ends.** Folding flips
`folded`/`active`; it never removes or renumbers a seat. A six-handed hand with
three players left is still a six-seat hand with three active players.

## Derived functions (`Poker.GameState`)

- `deriveStreet(state)` — street from the board, with `streetOverride` support.
- `positionLabels(state)` — seat → position, fixed for the hand (survives folds).
- `blindSeats(state)` — SB/BB seats, with the heads-up button-is-SB rule.
- `actionOrder(state)` — acting order for the street; pre-flop the BB acts last
  (the option), post-flop the button acts last; heads-up special-cased.
- `amountToCall(state, seat)`, `highestBetTo(state)`.
- `minRaiseTo(state, seat)` and `isFullRaise(state, seat, to)` (short-all-in
  reopen rule).
- `legalActions(state, seat)` — fold/check/call/bet/raise/all-in with legal
  min/max bet-to amounts.
- `effectiveStack`, `heroEffectiveStack`, `spr`.
- `canonicalPot`, `displayedToCanonical`, `totalCommitted`.
- `buildSidePots(state)` — layered pots with contributing and eligible seats.
- `validate(state)` — `{ warnings, errors }`; errors mean a calculation would be
  wrong (duplicate cards, negatives); warnings include the multi-deck
  range-disabled notice and pot-display inconsistencies.

## Action tracker (`js/action-tracker.js`)

`ActionTracker.apply(state, action)` is the only place commitments change. It
maintains `currentBetTo`, `lastFullRaiseSize`, `streetCommitted`,
`handCommitted`, `stackBehind`, `allIn`, `folded` and records each action.
Antes are posted as **dead** money: they enter the pot but never raise the bet
that others must match. `postBlinds`, `nextStreet` and `undo` are helpers.
