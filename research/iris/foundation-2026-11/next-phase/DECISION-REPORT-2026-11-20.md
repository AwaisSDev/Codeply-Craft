# Decision report after E1 (complete) and R4 Phase A start (2026-11-20)

Supersedes the interim `E1-DECISION-REPORT.md`, which stays on record. **M** = measured under the pre-registered
protocol; **X** = exploratory; **H** = hypothesis.
* No model is selected or adopted.
* E2 stays on hold.
* No R4 API money was spent and no AI-labelled data was generated.
* The test split was not accessed.
* The five original acceptance criteria are unchanged.

## 1. E1 outcome: what caused the control vs historical difference

* **M. Reading: stack-dominated, in both loops** (`E1-RESULTS.md` §7, `E1-DECOMPOSITION.json`).
  * The pilot control's own inference stack (Q4_K_M + JSON-Schema decoding through llama.cpp) explains **69 %**
    [36 %, 113 %] of its open-loop F1 gap to r2 and **78 %** [49 %, 122 %] of the closed-loop gap.
  * The training-recipe bundle (drills, epochs, template) leaves +0.035 open and +0.033 closed F1, neither
    distinguishable from zero.
  * On Transformers fp16 the pilot control scores **0.370 open / 0.279 closed**, close to r2's 0.404 / 0.311, instead
    of the 0.292 / 0.164 measured in the pilot.
* **M. Quantisation is the main stack factor:** F16 → Q4_K_M costs 0.048-0.059 F1 and 0.064-0.078 recall in open loop,
  for both adapters.
* **M. The backend is not a factor:**
  * Transformers vs llama.cpp F16 differ by −0.002 (pilot) and +0.007 (r2) F1;
  * false memories are identical within ±3 per 100.
* **M. Constrained decoding:** no F1 effect, but +17 to +23 false memories per 100 for the pilot adapter. The grammar
  turns the pilot's invalid outputs (16-24 % of sessions) into stored ops.
* **M. Adapter-dependent stack damage in closed loop:** the same stack costs the pilot adapter 0.115 closed F1 and r2
  0.048 (difference −0.067 [−0.133, −0.009]).
* **M. Reproductions:**
  * historical r2 (0.4042) and r3 (0.420) reproduced exactly on Transformers;
  * seed-1 pilot Q4-C reproduced exactly;
  * the r2 / r3 base revision was not recorded, but the content is identical across every revision.
* **Correction:** the interim report's exploratory "recipe gap ≈ 0.10 in closed loop" was wrong. It compared on Q4-C,
  where the stack, not the recipe, separates the adapters.
* **Still uncertain:**
  * whether Q4 hurts the 4B and Gemma pilot adapters as much as the 1.7B (not measured; H);
  * which part of the recipe produces the small remaining gap (stage 2, not approved);
  * all of this is one seed, on 24 development episodes.

## 2. What this means for the seed-1 pilot (no criterion changed, no re-scoring)

* The seed-1 outcome stands as recorded: no candidate met the five criteria, and nothing is adopted.
* **H.** The comparison was matched on stack, but E1 shows the stack's damage depends on the adapter. Its absolute
  numbers, and possibly the gaps between candidates and control, reflect Q4 behaviour as much as model quality.
  * If Q4 hurts the 1.7B control more than the 4B, seed 1 *overstated* the 4B's quality advantage.
  * The 4B's false-memory problem (more volume, not fewer false memories) was measured on the same stack and is not
    explained away by this.
* Consequence for E2's design: the primary evaluation stack must not be Q4_K_M alone (§5).

## 3. R4 Phase A: started (`r4-phaseA/README.md`)

* **Review page:** https://claude.ai/artifact/PVgxU3HUQRZihayABZ8Q9N (private to the owner; share it as Contributor
  with a second reviewer).
* **Sample:** 280 stratified items from training and validation (none from test), 71 in a second-reviewer overlap set.
  * By origin: 134 teacher labels, 146 model outputs.
  * By author: Opus 142, Sonnet 138.
  * By language: 146 Roman Urdu / Urdu script / mixed.
  * Two strata were short of model cases and were topped up with teacher items of the same type (recorded).
* **Blind:** no author, model, stratum, origin or correctness is shown. Original labels live only in `key-v1.json`.
* **Decisions:** remember / update / retract / skip / unsure, a details verdict, corrections, an explanation. Each
  reviewer sees only their own decisions, and export is versioned (`r4-phaseA-review/1`).
* **Analysis:** `analyze_review.py` was committed before any decision existed.
* **Nothing writes back** to training or validation data.
* **Status:** the owner continues the review from 2026-11-21. Not yet tested by a live save; the first decision is
  the first write.

## 4. Threshold rules (`THRESHOLD-RULES-COMPARISON.md`; nothing selected)

* **Recall-capped (0.02):**
  * needs a human-verified calibration set;
  * removes more false memories for the 4B (proxy median −33 per 100);
  * is noisier: 15 % of proxy draws exceed the −0.03 recall limit.
* **85 % retention:**
  * label-free and stable;
  * removes less for the 4B (−24 per 100);
  * ≤ 2 % of draws exceed the limit;
  * does not target recall, so its recall cost must be tested, not assumed.
* All numbers are optimistic development-set proxies. E1 adds one consequence for either rule: **confidences, and
  therefore τ, depend on the stack**, so τ must be fixed on the same stack that is evaluated.

## 5. What E2 now needs (still on hold)

1. **Stack:**
   * evaluate at F16 (or a pre-registered Q8_0) as primary, with Q4_K_M as a reported deployment cell for every
     model;
   * report constrained and unconstrained;
   * measure Q4's damage per model size before treating any Q4 comparison as fair.
2. **Sets:** development (current val), human-verified calibration C (≥ 24 episodes) and independent evaluation V
   (≥ 75-100 episodes for a 30-per-100 effect; `E2-DESIGN-REQUIREMENTS.md`).
3. **Seed variance first:** three seeds of one system on development, which sets V's size.
4. **Criteria:**
   * the five original criteria for the model comparison;
   * the threshold as a separate exploratory hypothesis, with a rule chosen by the owner before C's outputs exist;
   * the recall limit unchanged.
5. **Labels:** Phase A's measured error rates decide whether C and V can use AI-authored sessions with human review,
   and which R4 phases are worth funding.

## 6. Decisions for the owner (none needed tonight)

* After the review: approve or decline R4 Phases B-D, with Phase A's measured numbers in hand.
* Before E2:
  * the threshold rule (recall-capped, 85 % retention, or no threshold in E2);
  * the primary evaluation stack (F16 vs Q8_0).
* Optional:
  * a small follow-up measuring Q4 vs F16 for the 4B and Gemma pilot adapters on development (~1 GPU-hour), to settle
    §2's hypothesis;
  * stage 2 (splitting the recipe bundle), now low priority, since the recipe share is small and not significant.
