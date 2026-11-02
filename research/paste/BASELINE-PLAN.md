# PASTE baseline and training plan (for owner approval)

Date 2026-11-02. Nothing here has been run. Every system is trained only after the owner approves this plan,
the dataset audit and the evaluation protocol.

## 1. Systems

All encoder systems:

* Ettin-32M (MIT), with the shared heads of spec §5;
* identical data, losses, seeds {1, 2, 3}, optimiser settings, step budget, tuning budget, calibration and
  D2 head-input choice;
* only the memory pathway differs (owner decision 5, assumptions A1-A3).

| ID | System | Memory pathway | Parameters | Input tokens per segment (pilot, API wording, mean / p95) | Status |
|---|---|---|---|---|---|
| **PASTE** | Spec v2.1 | Soft-token store + memory tokens + temporary vectors | 39.26M | 76 / 116 | Built (Phase 3) |
| **M1c** | Central test | Records and temporary items as text rows | 36.42M | ≈175 / 264 | To build: text rendering, field pooling, row shuffling (heads reused) |
| **M1c-m** | Central test, parameter-matched | M1c + 2 extra layers | 39.07M | as M1c | To build (small) |
| **M1c+W** | "Does a text window suffice?" | M1c + previous 2 segments as text | 36.42M | ≈265 | To build (small) |
| RMT | Recurrent segment baseline (brief 6) | M1c + 4 memory tokens by replacement | 36.57M | ≈179 | To build (small) |
| KV | Learned key-value memory (brief 7) | Records as cached vectors read by the heads only; flat addressing | 36.86M | ≈46 + heads | To build |
| FC | Conventional full-history transformer (brief 5) | All previous segments' text (≤ 2,048) + records as text | 36.42M | grows with history | To build |
| R0 | Rules (brief 1) | Patterns + Brain guard + string-match addressing | 0 | — | To build (CPU) |
| Z1 | Existing DtW Ettin-150M / 400M checkpoints, zero-shot (brief 3-4) | Their own known-memories format | 150M / 400M | — | Optional; trained on WildChat-derived data, so **evaluation only** and labelled as such |
| Z2 | LFM3-1.7B production prompt, zero-shot (brief 2) | Prompted | 1.7B | — | Optional; CPU hours only |

**Ablations of PASTE** (spec §9.2):

| ID | Change |
|---|---|
| A1 | Flat addressing |
| A2 | No memory tokens |
| A3 | Single memory pool |
| A4 | No look-alike negatives in training |
| A5 | Teacher forcing only |
| A6a / A6b | Auxiliary losses |
| S17 | Ettin-17M scale |
| X1 | Delta-rule temporary memory (exploratory) |

## 2. What remains to implement before any training run

1. `paste/data.py`: dataset loader. It turns episodes into `StepInput`s and gold dicts for both memory
   pathways, and adds the gold merge pairs to the candidate set during training only (spec §5.10, D1).
2. `paste/baselines.py`: M1c, M1c-m, M1c+W, RMT, KV, FC. Each shares `SharedHeads`. Unit tests check
   parameter counts against `tools/param_count.py`, plus equivariance where it applies.
3. `paste/train.py`: windows of 8 segments, truncated BPTT (k = 4), curriculum, closed-loop scheduled
   sampling with provenance remapping, fp16 + GradScaler, gradient clip 1.0, checkpoint every epoch,
   resumable.
4. `paste/evaluate.py`: closed-loop and teacher-forced replay, matching rules, every metric in
   `EVALUATION-PROTOCOL.md` §4, calibration, bootstrap and Holm, and the `--final` guard.
5. `rules.py` (R0).
6. Kaggle notebook generator, adapted from `research/dtw/notebooks/make_notebooks_real.py`:
   * the code is cloned from the public branch under `/tmp`;
   * the data comes from a **private Kaggle dataset** (created from the private HF repo);
   * data hashes are checked before training;
   * artifacts are written to the private HF model repo after each run.

## 3. Compute budget: estimates, to be replaced by measurement

**Measured so far:** on CPU, PASTE-32M trains at 0.3 s per segment (forward + backward, batch 1, S1 toy
episode, 4 threads).

**Not yet measured:** throughput on a T4. The heads contain Python loops (per unit, per profile), so the
GPU speed-up is uncertain. Before any budgeted run:

* **Step 1:** CPU smoke training on 100 train episodes for each of PASTE and M1c, measuring segments/s.
* **Step 2:** one Kaggle smoke run, about 15 minutes of quota, measuring T4 segments/s for PASTE and M1c.

**Planning assumption (to be corrected by Step 2):** about 25 segments/s on a T4 for PASTE, about 15 for M1c
(longer inputs).

| Item | Size | Assumed T4 hours |
|---|---|---|
| Train set | 6,000 episodes ≈ 55k segments | |
| One epoch, PASTE / M1c | | ≈ 0.6 h / ≈ 1.0 h |
| Run of 3 epochs + val evaluation | | PASTE ≈ 2.0 h, M1c-family ≈ 3.2 h |
| D2 pilot (4 runs at reduced scale: 2,000 episodes, 1 epoch, seed 1) | | ≈ 1.5 h |
| Central test: PASTE ×3, M1c ×3, M1c-m ×3, M1c+W ×3 | 12 runs | ≈ 35 h |

**This does not fit one week (~30 h, assumption A6, unverified).** Options to put to the owner after Step 2,
cheapest first:

1. **Reduce training to 3,000 episodes × 3 epochs.** A learning-curve check on val, at 1,500 / 3,000 / 6,000
   episodes for one PASTE seed, decides whether this costs accuracy. Central test then ≈ 18 h; RMT, KV, A1-A3
   add ≈ 12 h.
2. **Use both T4s** of a "T4 ×2" session (one seed per GPU), if Kaggle counts quota per session hour. To be
   verified on the account; not assumed.
3. **A second week of free quota**, owner's decision.
4. **CPU here for the small runs:** R0, S17 (17M), Z1/Z2 evaluation, all evaluation runs.

**Priority (runs stop at the quota; anything with fewer than 3 seeds is labelled exploratory):**

| Priority | Runs |
|---|---|
| 0 | Steps 1-2 (throughput), D2 pilot |
| 1 | PASTE, M1c, M1c-m, M1c+W × 3 seeds (central test) |
| 2 | A2, A3, A1 × 3 seeds (H1-H3); RMT, KV × 3 seeds |
| 3 | FC, A4, A5, A6a/b, S17 (1-3 seeds) |
| 4 | R0, Z1, Z2 (CPU) |

## 4. Fixed in advance

* **D2 pilot scale:** 2,000 train episodes, 1 epoch, seed 1, full val set; PASTE and M1c, `head_norm` off
  and on. Selection is on validation PE, averaged over the two systems (`EVALUATION-PROTOCOL.md` §9).
* **Hyperparameter tuning:** the encoder learning rate ∈ {3e-5, 1e-4} only, 1 seed, on val, per system
  family (PASTE, M1c-family); spec §6.5.
* **Checkpoints:** every epoch, to the private HF model repo `Awais1290/paste-checkpoints` (created only when
  the first run starts; verified private before upload). Resuming from the last checkpoint is supported.
* **Logs:** Kaggle logs via `KaggleApi().kernels_logs()`, committed under `results/kaggle/` (no data, no
  secrets).
