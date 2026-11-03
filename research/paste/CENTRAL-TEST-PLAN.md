# Central test: execution plan (recipe fields are fixed from validation before any run)

Status 2026-11-03: **procedure ready; recipe fields pending validation runs (§2)**. It implements EVALUATION-PROTOCOL.md and spec §10.5; it changes neither. Every pending field
is filled from validation results (EXPERIMENTS.md) and committed **before** the first central-test training run.

## 1. Systems and seeds

| System | Config | Seeds |
|---|---|---|
| PASTE (spec v2.2) | `--system PASTE --head-norm --profile-rows` | 1, 2, 3 |
| M1c | `--system M1c --head-norm` | 1, 2, 3 |
| M1c-m (parameter-matched) | `--system M1c-m --head-norm` | 1, 2, 3 |
| M1c+W ("does a text window suffice") | `--system M1c+W --head-norm` | 1, 2, 3 |

Identical for all: data, budget, losses, BIO weight 5, optimiser (spec §6.5), D2 = head_norm on, calibration
procedure (`paste.calibrate_full`), evaluator.

## 2. Training recipe (decided from validation by rules fixed in advance)

The rules were committed (DECISIONS.md 2026-11-03, "recipe decision rules"; commit 630e689b) before the variant, LR and
learning-curve results, and are applied mechanically by `tools/choose_recipe.py` (unit-tested). A field stays
**pending** until all of its runs exist; it is never guessed.

| Item | Rule | Value |
|---|---|---|
| Closed-loop / corruption variant | Mean cross-fitted val PE over PASTE and M1c; FPM guard ≤ 1.10 x V0 for both; within δ of the best → prefer V1 (spec §6.3), then V0 | pending (V1-V4 runs) |
| Noise allowance δ | max(0.010, \|PE(S2-PASTE) − PE(V0-PASTE)\|) | pending (S2 run) |
| Encoder LR | per family (PASTE; M1c family from M1c): 5e-5 unless another of {3e-5, 1e-4} beats it by > δ | pending (LR runs) |
| Training data | 6,000 episodes (`train-mix-full` 0-5,999). 3,000 only as the owner's compute fallback and only if PE(3,000) ≥ PE(6,000) − 0.010 for both systems | 6,000 (fallback permission pending: learning curve) |
| Epochs | ≤ 4, per-epoch val, early stopping patience 1 (`--val-every-epoch --patience 1`); best epoch = `final.pt` | fixed |
| Accumulation | 2 episodes per step, every system, any hardware (pilot effective batch) | fixed: 2 |
| Precision | `--amp` for all iff T4 smoke: mean loss of the last 10 logged steps within 2 % of fp32 for every system, no failed run; else fp32 for all | pending (T4 smoke, needs GPU quota) |
| Calibration | `paste.calibrate_full` on full val (θ_R teacher forced; θ_W, θ_F, θ_M closed loop at 3:1; θ_X = 0.5) | fixed |

Groups are generated from the chosen recipe by `tools/make_groups.py --recipe recipe.json [--amp] --per-group N`
(seed 1 of all four systems first), then `scripts/kaggle/make_notebooks.py --runs groups.json --device cuda`.

## 3. Procedure

0. **Before the quota reset (validation only):** all recipe runs finish; `tools/choose_recipe.py --runs ... --out
   results/recipe.json`; fill §2 and DECISIONS.md; commit. `tools/dryrun_central.sh` (steps 5-8 on validation
   stand-ins in a scratch repository, with every guard exercised) must end in `DRYRUN OK` on the current commit.
1. **2026-11-07, after the quota reset:** `kaggle quota`; run `paste-smoke` (≈15 min): segments/s for all four
   systems, fp32 vs AMP; apply the precision rule. Compute the budget: runs × epochs × segments / throughput, plus
   per-epoch val and calibration.
2. Fix the remaining pending fields above in this file and in DECISIONS.md; commit.
3. Generate the training groups (`tools/make_groups.py`, then `scripts/kaggle/make_notebooks.py --runs groups.json`; one 12 h session per group,
   priority order: seed 1 of all four systems first, then seeds 2 and 3). Each run trains, picks its best epoch on
   validation, and runs `paste.calibrate_full --device cuda` (validation only).
4. Download `runs.tgz` per group (`kaggle kernels output`; outputs are private).
5. **Freeze** each run here: `python -m paste.final_eval --freeze --run-name <SYS>-s<seed> --run-dir <dir>`; commit
   `results/final/FROZEN-RUNS.json` (checkpoint SHA-256, model config, thresholds).
6. **Final evaluation here, on CPU** (test never leaves this machine): `python -m paste.final_eval --run-name ...
   --ckpt ... --data-dir <frozen dir> --files test-programmatic.jsonl test-api.jsonl` (stress later, secondary).
   Every access is logged in `results/final/ACCESS-LOG.md`.
7. Latency: `tools/bench_systems.py` on the frozen checkpoints, quiet machine, interleaved, K ∈ {8, 32, 128}.
8. `python -m paste.final_report --files test-programmatic.jsonl test-api.jsonl --latency lat.json --out ...`:
   outcome by spec §10.5.
9. Report with every result, including unflattering ones (protocol §10).

## 4. Fallbacks if the quota is short (in order; each is recorded as a deviation with its reason)

1. Seeds 1-3 for PASTE and M1c first; M1c-m and M1c+W with fewer seeds are labelled exploratory.
2. 3,000-episode training if the learning curve shows ≤ 1 PE point loss vs 6,000 on validation.
3. Free Kaggle CPU sessions for calibration and any remaining validation work (no GPU quota used).

## 5. Interpretation notes fixed in advance

* Bootstrap unit: plans (both wordings move together), as in EVALUATION-PROTOCOL §6 (spec §10.5 says episodes;
  the protocol, approved later, governs).
* Holm-adjusted CI for the two comparisons: reported as the Bonferroni 97.5 % CI (conservative), with Holm on the
  one-sided p-values; Pass needs both adjusted lower bounds > 0.
* FPM non-inferiority: one-sided 95 % bootstrap upper bound of FPM(PASTE)/FPM(B) ≤ 1.10.
* At pilot scale (E28) PASTE-v2.2 is 0.079 PE **below** M1c on validation. The central test may well end in
  "Fail" or "Inconclusive"; that result is reported as such.
