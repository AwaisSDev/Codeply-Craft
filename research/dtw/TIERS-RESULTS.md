# Calibration, fragment filtering and three tiers: results (2026-11-01)

Protocols, both committed before their runs: `CALIBRATION-PROTOCOL.md`
(`049f688a`) and `TIERS-PROTOCOL.md` (`29967d8f`). Tier configurations
were frozen (`results/tiers/FROZEN.json`, commits `c1f18cc6`, `d2908569`)
before any test set was read for that experiment. Models so far: realistic
Ettin-150M seeds 1-3 and Ettin-400M seed 1 (400M seeds 2 and 3 are
training). natural-300 (20 gold memories) is supporting only and left out
of the tables.

## 1. Single-threshold calibration (`-cal<r>` results)

At r = 3 a single storage threshold, chosen on val, drives every model
towards storing almost nothing (Ettin-150M seed 2: val recall 0.045). On
test-real it raised precision (seed 1: 0.26 → 0.72; F1 0.352 → 0.355), but
on Benchmark-520 F1 fell (0.39 → 0.19), and the cost stayed at or above
storing nothing. Under C = r·FP + FN a stored memory pays only above
precision r/(r+1), and production LFM3 (precision 0.38-0.55, no confidence
score) costs about twice storing nothing at 3:1 (test-real 722 vs 366;
Benchmark-520 1,056 vs 551).

## 2. Three tiers (automatic / pending / discard), frozen on val

Confidence q = gate × span confidence. Automatic tier: q ≥ τa, the lowest
value with val precision ≥ r/(r+1). Pending: the band below it down to τp
(val band precision ≥ 1/3). Δ = cost − store-nothing cost, 95 % bootstrap
over examples (negative = better than storing nothing).

| Model | Set | r | Auto P / R | Pending per 100 inputs (P) | Auto ∪ pending recall | Δ cost (95 %) |
|---|---|---|---|---|---|---|
| **Ettin-400M s1** | test-real | 2 | 0.74 / 0.35 | 21 (0.47) | 0.51 | **−73 to −2** |
| | | **3** | **0.78 / 0.24** | 46 (0.44) | 0.54 | −47 to +26 |
| | | 5 | 0.86 / 0.12 | 88 (0.39) | 0.64 | −36 to +18 |
| | Benchmark-520 | 2 | 0.76 / 0.20 | 35 (0.48) | 0.37 | **−71 to −13** |
| | | **3** | **0.77 / 0.13** | 66 (0.49) | 0.43 | −35 to +20 |
| | | 5 | 0.94 / 0.03 | 132 (0.44) | 0.58 | −24 to +2 |
| Ettin-150M s1 | test-real | 3 | 0.67 / 0.28 | 27 (0.34) | 0.42 | +4 to +99 |
| Ettin-150M s2 | test-real | 3 | 0.64 / 0.17 | 69 (0.34) | 0.52 | +5 to +88 |
| Ettin-150M s3 | test-real | 3 | 0.72 / 0.22 | 22 (0.41) | 0.35 | −25 to +59 |
| Ettin-150M s1-3 | Benchmark-520 | 3 | 0.60-0.77 / 0.08-0.14 | 24-74 (0.39-0.45) | 0.18-0.36 | s1 worse; s2, s3 ≈ nothing |

Full rows (every model, set and ratio, plus F0 against the chosen decoder
and the user-disjoint test-real subset): `results/tiers/*.json`.

Reading:

