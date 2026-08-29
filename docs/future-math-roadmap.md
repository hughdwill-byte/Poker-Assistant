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
- **Status:** **shipped (Phase C, Wave 0.2)** as `js/implied-odds.js` — the
  5-branch tree (hit+best+extra / hit+best+no-extra / hit+second-best /
  miss-realised / miss-forced-off), `simpleEV = e(P+W) − (1−e)C`, and
  `W_min = C(1−e)/e − P`, plus nominal-outs mapping. The Advanced UI shows a
  draw's outs, next-card hit %, and W_min ("pot odds justify now" vs "need ≥ X
  more later") — **reference-only**, and it assumes **no** future winnings (W=0),
  so W_min is exactly the break-even future win the caller must find.
- **Why:** the immediate pot alone under-prices draws and over-prices dominated
  hands.
- **Remaining:** a per-opponent future-bet model (how often / how big they pay
  after the card) to turn W_min into a live +EV/−EV call decision, and out
  discounting (dirty outs). Until then the reference deliberately leaves the
  future-win estimate to the user rather than inventing a multiplier.

### 3. Range-vs-range equity distributions & buckets
- **Status:** **engine shipped (Phase C, Wave 1.1)** as `js/range-vs-range.js`.
  `equityDistribution()` computes every hero-range combo's equity vs the
  opponent range(s) and the board runout (reusing `simulateRanges`), returning
  mean equity, nut/weak fractions, an equity histogram, per-combo equities, and
  — given the hero's real hand — its percentile within its own range. A
  `maxCombos` guard caps the O(combos) cost and reports truncation.
- **UI shipped (Wave 1.1b):** an Advanced-mode "Your range for this spot"
  selector (uniform / position prior / manual) drives a "Range vs range" card
  showing your range equity, nutted share, your hand's equity and its in-range
  percentile, and — heads-up — the range edge and nut advantage. Runs off the
  main thread (worker `rvr` job) with stale-job handling; analysis-only.
- **Remaining:** none for #3 itself; it now feeds #4 (range/nut advantage is
  already exposed) and #7/#15.

### 4. Range advantage & nut advantage metrics
- **Status:** **shipped heads-up (Phase C, Wave 1.1)** via
  `RangeVsRange.rangeAdvantage(heroDist, oppDist)` → equity edge + nut advantage
  on the board, surfaced in the "Range vs range" card. Built on #3.
- **Remaining:** feed these metrics into size selection / bluff frequency
  (currently displayed, not yet wired into candidate generation — see #7), and a
  multiway generalisation (advantage is only shown heads-up today).

### 5. Minimum Defense Frequency (MDF) and alpha
- **Status:** the **reference layer is shipped** (Phase C, Wave 0) as
  `js/equilibrium.js` — MDF `P/(P+B)`, alpha `B/(P+B)`, balanced bluff fraction
  `B/(P+2B)`, value:bluff `(P+B):B`, defense assessment and betting composition,
  validated against the spec §8.4 table. It is surfaced in the Advanced UI as a
  "GTO reference" readout and a balanced-bluff column, **reference-only**. What
  remains deferred is *wiring* it into advice.
- **Why:** replace heuristic fold estimates with indifference-based defense.
- **Hook:** wiring would replace `opponent-model.actionLikelihood`'s fold
  estimate with the `equilibrium.mdf`/`defenseAssessment` output where the
  opponent is assumed near-optimal.
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
- **Status:** **shipped (Phase C, Wave 1.2)** as `js/bet-composition.js`.
  `plan()` partitions the hero range into value / bluff / check for a bet size
  so the betting range is balanced at value:bluff `(P+B):B` — value = strongest
  combos, bluffs = the lowest-equity air up to the balanced count, mediums
  check. It reports the target vs actual bluff fraction, a `bluffShortfall` when
  the range lacks air, and the hero hand's role. The Range-vs-range card shows
  the hero hand's role (VALUE / BLUFF / CHECK) at ½ / ¾ / pot sizes. It reuses
  the equilibrium ratios (equilibrium.js) and the hero-range distribution (#3).
- **Remaining:** blocker-aware bluff selection among the air candidates (#15),
  and conditioning value on the opponent's *calling* range per size rather than
  the full range. Presented alongside the EV table (a GTO-approximation plan),
  not as the primary recommendation.

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
- **Status:** **shipped (Phase C, Wave 0.3).** `opponent-model.js` now carries
  stake/population-indexed Beta priors (`POPULATION_PRIORS`: default / micro /
  low / mid / high / live) selected via `stats(profile, {population})`, and
  recency weighting via `observe(counter, hit, t)` + `decayedRate` /
  `stats(profile, {halfLifeMs, now})` (each event weighted `2^(-age/halfLife)`,
  falling back to plain counts when no timestamps exist). `range-presets.js`
  maps each population to a baseline style. The Advanced UI has an opponent-pool
  selector and shows the assumed pool baseline (VPIP/PFR/3-bet) as a reference.
- **Remaining:** a validated decay constant per context, and wiring live
  per-opponent profiles into the strategy call so these priors and decayed reads
  actually shift the modelled ranges (arrives with the persistence/profile
  attachment in Wave 1). Today the baseline is surfaced as a reference and seeds
  `stats()`, but the strategy's opponents are still preset/uniform ranges.

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
