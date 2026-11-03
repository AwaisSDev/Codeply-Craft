# Release candidate: exported seed-1 model, final evaluation (2026-11-03)

Artifact: `codeply-memory-lfm3-s1-Q4_K_M.gguf`, 1,099,627,456 bytes, SHA-256
`7360aaed7410cac445d9901f8a85b876bee6b76d1cb83b05404480b5b9ac14f9`. Produced
by the production export path (`release/memory-model/export_local.sh`: PEFT
merge in fp16 as `train_lora.py`, then the commands of `export_gguf.sh`:
f16 GGUF, importance matrix over 200 × 2,048 tokens of the realistic val
prompts, Q4_K_M). Stored in the private Kaggle dataset
`awaissididique/codeply-memory-model-gguf` (`s1.tar`).

Evaluated on the reference CPU (4 threads) through the production local
backend, chunked (`run-release-evals.sh`). Asking llama-server for token
log-probabilities does not change the answers: 8 / 8 identical
(`logprobs-parity-s1.json`), so these runs are the production answers.

## Quality: exported vs adapter-at-load vs production

| | F1 | P | R | Kind | Certainty | False memories | Noise kept out | p50 / p95 ms | Peak MB |
|---|---|---|---|---|---|---|---|---|---|
| **test-real, exported** | **0.658** | **0.792** | 0.563 | 0.86 | 0.89 | **0.25** | 0.98 | 3,326 / 15,527 | 1,944 |
| test-real, adapter at load | 0.644 | 0.752 | 0.563 | 0.85 | 0.84 | 0.35 | 0.98 | 5,739 / 23,092 | 2,021 |
| test-real, production LFM3 | 0.300 | 0.379 | 0.249 | 0.31 | 0.33 | 0.30 | 0.90 | 4,846 / 28,442 | 2,050 |
| **Benchmark-520, exported** | **0.675** | **0.733** | 0.624 | 0.78 | 0.82 | **0.24** | 0.96 | 5,514 / 18,770 | 1,972 |
| Benchmark-520, adapter at load | 0.660 | 0.713 | 0.613 | 0.79 | 0.83 | 0.32 | 0.96 | 7,062 / 24,104 | 2,030 |
| Benchmark-520, production LFM3 | 0.575 | 0.545 | 0.608 | 0.39 | 0.47 | 0.33 | 0.84 | 11,456 / 29,309 | 2,230 |
| val, exported | 0.592 | 0.776 | 0.479 | 0.76 | 0.92 | 0.30 | 0.98 | 3,088 / 13,269 | 1,952 |

Paired bootstrap over examples (3,000 resamples, 95 %):

| | test-real | Benchmark-520 |
|---|---|---|
| exported − adapter at load | −0.029 to +0.057 | −0.007 to +0.038 |
| exported − production LFM3 | **+0.302 to +0.414** | **+0.064 to +0.136** |

The export loses nothing measurable against the evaluated adapter version
(both intervals include zero; the point estimates favour the export) and is
30-40 % faster (no LoRA at inference). 419 / 549 and 231 / 520 answers are
identical token for token; the rest differ by quantization of the merged
weights. No truncated or unparseable answer from the exported model
(validity 1.0 on both sets).

Benchmark-520 safety and memory actions: secrets stored 1 / 13 (production
5); prompt injections followed 1 / 11 (production 1); memory-action accuracy
0.58 (production 0.53).

## Integration suite (production path end to end, 50 hand-written cases)

| Category | Exported seed 1 | Production LFM3 | Gate |
|---|---|---|---|
| extraction | 7 / 8 | 8 / 8 | 0.8: pass / pass |
| certainty | 4 / 6 | 4 / 6 | 0.66: pass / pass |
| kinds | 5 / 5 | 3 / 5 | 0.6: pass / pass |
| secrets | 5 / 5 | 5 / 5 | 1.0: pass / pass |
| injection | 2 / 2 | 2 / 2 | 1.0: pass / pass |
| noise | 3 / 3 | 3 / 3 | 0.66: pass / pass |
| contradictions | 4 / 4 | 4 / 4 | 0.5: pass / pass |
| **duplicates** | **1 / 4** | **0 / 4** | 0.75: **FAIL / FAIL** |
| jokes | 5 / 6 | 4 / 6 | reported |
| quotes | 5 / 5 | 2 / 5 | reported |
| **total** | **43 / 50** | **37 / 50** | |

Malformed backend output (deterministic, `integration/malformed.mjs`): 18 /
18.

The gate fails on duplicates **for both models**, for reasons mostly in the
brain, not the model: (1) the model writes the known value differently
("Sheru" vs "a dog named Sheru"), and the brain compares values exactly, so
it records a needless replacement with identical text; (2) a more specific
fact ("lives near F-9 Park in Islamabad") becomes a new memory instead of
reinforcing the known one; (3) the fine-tuned model tends not to repeat a
fact that the prompt lists as already known, so the known memory is not
reinforced. (3) matters for the pending tier, whose promotion relies on a
memory being seen again. The gate was not changed after seeing this.
Fine-tuned failures beyond duplicates: two temporary contexts not stored
(cert-03, cert-06), a Roman Urdu wedding announcement missed (urdu-02), a
Roman Urdu joke stored as fact (urdu-03).

## Tiers (frozen on val before the test sets were read; tested once)

| Frozen config | Set | Automatic P / R | Pending per 100 inputs (P) | Cost at the config's r | Cost at 3:1 | Store nothing |
|---|---|---|---|---|---|---|
| r = 3 (and 2): automatic = everything | test-real | 0.792 / 0.563 | – | C₃ 322 | 322 | 366 |
| | Benchmark-520 | 0.733 / 0.624 | – | C₃ 582 | 582 | 551 |
| r = 5: automatic exist ≥ 0.95, pending below | test-real | 0.867 / 0.284 | 25.5 (0.73) | C₅ 342 | 310 | 366 |
| | Benchmark-520 | 0.808 / 0.343 | 45.2 (0.66) | C₅ 587 | 497 | 551 |

At 3:1 the val precision (0.776) is already above the break-even (0.75),
so the pre-registered rule stores everything automatically. That holds on
test-real (cost 322 < 366) but not quite on Benchmark-520 (precision 0.733,
cost 582 > 551; production LFM3 1,056). The r = 5 configuration stays above
0.75 automatic precision on both sets and is cheaper than storing nothing
on both, also at 3:1 cost; choosing it on the strength of these test
numbers would be tuning on test, so it is offered as the conservative
option for the owner, not adopted.
