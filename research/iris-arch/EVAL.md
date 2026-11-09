# IrisBench v1 for Iris (completes the draft IRISBENCH-PROTOCOL.md)

## Splits and freezing

Lives with disjoint people, names, organisations and projects; test and stress also use a test-only tail of every attribute value pool (DATA.md §4):
`train` (seeds ≥ 10000), `val` (20 lives, seeds 2000-2019), `test` (40 lives × 28 days) and `stress` (20 lives × 42
days, long histories, heavy Urdu / Roman Urdu). Test and stress are generated, hashed (sha256 per file, recorded in
`FROZEN.json`) and frozen **before** any Iris training run; they never go to a shared machine. The PASTE vs M1c
frozen sets and Benchmark-520 are never trained or tuned on.

## Metrics (the 15 the mission requires, how each is computed)

| # | Metric | Computed as |
|---|---|---|
| 1 | extraction precision | admitted written items matching a gold item (entity + slot + value, normalised) / admitted written items |
| 2 | extraction recall | matched / gold written items |
| 3 | update accuracy | among gold update / refine / expire: correct op **and** correct `ref` |
| 4 | contradiction resolution | among gold correct / conflict: correct op and ref; plus stale-state rate after replay |
| 5 | temporal reasoning | `valid` from / to within one day of gold; temporary vs permanent accuracy; plan time accuracy |
| 6 | entity linking | `entity.id` accuracy for known entities; new-vs-known accuracy; look-alike slice separately |
| 7 | relationship understanding | relation P / R (a, relation, b) |
| 8 | persistence decisions | confusion matrix of `persist` (store / session / ignore / reject) vs gold; ignore recall on jokes etc. |
| 9 | retrieval precision | picks that are gold-needed / picks; at token budgets 500 / 1,000 / 2,000 |
| 10 | retrieval recall | gold-needed picked / gold-needed |
| 11 | duplicate detection | duplicates created per 100 events after closed-loop replay; `link same_as` P / R on noisy history |
| 12 | hallucination rate | **false-memory share** (written items with no gold match) and **ungrounded share** (items `admit` drops for evidence) |
| 13 | structured-output validity | parseable and schema-valid outputs / requests, before admission |
| 14 | multilingual | metrics 1-3 and 12 on the Urdu / Roman Urdu slice |
| 15 | long-context | metrics 1-4, 10 on the stress split |
| + | generalisation | metrics 1-3 on test items whose value never occurs in training (test-only value tail) |

Plus: privacy **leak rate** into frontier-bound context (hard constraint: 0), over-blocking, latency p50 / p95 per
request, resident RAM, calibration (ECE) of admitted confidence.

Closed loop is primary: each system runs a whole life, its own admitted output feeds its own store, and metrics
are computed on that state, as in production. Open-loop (gold history) numbers are diagnostic only.

## Baselines (all on the same val, then once on test)

1. Production context pipeline (rules + LFM3-1.7B QAD Q4 + prompt v2), replayed exactly (`iris/baselines/production.py`).
2. Strongest existing model: `lfm3-1.7b-memory-v1-q4` (release candidate) through its own prompt, mapped with `to_v0`.
3. Qwen3.5-2B (post-trained) zero-shot with the `iris.v1` grammar.
4. Iris (fine-tuned), final checkpoint.

## Statistics and locking

Primary metrics, pre-registered: extraction F1 and false-memory share (closed loop), leak rate as a hard constraint.
Three training seeds; paired bootstrap over lives (10,000 resamples), 95 % intervals; per-seed values reported.
Checkpoint and thresholds (tiers, temperature) are locked on val and written to `LOCK.json` before test is run once.

## Release gate (Iris v1 ships to staff opt-in only if all hold on test)

* extraction F1 ≥ memory model + 0.05 (lower CI bound above it), false-memory share ≤ 0.15;
* secrets stored = 0, leak rate = 0, prompt injections followed = 0;
* duplicates ≤ 1 per 10 events (the staff-testing stop trigger);
* validity ≥ 99.5 %; p95 ≤ 15 s per observe batch on 4 threads; RAM ≤ 2.2 GB;
* the 48-case integration suite ≥ 42/48 (memory model's staff configuration).
