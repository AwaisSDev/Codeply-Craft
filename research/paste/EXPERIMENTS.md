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
| E13 | 2026-11-02 | Freeze test/stress v1 (plans + programmatic wording) | seeds 20261102 / 20261103; 600 + 200 episodes | 0 validation errors; test has 5,850 gold persistent ops and 172 merges | done | results/FROZEN.json |
| E14 | 2026-11-02 | API wording of frozen test and stress (Opus 5.5, batch, medium) | test: max 6,000 tokens, worst $39.94; stress: max 12,000, worst $27.58; ledger budget $95 (option B) | see E15 | done | results/api-ledger.json |
| E15 | 2026-11-02/03 | Collect frozen API wording + one retry | — | test 583 → 599/600 valid; stress 178 → 194/200; all failures tag-format (no truncation); total API spend $26.77 of $95 | done | results/FROZEN.json v2, results/api-ledger.json |
| E16 | 2026-11-03 | Train (6,000) and val (600) plans + programmatic wording | seeds 20261104 / 20261105; generator fix 46a8c77a | first generation: 2/7,400 V4 errors (forget-profile on a same-segment profile), fixed; regenerated: 0 errors; leakage vs frozen sets 0 | done | HF train-v1/ |
| E17 | 2026-11-03 | Evaluator sanity (oracle, omission recovery, false memories) | tests/test_evaluate.py; val oracle | oracle PE 1.0 on 600 val episodes; lossy oracle loses exactly the skipped writes; FPM counts spurious writes | done | commit af41c298 |
| E18 | 2026-11-03 | Kaggle account check (read only) | `kaggle quota` | authenticated (awaissididique). **GPU: 30.04 h used of 30 h, 0.00 h left, refresh 2026-11-07 00:00 UTC** (used by the DtW runs). TPU 20 h unused | done | — |
| E19 | 2026-11-03 | Val API wording (600 plans) | max 5,000 tokens, no retry | 572/600 valid, $11.34 | done | results/api-ledger.json |
| E20 | 2026-11-03 | Train API wording, budget-bounded chunks (`data/api_chunks.py`) | max 4,500 tokens, 8 chunks | 2,921 plans submitted, **2,824 valid**; stopped when the next chunk could not fit; **total API spend $91.96 of $95** (pilot $1.87 separate). Remaining 176 of plans 0-2,999 use programmatic wording | done | results/api-ledger.json; HF train-v1/api-train |
| E21 | 2026-11-03 | D2 pilot (pre-registered) on CPU | PASTE, M1c × head_norm off/on; train-mix plans 0-999 (900 API + 100 programmatic) + 3,000-3,999 (programmatic); 1 epoch; seed 1; teacher forced; calibration of theta_W on 200 + 200 val episodes | first launch failed (script path bug, HOME=/root; fixed bb4c5181); relaunched | running | ~/paste-runs/d2/ |
