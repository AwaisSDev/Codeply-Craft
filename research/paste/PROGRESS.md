# PASTE progress

Branch `research/paste-architecture`, base `672696c0` (`codeply-memarch-research`).

## Current phase

Phase 1, repository inspection: **done**. Waiting for the owner's answers
before Phase 2 (literature review and specification).

## Completed

* 2026-11-01: inspected `main`, `codeply-local-intelligence`,
  `codeply-li-architecture-research`, `codeply-li-dtw-experiment`,
  `codeply-memarch-research`, `dtw-artifacts` and
  `claude/wonderful-feynman-y2ldw2`.
* Wrote `REPOSITORY-CONTEXT.md`: what PASTE reuses, what it avoids, and why.

## Running jobs

None.

## Latest metrics

None yet. Nothing has been trained.

## Blockers / owner decisions pending

See `REPOSITORY-CONTEXT.md` §6:

* Track B scope (synthetic/licence-clean sequential data only).
* Budget for LLM-written data.
* Kaggle quota.
* Public visibility of data and checkpoints.

## Next actions

1. `LITERATURE-REVIEW.md` and `ARCHITECTURE-HYPOTHESES.md`.
2. `ARCHITECTURE-SPEC.md` (v2, ~35-40M on Ettin-32M).
3. Set up the CPU environment (PyTorch CPU); verify the Kaggle credentials.

## Decision log

| Date | Decision | Reversible | Why |
|---|---|---|---|
| 2026-11-01 | Base on `codeply-memarch-research` @ `672696c0` | yes | Holds the PASTE v1 spec, critique, harness and Brain code; DTW frozen data is identical to the DTW tip |
| 2026-11-01 | All PASTE files under `research/paste/`; checkpoints on a new orphan branch `paste-artifacts` | yes | Isolation from DTW and production |
| 2026-11-01 | No WildChat-derived rows for training, selection or evaluation | yes (if the audit clears it) | Licence, privacy and moderation unresolved |
| 2026-11-01 | Pretrained Ettin-32M backbone (MIT); no scratch training | yes | ~5K-50K examples cannot teach language |
