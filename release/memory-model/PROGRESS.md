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
| 1 | Third seed | Blocked on free GPU quota (Kaggle refused 2026-11-03 10:00). Ready: `kaggle-memory-model.ipynb` (exports seeds 1-2 with GPU imatrix, trains + exports seed 3); daily retry scheduled 14:17 UTC |
| 2 | Production export path (merge, imatrix, Q4_K_M) | **Seed 1 exported** (12:00 UTC): Q4_K_M 1,099,627,456 B, SHA-256 `7360aaed…ac14f9`; stored in private Kaggle dataset `awaissididique/codeply-memory-model-gguf` (s1.tar: Q4_K_M, imatrix.dat, SHA256SUMS) |
| 3 | Post-export evaluation (test-real, Benchmark-520) | **Done** (`results/EXPORT-PARITY.md`): test-real F1 0.658, Benchmark-520 0.675; no loss vs adapter at load; +0.36 / +0.10 vs production |
| 4 | Jokes and quotes | Done: `JOKES-AND-QUOTES.md` (labels never learned; same rate as production; fix = v2 data; cue guard rejected) |
| 5 | WildChat licensing and privacy | `WILDCHAT-OPEN-ISSUES.md`: 8 open items for owner/counsel; licence notice added next to the published data |
| 6 | Automatic / pending / discard tiers, confirmation workflow | **Done**: frozen on val (`TIERS-FROZEN.json`), tested once (`TIERS.md` Results). 3:1 → all automatic (ships as `tiers: null`); 5:1 option offered to owner |
| 7 | Brain integration package (no production change) | **Done**: branch `codeply-memory-model-integration` (rebased on this branch, not merged): tiers, pending memories, catalog entry with the release sha256, prompt-style fix; all tests pass |
| 8 | Integration test suite | **Done**: exported seed 1 41 / 48 (gate fails on duplicates, production also fails), production 35 / 48; malformed 18 / 18; `scripts/memory-model-test.mjs` 28 checks |
| 9 | Limitations, performance, deployment, rollback | **Done**: `MODEL-CARD.md` (final numbers), `DEPLOYMENT.md`, `rollback-memories.mjs` (tested) |

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

### 2026-11-03 10:05 UTC
* Seed-3 + GPU-export notebook ready; Kaggle still refuses GPU (weekly
  quota). Daily retry scheduled.
* Jokes/quotes analysed (task 4): the model never learned the labels (15 +
  11 train examples); same false-memory rate as production; a regex cue
  guard was measured on train/val and rejected (0/15 train jokes have cues,
  quote cue fires on 30 % of true memories). Fix = v2 training data.
* WildChat (task 5): labels hold no contact data (dates, ranges, one
  website); train inputs have ~10 real-looking e-mails, 4 phone numbers;
  the guard's grounding check means memorised training text cannot reach a
  user's brain. 8 open items written down; no clearance assumed.
* Integration found a hazard: `context-desktop.js` gives every `codeply-*`
  model the compact prompt, but this model was trained on the full prompt.
  The integration branch makes the catalog's `style` win.
* Brain already has the pending state the tiers need (`tentative`, promoted
  by a second sighting or `confirm`), but tentative memories never expired;
  the integration branch adds a 30-day expiry for pending memories only.

### 2026-11-03 12:01 UTC
* **Production export path works** for seed 1 on CPU: merge (PEFT, fp16,
  pinned base revision) + f16 conversion 3 min; importance matrix over 200
  chunks of the realistic val prompts ~2 h; Q4_K_M + Q8_0 quantization.
  Q4_K_M SHA-256 `7360aaed7410cac445d9901f8a85b876bee6b76d1cb83b05404480b5b9ac14f9`
  (1,099,627,456 bytes); Q8_0 `017bdbfa…01f5eb`.
* Artifact stored durably in the private Kaggle dataset
  `awaissididique/codeply-memory-model-gguf`.
* Release evaluation started automatically (`run-release-evals.sh 1`):
  logprobs parity, confidence runs (val, test-real, Benchmark-520), live
  integration suite.
* Built meanwhile: tier selection script (`select_tiers.py`), deployment and
  rollback guide (`DEPLOYMENT.md`), rollback tool + test.

### 2026-11-03 14:50 UTC — release candidate complete
* Exported seed 1 evaluated through the production backend: test-real F1
  0.658 (P 0.792), Benchmark-520 0.675 (P 0.733); export vs adapter at
  load CIs include zero; vs production LFM3 +0.30..+0.41 / +0.06..+0.14.
  Logprobs do not change answers (8 / 8).
* Integration suite: 41 / 48 (production 35 / 48; first reported as 43 / 50 and 37 / 50, an addition error). Duplicates gate fails
  for both models (Brain exact-value dedup + the model not repeating known
  facts); gate not loosened; Brain follow-up needs owner approval.
* Tiers frozen on val, tested once: 3:1 → everything automatic; Benchmark-520
  cost 582 vs 551 for storing nothing. 5:1 config (exist ≥ 0.95 automatic,
  rest pending) better on both sets but is the owner's call, not selected
  on test.
* Integration branch rebased, catalog sha256 set; tests pass.
* Remaining: seed 3 (GPU quota, daily retry), WildChat items (owner/counsel),
  owner approval to merge and host the artifact.
