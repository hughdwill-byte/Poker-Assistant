# Calibration box map

Reconstruction spec for the drawn calibration boxes in the poker-table
screenshot. All coordinates are NORMALIZED [0,1] against the CANVAS (the dark
drawing area), origin = canvas top-left. `canvasRefPx ≈ { width: 1045, height: 532 }`.

> **Provenance.** Coordinates were **visually estimated** from a rendered
> screenshot (±~1–2% of canvas), not pixel-sampled; colors are per palette
> category, not sampled. Drop the PNG into `docs/reference/` to regenerate this
> at pixel precision (contour detection + color sampling). The machine-readable
> version is [`calibration-box-map.json`](calibration-box-map.json).

Each region's `id` is the friendly form; `watchKey` is the internal Watch-mode /
`calibration-preset` region key (e.g. `hero0`, `b0`, `s2c`).

## Regions (id · watchKey · category · color · x,y,w,h · confidence)

| id | watchKey | category | color | x | y | w | h | conf |
|----|----------|----------|-------|----|----|----|----|------|
| your_card_1 | hero0 | number | #5fd38d | 0.590 | 0.694 | 0.025 | 0.053 | .60 |
| your_card_2 | hero1 | number | #5fd38d | 0.620 | 0.694 | 0.025 | 0.053 | .55 |
| flop_1 | b0 | number | #5fd38d | 0.455 | 0.455 | 0.025 | 0.049 | .70 |
| flop_2 | b1 | number | #5fd38d | 0.497 | 0.455 | 0.025 | 0.049 | .70 |
| flop_3 | b2 | number | #5fd38d | 0.538 | 0.455 | 0.025 | 0.049 | .70 |
| turn | b3 | number | #5fd38d | 0.578 | 0.455 | 0.025 | 0.049 | .70 |
| river | b4 | number | #5fd38d | 0.618 | 0.451 | 0.025 | 0.049 | .70 |
| your_card_1_suit | hero0s | suit | #4da3e6 | 0.597 | 0.748 | 0.023 | 0.041 | .35 |
| your_card_2_suit | hero1s | suit | #4da3e6 | 0.631 | 0.735 | 0.025 | 0.045 | .50 |
| flop_1_suit | b0s | suit | #4da3e6 | 0.455 | 0.504 | 0.023 | 0.041 | .60 |
| flop_2_suit | b1s | suit | #4da3e6 | 0.497 | 0.504 | 0.023 | 0.041 | .60 |
| flop_3_suit | b2s | suit | #4da3e6 | 0.538 | 0.504 | 0.023 | 0.041 | .60 |
| turn_suit | b3s | suit | #4da3e6 | 0.578 | 0.504 | 0.023 | 0.041 | .60 |
| river_suit | b4s | suit | #4da3e6 | 0.618 | 0.504 | 0.023 | 0.041 | .60 |
| pot_number | pot | money | #e6a43a | 0.549 | 0.571 | 0.056 | 0.038 | .60 |
| my_bet_number | mybet | money | #e6a43a | 0.549 | 0.613 | 0.057 | 0.034 | .45 |
| my_stack_number | mystack | money | #e6a43a | 0.460 | 0.801 | 0.059 | 0.041 | .65 |
| to_call_button | tocall | money | #e6a43a | 0.716 | 0.867 | 0.077 | 0.086 | .70 |
| seat1_bet | bet0 | bet | #e86cae | 0.382 | 0.553 | 0.040 | 0.041 | .65 |
| seat2_bet | bet1 | bet | #e86cae | 0.374 | 0.466 | 0.040 | 0.041 | .65 |
| seat3_bet | bet2 | bet | #e86cae | 0.470 | 0.344 | 0.040 | 0.041 | .50 |
| seat4_bet | bet3 | bet | #e86cae | 0.647 | 0.350 | 0.040 | 0.041 | .50 |
| seat5_bet | bet4 | bet | #e86cae | 0.757 | 0.462 | 0.044 | 0.045 | .65 |
| seat6_bet | bet5 | bet | #e86cae | 0.721 | 0.553 | 0.044 | 0.045 | .60 |
| seat1_cards | s0c | cards | #9a6fd0 | 0.372 | 0.654 | 0.026 | 0.045 | .70 |
| seat2_cards | s1c | cards | #9a6fd0 | 0.410 | 0.372 | 0.025 | 0.045 | .60 |
| seat3_cards | s2c | cards | #9a6fd0 | 0.540 | 0.342 | 0.025 | 0.045 | .35 |
| seat4_cards | s3c | cards | #9a6fd0 | 0.658 | 0.359 | 0.025 | 0.045 | .35 |
| seat5_cards | s4c | cards | #9a6fd0 | 0.735 | 0.395 | 0.027 | 0.045 | .65 |
| seat6_cards | s5c | cards | #9a6fd0 | 0.740 | 0.650 | 0.026 | 0.045 | .60 |
| seat1_spot | s0 | spot | #9a6fd0 | 0.319 | 0.637 | 0.020 | 0.041 | .70 |
| seat2_spot | s1 | spot | #9a6fd0 | 0.320 | 0.318 | 0.021 | 0.041 | .70 |
| seat3_spot | s2 | spot | #9a6fd0 | 0.453 | 0.222 | 0.021 | 0.038 | .65 |
| seat4_spot | s3 | spot | #9a6fd0 | 0.633 | 0.218 | 0.021 | 0.038 | .65 |
| seat5_spot | s4 | spot | #9a6fd0 | 0.769 | 0.327 | 0.023 | 0.041 | .70 |
| seat6_spot | s5 | spot | #9a6fd0 | 0.793 | 0.635 | 0.021 | 0.041 | .65 |

