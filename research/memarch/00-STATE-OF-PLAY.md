# State of play (verified 2026-10-31, before any new architecture work)

Branch `codeply-memarch-research` (from `codeply-li-dtw-experiment` at
`30b228c6`). Everything below was checked against the repository, not
taken from summaries. Labels: [M] measured or counted here, [R] read from a
committed file.

## 1. Commits and what they contain

| Area | Latest | State |
|---|---|---|
| DTW experiment branch | `30b228c6` (Kaggle fixes, this session) on top of `953dbafc` | realistic data, frozen split, protocol, baselines |
| Model-selection protocol | frozen at `6c21b2a0` (`research/dtw/MODEL-SELECTION-PROTOCOL.md`) | pre-registered; changes only as recorded deviations |
| PASTE | `research/architecture/PASTE-FORMAL-SPECIFICATION.md` (v1, committed `b872ed67`) | v2 exists only in another session's scratchpad: **not in any branch** [M: searched all remote branches] |
| Secret-guard fix | branch `claude/wonderful-feynman-y2ldw2`, `SECURITY-SECRETS.md` | not merged; LFM3 stored 5/13 benchmark secrets, template Ettin 6-7/13 [R] |
| Trained artifacts | orphan branch `dtw-artifacts` | template-trained Ettin-150M s1; realistic-data Ettin-150M s1-s3 |

## 2. Results: completed, failed, pending

| Result | Set | F1 | Status |
|---|---|---|---|
| Rules | Benchmark-520 / test-real / natural-300 | 0.091 / 0.097 / 0.080 | done |
| LFM3-1.7B QAD, prompt v2 (production) | Benchmark-520 | 0.575 (P 0.55, R 0.61) | done |
| LFM3-1.7B QAD, prompt v2 | natural-300 | 0.093 (noise kept out 96 %) | done |
| LFM3-1.7B QAD, prompt v2 | test-real | – | **pending** |
| Template-trained Ettin-150M (s1 / s1r) | Benchmark-520 | 0.306 / 0.328 | done, **old resolver: rerun needed** |
| Template-trained Ettin-150M s1r | test-real / natural-300 | 0.123 / 0.015 | done, old resolver |
| Claude labellers (Sonnet / Opus / hybrid) | Benchmark-520 | 0.838 / 0.844 / 0.831 | done (labeller quality, not a candidate) |
| **Ettin-150M ×3 on realistic data** (mean ± sd over seeds) | Benchmark-520 / test-real / natural-300 | **0.389 ± 0.012 / 0.341 ± 0.011 / 0.241 ± 0.048** | done (§2a); results `dtw-real-ettin150-s{1,2,3}-*` on the DTW branch, weights on `dtw-artifacts` |
| Ettin-400M ×1 on realistic data | – | – | run 3: out of memory at micro-batch 8; rerun at 2 × 16 |
| LFM3-1.7B LoRA on realistic data | – | – | run 3 running |
| Human agreement study (50 examples, 2 people) | – | – | **not started** (needs people) |

## 2a. Realistic-data Ettin-150M in the harness [M]

Three seeds trained on the frozen realistic train split (Kaggle run 3),
evaluated on CPU (4 threads, q8_0 backbone, corrected resolver) by
`research/dtw/run-protocol-evals.sh`. Mean ± sd over seeds:

| Set | F1 | Precision | Recall | Kind | Certainty | False memories | Noise kept out | p50 ms |
|---|---|---|---|---|---|---|---|---|
| Benchmark-520 | 0.389 ± 0.012 | 0.302 | 0.546 | 0.595 | 0.811 | 0.481 | 0.830 | 262 |
| test-real (549) | 0.341 ± 0.011 | 0.243 | 0.571 | 0.783 | 0.888 | 0.633 | 0.873 | 445 |
| natural-300 | 0.241 ± 0.048 | 0.153 | 0.567 | 0.883 | 0.789 | 0.222 | 0.912 | 464 |

Paired bootstrap over conversations (5,000 resamples, seed-mean Ettin minus
LFM3 QAD prompt v2):

* Benchmark-520: **−0.151 to −0.219** (95 %). Production LFM3 (0.575) is
  clearly better on the benchmark.
* natural-300: **−0.045 to +0.300**. Ettin's point estimate (0.241) is far
  above LFM3's (0.093), but natural-300 has only 20 gold memories in 16 of
  298 conversations, so the interval includes zero. Not a win under the
  protocol.

What this changes:

1. Realistic data fixed the template model's collapse (natural-300 F1 0.015
   → 0.241, noise kept out 0.014 → 0.912; the template numbers used the old
   resolver, and the corrected-resolver rerun is queued).
