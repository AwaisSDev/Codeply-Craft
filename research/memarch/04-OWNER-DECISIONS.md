# Owner decisions (2026-11-01)

| Question | Decision | Reason given |
|---|---|---|
| Ettin-400M seeds 2 and 3 | **Run both** | Three seeds are needed before trusting the 400M lead |
| Calibration cost ratio | **3:1 initially; test 2:1, 3:1 and 5:1** | Wrong memories are more damaging than missed ones; 3:1 is a starting hypothesis |
| Track B (closed-loop multi-session) | **Not now** | Premature without real multi-session data; do not build for a workload not yet demonstrated |
| WildChat for evaluation | **Only after licensing, privacy and contamination checks** | |
| natural-300 | **Not a selection argument** | Only 20 gold memories (in 16 conversations) |

Owner's reading of the results so far: data quality mattered more than
architecture complexity; Ettin-400M is a serious candidate, not selected.

## Consequences recorded here

* **Ettin-400M seeds 2 and 3**: Kaggle encoder run 5 (2026-11-01 06:34
  UTC, micro-batch 2 × 16 as seed 1). Evaluated by the same scripts.
* **Calibration**: pre-registered before any validation run in
  `research/dtw/CALIBRATION-PROTOCOL.md` on the DTW branch (`049f688a`):
  gate and span-confidence thresholds chosen on the frozen val split only,
  cost r·FP + FN for r ∈ {2, 3, 5}, 3 primary; applied once to test-real and
  Benchmark-520 (primary) and natural-300 (supporting only).
* **Track B** is closed for now. In `03-EXPERIMENT-PLAN.md` it was already
  conditional; it stays out of scope until real multi-session data exists.
  SRDE V2/V3 (store-relational variants) keep their place in the plan only
  as single-turn store-readout experiments.
* **natural-300**: every summary reports test-real and Benchmark-520 as the
  basis for decisions; natural-300 numbers are labelled supporting, with
  their 20-memory denominator.

## WildChat is already in the data (flag for the owner)

The WildChat decision affects more than a future evaluation. Counted on the
frozen files [M]:

| File | Examples | WildChat-derived |
|---|---|---|
| train | 4,096 | 3,315 |
| val | 478 | 378 |
| test-real | 549 | 425 |
| natural-300 | 298 | 298 |

So the licensing, privacy and contamination checks the owner asked for
apply to the realistic training data, test-real and natural-300 that every
current result rests on, not only to a new WildChat evaluation (and not
only to the `hashed_ip` linkage that Track B would have needed). Until those
checks are done, the realistic-data results should be treated as research
results, not as a basis for shipping a model trained on this data.
Contamination specifically: Ettin and LFM3 may both have seen WildChat
conversations in pre-training; the test-real comparison is between models
with possibly unequal exposure, which the check should assess.
