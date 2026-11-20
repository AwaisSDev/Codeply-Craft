# E1 decision memo: what each outcome implies for E2, the calibration split, and R4 vs E2 (2026-11-20)

Written before E1 runs. The readings and labels come from `E1-PROTOCOL.md` §5. Numbers in §2-§3 come from the new
read-only script `calibration_power.py` → `calibration_power.json` (no model, no GPU, no test). **M** = measured,
**H** = hypothesis. Nothing here selects a model or changes any pre-registered criterion.

## 1. E1 outcome → implication for E2

| E1 outcome | What it means | Implication for E2 |
|---|---|---|
| **G0 / G2 fail** (artifact missing, or r2 not reproduced on Transformers) | the historical reference cannot be trusted as measured | E2 is not designed on E1 at all. Report, find the drift (base revision, library versions), decide with the owner |
| **Stack-dominated, quantisation material** | Q4 hurts the 1.7B (H2) | E2's primary evaluation moves to GGUF F16 (or Q8, if pre-registered), with Q4 reported as the deployment cell. Thresholds are calibrated per stack (confidences are not portable). Seed-1 rankings stand, but absolute levels were understated |
| **Stack-dominated, constraint material** | the JSON-Schema grammar pushes the model to skip / emit less | E2 evaluates unconstrained as primary, constrained as secondary. Validity is then a reported cost, not hidden by the grammar |
| **Stack-dominated, backend material** (T ≠ F16-U) | conversion or engine bug | **Blocking:** fix and re-verify the export / server path before E2. Every GGUF number in seed 1 becomes suspect (incl. 4B and Gemma), and the seed-1 comparison is re-run once on the fixed stack |
| **Recipe-dominated** (stack small) | the pilot recipe (no drills, 2 epochs, think-block template) under-trains the 1.7B decision boundary (H1 / H3) | E2 should not reuse the seed-1 recipe as is. **Either** stage 2 first (≈1.5 GPU-h, separate approval) to find which part matters, then pre-register E2 on it; **or** E2 adopts the r2-like budget (drills + 3 epochs) for every model. The control then gets stronger, and the bar for 4B / Gemma rises. Either way, seed-1 outcomes cannot be pooled with E2 seeds |
| **Mixed** | both matter | E2 uses the better stack (from E1's components) **and** waits for stage 2 on the recipe. Until then, absolute numbers are reported as stack-specific |
| **Interaction only** (stack hurts pilot more than r2) | the pilot adapter's decision boundary is fragile (confident skips, M4, sit near a quantisation-sensitive region) | E2 reports every model at F16 and Q4. A model whose quality collapses at Q4 is flagged for deployment, not for ranking |
| **G3 fails** (seed-1 pilot not reproduced) | Kaggle / llama.cpp non-determinism larger than assumed | E2 adds a repeat-run noise floor and widens the "beyond noise" margins **for E2 only, pre-registered**. Seed-1 criteria stay as they were |

E1 decides **how E2 is evaluated and trained**. It does not decide **which model** wins: the candidates are not
re-run in E1, and no outcome adopts anything.

## 2. Is an 80/20 calibration split statistically meaningful?

**Size (M).** The teacher training data has 84 episodes (420 gold sessions, 1,312 gold content ops). 20 % gives
**17 episodes, ~84 sessions, ~262 gold content ops**, about 70 % of the validation set (24 / 120 / 359).

**Episode-level separation is required, not optional.** Sessions in one episode share a persona, a store and
cross-session updates. Splitting at session level would leak facts between fit and calibration and inflate
confidence. The unit of inference is therefore 17 episodes, not 262 ops. Stratifying 17 episodes by six teacher shards
and four languages leaves cells of 0-3 episodes; Urdu-script calibration would rest on about one episode.

**Threshold stability (M, proxy).** The proxy draws 17-episode samples from the seed-1 Qwen3-4B validation outputs (the
4B never trained on them, so they stand in for a held-out calibration set). τ = argmax F0.5 is chosen on each sample
(2,000 draws):

* the chosen τ (mean value-token logprob) varies: −0.3 in 55 % of draws, −0.4 in 30 %, −0.2 in 12 %, other 3 %;
* but its **effect is stable**: false memories / 100 on all 24 episodes at the chosen τ are 75.0 / 88.3 / 97.5
  (p5 / median / p95), against 130.8 without a threshold. Every plausible choice cuts about a quarter to a half of the
  false memories. The F0.5 surface is flat near its maximum, so a noisy τ costs little.

Caveat: this is a proxy. Draws are with replacement from 24 episodes (fewer distinct episodes than a real split). The
validation labels are used **only** to estimate variability; nothing is chosen from it.

**A design problem found by this check (M; validation-informed, disclosed as such).** On the same outputs, a fixed
τ = −0.3 changes 4B open-loop false / 100 by **[−64.2, −26.7]** and recall by **[−0.052, −0.012]** (paired 95 % CI).
E2's planned within-4B criterion "Δ recall lower bound ≥ −0.03" would therefore likely **fail by construction** at an
F0.5-optimal threshold, even though false memories fall clearly. The threshold rule and that criterion conflict. This
must be resolved **before** E2 is pre-registered, by an owner decision recorded as validation-informed (like A3).
Options:
(a) τ = max precision subject to a calibration-set recall loss ≤ 0.02;
(b) keep F0.5 and set the recall tolerance to what the owner accepts for fewer false memories;
(c) keep both and accept that Q2 tests the trade-off, not a free gain.

**Power (M).** Between systems (different models, 24 episodes), seed 1's paired SE of Δ false / 100 is about 18.7
(4B) / 17.6 (Gemma). The minimum detectable effect at 80 % power is **≈ 52 / 49 per 100 sessions**. Criterion 1 (upper
bound < 0) has a 50 % chance only if the true reduction is ≈ 37. Seed 1 observed +14 and −11. Three seeds pooled per
episode reduce training noise, not episode noise, which dominates. With 52 validation episodes (r4's planned
va03-va04), the MDE falls to **≈ 36 / 34**. A within-model threshold effect is far easier to detect, because pairing
on the same outputs removes episode variance (interval above, clearly below 0 with 24 episodes).

**Verdict.**
* An 80/20 split is **adequate for choosing one τ on a coarse, pre-registered grid**. The effect of the choice is
  stable, and episode-level separation is mandatory.
* It is **not adequate** for:
  * calibrated probabilities (isotonic or Platt scaling) or per-language thresholds (≈ 1-5 episodes per language);
  * fine τ grids.
* It costs 20 % of training data, so E2 becomes a new baseline that cannot be pooled with seed 1.
* Report the bootstrap distribution of τ over calibration episodes, which can be done legitimately on calibration data.

**Better: a dedicated held-out calibration shard** (≈ 20-24 new episodes, authored and reviewed like validation, never
trained on). It keeps 100 % of the training data, keeps E2 comparable with seed 1, and gives more calibration episodes
than the split. It also allows a cheap first answer **without any retraining**: τ for the existing seed-1 4B and
control can be fixed on the shard, then run once on validation (≈ 1 GPU-h). Cost: ≈ $8-10 of API authoring (by
analogy with r4's ≈ $9 for two validation shards), and it needs the owner's approval of an API budget. K-fold
cross-fitting (train K adapters) also avoids the 20 % loss but multiplies training cost by K; not recommended at T4
scale.

## 3. Should R4 data improvement come before E2?

The primary objective is fewer false memories. **Evidence (M):**
* Each capacity step stores more and leaves false memories flat or higher: 0.6B → 1.7B in REPORT §1; seed 1: 4B +14 /
  100 vs the control.
* About 23 % of r3's false memories in the stage-0 audit were naming or paraphrase penalties, i.e. label conventions,
  not model errors. The audit is exploratory.
* The current labels do not teach a storage threshold well. The control's confident wrong skips (M4) and 4B's extra
  volume both point at the store-or-skip decision.

**Assessment:**
* **E2 as designed** (three seeds, split, threshold) answers "is 4B > 1.7B robust" and "can an operating point cut false
  memories". At 24 episodes it is **underpowered for criterion 1** (§2). The threshold arm will almost certainly reduce
  false memories within a model, and that is already predictable from the seed-1 outputs.
* **R4** (label repair, storage-threshold negatives, own-memory updates, `conflict` examples, va03-va04) attacks the
  **cause** of false memories in the training signal, **and** raises statistical power (52 validation episodes). Any E2
  run on the current data would be repeated after R4 anyway, because R4 changes the training set and the comparison
  baseline.

**Recommendation (an owner decision; it needs API budget approval):**
1. Run E1 now (cheap; it decides the stack and recipe questions R4-based training will also face).
2. **Start R4 data authoring in parallel** (API only, no GPU): va03-va04 and a dedicated calibration shard first, then
   the training repairs. Budget ≈ $43-52 (r4 proposal) + ≈ $8-10 for the calibration shard.
3. Meanwhile, the only E2-like step worth running on current data is the **no-retraining threshold check** on the
   calibration shard (§2): seed-1 4B and control, τ fixed on the shard, val once. ≈ 1 GPU-h. It answers the
   operating-point question early.
4. Run **full E2 (three seeds) on R4 data**, with the stack and recipe E1 supports, the threshold rule fixed after the
   §2 conflict is resolved, and 52 validation episodes.

**Risks of this order:**
* R4 takes days, not hours.
* New Sonnet- or Opus-authored labels carry their own noise; blind review is planned in r4.
* va01-va02 stay unchanged, so seed-1 numbers remain comparable on those 24 episodes only.

If the API budget is not approved, the fallback is E2 as designed with the 80/20 split (§2 verdict), reported as
underpowered for criterion 1.
