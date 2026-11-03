# Memory model v1: readiness for an opt-in release (2026-11-03)

One page; details are in the linked files. Nothing is merged into main,
hosted publicly or changed in production.

## The candidate (frozen)

`codeply-memory-lfm3-s1-Q4_K_M.gguf`, 1,099,627,456 bytes, SHA-256
`7360aaed7410cac445d9901f8a85b876bee6b76d1cb83b05404480b5b9ac14f9`, private
Kaggle dataset `awaissididique/codeply-memory-model-gguf` (`s1.tar`). The
checksum and the 13 evaluation files are pinned in
`results/FROZEN-MANIFEST.json`; `node release/memory-model/verify-frozen.mjs
[--gguf <file>]` checks them.

| | test-real | Benchmark-520 |
|---|---|---|
| F1 (production LFM3) | 0.658 (0.300) | 0.675 (0.575) |
| Precision / recall | 0.792 / 0.563 | 0.733 / 0.624 |
| Integration suite, 48 live cases | 41 / 48 (production 35 / 48) | |

## Checklist

| Requirement | Status | Where |
|---|---|---|
| Model beats production on frozen sets | **Done** | `results/EXPORT-PARITY.md` |
| Production export path validated, no loss vs adapter | **Done** | same |
| Malformed output, secrets, injection handled | **Done** (18 / 18; 5 / 5; 2 / 2) | `integration/` |
| Tiers frozen on val, tested once; 3:1 vs 5:1 trade-off on val | **Done**; owner picks 3:1 (frozen default) or 5:1 (recommended for opt-in) | `TIERS.md` |
| Opt-in only, checksum-enforced install, no app download | **Done** on the integration branch (not merged) | `PRIVATE-OPT-IN.md` |
| Rollback (model switch, tiers off, undo writes) | **Done**, tested | `DEPLOYMENT.md`, `rollback-test.mjs` |
| Counts-only feedback from testers | **Done**, tested | `optin-report.mjs` |
| Licence notices to ship with the file | **Done** (draft wording for counsel) | `notices/` |
| Duplicates gate (0.75) | **Fails** (1 / 4; 2 / 4 with the proposed Brain fix) | `results/BRAIN-DEDUP.md` |
| Brain value-match fix | **Proposed**, tested, needs owner approval | branch `codeply-brain-value-match` |
| Third seed | **Blocked** on free Kaggle GPU quota; daily retry on (14:17 UTC) | `PROGRESS.md` |
| Legal / privacy questions | **Open**: 8 for counsel, 4 owner decisions | `LEGAL-AND-PRIVACY-QUESTIONS.md` |

## What blocks each step

| Step | Blocked by |
|---|---|
| Internal evaluation (staff only) | Owner approval to merge nothing but build the integration branch for staff; suggested legal minimum B1, C3, D1 |
| Named external testers | The above + A1, A2, B2, C1, C2, D2 answered by counsel |
| Public opt-in | Everything in the legal file; duplicates decision (accept the known gap or fix first) |
| Default model | A clean opt-in period (`PRIVATE-OPT-IN.md` bars) |

## Decisions the owner can make now (no counsel needed)

1. Tiers for the opt-in: 3:1 (frozen default) or **5:1 (recommended)**.
2. Merge `codeply-brain-value-match` into the integration branch: yes / no.
3. A4: keep the derived WildChat data public in the repo, or move it.
4. E1: exclude the 17 weak minors-score conversations from any v2 data
   (recommended).
5. Accept the duplicates gate failure as a documented limitation for an
   opt-in phase, or require the fix first.