1. **Ettin-400M is the only model whose automatic tier is net-positive.**
   Its val-chosen thresholds held on unseen data (automatic precision
   0.74-0.94, at or above each ratio's break-even), and at 2:1 it beats
   storing nothing on both test-real and Benchmark-520. At 3:1 the point
   estimate is better than nothing on both sets, but the interval includes
   zero. One seed; seeds 2 and 3 decide.
2. **Ettin-150M's thresholds do not transfer**: val precision ≥ 0.75
   becomes 0.64-0.72 on test-real, and its automatic tier costs as much as
   or more than storing nothing at 3:1.
3. **The pending tier is where most correct memories are**: precision
   0.34-0.49, holding as many extra gold memories as the automatic tier or
   more (400M at 3:1: automatic ∪ pending recall 0.54 on test-real against
   0.24 automatic). Its value depends on a mechanism this experiment does
   not test (user confirmation, or promotion when a memory recurs). Volume
   is the cost: 21-132 pending items per 100 inputs.
4. **Fragment filtering** was chosen over the original decoder in 8 of 12
   (model, ratio) cases, with small gains at these thresholds (400M on
   test-real, same tiers: automatic precision 0.739 vs 0.684 at 2:1, 0.777
   vs 0.759 at 3:1, recall unchanged within 0.006).
   Most fragments already have low confidence, so the tiers discard them;
   the large effect seen without thresholds (val precision 0.24 → 0.38)
   mostly does not add on top of the tiers.
5. Ettin-400M on the user-disjoint test-real subset keeps its automatic
   precision (0.771 at 2:1 and 3:1, 0.842 at 5:1) with lower recall (0.25,
   0.18, 0.11).

## What this means for the product (no production change made)

* Automatic storage at 3:1 is supported, narrowly, by one model and one
  seed (Ettin-400M), at roughly a quarter of memories on test-real and an
  eighth on Benchmark-520. Production LFM3 is not supported by this cost
  model at any ratio tested.
* Most of the value is in the pending tier, so its mechanism (confirm,
  promote on recurrence, expire) is the next design question; it needs
  multi-session behaviour, which the owner has deferred.

## 3. Ettin-400M on three seeds (added after Kaggle run 5)

Seeds 2 and 3 went through the same steps; each seed's tier
configuration was frozen and committed before its test sets were read
(`0dc8d8a6`, `b7d75f87`). At 3:1 all three seeds chose a threshold of 0.9
on val.

Uncalibrated (no tiers), mean ± sd over seeds: Benchmark-520 F1 0.412 ±
0.005, test-real 0.413 ± 0.012 (natural-300 0.314 ± 0.042, supporting
only). Against production LFM3, paired bootstrap of the seed mean:
test-real **+0.113 (+0.062 to +0.166)**, user-disjoint test-real **+0.173
(+0.090 to +0.257)**, Benchmark-520 **−0.162 (−0.195 to −0.128)**.

Three tiers, frozen per seed, seed-mean automatic tier; Δ = cost minus
store-nothing cost with a 95 % bootstrap over examples:

| Set | r | Auto P / R | Δ cost (95 %) |
|---|---|---|---|
| test-real (store nothing = 366) | 2 | 0.74 / 0.35 | **−38 (−65 to −7)** |
| | **3** | **0.79 / 0.25** | −17 (−45 to +12) |
| | 5 | 0.87 / 0.17 | −9 (−32 to +15) |
| test-real user-disjoint (150) | 2 | 0.76 / 0.28 | −16 (−33 to +2) |
| | 3 | 0.84 / 0.20 | −13 (−29 to +3) |
| | 5 | 0.91 / 0.15 | **−12 (−24 to −2)** |
| Benchmark-520 (551) | 2 | 0.70 / 0.24 | −11 (−38 to +18) |
| | **3** | **0.71 / 0.14** | +20 (−7 to +48) |
| | 5 | 0.81 / 0.07 | +21 (−1 to +44) |

Per seed at 3:1, automatic precision on test-real 0.777 / 0.806 / 0.777
(all at or above 0.75; all three cost less than storing nothing: 354, 338,
354 against 366) and on Benchmark-520 0.772 / 0.707 / 0.653 (only seed 1
below store-nothing: 543, 571, 599 against 551). Pending tier at 3:1:
41-91 items per 100 inputs, precision 0.37-0.49.

Reading, three seeds:

1. On test-real the val-chosen thresholds hold for every seed: automatic
   precision stays at or above the break-even for each ratio, and the
   automatic tier is never worse than storing nothing; at 2:1 it is
   clearly better. At 3:1 the gain is real in direction for every seed but
   small (about 5 % of the store-nothing cost) and its interval includes
   zero.
2. On Benchmark-520 the thresholds do not hold: automatic precision falls
   to 0.65-0.71 for seeds 2 and 3, below the 3:1 break-even, and at 3:1
   the automatic tier costs about as much as storing nothing (point
   estimate slightly worse). Benchmark-520 is out of distribution for the
   training and val data (jokes, quotes, duplicates); that is where
   calibration fails to transfer.
3. So the evidence for automatic storage at 3:1 is: supported on realistic
   data, narrowly; not supported on the adversarial benchmark. 2:1 is
   supported on realistic data with a clear margin. The decision between
   them is the owner's (it is the cost ratio itself).
4. The pending tier carries most correct memories on every seed and set.
