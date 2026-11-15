# The user's brief for Iris 1.7B r4 (verbatim, 2026-11-15)

We need to move Iris forward. I want our next milestone to be a significantly better fine-tuned Qwen3-1.7B, not a larger model.
Before training anything, perform a thorough audit of the existing Iris experiments and resolve the dataset discrepancy.

## Phase 1: Audit

1. Inspect the exact datasets, manifests, splits, training configs, checkpoints and evaluation outputs used by r2 and r3.
2. Resolve why one report shows 42 train / 12 validation / 28 test episodes, while another shows 144 train / 24 validation / 0 test.
3. Identify which dataset and checkpoint versions produced the reported results.
4. Verify there is no train/validation/test leakage, including shared entities, templates or generated examples.
5. Do not modify existing datasets, checkpoints or experiment results.

## Phase 2: Diagnose

Analyze why Iris 1.7B r3 achieved approximately 0.420 open-loop F1 but only 0.333 closed-loop F1.
Break down errors by:

* Operation type: add, update, confirm, retract, conflict and skip.
* False memories and missed memories.
* Contradictions and changing facts.
* Ambiguous statements, jokes, hypotheticals and hearsay.
* Unrelated conversations and topic boundaries.
* English, Roman Urdu and Urdu.
* Screen-derived context.

Identify the highest-impact causes of failure. Do not assume that simply adding more data will solve them.

## Phase 3: Design the next training run

Design Iris 1.7B r4.
Priorities:

* Better precision and fewer false memories.
* Better closed-loop performance.
* Stronger handling of updates and contradictions.
* Better skip decisions.
* More realistic multi-session conversations.
* Better multilingual performance.

Investigate data balancing, hard-negative examples, curriculum design and training hyperparameters. Keep the existing six-operation `iris.ops/1` contract and deterministic evidence validation.
Compare a fresh fine-tuning run against r2 and r3. Do not blindly continue r3 if its validation loss indicates overfitting.

## Phase 4: Evaluation

* Preserve a genuinely untouched test set.
* Use multiple training seeds.
* Report precision, recall, F1, wrong-fact share and update accuracy.
* Evaluate both open-loop and closed-loop.
* Include confidence intervals and per-operation breakdowns.
* Compare against rules, untrained Qwen3-1.7B and existing checkpoints.

## Important constraints

* Do not touch production Codeply.
* Do not mix Iris with PASTE or Pollen.
* Do not modify the PASTE research branch.
* Do not train on test data or tune against test results.
* Preserve all existing artifacts and reproducibility.
* Do not start training until the audit and r4 proposal are complete.

Deliverable: A concise audit report, the exact cause of the dataset discrepancy, a proposed r4 dataset and training configuration, expected compute requirements, and a clear experiment plan.
I want you to make evidence-based decisions, not just launch another training run. Once the plan is ready, present it for review before executing anything.

---

## Status against this brief (updated 2026-11-15)

| Item | Status |
|---|---|
| P1.1 inspect datasets, manifests, configs, checkpoints, outputs of r2/r3 | done: `lineage_leakage.json`, `results/gpu-r2/`, HANDOFF-r4.md |
| P1.2 resolve 42/12/28 vs 144/24/0 | done: different counting scopes (teacher-authored Opus only vs full build; test excluded from the Kaggle bundle on purpose); train/val sha256 identical |
| P1.3 which versions produced the results | done: Kaggle kernel v2, dataset `codeply-iris-src` v2, repo commit `380b8a1c` + data `c8193777`, adapters `best/`, sha256 in `ADAPTERS.sha256` |
| P1.4 leakage | done: no duplicates or near-duplicates; found shared invented names (Ledgerline, Project Kestrel) and reused templates that the build check missed |
| P1.5 nothing modified | held: all audit files are new |
| P2 by operation | done for add / update / confirm / retract / skip. **conflict: no gold examples in train or val (2 in test), so not measurable** |
| P2 false and missed memories, contradictions | done (`diagnosis.json`, `diagnosis_extra.json`) |
| P2 jokes / hypotheticals / hearsay | done: skip traps are about 5% of false memories |
| P2 unrelated conversations and topic boundaries | done: the model rarely acts on another conversation's memories (3 of 76 ref-ops for 1.7B r3, 0 for r2); look-alike first-name confusion is about 3% of predictions; see `topic_boundary` in `diagnosis_extra.json` |
| P2 English / Roman Urdu / Urdu | done, but slices are tiny (Urdu 10 sessions): not rankable |
| P2 screen-derived context | done, tiny (10 sessions, 13 gold facts) |
| P3 r4 design | **draft only** (HANDOFF-r4.md); written proposal not yet delivered or reviewed |
| P4 evaluation plan | **draft only** (multi-seed, CIs, per-operation, baselines incl. untrained 1.7B not yet run) |
| Deliverable: concise audit report, r4 dataset and config, compute, plan, then user review | **pending** |
