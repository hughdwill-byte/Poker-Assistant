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

## 6a. Rake-adjusted EV (cash games)

Cash-game rake is a pure function of the pot it is charged on:

```
rake(pot) = min(pot · rakePercent, rakeCap)          // rakeCap 0 = uncapped
```

Rake is gated by `game.mode`: it is **0 for play-money and tournament** play,
and applied only in `cash` mode (`js/action-ev.js rake`). It is charged **only
on a pot that is actually won at showdown**, never on chips returned uncalled
and never on a fold-branch win (no showdown, "no drop"). Because the hero only
collects the pot a fraction `e` of the time, expected rake is netted against the
hero's share:

```
EV_call  = e·(P + C) − C − e·rake(P + C)
EV_bet   = F·P + (1 − F)·[ e_called·(P + 2B) − B − e_called·rake(P + 2B) ]
EV_branch(call/raise) = e·pot − heroAdditional − e·rake(pot)
EV_branch(fold)       = P + opponentAlreadyIn            // no rake, no showdown
```

Worked check (`test/rake-and-refs.test.js`): `P=100, B=50, F=0.5,
e_called=0.6`, 5% uncapped rake → the fold branch wins 100 unraked, the called
pot 200 is raked 10 → `EV_bet = 0.5·100 + 0.5·(0.6·200 − 50 − 0.6·10) = 82`
(vs 85 with no rake). With `rakePercent = 0` or a non-cash mode every EV equals
the un-raked formula exactly, so the zero-rake path is unchanged.

Rake is applied **per terminal pot**, so with side pots each layer is raked on
the amount the hero wins from that layer.

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
of an equilibrium solver. The **recommendation** is never labelled "GTO" — its
names are "Range/EV strategy", "model-adjusted recommendation" and
"showdown-equity recommendation". The one place "GTO" appears is the clearly
labelled **GTO reference** readout (§14): deterministic indifference math shown
*alongside* the recommendation for comparison, explicitly marked "reference only
— the recommendation is exploitative EV, not a solver output". It never drives
the advice.

## 12. Deterministic reference formulas

These exact formulas from the source specification are implemented as pure
functions for explanation and regression, and are **not** wired to override the
EV engine or the opponent-model fold estimate:

- **Outs / draw probabilities** (`js/draw-odds.js`): next-card `O/unseen`;
  two-card all-in `1 − (unseen−O)/unseen · (unseen−1−O)/(unseen−1)`. E.g. nine
  outs = `9/47 = 19.1489%` on the turn, `34.9676%` by the river all-in.
- **Set-mining**: a pocket pair flops at least a set with probability
  `1 − C(48,3)/C(50,3) = 11.7551%`.
- **Pure-bluff break-even folds** (`ActionEV.breakEvenFoldForBluff`):
  `B/(P+B)` — half-pot 33.33%, pot 50%.
- **Two-branch required fold frequency** (`ActionEV.requiredFoldFrequency`):
  `−V_c/(P−V_c)` — the 4-bet reference `P=15, V_c=−26.6 → 63.9423%`.
- **MDF and ideal bluff fraction** (`ActionEV.minDefenseFrequency`,
  `idealBluffFraction`): `P/(P+B)` and `B/(P+2B)` — idealized reference values.
- **Geometric multi-street sizing** (`DrawOdds.geometricBetFraction`):
  `((1 + 2S/P)^{1/n} − 1)/2` — a candidate-size helper only.

## 13. Deferred factors

Implied/reverse-implied odds, equity realization, range-vs-range distributions,
range/nut advantage, MDF-driven defense, mixed-strategy output, multi-street
game trees, joint multiway EV, joint card-removal, ICM/bubble factor, Nash
push/fold, recency-weighted stats, blocker-driven selection and a trained
opponent model are **documented, not implemented** in live advice. See
[future-math-roadmap.md](future-math-roadmap.md) for each factor's hook point
and prerequisites. Only trivial, safe, disabled stubs exist
(`DrawOdds.geometricBetFraction`, `js/tournament-icm.js`).

