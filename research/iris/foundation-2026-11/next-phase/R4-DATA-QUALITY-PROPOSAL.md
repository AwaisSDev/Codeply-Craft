# R4 data-quality proposal: better labels, not more labels (2026-11-20)

Status: **proposal only. No API money is spent**, no data is authored or changed, the test split is not read. It
answers the owner's five questions of 2026-11-20 before any budget request. It replaces the "more shards" framing of
`audit-r4/PROPOSAL-r4.md` §3 with a measure-first plan; that document stays on record unchanged. **M** = measured (with
its source), **H** = hypothesis, **E** = estimate.

## 0. The uncomfortable fact first: no label has been verified by a human

| Data | Episodes / sessions | Authored and labelled by | Reviewed by | Human-verified |
|---|---|---|---|---|
| `syn01` drills (train) | 60 / 235 | templates (programmatic) | deterministic validator | n/a (template-generated) |
| `tr01-03` (train) | 42 / 210 | Claude Opus (teacher spec) | 40-session blind review by AI annotator agents, adjudicated by one AI reader: agreement F1 0.805, 7 / 40 sessions with a label error | **no** |
| `tr04-06` (train) | 42 / 210 | Claude Sonnet 5.5 (`author_api.py`, validator-gated) | same procedure: F1 0.934 (tr04, 1 / 40), 0.916 (tr05-06, 0 / 40) | **no** |
| `va01` (val) | 12 / 60 | Opus | AI blind review, F1 0.929, ~5 % error sessions | **no** |
| `va02` (val) | 12 / 60 | Sonnet | AI blind review, F1 0.979, 0 / 40 | **no** |
| `te01-02` (test) | 28 | Opus | **never reviewed** (and not read now) | **no** |
| Stage-0 false-memory inspection | 78 r3 false memories | — | one Claude annotator, not blind to the model output | **no** |

Sources: `audit-r4/HANDOFF-r4.md`, `data/review/*-RESULT.json`, `foundation-2026-11/stage0/CHANGES.md` §3.

Consequences:
* Every "agreement" number above is **AI-vs-AI agreement**. A shared blind spot of the model family (a naming
  convention, a storage-threshold habit, a misreading pattern) counts as agreement, not as an error.
* The Sonnet shards' high agreement (0.92-0.98) was measured with **Sonnet-family annotators reviewing
  Sonnet-authored labels**. It may partly measure self-consistency, not correctness.
* **M (new, from the built data):** the two authors label the storage threshold differently. Skip ops per 70-session
  train shard: Opus 32-47, Sonnet 82-88. In val: `va01` (Opus) 23 skips, `va02` (Sonnet) 77. Adds per shard are similar
  (171-205). The models are trained and scored against two different conventions for "not worth storing". This is
  a label-consistency problem, not a coverage problem.

## 1. Which failure types would the new data address?

Evidence on what the false memories are (r3 open loop, 177 false; two exploratory analyses with different methods):

