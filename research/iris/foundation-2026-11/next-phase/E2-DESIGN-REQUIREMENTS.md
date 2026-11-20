# What E2 needs before it can run (2026-11-20; drafted while E1 ran, independent of E1's results)

Owner decisions of 2026-11-20 this answers:
* the five original acceptance criteria stay unchanged;
* thresholding is a separate exploratory hypothesis;
* no threshold is chosen on validation data and then claimed on the same data;
* a separate episode-level calibration set and an independent evaluation set are needed;
* sample sizes must account for episode and seed variation;
* the recall vs false-memory trade-off is specified before the next evaluation and never weakened to let a candidate pass.

Numbers: `e2_sample_size.py` → `e2_sample_size.json`, `calibration_power.json` (read-only, seed-1 outputs). **E2 stays on
hold**: nothing here is run, trained or approved.

## 1. Three disjoint episode sets, each with one job

| Set | Job | Used for | Never used for |
|---|---|---|---|
| **Development** = current `va01-02` (24 episodes) | everything already done: diagnosis, pilot, E1 | debugging, sanity checks | any E2 claim (it has been looked at many times, incl. the threshold opportunity) |
| **Calibration C** (new) | fix τ for each trained model and seed, by a rule written in advance | the exploratory threshold hypothesis only | scoring a claim |
| **Evaluation V** (new, independent) | the five original criteria, once per frozen configuration | the E2 claims | design choices of any kind, threshold choice, error analysis before the run |
| Test (existing, never read) | final check of an adopted system (IRISBENCH §6) | after E2, if anything is to be adopted | — |

* All three are split **by episode** (a persona's sessions share a store; a session-level split leaks).
* Every session in C and V is **human-verified** (`R4-DATA-QUALITY-PROPOSAL.md` §2), so a shared AI annotation habit
  cannot be both trained in and scored as correct.
* Fit data stay at the full training set, so E2 is comparable with seed 1. An 80/20 carve-out is the fallback only if
  no new C can be built (`E1-DECISION-MEMO.md` §2).

## 2. Sample size: what the evaluation set must hold

Between two systems, with k training seeds each and n evaluation episodes:
Var(Δ) ≈ SD_ep² / n + 2 σ_seed² / k.

* **SD_ep (measured, seed 1, closed loop):** per-episode SD of the paired Δ false memories / 100 sessions is
  **≈ 92** (4B 91.6, Gemma 86.4). For Δ recall it is ≈ 0.14.
* **σ_seed:** the seed-to-seed SD of a system's false / 100 at fixed episodes, **unknown** (one seed exists).

Minimum detectable effect, false memories / 100 sessions (80 % power, two-sided 5 %), k = 3 seeds:

| σ_seed \ episodes | 24 | 52 | 76 | 100 | 150 | 200 |
|---|---|---|---|---|---|---|
| 0 | 52 | 36 | 29 | 26 | 21 | 18 |
| 5 | 54 | 37 | 32 | 28 | 24 | 21 |
| 10 | 57 | 42 | 37 | 34 | 31 | 29 |
| 15 | 63 | 49 | 45 | 43 | 40 | 39 |

Episodes needed (k = 3):

| Realistic Δ false / 100 | σ_seed 0 | σ_seed 5 | σ_seed 10 |
|---|---|---|---|
| 40 | 42 | 45 | 62 |
| 30 | 74 | 86 | 175 |
| 20 | 165 | 245 | not reachable with 3 seeds (5 seeds: 763) |

Recall non-inferiority (criterion 2, margin −0.03) is about as demanding: ≈ 180 episodes at σ_seed 0. It needs 270-420
at σ_seed 0.01, depending on the number of seeds, and is out of reach at σ_seed 0.02.

**What this means:**
* Seed 1's observed differences (+14, −11 per 100) are far below anything the current 24 episodes can resolve. So
  "no candidate beat the control" is mostly "not detectable", not "no difference".
* A credible E2 needs **≈ 75-100 independent evaluation episodes for a 30-per-100 effect**, more for smaller effects.
  Seed variance can put a floor under what any n can show, so **E2's first stage must measure σ_seed** before its
  size is fixed:
  * three seeds of one system;
  * on the development set;
  * reported, with no claim attached.
* Building V: about 4-7 new shards of 14 episodes. That is a data cost, and part of the R4 budget question; not
  approved now.
* Within-model contrasts (the same outputs with and without a threshold) do not carry the between-model or seed
  terms. On the development set the 4B threshold example was already −64 to −27 per 100 (descriptive). So the
  threshold hypothesis is cheap to test on V, while model comparisons are not.

## 3. Calibration set size

Threshold-stability proxy (4B seed-1 outputs as a stand-in pool; draws of m episodes; τ = argmax F0.5):

| m (episodes) | modal τ share | distinct τ chosen | false / 100 at the chosen τ (p5 / p50 / p95) |
|---|---|---|---|
| 8 | 0.44 | 9 | 75 / 88 / 107 |
| 12 | 0.47 | 9 | 75 / 88 / 107 |
| 17 | 0.55 | 7 | 75 / 88 / 98 |
| 24 | 0.60 | 5 | 75 / 88 / 98 |
| 36* | 0.68 | 4 | 75 / 88 / 98 |

(* reuses the 24 episodes, so it understates the spread.)

* The chosen value is unstable, but its effect stabilises at about 17-24 episodes; the upper tail shrinks from 107 to
  98.
* **Recommendation:** C ≥ 24 episodes (≈ 120 sessions), a coarse grid fixed in advance, and the bootstrap
  distribution of τ over C's episodes reported with every result.

## 4. The recall vs false-memory trade-off must be fixed in advance

Measured on the development set (descriptive): an F0.5-optimal threshold for 4B costs **0.012-0.052 recall** for
**27-64 fewer false memories per 100 sessions**. An F0.5 rule and a "Δ recall ≥ −0.03" criterion therefore conflict.

**Proposal for the owner to decide before any E2 run (one rule, for every model and seed):**

1. **The five original criteria stay as they are** for the unthresholded model comparison (Q1).
2. The threshold is a **separate, exploratory hypothesis (H-T)**, never mixed into Q1. Its rule is fixed from the
   calibration set only, and in a form that cannot trade recall freely. Options for the owner:
   * **(a) recall-capped:** τ = the most precise grid point whose recall loss on C is ≤ 0.02 (below the −0.03 margin,
     so the margin is not consumed by calibration noise); or
   * **(b) volume-capped:** τ = the most precise grid point that keeps ≥ 85 % of the model's content ops on C.

   **Not recommended:** F0.5 argmax. It is the rule that conflicts with the recall limit.
3. H-T is tested on V once, with the **same recall limit as criterion 2 (lower bound ≥ −0.03)** and Δ false / 100 upper
   bound < 0. If it fails the recall limit, it fails. The limit is not relaxed.
4. **Reporting:** the risk-coverage curve on V is shown descriptively, never used to pick the operating point.

This proposal is written after seeing validation results (the conflict was found on the development set), so it is
recorded as **validation-informed**, like amendment A3. It changes no existing criterion.

## 5. Order before E2 can be pre-registered

1. E1 result and decision report (in progress).
2. Owner decisions: the rule in §4 (a) or (b); whether to fund the human audit and C / V construction (R4 proposal).
3. Build C (≥ 24 episodes) and V (≥ 75 episodes, more if σ_seed turns out larger than 5), human-verified, by episode.
4. σ_seed measurement (three seeds of one system on development), then fix V's size and the number of seeds.
5. E2 protocol with the five criteria unchanged, H-T separate, V used once.
