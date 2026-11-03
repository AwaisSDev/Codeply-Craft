# LFM3-1.7B LoRA on the realistic data: results (2026-11-03)

The last candidate of `MODEL-SELECTION-PROTOCOL.md`: LFM3-1.7B fine-tuned
with LoRA by the production script (`ml/finetune/train_lora.py`,
`config-lfm3.yaml`) on the frozen realistic train split, seeds 1 and 2
(Kaggle LoRA run 4; fp16 on two T4s, 508 steps, final val loss 0.1125 /
0.1129). Evaluated with `research/dtw/run-lora-evals.sh` on the reference
CPU (4 threads).

**Deviation (recorded in `KAGGLE-RUNS.md`).** The merged-and-quantized
export did not fit Kaggle's limits without GPU quota, so each adapter was
converted to a GGUF LoRA (f16) and applied at load time (`llama-server
--lora`) on the same `LFM3-1.7B-Q4_K_M.gguf` file that the untrained
baseline `lfm3-q4-v2-test-real` uses. This isolates the effect of
fine-tuning (identical base file), but it is not the production export
path (merge, importance matrix, Q4_K_M).

**Two seeds**, not three: the protocol's three-seed requirement is not met
for this candidate (the weekly GPU quota was used up); the seeds agree
closely (F1 0.644 / 0.670 test-real, 0.660 / 0.647 Benchmark-520).

## Results (mean over seeds)

| System | test-real F1 (P / R) | Benchmark-520 F1 (P / R) | natural-300 F1* | p50 / p95 latency (test-real) |
|---|---|---|---|---|
| **LFM3 LoRA (2 seeds)** | **0.657** (0.78 / 0.57) | **0.653** (0.73 / 0.59) | 0.445 | 5.5 s / 21.9 s |
| LFM3 production (QAD Q4_0, prompt v2) | 0.300 (0.38 / 0.25) | 0.575 (0.55 / 0.61) | 0.093 | 4.8 s / 28.4 s |
| LFM3 untrained Q4_K_M (same base file) | 0.317 (0.26 / 0.42) | – | – | 11.8 s / 41.2 s |
| Ettin-400M (3 seeds) | 0.413 (0.31 / 0.64) | 0.412 (0.30 / 0.66) | 0.314 | 1.1 s / 2.9 s |
| Ettin-150M (3 seeds) | 0.341 (0.24 / 0.57) | 0.389 (0.30 / 0.55) | 0.241 | 0.4 s / 1.2 s |

\* natural-300: 20 gold memories, supporting only.

Paired bootstrap (3,000 resamples over examples; LoRA seed mean minus the
other system's seed mean; 95 %):

| Comparison | test-real | test-real, user-disjoint (n = 279) | Benchmark-520 |
|---|---|---|---|
| LoRA − production LFM3 | **+0.356 (+0.298 to +0.412)** | +0.365 (+0.270 to +0.463) | **+0.079 (+0.045 to +0.115)** |
| LoRA − untrained LFM3, same base file | +0.340 (+0.282 to +0.400) | +0.358 (+0.261 to +0.451) | – |
| LoRA − Ettin-400M | **+0.244 (+0.196 to +0.287)** | +0.192 (+0.116 to +0.261) | **+0.241 (+0.209 to +0.272)** |

Every primary interval excludes zero by a wide margin, so a Holm
correction over these comparisons does not change any conclusion.

Other measures (LoRA, mean of seeds):

* Kind / certainty accuracy: 0.86 / 0.88 on test-real, 0.80 / 0.85 on
  Benchmark-520 (production LFM3: 0.31 / 0.33 and 0.39 / 0.47).
* False-memory rate 0.30 on both primary sets (production 0.30 / 0.33,
  Ettin-400M 0.57 / 0.54); noise kept out 0.98 / 0.97.
* Benchmark-520 safety: 0 of 13 secrets stored (production 5, Ettin-400M
  1.3 on average); prompt injections followed 1 and 0 of 11 (production 1).
* Benchmark-520 memory actions 0.538 / 0.543 (production 0.528). Better
  than production on duplicates (0.54-0.61 vs 0.39), contradictions (0.48
  vs 0.26) and hypotheticals (0.68-0.73 vs 0.52); slightly worse on jokes
  (0.52-0.54 vs 0.61) and quotes (0.56-0.60 vs 0.62), where train is thin
  (15 jokes, 11 quotes).
* Plans on Benchmark-520: precision ~1.0 (seed 2 reports 1.049, a harness
  matching quirk where one predicted plan can match more than one gold
  plan), recall 0.61 / 0.40, date accuracy 0.86 / 0.81.

## Cost model (owner's 3:1, with 2:1 and 5:1 tested in TIERS-RESULTS.md)

The LoRA model has no confidence score to tier with, so all its answers
count as automatic. C = r·FP + FN, against storing nothing:

| Set | C₂ | C₃ | Store nothing |
|---|---|---|---|
| test-real | 274 | **332** | 366 |
| Benchmark-520 | 467 | 588 | 551 |

It is the first system that beats storing nothing on test-real at 3:1
without calibration (precision 0.78 ≥ 0.75), and on both primary sets at
2:1. On Benchmark-520 at 3:1 it costs slightly more than storing nothing
(precision 0.73 < 0.75), less than any other candidate (production 1,056,
Ettin-400M 2,755).

## Reading

1. On the protocol's two primary sets the fine-tuned LFM3 is better than
   every other candidate, including production LFM3 on Benchmark-520,
   which no Ettin model beat. The gain is from fine-tuning: on the
   identical base file it adds +0.34 F1 on test-real.
2. It is not explained by in-distribution data or user overlap: the lead
   holds on Benchmark-520 (written independently of the training data) and
   on the user-disjoint test-real subset.
3. Costs: latency about 5-10× Ettin-400M (p50 5.5-6 s, p95 ~20 s on 4 CPU
   threads), comparable to production LFM3; a 1.7B model to ship instead
   of a 400M encoder.
4. Open before a selection: a third seed; evaluation of the production
   export path (merged + importance-matrix Q4_K_M) when GPU quota allows;
   the WildChat licensing/privacy decisions (the training data is mostly
   WildChat-derived); jokes and quotes coverage.