## Drawn in image (36)
All 36 palette options are drawn: 7 number, 7 suit, 4 money, 6 bet, 6 cards, 6 spot.

## Palette options NOT drawn
None — every palette option has a box in the canvas.

## Ambiguities — needs confirmation
- **seat3_cards vs seat3_bet** and **seat4_cards vs seat4_bet** — labels collide in
  the top-center; color separates category (purple cards vs pink bet) but the exact
  box positions are estimates.
- **your_card_1_suit** — densest cluster (hero cards + suits + pot + my_bet
  lower-center); least certain.
- **my_bet_number** — overlaps pot/hero cards; confirm it sits just below Pot.
- **cards vs spot share the same purple** (#9a6fd0) — disambiguated by label +
  geometry only (spot = smaller, further out; cards = nearer the seat).

## Reconstruction guide (for the implementing agent)
This box map is the same shape as a **calibration preset** normalized to an anchor
(here the anchor = the whole canvas). To place the regions:
1. Get the target table/anchor rect in px: `A = { x, y, w, h }`.
2. For each region: `px = A.x + x*A.w`, `py = A.y + y*A.h`, `pw = w*A.w`,
   `ph = h*A.h`; draw with the category `colorHex`.
3. Preserve aspect: these were normalized against a **1045×532** canvas
   (aspect ≈ 1.96:1). Feed them to `Poker.CalibrationPreset` with
   `tableAspect ≈ 1.964` and `fitMode:"contain"` so they never stretch onto a
   differently-shaped anchor. `denormalize(region, anchorPx, {tableAspect, fitMode})`
   does exactly step 2 with letterboxing.
4. Category → color: number #5fd38d, suit #4da3e6, money #e6a43a, bet #e86cae,
   cards/spot #9a6fd0.
5. Seat-geometry sanity: 1 bottom-left, 2 left, 3 top-left, 4 top-right, 5 right,
   6 bottom-right; hero bottom-center; board center with suits directly beneath;
   pot/my_bet center, my_stack lower-center, to_call lower-right.

To turn this into a live preset, feed the `regions` array (mapping each `watchKey`
to `{x,y,w,h}`) through `Poker.CalibrationPreset.createPreset({ tableAspect: 1045/532,
fitMode: "contain", regions })`, then `serialize()` it.