## 14. GTO reference layer (Phase C, Wave 0)

`js/equilibrium.js` provides the deterministic indifference references implied
by pot geometry alone (heads-up, one street, no rake; the spec §8.4 model). For
a bet of size `B` into pot `P`:

```
MDF (min defense frequency) = P / (P + B)       // defender must continue this often
alpha (bettor risk / max fold) = B / (P + B)    // = 1 − MDF; a pure bluff's break-even fold
balanced bluff fraction      = B / (P + 2B)     // bluff share of a polarised betting range
value : bluff                = (P + B) : B
call break-even equity       = B / (P + 2B)     // a bluff-catcher's price facing the bet
```

Validated against the spec table (`test/equilibrium.test.js`): ¼-pot → MDF 80%,
α 20%, bluff 16.67%; pot → MDF 50%, α 50%, bluff 33.33%, value:bluff 2:1; etc.

This is a **reference layer**. It is shown alongside the exploitative EV
recommendation — a "GTO reference" readout facing a bet (MDF, α, value:bluff)
and a balanced-bluff column per candidate bet size — and it **never** overrides
the EV engine, the opponent-model fold estimate, or legal-action generation.
Wiring these into live advice (MDF-driven defense, mixed-strategy frequencies)
is deferred; see [future-math-roadmap.md](future-math-roadmap.md) #5, #6, #7.

## 15. Implied and reverse-implied odds (Phase C, Wave 0.2)

`js/implied-odds.js` prices a draw beyond the current pot (spec §9). With
`P` = pot before the call, `C` = the call, `e` = the draw's hit probability
(NOT the full showdown equity), `W` = net future chips won after hitting:

```
simpleEV = e·(P + W) − (1 − e)·C          // reduces to EV_call when W = 0
W_min    = C·(1 − e)/e − P                // minimum future win to break even
```

`W_min ≤ 0` means immediate pot odds already justify the call. A structured
`drawEV()` enumerates five inspectable branches — hit+best+extra, hit+best+no
extra, hit+second-best (reverse implied), miss-realised, miss-forced-off — so
implied and reverse-implied odds coexist without a single "magic multiplier".

The Advanced UI shows, for a drawing hand facing a bet: nominal (undiscounted)
outs, the **next-card** hit probability (spec §4.1 one-card rule — the future
cost isn't fixed, so the two-card figure is not used), and `W_min`. It assumes
**no** future winnings, so the displayed W_min is exactly the break-even future
win the caller must find. This is reference-only; it does not change the EV
recommendation. Out discounting and a per-opponent future-bet model are deferred
(see [future-math-roadmap.md](future-math-roadmap.md) #2).

## 16. Baseline priors & recency weighting (Phase C, Wave 0.3)

Opponent statistics use beta-binomial shrinkage (spec §12.4): a rate is
`(hits + α) / (opps + α + β)`. Two Wave-0.3 refinements:

- **Stake/population priors** (`OpponentModel.POPULATION_PRIORS`): the `(α, β)`
  baseline a zero-data opponent shrinks toward is chosen by pool — default,
  micro (loose-passive, ~43% VPIP), low, mid, high (tight-aggressive, ~21% VPIP,
  more 3-bets), live (very loose). `stats(profile, {population})` selects the
  set; an unknown key falls back to the default.
- **Recency weighting** (`observe(counter, hit, t)` + `decayedRate`): each
  timestamped event is weighted `2^(-age / halfLife)`, so old reads fade and
  recent behaviour dominates; `stats(profile, {halfLifeMs, now})` returns
  decayed rates. With no timestamps it falls back to plain counts, so existing
  profiles keep working unchanged.

The Advanced UI has an opponent-pool selector and shows the assumed pool
baseline (VPIP/PFR/3-bet) as a **reference**. These priors seed the model but do
not by themselves change the EV until live per-opponent profiles are attached to
the strategy call (deferred; see [future-math-roadmap.md](future-math-roadmap.md)
#14).
