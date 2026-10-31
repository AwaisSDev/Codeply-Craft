# Architecture research (2026-10-31)

Can a 1–2B local model understand, filter and update a user's context more
reliably than today's small general-purpose models, and stay fast on a CPU?

Read in this order:

1. `FINAL-RECOMMENDATION.md`: the answer, the recommended architecture
   (Decide-then-Write), what to build first and what not to build.
2. `ARCHITECTURE-RESEARCH.md`: the evidence (our measurements, papers,
   model cards, costs).
3. `PROPOSED-ARCHITECTURES.md`: three designs, layer by layer, with
   latency and memory estimates.
4. `ARCHITECTURE-COMPARISON.md`: LFM3 vs alternative backbones vs the
   designs.
5. `EXPERIMENT-ROADMAP.md`: experiments, datasets, costs, release gate v2.

`analysis/` holds the scripts and raw results behind every number marked
[M]: `RESULTS.md` summarises them.

Research only: nothing in the production pipeline (`codeply-cli/lib`,
`ml/`) was changed on this branch.
