# WildChat-derived data: kept out of the public repository

Owner decision 2026-11-03: keep the derived data out of the public
repository until the legal and privacy questions are cleared
(`LEGAL-AND-PRIVACY-QUESTIONS.md`, A3/A4, C1, D1).

## What moved

99 files (90 MB) that contain WildChat conversation text, or model answers
about those conversations. The set was found by searching every tracked
file for snippets of 409 sampled WildChat user turns (77 hits), widened by
rule to every file of the same kind:

| Files | What they are |
|---|---|
| `research/dtw/data/real/{train,val,test}.jsonl`, `*.spans.jsonl.gz` | the frozen realistic split (inputs + Claude labels) |
| `research/dtw/label/data/*.jsonl` | labelling pools, natural-300, synthetic rewrites |
| `research/dtw/results/details/*-{val,test-real,natural}*.jsonl` | per-example answers of earlier evaluations |
| `research/dtw/results/calibration/details/…` (same sets) | calibration runs |
| `release/memory-model/results/details/release-s1-{val,test-real}.jsonl` | the release candidate's per-example answers (frozen; checksums unchanged) |

Still public (no conversation text): `SPLIT.json` (hashes, counts),
`split.jsonl` (example ids and source conversation ids only), every summary
result (`*.json` with metrics), Benchmark-520 (written for Codeply, not
WildChat) and its details, the audit outputs (counts and ids only), all code
and documents. An exhaustive check found no WildChat user turn quoted in any
remaining tracked document or script.

## Where it is

* Private Kaggle dataset **`awaissididique/codeply-memory-derived-data`**
  (anonymous access refused: HTTP 403). The seed-3 notebook attaches it.
* `PRIVATE-DATA-MANIFEST.json` (public): path, size and SHA-256 of every
  file, nothing else.
* Restore to the original paths and verify (every script then works as
  before): `release/memory-model/fetch-private-data.sh` (Kaggle credentials
  of an account the owner gave access), or `PRIVATE_DATA_DIR=<dir>` for a
  copy already on disk. Round trip tested from Kaggle into a clean tree:
  99 / 99 verified.
* `.gitignore` blocks the same paths, so the files cannot be re-added by
  accident; new per-example details on val, test-real or natural are
  ignored too and belong in a new version of the private dataset.

## What this does NOT do

The files were removed from the **current tip** of the six branches that
had them (`codeply-memory-model`, `codeply-memory-model-integration`,
`codeply-brain-value-match`, `codeply-li-dtw-experiment`,
`codeply-memarch-research`, `research/paste-architecture`; not on `main`).
**Their history still contains them, and the repository is public**
(GitHub API answers anonymous requests for it), so anyone can still read
older commits. Two owner actions close that; neither has been done:

1. **Make the repository private** (GitHub → Settings → General → Danger
   Zone → Change visibility). Immediate, reversible, no history change.
   Recommended now.
2. **Purge the files from history** (rewrite all six branches with
   `git filter-repo`, force-push, ask GitHub support to drop cached views;
   forks and existing clones keep their copies). Destructive; only with
   explicit approval, and only if the repository must stay public.
