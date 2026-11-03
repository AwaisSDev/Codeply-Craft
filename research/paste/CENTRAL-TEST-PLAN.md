# Central test: execution plan (draft; fields marked TBD are fixed from validation before any run)

Status 2026-11-03: **draft**. It implements EVALUATION-PROTOCOL.md and spec §10.5; it changes neither. Every TBD
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

## 2. Training recipe (TBD from validation)

| Item | Value | Decided by |
|---|---|---|
| Training data | TBD: 3,000 or 6,000 episodes of `train-mix-full` (API/programmatic proportions as E27) | Learning curve (task 17) and measured T4 throughput |
| Epochs | ≤ 4 with per-epoch val and early stopping, patience 1 (`--val-every-epoch`); TBD if the quota forces fewer | Spec §6.5; throughput |
| Closed-loop / corruption variant | TBD among V0-V4 | Variant experiments (task 16), mean over PASTE and M1c |
| Encoder LR | TBD in {3e-5, 5e-5, 1e-4} per family (PASTE; M1c-family) | Pre-registered tuning (BASELINE-PLAN §4) |
| Accumulation | 2 episodes per step on CPU pilots; TBD on T4 (effective batch kept at the pilot's unless throughput forces otherwise) | Throughput |
| Precision | fp16 autocast + GradScaler (`--amp`) if the smoke test shows equal loss traces | Smoke test |

## 3. Procedure

1. **2026-11-07, after the quota reset:** `kaggle quota`; run `paste-smoke` (≈15 min): segments/s for PASTE and M1c,
   fp32 vs AMP. Compute the budget: runs × epochs × segments / throughput, plus per-epoch val and calibration.
2. Fix the TBDs above in this file and in DECISIONS.md; commit.
3. Generate the training groups (`scripts/kaggle/make_notebooks.py --runs groups.json`; one 12 h session per group,
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