2. The remaining failure is **precision**: about three predicted memories
   per real one, at roughly 0.55 recall, on every set. That is an
   operating-point and calibration problem before it is an architecture
   problem, which is what the calibration layer in `02` targets. Seed-to-seed
   spread is small (sd ≤ 0.012 on the two larger sets), so the gap to LFM3
   on Benchmark-520 is not seed noise.
3. Benchmark-520 is out of distribution for this training data (its jokes,
   quotes and merge cases are thin in train, §3), which is consistent with
   kind accuracy 0.60 there against 0.78-0.88 elsewhere.
4. natural-300 cannot separate candidates; the test-only stress set in `03`
   is a precondition for any architecture claim.

## 3. The realistic dataset and the frozen split

Verified [M]: `train.jsonl` 4,096, `val.jsonl` 478, `test.jsonl` 549; every
file's SHA-256 equals `SPLIT.json`; `leakChecksPass: true`; 0 families or
ids in two splits; 0 benchmark texts (exact or near) in train/val; 94
removed for natural-sample overlap; 206 merge examples dropped for
cross-split known memories (163 train, 43 val).

Composition of train [M]:

| | Count |
|---|---|
| Examples / with nothing to keep | 4,096 / 2,454 (60 %) |
| Strata | WildChat 2,535, MultiWOZ 541, Topical-Chat 118, Roman Urdu (UCI) 113, synthetic Roman Urdu 279, synthetic mixed 275, merge 235 |
| Languages | en 3,377, mixed 417, ur 302 |
| Observations by certainty | stated 2,035, implied 222, temporary 207, hypothetical 109, **joking 15, quoting 11** |
| Plans / context with `until` | 262 / 208 |
| Observations with a merge target | 219 (same 119, different 100) |

**Coverage gap that matters for every architecture**: Benchmark-520 has 62
jokes and 66 quotes; train has 15 and 11. False memories from jokes and
quotes are one of the owner's main failure categories, and no model can learn
to reject them from 26 examples. Merges are also thin (219).

## 4. The Kaggle failures (diagnosed, fixed, relaunched)

Details: `research/dtw/KAGGLE-RUNS.md`. Encoders: CUDA out of memory on the
T4 at the first step (batch 32, inputs up to 1,462 tokens). LFM3 LoRA:
`ImportError` (PEFT rejects Kaggle's torchao 0.10). Neither is a model or
data problem; the same command trains on CPU. Fixed with batch 8 × 4
accumulation + gradient checkpointing, and removing torchao (micro-batch 4 ×
4); effective batches unchanged. Both kernels pushed as version 2 at 15:33.
The slow log retrieval was the CLI paging through every output file before
writing the log; `KaggleApi().kernels_logs()` gets it in one request.

Runs 2 and 3 (details in `research/dtw/KAGGLE-RUNS.md` on the DTW branch):
run 2 failed on a device bug in the temperature fit (encoders) and on the
128K-vocabulary logits (LoRA, out of memory); both fixed. Run 3 trained all
three Ettin-150M seeds. **Exact-span F1 0.05-0.07 is a warning sign, not yet
a result**: it scores exact token boundaries against Claude's evidence spans
(often whole clauses), while the harness scores value words. The harness
evaluation decides; until then no claim about the realistic-trained encoder
should be made. The kernel output contained the whole cloned repository,
which is why every log and artifact download was slow; the notebooks now
clone under `/tmp` and save each run's artifacts as soon as it finishes.

## 5. Facts that constrain the architecture research

* **Input length** [M, Ettin tokenizer]: train mean 238 tokens, p95 569, max
  1,462; test-real max 1,080; Benchmark-520 max 527; natural-300 max ~3,100
  characters. Every example fits in one Ettin window (7,999 positions).
* **No longitudinal structure** [M]: every example is an independent
  snippet; no per-user sequences; known memories exist in 235 train
  examples, built synthetically for merges.
* Therefore, on every current evaluation set, **chunked Ettin (M1c) is
  identical to Ettin**, and any segment-recurrent or persistent-state
  mechanism has nothing to carry and nothing to be scored on. PASTE v1 §0
  already says this; the data confirms it.
* **Production inputs are short too** [R]: ≤ 8 events, ≤ 6,000 characters
  each, call summaries ≤ 800 characters; full transcripts never reach the
  memory pipeline.
* **Compute here**: 4-core CPU, no GPU. Measured fine-tuning speed for
  Ettin-150M ≈ 375 tokens/s (forward + backward); one realistic epoch ≈ 1M
  tokens ≈ 45 min. Ettin-17M/32M/68M (same recipe, MIT) are 2-9× cheaper. So
  pretrained-initialised architecture experiments (Option A) can run here,
  with seeds and ablations, without Kaggle.