| Failure type | Evidence | Kind of problem | Data intervention |
|---|---|---|---|
| Correct fact, different naming or granularity than the label ("user / father's health" vs the father's name) | ≈ 23 % of false memories (stage 0, 78 sampled); 51 % "right statement, different value / entity" (r4 audit, a coarser bucket) | **annotation convention** (also a metric limit) | written naming and value conventions (spec v2), applied consistently across all shards, **human-ratified** |
| True but not worth storing (boilerplate, transient requests, trivia) | ≈ 19 % (stage 0) | **annotation convention** (the Opus / Sonnet skip-density split above) **and coverage** (few contrastive negatives) | one storage-threshold rule, human-ratified; relabel existing shards to it; contrastive "do not store" negatives |
| Genuine model errors: invented, misread (questions as facts, ignored self-corrections, inverted relations, wrong dates), misattributed to the user | ≈ 45 % (stage 0); 5 % other-speaker attribution (r4 audit) | **coverage / model capacity** | targeted examples (self-corrections, other speakers, questions); only partly a data problem |
| Label errors in the teacher data | 7 / 40 Opus train sessions with an adjudicated error (17.5 %) | **annotation quality** | repair `tr01-03` (and `va01` under a versioned val), human-adjudicated |
| Confident wrong skips of real facts (pilot control) | 13 skips on labelled facts, median p 0.85 (`NEXT-PHASE-ASSESSMENT.md` M3-M4) | either the labels teach inconsistent skipping (H, linked to the skip-density split) or under-training (E1 tests the training side) | consistent storage threshold; E1 first |
| Updating its own memories in closed loop | 50 % of 42 linked updates handled (r4 audit §5.2) | **coverage** | update / correction / confirm chains, incl. updates to facts first stated in other words |
| Retractions | precision 0.11-0.32 | **coverage** | retraction examples with look-alike negatives |
| `conflict` op | 0 gold examples in train and val | **coverage** (an untested contract op) | conflict examples, plus validation examples so it can be measured at all |
| Implied facts missed | recall ≈ 23 % implied vs ≈ 43 % stated (r4 audit) | coverage, but also label inconsistency on what counts as implied | convention first, then examples |
| Skip traps stored (jokes, hypotheticals, injections) | ≈ 4 % | small | none beyond what exists |

**Answer:** both annotation quality and coverage, but **not in equal measure for the stated objective**. Roughly 40 %
of measured false memories (naming 23 % + storage threshold 19 %) trace to **label conventions and consistency**, which
more shards from the same AI authors would reproduce. The coverage items (updates, retractions, conflict) mostly
address recall and closed-loop correctness. The genuine-error share (≈ 45 %) is only partly fixable by data. The
estimates come from one non-blind AI annotator on 78 items, so each share has a wide interval (±10 points or more).

## 2. AI-generated vs independently human-verified labels

Today: **all labels are AI-generated; none is human-verified** (§0). Under this proposal:

| Label set | Generated by | Human role |
|---|---|---|
| Spec v2 conventions (naming, value granularity, storage threshold, conflict) | drafted by AI from the cases in the audit | **written decisions ratified by the owner** (a 2-3 page rule sheet with worked examples); the spec is the reference, not any model's habit |
| Human audit set (§4) | items sampled from existing data and model outputs | **labelled by humans, blind to the teacher label and the model** (two humans on an overlap subset) |
| Repaired `tr01-03` | AI proposes corrections against spec v2 | every **disagreement** between proposer and existing label is **adjudicated by a human**; unchanged items stay AI-labelled and are marked so |
| New coverage shards (if approved after the audit) | AI-authored, validator-gated | a human-reviewed sample per shard (≥ 30 sessions) with an acceptance rule fixed in advance |
| New evaluation sets (calibration shard, val expansion) | AI-authored | **every session human-reviewed** (they are the measuring instrument) |
| Existing `va01-02` | AI | human-reviewed in full only as a **new val version** (`val-v1.1`), so seed-1 numbers remain reproducible on the original |

Every label carries a provenance field (`ai_author`, `ai_reviewed`, `human_verified`, `human_adjudicated`), and every
report states which subset a number comes from.

## 3. How to stop the new data reproducing the same AI annotation errors

1. **Measure the AI's error profile against humans before generating anything** (the audit, §4). Scale AI labelling
   only for categories where AI labels agree with human labels at agreement F1 ≥ 0.90 on the audit set. For the
   others (expected: naming granularity, storage threshold, implied facts), labels come from the ratified rule sheet
   with human adjudication, or the category is left out.
2. **Separate the roles that are now one model family.** Today the authoring model writes the labels, and the same
   family reviews them. Instead:
   * the author writes sessions;
   * labelling is a separate pass blind to the author's intent;
   * the reviewer is a human, or at least a different model family **plus** a human on the disagreements.

   AI-vs-AI agreement is never reported as label quality again.
3. **Deterministic checks a model cannot talk its way past:**
   * the value must be supported by tokens in the quoted evidence (date and number normalisation);
   * no user-attributed fact from another speaker's question;
   * self-corrections in the same message resolve to the corrected value;
   * one skip-density and naming lint per shard against the rule sheet.

   Failures go to a human queue, not back to the model.
4. **Counterfactual consistency probes:** the same fact phrased three ways across sessions must get the same label.
   Inconsistency rates are reported per author.
5. **No training on unaudited categories:** a new shard enters training only after its human-reviewed sample meets
   the pre-registered rule (§5).
6. **The evaluation sets are human-verified in full**, so an AI convention error cannot be both trained in and scored
   as correct.

## 4. Human review of a stratified sample of existing examples: yes, and it should come first

Design (validation and training data only; test is not touched):

| Stratum | Source | Items | What the human answers |
|---|---|---|---|
| False memories (model said X, labels disagree) | seed-1 pilot 4B + r2 outputs on val, by error category | 80 | is X true, supported, memory-worthy; is the label wrong, or the naming different but equivalent |
| Incorrect updates | gold updates the model missed or mis-targeted, plus model updates scored wrong | 40 | right op, right target, right new value |
| Retractions | gold and model retractions, incl. look-alikes | 30 | is this a retraction; of which memory |
| Skip decisions | labelled skips the model stored; labelled facts the model skipped (the pilot's confident wrong skips); **Opus vs Sonnet skips on similar statements** | 60 | store or skip under the rule sheet |
| Correct-looking gold adds (control) | random gold adds, stratified by author | 40 | is the label right (estimates the base error rate) |
| Roman Urdu / Urdu script | across the above | 30 | same questions (needs an Urdu-literate reviewer) |
| **Total** | | **≈ 280** | |

* **Blinding:** the reviewer sees the session and the candidate fact, not which side (teacher or model) proposed it.
* **Agreement:** a second human labels a 25 % overlap subset (≈ 70 items) to measure human-human agreement. That is
  the real ceiling for any model.
* **Precision:** a share near 30 % estimated from 80 items has a 95 % interval of about ±10 points; per-author
  comparisons need about 40 items per side.
* **Effort (E):** about 1-1.5 min per item, so ≈ 5-7 human-hours for one reviewer plus ≈ 1.5 h for the overlap. No API
  cost. Packets can be generated offline from committed files; that is a no-spend step that can be prepared on request.
* **Validation hygiene:** label errors found in `va01-02` are fixed only in a new version (`val-v1.1`). All later
  results are reported on both versions. The audit's purpose is measurement of label noise, never re-scoring a
  candidate to make it pass.

**What the audit decides:** per category, (a) the human-measured label error rate; (b) the AI-vs-human agreement;
(c) how much of each false-memory category is a label problem vs a model problem. That settles §1's split with
human evidence instead of AI estimates.

## 5. Cost, size and expected benefit (for a later budget request; nothing approved or spent)

| Phase | Content | API cost (E) | Human time (E) | Gate to the next phase |
|---|---|---|---|---|
| A. Human audit | §4, ≈ 280 items + overlap; rule-sheet ratification | $0 | 7-9 h | done when per-category error and AI-human agreement are measured |
| B. Convention repair | relabel the storage threshold and naming in `tr01-06` to the rule sheet (AI proposals, human adjudication of every disagreement; est. 10-20 % of 840 sessions touched) | ≈ $10-15 | 4-8 h adjudication | lint and consistency probes pass; a re-audit sample of 40 shows ≥ 0.90 human agreement |
| C. Evaluation sets | calibration shard (≈ 24 episodes) + `va03-04` (28 episodes), AI-authored, **every session human-reviewed** | ≈ $17-20 | ≈ 10-14 h | each set ≥ 0.90 human agreement after adjudication |
| D. Coverage shards (only where A shows AI labels are reliable) | updates / corrections, retractions, conflict, other speakers; ≈ 4 × 14 episodes | ≈ $17-20 | ≈ 4 h (30-session sample per shard) | sample rule met |
| **Total if all phases run** | train ≈ 840 → ≈ 1,120 teacher sessions; val 24 → 52 episodes; + 24 calibration episodes | **≈ $45-55** (about the same money as `PROPOSAL-r4`, spent on different things) | **≈ 25-35 h** | |

**Expected benefit (H; to be measured, not promised):**
* **Measurement:** human-verified validation removes the AI-convention bias from the scorer, and a 52-episode val cuts
  the minimum detectable Δ false memories / 100 from ≈ 52 to ≈ 36 (`calibration_power.json`; see §6 for why this is
  still not enough on its own).
* **False memories:** if the ≈ 40 % convention-driven share is real, consistent conventions could remove part of it
  (training stops learning two thresholds; scoring stops penalising equivalent naming). A plausible but unproven
  range is a 10-25 % reduction in measured false memories at equal recall. The genuine-error share is not addressed
  by labels.
* **What it does not buy:** capacity. The 4B-vs-1.7B question and the threshold question remain E2's.

## 6. Sequencing and what is asked now

* **Now, no spend:** nothing. The owner decides whether to run Phase A (human time only) and whether to ratify a rule
  sheet. If approved, the sampling script and review packets are prepared from committed files.
* **Later, after Phase A:** a budget request for B-D with the audit's measured numbers, not estimates.
* Interaction with E2 (detail in the post-E1 decision report): the independent evaluation and calibration sets of
  Phase C are what E2 needs. A realistic false-memory effect (≈ 20-30 per 100 sessions) needs far more than 52
  episodes once seed variance is included, so the evaluation design, not only the label quality, limits what E2 can
  show.
