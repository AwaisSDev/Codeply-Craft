# Threshold rules: 0.02 recall-loss cap vs 85 % retention (2026-11-20). For the owner's choice; **nothing selected**

Context: the threshold is a separate, exploratory hypothesis (owner decision). The five original acceptance criteria
are unchanged and apply to the unthresholded model comparison. E2 stays on hold.

| | **Rule R: recall-capped** | **Rule V: volume-capped** |
|---|---|---|
| Definition (fixed on the calibration set C) | strictest confidence threshold whose recall loss on C is ≤ 0.02 | strictest confidence threshold that keeps ≥ 85 % of the model's content ops on C |
| Needs labels on C | **yes**: recall is measured against gold labels, so C must be human-verified | **no**: only the model's own outputs and confidences |
| What it holds equal across models | the recall cost | the share of stored memories removed (15 %) |
| What it lets vary | how much each model's volume shrinks | each model's recall cost |
| Exposure to label noise and AI annotation conventions | direct: a convention error in C moves τ | none in choosing τ (only in scoring the result) |
| Exposure to calibration sampling noise | higher: the recall estimate on 24 episodes is noisy | lower: an op-count share is stable |
| Guarantee on the evaluation set | none, but it targets the quantity criterion 2 tests | none, and it does not target recall at all |
| Interaction with criterion 2 (Δ recall lower bound ≥ −0.03) | the 0.02 cap leaves 0.01 for calibration-to-evaluation shift | indirect: passes only if the dropped 15 % is mostly wrong ops |
| Interaction with criterion 1 (fewer false memories) | removes more when confidence separates well | removes a fixed slice, so a weak-confidence model gains less |
| Failure mode | over-aggressive τ when C happens to be easy; a recall-limit failure on V | under-filters a model whose errors are confident; over-filters a model with few errors |

## Descriptive consequences (proxy; `threshold_rules_compare.py` → `threshold_rules_compare.json`)

1,000 calibration-sized draws (24 episodes) from the seed-1 **development** outputs (validation, open loop), each
rule applied, effect read on the same 24 development episodes. Calibration and read-out overlap, so every number is
optimistic. This is **not evidence for either rule and selects nothing.** Median (5th-95th percentile) vs no
threshold:

| Model (seed 1) | Rule | Δ false / 100 | Δ recall | Δ precision | Ops kept | Draws with Δ recall < −0.03 |
|---|---|---|---|---|---|---|
| Qwen3-4B | R | −33 (−43 to −24) | −0.014 (−0.031 to −0.011) | +0.06 | 85 % | **15 %** |
| Qwen3-4B | V | −24 (−33 to −24) | −0.011 (−0.014 to −0.011) | +0.04 | 89 % | 2 % |
| Gemma 4 E2B | R | −16 (−38 to −11) | −0.019 (−0.036 to −0.006) | +0.02 | 88 % | 6 % |
| Gemma 4 E2B | V | −16 (−16 to −11) | −0.019 (−0.019 to −0.006) | +0.02 | 88 % | 0 % |
| Qwen3-1.7B control | R | −31 (−31 to −26) | −0.014 (−0.014 to −0.006) | +0.05 | 82 % | 4 % |
| Qwen3-1.7B control | V | −26 (−31 to −11) | −0.006 (−0.014 to −0.006) | +0.05 | 86 % | 0 % |

What the proxy suggests (H):
* R removes more false memories for the strongest model (4B: about −33 vs −24 per 100).
* R is also more often too aggressive: in 15 % of draws the 4B's recall loss exceeds the −0.03 limit, against 2 % for
  V.
* V behaves almost identically across draws. It costs ≤ 0.02 recall for every model here, but nothing in the rule
  guarantees that for an unseen model.
* For the weaker models the two rules land in the same place.

## Consequences for E2's design, whichever is chosen

* **Choosing R** commits E2 to a **human-verified calibration set** (R4 Phase A/C). With today's AI-only labels, R
  would encode the Opus / Sonnet convention split (`R4-DATA-QUALITY-PROPOSAL.md` §0) into τ.
* **Choosing V** can be fixed before any labels exist and is the same procedure for every model. Its recall cost must
  then be tested on the evaluation set as an outcome (criterion 2 unchanged), not assumed.
* **Either way:**
  * τ is fixed per model and seed on C, by a rule written before C's outputs are seen;
  * τ is applied once on the independent evaluation set V;
  * the five criteria and the recall limit are not relaxed if the thresholded system fails them;
  * the risk-coverage curve is reported descriptively, never used to move τ.
* **A third option** the owner may prefer: no threshold in E2 at all, keeping the hypothesis for after the human
  audit.
