# E1 control diagnosis: results (2026-11-20). **Incomplete: all Transformers cells failed**

Protocol: `E1-PROTOCOL.md` (pre-registered), preflight `E1-PREFLIGHT.md`. Analysis: `e1/e1_decompose.py` (committed
before any result) → `E1-DECOMPOSITION.json`; `e1/e1_exploratory.py` (written **after** seeing results, labelled
exploratory) → `E1-EXPLORATORY.json`. Outputs: `results/foundation-2026-11/e1/` (+ `_run/`: status, gates, logs,
kernel log). Validation only; the test split was not uploaded or read. **No model is selected or adopted from E1.**

## 1. What ran

GPU kernel `codeply-iris-e1-eval` v1 (2 x T4), 1 h 43 min of kernel time (6,197 s), under the 3.5 h hard stop
(`hard_cap_reached: false`). Environment: torch 2.11.0+cu130 (= historical), transformers 5.23.0, peft 0.21.3,
accelerate 1.16.0, llama.cpp `7a4117e`.

| Check | Result |
|---|---|
| Export status, G0 (adapters, GGUFs, val, llama.cpp commit, 2 x T4, base files at `70d244cc`) | pass |
| G1 template gates TG1 / TG2 (in kernel) | pass / pass |
| **SC1** (score capture) | **failed: crashed before generating** (see §2) |
| **G2** (r2 Transformers reproduction) | **not evaluated: cell 1 crashed** (not a drift result) → protocol action: all Transformers cells stopped |
| G3 (pilot Q4-C reproduction, report only) | pass: open F1 0.2924 = the committed seed-1 value exactly |

| Cell | Status | Cell | Status |
|---|---|---|---|
| 1 r2 T open | **failed (crash, 0.3 min)** | 10 p Q4-C open | ok |
| 6 p T open | **not run** (G2 stop) | 2-5 r2 F16-U / F16-C / Q4-U / Q4-C open | ok |
| 11 r3 T open | **not run** | 7-9 p F16-U / F16-C / Q4-U open | ok |
| 13 r2 T closed | **not run** | 12 r3 Q4-C open | ok |
| 15 p T closed | **not run** | 14 r2 Q4-C closed, 16 p Q4-C closed | ok |
| | | X1, X2 (exploratory) | ok |

## 2. Failure: all Transformers cells (reported, not re-run)

`peft` 0.21.3 refused to build LoRA layers: *"Found an incompatible version of torchao. Found version 0.10.0, but only
versions above 0.16.0 are supported"* (`_run/logs/r2-T-open.log`, `_run/e1-status.json` SC1). The Kaggle image ships
torchao 0.10.0. The historical r2 / r3 kernel (`scripts/kaggle/run.py`) uninstalled torchao before loading peft for
exactly this reason; the E1 kernel did not.

**This is a preflight miss on my side.** Package versions were checked, but this environment step of the historical
setup was not carried over, and the CPU smoke test ran in a clean venv without torchao.

Per protocol §6 (E), the crashed cells are reported and **not re-run** without approval. No Transformers generation
happened, so nothing was measured with them. A re-run would need one setup change: `pip uninstall torchao`, the
historical kernel's own step. It needs the owner's approval (decision report §6).

## 3. Results of the completed cells (open loop unless stated; strict metrics)

| Cell | P | R | **F1** | False / 100 | P@60 | F0.5 | Valid | Content ops | No-store sessions | Skips on labelled facts |
|---|---|---|---|---|---|---|---|---|---|---|
| r2 F16-U | 0.428 | 0.370 | **0.397** | 139.2 | 0.517 | 0.415 | 0.942 | 311 | 24 | 5 |
| r2 F16-C | 0.424 | 0.368 | 0.394 | 140.0 | 0.517 | 0.412 | 0.933 | 311 | 24 | 5 |
| r2 Q4-U | 0.406 | 0.306 | 0.349 | 126.7 | 0.500 | 0.381 | 0.958 | 271 | 25 | 4 |
| r2 Q4-C | 0.397 | 0.301 | 0.342 | 129.2 | 0.550 | 0.373 | 0.883 | 272 | 27 | 3 |
| pilot F16-U | 0.428 | 0.329 | **0.372** | 125.0 | 0.600 | 0.403 | **0.842** | 276 | 34 | 8 |
| pilot F16-C | 0.387 | 0.320 | 0.351 | 142.5 | 0.517 | 0.372 | 0.908 | 297 | 32 | 9 |
| pilot Q4-U | 0.417 | 0.251 | 0.313 | 101.7 | 0.483 | 0.368 | **0.758** | 216 | 47 | 11 |
| pilot Q4-C (= seed 1) | 0.362 | 0.245 | 0.292 | 124.2 | 0.483 | 0.331 | 0.917 | 243 | 45 | 13 |
| r3 Q4-C | 0.356 | 0.326 | 0.340 | 162.5 | 0.450 | 0.349 | 0.867 | 329 | 21 | 3 |
| *Committed historical r2 T (other run)* | 0.433 | 0.379 | 0.404 | 140.0 | N/A | 0.418 | 0.942 | 314 | 24 | 5 |

Closed loop:

