# Operating-point calibration (pre-registered 2026-11-01, before any validation run)

Owner decisions, 2026-11-01: run Ettin-400M seeds 2 and 3; calibrate with a
false-positive : false-negative cost ratio of **3:1 initially, and test 2:1,
3:1 and 5:1**; no multi-session track yet; WildChat only after licensing,
privacy and contamination checks; natural-300 is not a selection argument
(20 gold memories).

This is an addition to `MODEL-SELECTION-PROTOCOL.md`, not a change to it:
the frozen split, data, training configuration and the protocol's metrics
are unchanged.

## Why

Every realistic-trained Ettin model runs at precision ≈ 0.30 and recall
≈ 0.55-0.68 on every evaluation set: about three stored memories per real
one. A wrong memory is worse for the user than a missed one, so the
operating point (how sure the model must be before it stores something) is
part of the system, and it should be chosen deliberately, on data the test
sets never see.

## Knobs (both off by default; with both at 0 the provider's output is unchanged)

* `--dtw-gate g`: drop every observation of an input whose gate probability
  (does this input contain anything to keep?) is below g. Already in the
  provider.
* `--dtw-span-min s`: drop an observation whose span confidence is below s.
  Span confidence = the mean over the span's tokens of 1 − P(O), the tag
  head's probability that the token is inside some span. New; recorded per
  observation (`p.span`, `p.gate`) in the raw answer.

Plans are not filtered (they are scored separately and are not the
precision problem).

## Selection (validation split only)

* Data: `research/dtw/data/real/val.jsonl` (478 examples, frozen). No test
  set, Benchmark-520 or natural-300 example is used to choose anything.
* Each model is run once on val with both knobs at 0; the stored answers
  are then filtered for every grid point and rescored with `ml/eval/run.mjs
  --rescore` (the harness's own guard and matching).
* Grid: g ∈ {0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9} × s ∈ {0, 0.5, 0.6,
  0.7, 0.8, 0.85, 0.9, 0.95} (72 points).
* Cost on val: **C_r = r · FP + FN**, with FP = predicted memorable
  observations − matched, FN = gold memorable observations − matched,
  summed over val; r ∈ {2, 3, 5}. The operating point minimising C_r is
  chosen per model and per seed; ties go to the lower thresholds (store
  more).
* Primary: r = 3. The 2:1 and 5:1 points are reported as sensitivity.

## Evaluation (once per chosen operating point)

* Sets: test-real (549), Benchmark-520, natural-300, through the unchanged
  harness. Every metric the protocol reports, plus the expected cost per
  example at r = 2, 3, 5.
* Models: realistic Ettin-150M seeds 1-3 and Ettin-400M seeds 1-3 (seeds 2
  and 3 when Kaggle run 5 has trained them). Uncalibrated results stay as
  they are; calibrated results are saved under `-cal<r>` names.
* Comparison with production LFM3 (QAD Q4_0, prompt v2, fixed operating
  point; it has no threshold): paired bootstrap over examples, seed mean for
  Ettin, on **test-real and Benchmark-520 only**. natural-300 is reported as
  supporting evidence, never as a selection argument.

## What would change the conclusion

* Calibration helps if, at r = 3, the expected cost on test-real falls
  against the uncalibrated model for every seed, and precision rises
  without F1 falling by more than 0.02.
* If the best val operating point is (0, 0) (no filtering), the confidence
  scores do not separate right from wrong memories, and the precision
  problem must be fixed elsewhere (data, decoding).
* Known risk: val comes from the same generator as train, so its operating
  point may not transfer to Benchmark-520. This is reported, not tuned
  away.

## Also measured (diagnostic, not a selection input)

Span fragmentation: the share of predicted memorable observations whose
value is a single word or only stopwords (e.g. "I", "staying" cut from one
clause). If it is large, part of the precision problem is BIO decoding, which
no threshold fixes.
