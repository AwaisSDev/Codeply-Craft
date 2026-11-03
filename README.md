# dtw-artifacts: moved to private storage

This branch held Codeply's DtW research weights (Ettin encoder backbones as
split GGUF files, classifier heads, configs and training logs; six of the
seven models were trained on WildChat-derived data). Under the research
release policy (`research/RELEASE-POLICY.md` on `codeply-memory-model`:
open research, closed weights) they are no longer published here.

* Private copy: Kaggle dataset `awaissididique/codeply-dtw-artifacts`
  (file names = original path with `/` replaced by `__`), all 69 files
  verified by SHA-256 against this branch's previous tip on 2026-11-03.
* Checksums: `ARTIFACTS.json` in the private research repository.
* The files remain in this branch's git history (no history rewrite; see
  `release/memory-model/PRIVATE-DATA-AUDIT.md` and `HISTORY-PURGE-PLAN.md`).