| Cell | P | R | F1 | False / 100 | P@60 | End-state F1 | Valid |
|---|---|---|---|---|---|---|---|
| r2 Q4-C | 0.307 | 0.230 | 0.263 | 155.0 | 0.450 | 0.241 | 0.867 |
| pilot Q4-C (= seed 1) | 0.221 | 0.130 | 0.164 | 140.8 | 0.283 | 0.134 | 0.908 |
| *Committed historical r2 T* | 0.348 | 0.282 | 0.311 | 155.8 | N/A | 0.304 | 0.942 |

## 4. Pre-registered decomposition

**Reading: "not computable"** (open and closed). G, S, Tr, the backend components and the stack x adapter interaction
all need the Transformers cells. The measured components (paired episode bootstrap, 2,000 resamples, seed 0;
positive = the first setup scores higher):

| Component (open loop) | Δ F1 | Δ false / 100 | Δ recall | Material |
|---|---|---|---|---|
| Quantisation, pilot (F16-U − Q4-U) | **+0.059 [+0.014, +0.112]** | +23.3 [−1.7, +47.5] | **+0.078 [+0.031, +0.128]** | yes |
| Quantisation, r2 | **+0.048 [+0.015, +0.085]** | +12.5 [−9.2, +34.2] | **+0.064 [+0.031, +0.101]** | yes |
| Constraint at Q4, pilot (Q4-U − Q4-C) | +0.021 [−0.010, +0.053] | **−22.5 [−40.8, −3.3]** | +0.006 [−0.020, +0.032] | yes (false memories) |
| Constraint at F16, pilot | +0.021 [−0.010, +0.051] | **−17.5 [−31.7, −4.2]** | +0.008 [−0.018, +0.037] | yes (false memories) |
| Constraint at Q4, r2 | +0.007 [−0.017, +0.031] | −2.5 [−10.8, +6.7] | +0.006 [−0.017, +0.028] | no |
| Constraint at F16, r2 | +0.003 [−0.017, +0.022] | −0.8 [−11.7, +8.3] | +0.003 [−0.016, +0.020] | no |

Reading the constraint row: for the pilot, decoding under the JSON Schema produces **more** false memories (17-23 per
100 sessions), not fewer. This is largely mechanical. Unconstrained pilot outputs are invalid in 16-24 % of sessions
(valid 0.84 F16, 0.76 Q4), and an invalid output stores nothing. The grammar recovers those sessions, along with their
false ops. r2's outputs are valid either way, so the grammar changes nothing for r2.

## 5. Exploratory (after results; not pre-registered; `E1-EXPLORATORY.json`)

F16-U stands in for the missing Transformers anchor; "cross-run" rows compare with the committed historical
Transformers results (another run and date). These do not replace §4.

| Quantity | Δ F1 | Δ false / 100 | Δ recall |
|---|---|---|---|
| Cross-run: historical r2 T − E1 r2 F16-U | +0.007 [−0.001, +0.017] | +0.8 [−2.5, +5.0] | +0.008 [0.000, +0.018] |
| G′ = r2 F16-U − pilot Q4-C (open) | +0.105 [+0.044, +0.167] | +15.0 [−14.2, +42.5] | +0.125 [+0.063, +0.185] |
| Pilot stack F16-U → Q4-C (share of G′) | +0.079 [+0.034, +0.129] (**0.76 [0.43, 1.25]**) | +0.8 [−25.8, +26.7] | +0.084 [+0.034, +0.138] |
| Recipe at F16-U (r2 − pilot) | +0.025 [−0.016, +0.067] | +14.2 [−3.3, +31.7] | +0.042 [−0.006, +0.085] |
| Recipe at Q4-C, open | +0.050 [+0.005, +0.098] | +5.0 [−21.7, +31.7] | +0.056 [+0.006, +0.107] |
| **Recipe at Q4-C, closed** | **+0.100 [+0.052, +0.153]** | +14.2 [−6.7, +35.0] | **+0.101 [+0.058, +0.150]** |
| Quantisation difference-in-differences (r2 − pilot) | −0.011 [−0.071, +0.043] | −10.8 [−39.2, +18.3] | −0.014 [−0.073, +0.042] |
| Cross-run: historical r2 T − E1 r2 Q4-C, closed | +0.048 [+0.009, +0.083] | +0.8 [−15.8, +16.7] | +0.052 [+0.014, +0.086] |

Exploratory format swaps (adapter evaluated in a format it was not trained on; Q4-C, open):

| Cell | F1 |
|---|---|
| X1: pilot without the think block | 0.254 (its own format: 0.292) |
| X2: r2 with the think block | 0.344 (its own format: 0.342) |

## 6. Deviations from the protocol (complete list)

1. All Transformers cells failed (§2): SC1 crashed, G2 not evaluated, cells 1 / 6 / 11 / 13 / 15 produced no output.
   Not re-run.
2. The pre-registered decomposition is not computable. An exploratory substitute is reported separately (§5).
3. Preflight items already recorded in `E1-PREFLIGHT.md`:
   * the revision wording;
   * hard-stop kills;
   * SC1 run on r2 only;
   * export v1 infrastructure failure;
   * the pilot Q4 re-export metadata-only hash difference.
