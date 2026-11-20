# Photon (Iris) next phase: research assessment (2026-11-20)

Analysis only. No code changed, no Kaggle job, no GPU quota, no test access. Evidence comes from committed artifacts and
two new read-only scripts: `foundation-2026-11/next-phase/control_diagnosis.py` → `control_diagnosis.json`, and
`threshold_opportunity.py` → `threshold_opportunity.json`. **M** marks a measured finding, **H** a hypothesis not yet
tested. Nothing here changes the five pilot criteria, the seed-1 outcome (`pilot/PILOT-S1-RESULTS.md`: no candidate
beats the control, nothing adopted) or any earlier result.

## 1. Why the pilot control is weaker than the historical 1.7B runs

Closed-loop F1: r2 0.311, r3 0.333 (`results/gpu-r2/val/iris-1.7b-r{2,3}/result-val-closed.json`); pilot control 0.164
(`results/foundation-2026-11/pilot-s1/qwen3-1.7b/result-val-closed.json`). Open loop: 0.404 / 0.420 vs 0.292.

**What differs (from the run configs and manifests):**

| | r2 / r3 | Pilot control |
|---|---|---|
| Training data | 1,255 examples incl. 320 drill observe examples; r3 adds self-output data | 826 teacher examples, drills excluded |
| Training compute | r2: 3 epochs, 471 steps, 2.66M tokens | 2 epochs, 208 steps, 1.37M tokens |
| Formatting | raw ChatML, no think block (`prompt.chatml`) | official template, `enable_thinking=false` (empty think block), in training and evaluation |
| Inference | transformers fp16, unconstrained | llama.cpp Q4_K_M, JSON-Schema constrained |

**Measured:**

* **M1. The evaluation is not the cause.** Same scoring code (the 12 replay tests in `tests/test_foundation.py`
  reproduce every committed result), same validation data (sha256 `0ae33173…`), and the same 120 checkpoint-selection
  examples as r2 (`checkpoint_val_subset_identical: true`).
* **M2. The training objective was reached about equally.** Validation loss: pilot 0.218 at step 208; r2 0.222 at step
  200 and 0.2135 at best (step 400).
* **M3. The control's failure is a behaviour: it skips real facts.** On identical sessions (open loop) it stores nothing
  in 45 of 120 sessions (r2 / r3: 24 each; gold has content in 95). It emits as many skip ops (117 vs 113 / 103), but 13
  land on labelled facts (r2 5, r3 2) and only 47 on labelled skips (r2 73, r3 72). It adds less (221 vs 282 / 291).
* **M4. Those wrong skips are confident** (median token probability 0.85; none below 0.7). This is learned behaviour,
  not near-ties that quantisation noise might flip.
* **M5. Constrained decoding is not the main cause.** On the 30 sessions run both ways (first 6 val episodes), the
  pilot control scores F1 0.279 constrained and 0.254 unconstrained; r2 / r3 score 0.373 / 0.400 on the same sessions.
* **M6. The same stack does not cap a larger model there.** The pilot 4B (Q4, constrained, same template and data)
  reaches open-loop F1 0.402, the level of r2.
* **M7. Drills were not denser in facts.** Store ops per target: drills 1.56, teacher 3.34. Targets with no store op:
  26 % vs 23 %. The op mix is similar (add 62 % in both; skip 26 % vs 21 %).

**Plausible causes (untested; the next experiment separates them):**

* **H1. Half the training signal.** 1.37M vs 2.66M training tokens. Similar validation loss (M2) measures token
  likelihood, not decisions such as skip-vs-add. M3-M4 fit an under-trained decision boundary.
* **H2. Q4 quantisation hurts the 1.7B more than the 4B.** No fp16 evaluation of the pilot adapter exists. M4 argues
  against near-tie flips but not against a shifted distribution.
* **H3. The empty-think-block template changes the skip prior.** It is consistent between training and evaluation, so
  this is a smaller suspect.

**Not supported:** a scoring or data bug (M1), constrained decoding as the main cause (M5).

**Consequence:** the candidate-vs-control comparison stays valid (matched recipe). But the absolute level of every
pilot system may be held down by the shared recipe or stack (H1, H2), so it understates what Photon can do. This
matters for the deployment question, not for the ranking.

## 2. The 4B precision opportunity (descriptive, validation labels)

`threshold_opportunity.json`, open loop (exact; a threshold does not change later inputs there). Confidence = mean token
log-probability of the op's value. **These numbers use validation labels; they show the size of the opportunity and
must not be used to choose a threshold.**

| Qwen3-4B, op kept if confidence ≥ | Ops | Precision | Recall | F1 | False / 100 sessions |
|---|---|---|---|---|---|
| no threshold | 293 | 0.447 | 0.365 | 0.402 | 130.8 |
| 0.61 | 260 | 0.488 | 0.354 | 0.410 | 106.7 |
| 0.74 | 230 | 0.522 | 0.334 | 0.407 | 88.3 |
| 0.82 | 199 | 0.528 | 0.292 | 0.376 | 75.0 |
| 0.95 | 104 | 0.587 | 0.170 | 0.263 | 34.2 |
| (control, no threshold) | 243 | 0.362 | 0.245 | 0.292 | 124.2 |

* **M.** A moderate threshold removes about a third of 4B's false memories for 1-3 points of recall, and F1 does not
  fall. The control's curve is lower everywhere (at about 0.74: precision 0.434, recall 0.209).
