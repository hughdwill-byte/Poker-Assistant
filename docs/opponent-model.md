# Opponent Model & Ranges

This describes the range representation, the notation parser, the opponent
statistics and the Bayesian range update. Everything here is a transparent,
inspectable heuristic — a **modelled** range, never a claim to know the exact
cards, and never labelled "GTO".

## Range representation (`js/ranges.js`)

A range is a list of weighted exact combinations:

```
[ { c1: cardId, c2: cardId, weight: number }, ... ]     // c1 < c2, weight >= 0
```

For a single deck there are exactly **C(52,2) = 1,326** combinations. Verified
combo counts (see `test/ranges.test.js`):

| class | combos |
|---|---|
| pocket pair (e.g. `AA`) | 6 |
| suited non-pair (e.g. `AKs`) | 4 |
| offsuit non-pair (e.g. `AKo`) | 12 |
| both (e.g. `AK`) | 16 |
| full range | 1,326 |

Operations: generation, canonical ordering (`c1 < c2`), cloning, normalisation
(weights sum to 1), blocker removal, intersection, union, weighted sampling
(cumulative-weight binary search), combo↔169-class conversion,
percent-of-combos, class summaries and validation.

### Notation

Tokens are comma- or whitespace-separated:

```
AA            pocket pair class          (6)
AKs           suited class               (4)
AKo           offsuit class              (12)
AK            suited + offsuit           (16)
QQ+           QQ, KK, AA
22-66         22, 33, 44, 55, 66
AJs+          AJs, AQs, AKs
KQo           a single offsuit class
AKs:0.5       weighted entry (weight 0.5)
```

Ten is written `T` (or `10`). Invalid or ambiguous tokens (`XZ`, `AAs`,
`AA:-1`) are **rejected with an explicit error**, never silently ignored.
Blockers (hero cards, board, dead cards, other players' known cards) are removed
before use; if blockers empty a range the problem is reported, not hidden.

## Initial ranges (priors) (`js/range-presets.js`)

Supported prior sources: uniform/random, manual text, a position open-raise
preset, a position/action preset, and a profile-adjusted preset. All preset and
likelihood values live in documented configuration data, not in control flow.
The UI always shows which prior was used. When data is missing the model
defaults to **uniform** and states that equity is versus random hands — a
conservative, transparent prior instead of invented precision.

## Opponent statistics (`js/opponent-model.js`)

Each profile tracks hands observed; VPIP, PFR, 3-bet, fold-to-3-bet and c-bet /
fold-to-c-bet opportunities and successes; aggression counts; showdowns; average
action size by street; recent history; and total sample size. Rates use
**beta-binomial (shrinkage) priors**:

```
rate = (hits + α) / (opportunities + α + β)
```

so a handful of hands cannot overwhelm a sensible population prior. Population
priors (α, β) are stored as data (`STAT_PRIORS`). `sampleConfidence` grows with
the number of hands and scales how much the model trusts the reads.

## Action likelihood and Bayesian update

For an observed action A:

```
posteriorWeight(combo) = priorWeight(combo) · likelihood(A | combo, state, profile)
```

then the range is renormalised. Guarantees (see `test/opponent-model.test.js`):

- every likelihood is in [0, 1];
- posterior weights are non-negative and finite;
- the posterior always normalises to 1;
- a **raise** shifts weight toward strong value **and** keeps a plausible
  bluff/draw region (a polarised range), so it is not purely value;
- a **call** range is distinct — it concentrates medium-strength made hands and
  draws — it is **not** simply a weakened raise range;
- blocker effects remain correct across updates;
- repeated updates never produce negative probabilities;
- small samples stay close to the prior; larger samples move the model more.

The v1 likelihood is a configurable heuristic driven by exact hand features
(`js/hand-features.js`): made-hand category and pair position, flush and straight
draws, board texture and blockers. A trained model can replace
`actionLikelihood` behind the same interface; the `TrainedModel` hook exists but
is **disabled** and refuses to run until a real labelled dataset, feature
schema, validation method and model artefact exist. The RandomForest placeholder
from other projects is deliberately **not** implemented.

## Persistence (`js/persistence.js`)

Profiles are stored locally (localStorage) under a versioned schema with a
stable key built from a site/table namespace plus a normalised display name (or
an explicit profile id), so a profile follows a player across seat changes
rather than being tied to a seat number. Create, link, edit, reset, export/import
JSON, show sample size and schema migration are all supported. All data stays on
the device — there is no server.
