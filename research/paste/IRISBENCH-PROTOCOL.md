# IrisBench v0 protocol (draft; frozen before any Iris model is trained)

Status 2026-11-05: **draft for owner review.** Pre-registers splits, primary metrics and decision rules before any
IrisBench result exists, as for the central test (EVALUATION-PROTOCOL.md). Builds on IRIS-DESIGN.md §3.

## 1. Data

* Lives from `iris.sim.life` (life simulator v2), rendered by a local open-weights model chosen on pilot lives only
  (§4), verified by `iris.render.verify`. Every gold label comes from the simulator.
* Splits (disjoint first names, surnames, organisations, projects, places and the last 20 % of every value pool):

| Split | Lives | Use |
|---|---|---|
| pilot | ≤ 10 | generator choice, prompt and pipeline debugging only (results never reported as IrisBench numbers) |
| train | as many as compute allows | Iris training |
| val | 20 | model selection, thresholds, early stopping |
| test | 40 (21 days each) | primary results, once per frozen system |
| stress | 20 (42 days each, twice the change / conflict / sensitive rate) | secondary |

* Test and stress lives are generated and rendered only in sessions that run no training, written under a `frozen`
  path (the generator refuses otherwise), hashed (sha256 in `results/IRISBENCH-FROZEN.json`, committed), stored only
  in the private HF data repo, and never mounted by a training notebook. A render that fails verification three
  times is dropped and counted; the drop rate is reported per split.
* Non-commercial public sets (LoCoMo, PerLTQA, HaluMem) are evaluated and reported in a separate table; never
  trained on; commercially licensed public sets (LongMemEval, REALTALK) in another.

## 2. Systems evaluated

Baselines: production rules extractor (research port), production prompt v2 + LFM3-1.7B QAD Q4_0 (production's
current local model, research run), Iris-schema prompt + the same and a ≈4B open model zero-shot, PASTE / M1c frozen
central checkpoints (closed vocabulary mapped to slots). Iris candidates later.

## 3. Primary metrics (pre-registered)

Computed by `iris.eval.extraction` on the test split, open loop first (gold KNOWN memories before each event), then
closed loop (each system's own store) when the store executor is in place:

1. **Extraction F1** (entity + value match; slot, kind, certainty, op reported on matched pairs).
2. **False-memory share** = predicted storable observations with no storable gold match / predicted storable
   observations (production's release-gate measure).
3. **Privacy leak rate** (once retrieval exists): sensitive (secret / private) memories placed in a frontier-bound
   context, per agent task; target 0. A hard constraint, not traded against F1.

Secondary: misattribution, stored non-storable, op accuracy by gold op (update / contradict / reinforce), plan
precision / recall and status accuracy, conflict detection, nudge precision / recall, latency and RAM per event.

## 4. Decision rules

* **Generator choice (pilot only):** the model with the highest verified pass rate among those whose sampled meaning
  check (100 renders, manual) shows ≤ 5 % renders whose text states a fact contrary to or beyond the gold; ties by
  rendered conversations per CPU- / GPU-hour.
* **"Iris beats production" (test):** Iris − production F1 > 0 with the lower end of the 95 % paired bootstrap CI
  over lives (10,000 resamples; seed-mean over 3 seeds) > 0, **and** Iris false-memory share lower with the upper end
  of its CI < 0, **and** leak rate 0 on every seed. Otherwise reported as not shown.
* Per-seed values are always listed; the bootstrap over lives does not include training-seed variance (E41).
