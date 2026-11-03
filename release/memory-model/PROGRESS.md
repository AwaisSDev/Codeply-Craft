# Memory model release: progress log

Branch `codeply-memory-model` (from `codeply-li-dtw-experiment`). Owner
directive 2026-11-03: get the fine-tuned LFM3-1.7B memory extraction model
ready for production integration; PASTE paused; no paid compute; no change
to production Brain without explicit approval.

## How to resume (any session)

1. `git checkout codeply-memory-model && git pull`; read this file, newest
   entry last.
2. Long jobs are resumable; rerun the same command and finished steps are
   skipped:
   * export: `W=<work> LLAMA_SRC=<llama.cpp @ aa588a3> PY=<venv python>
     release/memory-model/export_local.sh <seed> <adapter dir>`
   * evaluation: `research/dtw/run-chunked-eval.py` (50-example chunks).
3. The cloud container is reclaimed when no background task runs and can be
   restarted at any time: keep a background wait armed while a job runs.
4. Inputs that are not in git: the adapters are the private Kaggle dataset
   `awaissididique/codeply-real-lfm3-lora-adapters` (seeds 1, 2; final
   adapter + train-log), also in the output of kernel
   `codeply-real-lfm3-lora` version 4.

## Status

| # | Task | Status |
|---|---|---|
| 1 | Third seed | Blocked on free GPU quota (30 h/week used up 2026-11-01); seed-3 notebook to be prepared so that one GPU session trains it and exports all seeds |
| 2 | Production export path (merge, imatrix, Q4_K_M) | Running locally for seed 1 (CPU) |
| 3 | Post-export evaluation (test-real, Benchmark-520) | Pending 2 |
| 4 | Jokes and quotes | Pending |
| 5 | WildChat licensing and privacy | Facts in `research/dtw/label/audit/WILDCHAT-AUDIT.md`; owner/counsel items open |
| 6 | Automatic / pending / discard tiers, confirmation workflow | Pending |
| 7 | Brain integration package (no production change) | Pending |
| 8 | Integration test suite | Pending |
| 9 | Limitations, performance, deployment, rollback | Pending |

## Log

### 2026-11-03 09:50 UTC
* Starting point: LoRA seeds 1, 2 evaluated with the adapter applied at
  load time (`research/dtw/LORA-RESULTS.md`): F1 test-real 0.657,
  Benchmark-520 0.653 (production LFM3 0.300 / 0.575).
* Freed 9 GB of scratch (stale runs; everything was pushed to
  `dtw-artifacts` first): 14 GB free, enough for a local export.
* Decision: validate the production export path locally on CPU first
  (seed 1), because it is the highest-value unknown and needs no GPU:
  `release/memory-model/export_local.sh` runs the merge exactly as
  `train_lora.py` and the commands of `ml/finetune/export_gguf.sh`
  verbatim, resumable per step. Seed 1 started 09:52 UTC.