* **M.** Confidence is informative but far from calibrated: even ops above 0.99 are only 60 % strict-correct (part of
  that is the matcher's naming penalty, stage 0 §3).
* **Not measurable offline:** the closed-loop effect. Dropping an op changes the store, and with it later prompts, so it
  must be run live.
* **The threshold cannot come from the current 4B on training data**: that model was trained on those labels, so its
  confidence there is inflated. A clean choice needs data the model did not train on: a calibration split carved from
  the training shards (§3).

## 3. Proposed follow-up design (E2, to be pre-registered before running)

* **Data:** split the 84 teacher training episodes once into fit (80 %) and calibration (20 %), by episode, stratified
  by shard and language, with a fixed seed, written to a committed id file before training. Validation unchanged; test
  untouched.
* **Systems:** Qwen3-4B, Gemma 4 E2B, Qwen3-1.7B. The pilot recipe unchanged except the fit split (and any stack change
  that E1 justifies, pre-registered).
* **Seeds:** 1, 2, 3 for every system (seed 1 is retrained on the fit split).
* **Threshold rule (fixed before training):** per model and seed, τ = the confidence that maximises F0.5 on the
  calibration split's open-loop outputs (ties → the higher τ). Applied by infrastructure after the guard (Iris proposes,
  the store decides), live in both loops. The same rule for every model, so the control gets a threshold too.
* **Questions and criteria:**
  * **Q1 (replication, the original five criteria unchanged):** 4B vs 1.7B, both without a threshold, with the three
    seeds pooled per episode in the paired bootstrap. Also required: the direction holds in at least 2 of 3 seeds.
  * **Q2 (operating point):** 4B at its τ vs 1.7B at its τ, under the same five criteria. Within 4B: at τ vs without
    it, Δ false memories / 100 sessions upper bound < 0 and Δ recall lower bound ≥ −0.03.
  * Gemma is compared the same way. Reported in all cases: equal-volume precision (A4 definition), end-state F1, false /
    stale / duplicate shares of the final store, per-seed values, seed spread.
* **Adoption:** not from E2 alone. A model can only be adopted after a frozen configuration is run once on the test
  split (IRISBENCH §6), and only after E2 passes.

## 4. Experiments, ranked

| # | Experiment | Answers | Compute (estimates from measured pilot times) | Value / cost |
|---|---|---|---|---|
| **1** | **E1: control diagnosis (factorial).** Evaluate on val, open loop: r2 adapter and pilot adapter × {transformers fp16 unconstrained, GGUF F16 constrained, GGUF Q4 constrained} (r2 in its raw-ChatML format); closed loop for the two decisive cells. Second stage only if inference does not explain at least half the gap: retrain the 1.7B in pilot format with r2's data and 3 epochs | Is the shared stack (Q4, backend) or the shorter, drill-free training holding quality down? Decides the stack for E2 | exports on a CPU kernel (no quota); evaluation about 1.5 GPU-session-h; optional stage 2 +1.5 h | highest: cheap, and it decides how to read every absolute number |
| **2** | **E2: three seeds + calibration split + threshold** (§3) | Seed variance; is 4B > 1.7B robust; can an operating point cut false memories without losing recall; end-state quality | per seed: training ~65 min (2 x T4), calibration inference ~25 min, val evaluation unthresholded + thresholded ~90 min ⇒ ~3 h; three seeds **~9 GPU-session-h** (about 6 h without Gemma; up to double if Kaggle bills both GPUs) | high: answers the main open question |
| 3 | E3: r4 data (label repair, storage-threshold negatives, own-memory updates, `conflict` examples) | the dominant cause of false memories (REPORT §1; stage 0 §3) | API about $43-52 (r4 proposal), no GPU to build; retraining afterwards | high impact, slower; can be prepared in parallel |
| 4 | Gemma-specific: cap hits (12.5 %) and validity (73 %) | is Gemma's lower false count real or an artefact of truncated answers | small, inside E2 | low until E2 |

Kaggle quota resets on 21 November (30 h). E1 + E2 ≈ 10.5 h (up to about 21 h if billed per GPU) fits one week.

## 5. Risks

* **Small validation** (24 episodes): intervals stay wide even with 3 seeds; seed pooling narrows training noise, not
  episode noise.
* **Label noise and naming conventions** penalise correct paraphrases for every model (stage 0: ≈ 23 % of r3's false
  memories; exploratory). Thresholds learned against noisy labels inherit it.
* **The calibration split** costs 20 % of training data, so E2 is not directly comparable with seed 1; it is a new
  baseline.
* **Threshold portability:** confidences depend on quantisation and backend; τ must be chosen on the deployed stack.
* **The closed-loop threshold effect** is unknown until run live (§2).
* **Queueing** on Kaggle (10-20 min waits seen) and quota sharing with PASTE.

## 6. Recommendation

**Run E1 next.** It is about 1.5 GPU-hours and decides whether the pilot stack understates every model, which E2's design
depends on (Q4 or F16, constrained or not, training length). Then pre-register and run E2 with three seeds and the
calibration-split threshold. Prepare the r4 data (E3) in parallel if the API budget is approved. No adoption until E2
passes and a frozen system is run once on test. Each experiment gets a written protocol and success criteria, committed
before it runs; E1's criteria are diagnostic: it reports the share of the r2-vs-pilot gap explained by each factor, with
bootstrap intervals, and decides nothing about adoption.
