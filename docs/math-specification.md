# Math Specification

Every formula shown in the UI has the same definition here and in the code
(`js/action-ev.js`, `js/range-equity.js`, `js/game-state.js`). Chips are the
unit throughout. Equity `e` always already includes fractional tie shares.

## 1. Pot semantics (the canonical convention)

Poker sites disagree about whether the "pot" box includes the current street's
bets, so the app keeps the raw `displayedPot` and a `potDisplayMode`, then
derives one canonical quantity used by every calculation:

> **P** = all chips currently available to win **before** the hero contributes
> new chips. P **includes** opponents' current bets and **excludes** the hero's
> pending call or raise.

`potDisplayMode` maps the displayed pot to P (`GameState.displayedToCanonical`):

| mode | meaning | P derived as |
|---|---|---|
| `includes-current-bets` | box already contains this street's bets | `displayedPot − heroStreetCommitted` |
| `excludes-current-bets` | box is prior-street chips only | `displayedPot + opponents' street bets` |
| `manual-canonical` | box is already "what you can win" | `displayedPot` |

When per-action commitments are tracked, P is the exact sum of every player's
`handCommitted` and the displayed value is only used to warn about
inconsistencies. **Current bets are never added twice.**

## 2. Call cost and break-even

```
C = max(0, currentBetTo − heroStreetCommitted)      // additional call cost
break-even equity = C / (P + C)
```

Pot odds expressed as a payoff ratio are **not** comparable with a 0–1 equity;
always convert to break-even equity before comparing with `e`.

## 3. Expected value (relative to folding)

```
EV_fold = 0
EV_call = e · (P + C) − C
```

Worked checks (see `test/action-ev.test.js`):

- P=100, C=50, e=1/3 → EV_call = 0 (exactly break-even).
- P=100, C=50, e=0.40 → EV_call = 10.

## 4. Fold equity and bet EV

For a heads-up open bet of size **B** (hero and villain currently unbet):

```
F        = P(villain folds)
eCalled  = hero equity GIVEN villain calls
EV_bet   = F · P + (1 − F) · (eCalled · (P + 2B) − B)
```

Worked check: P=100, B=50, F=0.5, eCalled=0.6 → EV_bet = 85.

When villain folds the hero wins the pot **as it stood (P)**; the hero's own
uncalled bet is returned — a fully-folded branch never returns `P + B`.

## 5. General response-branch EV

```
EV = Σ_branch prob(branch) · payoff(branch)

payoff(fold branch)  = P + opponentAlreadyIn        (hero's own bet returned)
payoff(call/raise)   = branchEquity · (P + heroAdd + oppAdd) − heroAdd
```

`ActionEV.evFromBranches` implements this and reduces to §4 for the two-branch
bet. Raise EV uses fold/call branches; the **re-raise branch is not modelled**
in v1, which is stated in the output and lowers the reported confidence.

## 6. Side pots

Contribution levels build layered pots (`GameState.buildSidePots`). Each layer
has an `amount`, its `contributingSeats` and its `eligibleSeats` (contributors
who have **not** folded). Expected chips won:

```
E[chips] = Σ_layer  amount(layer) · heroShare(layer)     for layers the hero is eligible for
```

Layers the hero cannot win contribute 0 (`ActionEV.sidePotExpectation`). Folded
players' chips stay in the pot but they win no layer.

## 7. Effective stack and SPR

```
effectiveStack(hero, opp) = min(heroTotal, oppTotal)      // total = behind + committed
SPR = heroStackBehind / P
```

## 8. Legal bet and raise sizing

```
minRaiseTo = currentBetTo + lastFullRaiseSize             // except a smaller all-in
```

A short all-in that is **not** a full raise does not reopen betting for players
who already acted (`GameState.isFullRaise`, `ActionTracker`). Candidate sizes
are generated from pot fractions (25%…150%, plus min-raise and all-in),
capped by the stack and effective stack, and deduplicated to distinct legal
amounts. Every candidate is scored by estimated EV and ranked.

## 9. Range-weighted equity

Against opponents modelled as weighted combination ranges, the hero's expected
share is estimated under the **independent-combo prior**: sample one combo per
opponent from its own range, reject the whole assignment on any card collision
(this preserves the intended joint distribution — a naive conditional sampler
would bias it), then deal the board uniformly and split ties fractionally
(`js/range-equity.js`).

- **Exact** enumeration is used when the number of surviving leaves is below a
  configurable limit; the result is then the true weighted expectation.
- **Monte Carlo** otherwise, with a deterministic seeded RNG available for
  tests. Reported per player: win, tie, lose, equity, variance, standard error,
  a 95% confidence interval, trials accepted, rejected collision samples,
  mode and elapsed time. Convergence stopping halts once the CI half-width is
  below a chosen tolerance.

Outputs are rounded to the precision the confidence interval supports — the app
never claims accuracy the CI does not justify.

## 10. Why Kelly is not the bet-size optimiser

The classic Kelly fraction assumes a fixed binary wager where changing the stake
leaves the win probability and payoff odds unchanged. A poker bet violates all
of that: size changes fold equity, calling ranges, future streets and pot
geometry. So Kelly is **not** used to choose the poker bet. It is retained only
as an optional, clearly labelled bankroll-risk statistic (fractional Kelly), and
the tournament stack is kept distinct from a bankroll. Bet sizes are chosen by
comparing estimated EV across legal candidates (§8), not by Kelly.

## 11. Why this is not a GTO solver

The opponent ranges and action likelihoods are transparent heuristics and
Bayesian updates (`js/opponent-model.js`, `js/range-presets.js`), not the output
of an equilibrium solver. Nothing here is labelled "GTO". The strategy names
used are "Range/EV strategy", "model-adjusted recommendation" and
"showdown-equity recommendation".
