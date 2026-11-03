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
| Tiers frozen on val, tested once; 3:1 vs 5:1 trade-off on val | **Done**; owner chose **5:1** for restricted testing (set on the integration branch; live suite 42 / 48) | `TIERS.md` |
| Opt-in only, checksum-enforced install, no app download | **Done** on the integration branch (not merged) | `PRIVATE-OPT-IN.md` |
| Rollback (model switch, tiers off, undo writes) | **Done**, tested | `DEPLOYMENT.md`, `rollback-test.mjs` |
| Counts-only feedback from testers | **Done**, tested | `optin-report.mjs` |
| Licence notices to ship with the file | **Done** (draft wording for counsel) | `notices/` |
| Duplicates gate (0.75) | **Fails** (2 / 4 with the fix); **accepted by the owner for staff-only testing** with monitoring and rollback, not for public release | `results/BRAIN-DEDUP.md`, `PRIVATE-OPT-IN.md` |
| Brain value-match fix | **Merged into the integration branch only** (owner approval), not main | `codeply-memory-model-integration` |
| WildChat-derived data out of the public repo | **Done** at all branch tips (private Kaggle copy, checksums public); **history still public** until the repo is made private or purged | `PRIVATE-DATA.md` |
| v2 data: 17 minors-score examples excluded | **Done** (list + guard) | `ml/data/v2/` |
| Third seed | **Blocked** on free Kaggle GPU quota; daily retry on (14:17 UTC) | `PROGRESS.md` |
| Legal / privacy questions | **Open for counsel** (B1, C3, D1 first); owner decisions A4 and E1 made | `LEGAL-AND-PRIVACY-QUESTIONS.md` |

## What blocks each step

| Step | Blocked by |
|---|---|
| Internal evaluation (staff only) | Owner go-ahead to give staff the file and an integration-branch build (nothing merged); suggested legal minimum B1, C3, D1. Configuration and monitoring ready (`PRIVATE-OPT-IN.md` phase 1) |
| Named external testers | The above + A1, A2, B2, C1, C2, D2 answered by counsel |
| Public opt-in | Everything in the legal file; the duplicates gap fixed or re-decided (accepted for staff only) |
| Default model | A clean opt-in period (`PRIVATE-OPT-IN.md` bars) |

## Owner decisions (2026-11-03)

1. Tiers: **5:1** for restricted opt-in testing. Applied (integration branch).
2. Brain value-match fix: **merged into the integration branch only**. Applied.
3. WildChat-derived data: **out of the public repo** until clearance. Applied
   to every branch tip; history needs the repo made private (recommended,
   owner action) or a purge (destructive, needs explicit approval).
4. 17 minors-score examples: **excluded from v2** until reviewed. Applied.
5. Duplicates gap: **accepted for staff-only testing** with monitoring and
   rollback; not for public release. Plan in `PRIVATE-OPT-IN.md`.

## Still open

* Owner: go-ahead for phase 1 (staff), repository visibility / history.
* Counsel: B1, C3, D1 before staff; A1, A2, B2, C1, C2, D2 before external
  testers.
* Seed 3: free GPU quota (daily retry).
