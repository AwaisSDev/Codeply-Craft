# PASTE experiments

Every run, including failures, in the order run. "Result file" paths are relative to `research/paste/`; data
artifacts are in the private HF dataset `Awais1290/paste-data`.

| ID | Date | What | Config | Result | Status | Result file |
|---|---|---|---|---|---|---|
| E01 | 2026-11-01 | Encoder latency, HF ModernBERT, CPU fp32, 4 threads | Ettin-17M/32M, 128-960 tokens | 32M: 212 tok 45 ms, 704 tok 169 ms | done | PROGRESS (resume notes) |
| E02 | 2026-11-01 | Phase 3 unit tests T1-T12 + S1 | — | 25/25 pass after 2 test fixes, 1 implementation fix (cache-history dependence) and 1 tolerance clarification | done | results/phase3/test-run.txt |
| E03 | 2026-11-01 | Prototype CPU latency (untrained), 3 units/segment, warm | 32M, K = 8/32/128 | 30 / 40 / 113 ms per segment; peak RSS 482-496 MB | done | results/phase3/bench-cpu-*.json |
| E04 | 2026-11-01 | Head-input scale on a toy episode (D2 evidence) | raw vs parameter-free LayerNorm | Step-0 loss 149 vs 18.6; both reach 0.001 by step 41 with clipping | done | PHASE3-REPORT §3 |
| E05 | 2026-11-01 | Spec v2.1 tests (D1, D2) | — | 27/27 pass | done | results/phase3/test-run-v2.1.txt |
| E06 | 2026-11-02 | Dataset drafts, validation at scale | 1,000 train, 200 val, 300 test, 50 stress (seed 7; drafts, not frozen) | 0 errors V1-V6; leakage L1-L3 = 0 | done | DATASET-AUDIT §1 |
| E07 | 2026-11-02 | API pilot, Opus 5.5, batch | 100 plans, effort medium, max 7,000 tokens, cap $7.80 | 95/100 valid; $1.83 + $0.04 smoke test; 333k in / 116k out tokens | done | HF pilot-2026-11-02/api-opus/collect.json |
| E08 | 2026-11-02 | Programmatic vs API comparison (same plans) | data/compare.py | distinct-2 0.22 vs 0.43. Shortcut probe route 0.97 → 0.60 (majority 0.65); relation 0.91 → 0.44 | done | HF pilot-2026-11-02/compare.json |
| E09 | 2026-11-02 | Merge frequency 60 %, throwaway test draft (seed 99, deleted) | 300 episodes | 108 merges; 0 validation errors | done | DECISIONS |
| E10 | 2026-11-02 | Training speed, CPU, before the fix | PASTE-32M, teacher forced, batch 1 episode, 84 segments | 1,123 ms per segment; backward 87 % of the time | done (superseded) | — |
| E11 | 2026-11-02 | Training speed, CPU, after one-lookup fix | same | **288 ms per segment** (3.48 segments/s); encoder fwd+bwd at 175 tokens (M1c lower bound) 195 ms | done | results/phase3/bench-train-cpu.json |
| E12 | 2026-11-02 | Tests after E11 | — | 27/27 pass (S1 needed the attribute name updated) | done | results/phase3/test-run-phase4.txt |
