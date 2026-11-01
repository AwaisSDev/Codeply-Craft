# Fragment filtering and three-tier storage (pre-registered 2026-11-01, before any run of this experiment)

Owner decisions, 2026-11-01 (second round): go ahead with fragment
filtering as an additional **validation** experiment, compared against the
original decoder; **no test set is touched until the configuration is
frozen**. Cost model: three tiers (automatic, pending, discard); 3:1
initially, 2:1 and 5:1 tested; low-confidence memories are not forced into
permanent Brain storage. Everything stays on the experiment branch;
production Brain behaviour is unchanged.

This follows `CALIBRATION-PROTOCOL.md` (single threshold pair, results
already committed). What that experiment showed on val, and why this one
exists: at 3:1, one storage threshold drives the system towards storing
almost nothing (Ettin-150M seed 2 chose a point with val recall 0.045), and
about half of all predicted memories are one-word or stopword fragments.

## Inputs (already recorded, nothing re-run)

The val runs `research/dtw/results/calibration/cal-<model>-val` (knobs off;
each observation carries `p.span` and `p.gate`). Models: realistic
Ettin-150M seeds 1-3, Ettin-400M seeds 1-3 (2 and 3 when trained).

## Decoders compared (applied to the stored answers, before the tiers)

* **F0**: original decoder (no filter).
* **F1**: drop a memorable observation whose span (`value`) has one word or
  only stopwords. The stopword list is the one in `calibrate.py`.
* **F2**: drop a memorable observation whose span has fewer than two
  non-stopword words.

## Tiers

Confidence of an observation: **q = p.gate × p.span**.

* **Automatic** (q ≥ τa): goes to the Brain; this is what the harness
  scores as stored memories.
* **Pending** (τp ≤ q < τa): kept out of permanent storage; measured
  separately (could be confirmed by the user or promoted by repetition;
  neither mechanism is built or assumed to work here).
* **Discard** (q < τp, and every F1/F2-filtered fragment).

Grid for τa and τp: {0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8,
0.85, 0.9, 0.95}.

## Choosing the configuration (val only)

For each cost ratio r ∈ {2, 3, 5} (3 primary):

1. **τa** = the lowest grid value at which the automatic tier's val
   precision is ≥ r / (r + 1) (0.67, 0.75, 0.83): the break-even
   precision at which a stored memory is worth its risk under C = r·FP + FN.
   If no value reaches it, the automatic tier is empty for that model and
   ratio, and that is reported as the result.
2. **τp** = the lowest grid value < τa at which the precision of the
   pending band [τp, τa) on val is ≥ ρ. **ρ = 1/3 is an assumption** (at
   most two wrong suggestions per right one) and not an owner decision;
   0.25 and 0.5 are reported as sensitivity.
3. **Decoder**: per model and r, the one of F0, F1, F2 whose automatic tier
   holds the most correctly matched memories (val true positives) at the
   chosen τa; ties go to the simpler (F0, then F1). The decoder is chosen
   per model, but the across-seed majority is also reported.

Measured on val for every configuration, through the harness's rescore:
automatic tier precision, recall, F1, false-memory rate, cost
C_r = r·FP_auto + FN_auto; pending tier size per 100 inputs, precision and
the extra gold memories it holds (TP of automatic ∪ pending − TP of
automatic); recall of automatic ∪ pending; cost against store-nothing.

## Freeze, then test

The chosen (decoder, τa, τp) per model and ratio are written to
`research/dtw/results/tiers/FROZEN.json` and committed **before** any test
set is read for this experiment. Then, once, on test-real and
Benchmark-520 (primary) and natural-300 (supporting only, 20 gold
memories): the same metrics, from the already recorded test runs
(`calibration/cal-<model>-<set>`), filtered and rescored. test-real is also
reported on its user-disjoint subset
(`research/dtw/label/audit/user-overlap-ids.json`).

Comparisons: F0 against the chosen decoder at the same tiers (does
fragment filtering help?); the tiered system against the single-threshold
calibration and against production LFM3, whose answers all count as
automatic (it has no confidence), by paired bootstrap over examples.

## What would change the conclusion

* Fragment filtering helps if the chosen decoder holds more automatic true
  positives on val than F0 for most seeds, and the test automatic tier
  keeps that advantage.
* The three tiers help if, at r = 3, the automatic tier beats
  store-nothing on test-real (C_3 below the gold count) while
  automatic ∪ pending keeps at least half the uncalibrated recall.
* If no model reaches 0.75 precision on val at any τa, automatic storage
  at 3:1 is not supported by any current model, and the honest product
  answer is pending-only until precision improves.
