# IrisBench v1: protocol

Committed before any validation or test number existed (git history is the proof). It replaces the IrisBench v0
draft (`research/paste/IRISBENCH-PROTOCOL.md`) for this work; v0's simulator-first design was blocked by render
fidelity (AUDIT.md §2). Code: `codeply_iris/metrics.py`, `codeply_iris/evaluate.py`.

## 1. Data

Episodes written and labelled by a frontier teacher (DATASET.md): several sessions in one fictional user's
life, each labelled with the facts it establishes, the look-alikes that must not be stored, and retrieval
queries with their minimal relevant facts.

| Split | Written by | People | Use |
|---|---|---|---|
| train | teacher shards `tr*` + programmatic drills `syn*` | train name pool | training only |
| val | teacher shards `va*` | disjoint name pool | model selection, thresholds, error analysis |
| test | teacher shards `te*` | disjoint name pool | reported once per frozen system (`--final`) |

Drills never enter val or test. Splits are written by separate authors who do not read each other's files,
with disjoint first names and surnames (`data/spec/pools.json`, enforced by the validator); the build reports
shared entity names and near-duplicate sessions across splits (`data/built/MANIFEST.json`), and any hit is
resolved before evaluation. Split hashes are in the manifest.

## 2. Two settings

* **Open loop.** Each session is judged with the gold store before it (plus unrelated memories from other
  episodes of the same split). Isolates per-batch interpretation.
* **Closed loop.** Sessions run in order; the system reads the store that its own guarded operations built.
  Gold operations are re-derived against that store (`store.derive_ops`): a fact the system missed is a new fact
  when it comes up again; a memory it invented matches nothing. At the end, the store is compared with the
  teacher's ledger. This is the setting that matches the product, and the one a model trained only on gold
  histories fails in.

## 3. Metrics (each reported separately)

A *content op* is add / update / conflict. A predicted and a gold content op **match** when the entity agrees
(exact after normalisation, or an unambiguous shorter form) and the value agrees (token-F1 ≥ 0.5, or the same
resolved date with partial value overlap); one-to-one, best pairs first.

| # | Capability | Metric |
|---|---|---|
| 1 | Fact extraction precision | matched / predicted content ops |
| 2 | Fact extraction recall | matched / gold content ops |
| 3 | Update accuracy | gold updates and conflicts answered with the same op **and** the same target memory |
| 4 | Contradiction resolution | the above plus retractions, over all gold updates, conflicts and retractions |
| 5 | Temporal reasoning | resolved date correct on matched ops that have one (also: date-time, `until`) |
| 6 | Entity linking | value-matched pairs whose entity is also right (1 − misattribution) |
| 7 | Relationship understanding | micro-F1 of `rel` on matched ops |
| 8 | Persistence decisions | `keep` (long / temp) on matched ops; whether the session should change the store at all; empty sessions left empty |
| 9 | Retrieval precision | selected ∩ relevant / selected |
| 10 | Retrieval recall | selected ∩ relevant / relevant |
| 11 | Duplicate detection | gold confirms answered with confirm on the same memory; **duplicates created** (re-adding a stored fact) |
| 12 | Hallucination | **false-memory share** = predicted content ops with no gold match and not a restatement / predicted content ops; **hard negatives stored** = labelled skips whose text was stored; **ungrounded evidence** = ops whose quote is not in the cited message (before the guard) |
| 13 | Structured-output validity | answers that are strict, schema-valid JSON |
| 14 | Multilingual | all of the above on Roman Urdu / Urdu / mixed episodes vs English |
| 15 | Long context | all of the above on long sessions (≥ 450 words or ≥ 14 messages) and large stores (≥ 12 memories) |

Closed loop adds the **end state**: precision / recall / F1 of live memories against the ledger's current
facts, and the shares of stale, duplicate and false memories in the store.

Also reported: kind, sensitivity, basis, confidence and change-type accuracy on matched ops; skip recall;
p50 / p95 latency per batch and peak resident memory on the reference CPU (4 threads).

## 4. Primary endpoints and decision rule (pre-registered)

Primary, on the test split, closed loop: **extraction F1**, **false-memory share**, **end-state F1**.

*Iris beats a baseline* when the 95 % paired cluster-bootstrap interval (2,000 resamples over episodes) of
Iris − baseline is above 0 for extraction F1 and end-state F1 **and** below 0 for false-memory share.
Otherwise the comparison is reported as not shown. Everything else is secondary and descriptive.

One training seed is the default given the compute (CPU only); the bootstrap covers episode sampling, not
training-seed variance, and the report says so. A second seed is run only if time allows and is labelled.

## 5. Systems

| System | What it is |
|---|---|
| `nothing` | stores nothing (cost reference) |
| `rules` | production's no-model extractor (rules-v1), research port |
| `production` | production's extraction request as shipped (prompt v2, strict schema, 700 tokens, production guard) on a local GGUF model; production's own model is LFM3-1.7B |
| `zeroshot` | the selected foundation, untrained, with full written instructions and one example |
| `iris` | the fine-tuned model with its guard |

Baselines without operations are mapped generously (`baselines.py`): a production observation whose slot equals
a known memory's slot counts as an update or a confirm of that memory, as `brain.observe()` would treat it.
Memory model v1 (LFM3 LoRA) and PASTE / M1c are not evaluated: their weights are not reachable from this
environment (AUDIT.md §5). If a baseline cannot be run, the report says so; no number is carried over from a
different benchmark.

## 6. Access rules

* Training and tuning read `train` and `val` only. `evaluate.py` refuses the test split without `--final`.
* Checkpoint, decoding settings and guard are fixed (EXPERIMENTS.md "freeze" entry) before the first test run.
* Test predictions are not inspected for tuning; error analysis uses validation.
* The test split is in this (public) repository for reproducibility. That makes it unsuitable as a hidden
  benchmark for future models trained on public data; a private successor should be generated the same way
  (`data/make_briefs.py` with new shard names) and kept off public branches.
