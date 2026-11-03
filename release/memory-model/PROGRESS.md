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
| 2 | Production export path (merge, imatrix, Q4_K_M) | Seed 1 running locally (CPU): merge + f16 done in 3 min, importance matrix ~2 h |
| 3 | Post-export evaluation (test-real, Benchmark-520) | Pending 2 |
| 4 | Jokes and quotes | Done: `JOKES-AND-QUOTES.md` (labels never learned; same rate as production; fix = v2 data; cue guard rejected) |
| 5 | WildChat licensing and privacy | `WILDCHAT-OPEN-ISSUES.md`: 8 open items for owner/counsel; licence notice added next to the published data |
| 6 | Automatic / pending / discard tiers, confirmation workflow | Design + selection pre-registered (`TIERS.md`); thresholds pending the exported model's val run |
| 7 | Brain integration package (no production change) | Branch `codeply-memory-model-integration` (not merged): tiers, pending memories, catalog entry, prompt-style fix; all tests pass |
| 8 | Integration test suite | `integration/`: 50 live cases (to run on the exported model) + 18 malformed-output cases (pass); `scripts/memory-model-test.mjs` on the integration branch (28 checks) |
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
