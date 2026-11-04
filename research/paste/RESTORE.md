# Persistence, backup and restore (any machine, any Kaggle account)

Nothing the research needs lives only in a Kaggle session or in this container. Three persistent stores, each with
its own role:

| Store | What | Access |
|---|---|---|
| GitHub, branch `research/paste-architecture` (public) | code, docs, decisions, results JSON (no data, no weights), `results/final/FROZEN-RUNS.json`, `results/final/ACCESS-LOG.md` | public |
| HF `Awais1290/paste-checkpoints` (private model repo) | every run: checkpoints with full resume state, logs, configs, metrics, val per-episode files, calibration | HF token |
| HF `Awais1290/paste-data` (private dataset repo) | `kaggle-trainval-v1/` (exact Kaggle training bundle + MANIFEST sha256), `train-v1/`, `frozen-v1/` (test/stress: **never** uploaded to Kaggle) | HF token |

Kaggle (`/kaggle/working`, kernel outputs) is only a working area and a second copy.

## What a backup contains

`paste.backup` snapshots a whole run directory into `checkpoints/<prefix>/<run>/`:

* `blobs/<sha256[:16]>-<file>`: content-addressed files. A blob path never changes its content, so nothing is ever
  overwritten; a file that did not change is not uploaded again.
* `snapshots/<UTC>-<label>/MANIFEST.json`: every file of the run directory with its blob, sha256 and size, the
  resume point (position, optimizer step, epochs done) and metadata (Kaggle user, code commit). A snapshot is one
  commit with its blobs, so it is complete or absent. Snapshots are never deleted.

The run directory holds everything needed to continue exactly where it stopped:

| File | Content |
|---|---|
| `last.pt` | model, AdamW state, LR-scheduler state, position in the epoch order, optimizer step, Python / torch / CUDA RNG states, AMP GradScaler, per-epoch validation history (written atomically every 250 episodes and after each epoch's validation) |
| `epoch<k>.pt`, `final.pt` | per-epoch model; best epoch on validation |
| `config.json` | every training argument (the data order is a pure function of it) |
| `log.jsonl`, `train.out`, `calibrate.out` | training log and process output |
| `val-epoch<k>*.json`, `epochs.json`, `val*.json` | per-epoch validation, early-stopping record |
| `calibration-full.json.partial.json` | finished calibration configurations (calibration resumes from it) |
| `calibration-full.json` | frozen thresholds (used by `paste.final_eval --freeze`) |

Labels: `periodic` (every 45 min of a running session), `trained`, `calibrated`, `time-guard` (the session stopped at
11 h 15 min), `failed`, `kaggle-output` (uploaded from the scheduler machine after a kernel finished),
`validation-run` (validation-phase runs, prefix `validation/`).

## Restore and continue with a different Kaggle account

1. New Kaggle account: create an API token; export `KAGGLE_USERNAME`, `KAGGLE_KEY`; export `HF_TOKEN` (a token with
   write access to `Awais1290/paste-checkpoints` and read access to `Awais1290/paste-data`).
2. Clone the repository branch `research/paste-architecture`; `cd research/paste`.
3. Recreate the two private Kaggle datasets in the new account from HF (hash-checked):
   `bash scripts/kaggle/make_datasets.sh`. Confirm both are private (`kaggle datasets list --mine`).
4. Regenerate and push the notebooks with the **same** groups file (`results/central/groups.json`, committed) at the
   current commit: `python scripts/kaggle/make_notebooks.py --commit <HEAD> --runs results/central/groups.json
   --device cuda --out NB_DIR`, then `bash scripts/kaggle/push.sh NB_DIR/paste-train-<k>.ipynb paste-central-<run> gpu`.
   Nothing in a notebook depends on the account: data is located by its MANIFEST, the code by its commit, backups by
   the HF repo id.
5. Each notebook restores every run that has no local state from its **latest** HF snapshot, verifies every sha256,
   and the trainer resumes from `last.pt` (calibration from its partial file). Finished runs (calibrated) are only
   re-snapshotted, never retrained.

## Restore by hand (any machine)

    python -m paste.backup list --prefix central                     # runs and their snapshots
    python -m paste.backup restore --run PASTE-s1 --dest DIR --prefix central [--snapshot <UTC>-<label>]
    python -m paste.train ... --out DIR                              # same arguments as config.json: resumes exactly

`restore` writes only into a missing or empty directory and refuses to overwrite files. To go back to an earlier
state, restore a named older snapshot into a new directory.

## Freezing and test evaluation

Frozen test and stress data are kept only here and on HF (`frozen-v1/`, private); they are never put on Kaggle. To
evaluate on another machine: download `frozen-v1/` from HF, check every hash against `results/FROZEN.json` (the
evaluator refuses otherwise), restore the run's `calibrated` snapshot, then `paste.final_eval --freeze` (commit
`FROZEN-RUNS.json`) and `paste.final_eval` as in CENTRAL-TEST-PLAN §3. Every access is appended to
`results/final/ACCESS-LOG.md`.

## Verified

`tools/verify_backup_resume.py` (EXPERIMENTS E48): a run killed mid-training, backed up, deleted, restored into a
fresh directory and resumed ends with **bit-identical** weights to an uninterrupted run; calibration killed after a
few configurations, backed up, deleted, restored and resumed gives the same thresholds; restore refuses to overwrite.
