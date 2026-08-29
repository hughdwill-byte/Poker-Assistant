# Future Math Roadmap — deferred advanced factors

These factors are **documented, not implemented** in live recommendations. Each
entry says why it matters, where it would hook into the current code, and what
data or validation is required before it can safely drive advice. Nothing here
overrides the exact rules, the equity engine, or the EV accounting; several
would *refine* the estimated-model layer once the prerequisites exist.

Two trivial, safe, **disabled** artefacts exist as anchors for this work:
`js/draw-odds.js geometricBetFraction` (a pure size helper, not wired into
candidate generation) and `js/tournament-icm.js` (a disabled ICM interface that
throws until enabled). Neither feeds a recommendation.

---

### 1. Equity realization factor (R)
- **Why:** raw showdown equity overstates EV out of position, without
  initiative, or with hands that cannot continue on many runouts.
- **Hook:** wrap `strategy.rangeRecommend`'s `e` in a realization factor
  `R(position, initiative, playability, SPR)` before EV, or (preferred) replace
  the one-decision approximation with a multi-street tree (#8).
- **Needs first:** a calibrated `R` from solved or large-sample data, per
  position/street/texture; validation against a multi-street tree so `R` is a
  fast approximation of something real, not a fudge factor.

### 2. Implied and reverse-implied odds
- **Why:** the engine currently prices only the immediate pot. Draws and
  dominated hands need future streets.
- **Hook:** add branches to `action-ev.js` per spec §9.2 (miss/fold,
  improve+win-0, improve+win-future, improve+lose, fail-to-realize); expose
  `W_min = C(1−e)/e − P`.
- **Needs first:** a per-opponent future-bet model (how often, how big they pay
  after the card) and stack/position context; otherwise implied odds become an
  unbounded fudge multiplier (explicitly warned against by the spec).

### 3. Range-vs-range equity distributions & buckets
- **Why:** point equity (hero-vs-range) hides variance; two hands with equal
  average equity can play very differently.
- **Hook:** extend `range-equity.js` to return an equity histogram over the
  hero's range vs the opponent's range, plus bucket boundaries.
- **Needs first:** a hero-range model (currently only the opponent is a range)
  and a performance budget — full range-vs-range is O(combos²·runouts).

### 4. Range advantage & nut advantage metrics
- **Why:** who can bet big on a given board depends on which range holds more
  strong hands and more nut combos.
- **Hook:** a board-conditioned metric over both ranges in `hand-features.js` /
  a new `range-advantage.js`, feeding size selection and bluff frequency.
- **Needs first:** #3 (distributions) and a hero range; validation against
  solver outputs so "advantage" maps to real strategy, not a slogan.

### 5. Minimum Defense Frequency (MDF) and alpha
- **Why:** replace heuristic fold estimates with indifference-based defense.
- **Hook:** the reference formulas already exist (`action-ev.js
  minDefenseFrequency`, `idealBluffFraction`); wiring would replace
  `opponent-model.actionLikelihood`'s fold estimate with an MDF-derived defense
  where the opponent is assumed near-optimal.
- **Needs first:** a decision on exploit-vs-GTO posture per opponent (MDF
  assumes a defending opponent; exploitative play deviates), and calibration so
  MDF is used only where population data supports near-optimal defense.

### 6. Mixed-strategy / frequency output
- **Why:** near equilibrium the right answer is "raise X%, call Y%", not one
  action.
- **Hook:** change the `EVResult` contract in `strategy.js` to emit a frequency
  vector; the UI already renders an EV table and could show mixes.
- **Needs first:** an indifference/solver layer to produce frequencies; without
  it, invented mixes are worse than an honest single best-EV action.

### 7. Polarisation & optimal bluff-to-value ratios
- **Why:** by-size value:bluff ratios `(P+B):B` govern balanced betting.
- **Hook:** `opponent-model.js` already polarises heuristically; a real version
  would set bluff frequency from size and range composition (#4).
- **Needs first:** range advantage (#4) and a commitment to a
  GTO-approximation objective for that branch.

### 8. Full multi-street recursive game-tree EV (CFR-style)
- **Why:** replaces the one-decision approximation and the omitted re-raise
  branch; the correct way to value draws, floats and multi-barrels.
- **Hook:** replace `strategy.addBet/RaiseCandidates` inner EV with a recursive
  `continuation_ev(next_state)` per spec Listing 3/8.
- **Needs first:** a tractable abstraction (bet-size and card bucketing), a
  solver or depth-limited search, and a big performance budget — this is the
  largest single item and belongs off the main thread with caching.

### 9. Full multiway aggressive-action EV
- **Why:** the current multiway bet/raise EV is a labelled one-decision
  approximation with independent folds (`∏fᵢ`).
- **Hook:** `strategy.combinedResponse` → a joint fold/call/raise model across
  opponents with correlated ranges and correct side-pot branch payoffs.
- **Needs first:** a joint response model (correlation data) and joint
  card-removal sampling (#11).

### 10. Multi-street geometric bet sizing
- **Why:** plan sizes so stacks go in by the river given SPR.
- **Hook:** `draw-odds.geometricBetFraction` exists as a pure helper; wiring
  would add its output to `strategy.betTargets`/`raiseTargets` and carry a
  multi-street plan.
- **Needs first:** the multi-street tree (#8) so the plan is evaluated, not
  assumed optimal.

### 11. Joint multi-opponent card-removal conditioning
- **Why:** independent per-opponent sampling with rejection is unbiased but slow
  for narrow ranges and ignores strategic correlation.
- **Hook:** `range-equity.js` sampler → sequential conditional renormalisation
  or a precomputed joint distribution (spec §17.2).
- **Needs first:** a correlation model when ranges are strategically linked;
  the current rejection sampler is correct for the independent-prior case.

### 12. ICM, bubble factor, risk premium (tournaments)
- **Why:** chip-EV ≠ prize-EV near pay jumps; a +cEV shove can be −$EV.
- **Hook:** a `tournaments/` objective-conversion layer applied to terminal
  stack vectors of each EV branch — **never** inside cash-game equity. A
  disabled `js/tournament-icm.js` interface marks the seam.
- **Needs first:** a validated ICM recursion (reference vector
  `[38.33,30.83,30.83]` for stacks `[5000,2500,2500]`, payouts `[50,30,20]`),
  full terminal stack vectors per branch, and a mode gate so cash EV is
  untouched.

### 13. Nash push/fold equilibria (short stacks)
- **Why:** ≤ ~15bb play is well-approximated by push/fold charts.
- **Hook:** a preflop short-stack solver feeding candidate actions in
  `strategy.js` when SPR/stack is low and mode is tournament.
- **Needs first:** an equilibrium solver or validated charts as versioned data
  with metadata; must be labelled by structure/antes, not frozen universally.

### 14. Time-decay / recency weighting + stakes/population priors
- **Why:** opponents change; old reads should fade; priors should depend on
  stake and population.
- **Hook:** `opponent-model.js recordAction`/`stats` — weight observations by
  recency and start from stake-specific Beta priors.
- **Needs first:** timestamps on observations (already stored) and a validated
  decay constant + population prior set; avoid overfitting tiny samples.

### 15. Blocker-driven strategic bluff/value selection
- **Why:** hero's own blockers should bias which hands bluff or value-bet.
- **Hook:** `hand-features.blockers` already computes blocker flags;
  `opponent-model`/`strategy` would use them to pick bluff combos.
- **Needs first:** #4/#7 (range and nut advantage) so blocker effects are
  weighed against a real continuing range, not applied as a bonus.

### 16. Trained ML opponent model
- **Why:** a learned policy could outperform the heuristic likelihood.
- **Hook:** `opponent-model.TrainedModel` is a **disabled** interface that
  throws; enabling it would replace `actionLikelihood`.
- **Needs first:** a real labelled dataset, a documented feature schema, a
  validation method (calibration: Brier/log-loss, reliability bins) and a
  versioned model artefact. The reference repo's RandomForest placeholder is
  deliberately **not** implemented.

---

## Non-negotiables for any of the above

- No factor may override exact rules, legal-action generation, the evaluator,
  or the pot/side-pot accounting.
- No unvalidated model may feed a live recommendation; ship it disabled behind
  an interface until its prerequisites and validation exist.
- Cash chip-EV and tournament prize-EV stay separate throughout.
- Every heuristic records provenance, confidence, applicable game type, stack
  depth, position, player count and date sensitivity.
