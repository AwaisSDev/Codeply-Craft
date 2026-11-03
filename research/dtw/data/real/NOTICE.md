# Notice: third-party data in this folder

The files here (`train`, `val`, `test`, `split`, `*.spans`) are excerpts of
third-party datasets, de-identified again and relabelled by Claude (Anthropic)
in Codeply's memory schema. Every example records its source in
`source.dataset`, `source.licence`, `source.url`, `source.revision`,
`source.file`, `source.sha256` and `source.original_id`.

They are a derived database of those datasets and keep their terms:

* **WildChat-1M** (Allen Institute for AI): ODC-BY 1.0,
  https://opendatacommons.org/licenses/by/1-0/ — this derived database is
  made available under ODC-BY 1.0. Contains information from WildChat-1M,
  which is made available under the ODC Attribution License. The licence
  covers the database, not the individual contents (users' own text), which
  may carry other rights (ODC-BY §2.4).
* **Topical-Chat** (Amazon): CDLA-Sharing 1.0 — publishing these examples
  (or modified versions) keeps CDLA-Sharing.
* **MultiWOZ 2.2**: MIT, Copyright (c) 2019 Paweł Budzianowski.
* **Roman Urdu Data Set** (UCI 458): CC BY 4.0.

Full attribution: `research/dtw/label/NOTICE.md`. Open licensing and privacy
questions (not resolved, no legal clearance assumed):
`release/memory-model/WILDCHAT-OPEN-ISSUES.md` (branch `codeply-memory-model`).
