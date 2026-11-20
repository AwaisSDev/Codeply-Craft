# Matched LoRA pilot, seed 1: results (2026-11-20)

Protocol: EVAL-PLAN amendment A4 and `PILOT-PROPOSAL.md` §3-§6, as approved; nothing changed after results. Validation
only (24 episodes, 120 sessions per loop); the test split was never uploaded or read. **One seed; no model is adopted on
this result.**

## 1. Outcome against the pre-registered criteria (closed loop, vs the retrained Qwen3-1.7B control)

`PILOT-S1-COMPARISON.json`; 95 % paired episode bootstrap, 2,000 resamples, seed 0.

| Criterion | Qwen3-4B-Instruct-2507 | Gemma 4 E2B |
|---|---|---|
| 1. Δ false memories / 100 sessions, upper bound < 0 | +14.2 [−20.0, +53.3]: **not met** | −10.8 [−45.0, +24.2]: **not met** |
| 2. Δ recall, lower bound ≥ −0.03 | +0.173 [+0.119, +0.233]: met | +0.109 [+0.060, +0.155]: met |
| 3. Δ equal-volume precision, lower bound > 0 | +0.207 [+0.104, +0.282]: met | +0.161 [+0.088, +0.233]: met |
| 4. Δ end-state F1, lower bound > −0.02 | +0.163 [+0.101, +0.228]: met | +0.119 [+0.057, +0.174]: met |
| 5. Point estimates beyond hardware noise (Δ false < −5 and Δ precision > 0.05) | false memories +14.2: **not met** | met |
| **Beats the control** | **no** | **no** |

**Neither candidate meets all five criteria.** Under the protocol, seeds 2-3 are not triggered and nothing is adopted.

Equal-volume detail: the control stored 217 content ops, Qwen3-4B 307, Gemma 245. At V = 217 (the control's volume), the
precision of each system's 217 most confident ops is 0.429 (4B), 0.383 (Gemma), 0.221 (control). No op lacked a
confidence score (0 % unscored for all three); no volume shortfall.

## 2. All systems (seed 1, Q4_K_M, Kaggle T4, `--system iris`, constrained)

### Closed loop

| System | Content ops | Strict P | R | **F1** | False / 100 sessions | P@60 | F0.5 | **End-state F1** | End-state false share | Valid output | Cap hit |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Qwen3-4B-Instruct-2507 | 307 | **0.365** | **0.303** | **0.331** | 155.0 | **0.450** | **0.350** | **0.297** | **0.627** | 0.90 | 1 / 120 |
| Gemma 4 E2B | 245 | 0.359 | 0.239 | 0.287 | 130.0 | 0.383 | 0.326 | 0.253 | 0.634 | 0.73 | 15 / 120 |
| Qwen3-1.7B (control) | 217 | 0.221 | 0.130 | 0.164 | 140.8 | 0.283 | 0.194 | 0.134 | 0.763 | 0.91 | 6 / 120 |

### Open loop

| System | Strict P | R | F1 | False / 100 | P@60 | F0.5 | Update right op + target | Skip traps stored | Skip recall |
|---|---|---|---|---|---|---|---|---|---|
| Qwen3-4B-Instruct-2507 | **0.447** | **0.365** | **0.402** | 130.8 | **0.617** | **0.428** | **0.56** | 2 / 100 | **0.73** |
| Gemma 4 E2B | 0.440 | 0.284 | 0.345 | 104.2 | 0.500 | 0.396 | 0.40 | 5 / 100 | 0.40 |
| Qwen3-1.7B (control) | 0.362 | 0.245 | 0.292 | 124.2 | 0.483 | 0.331 | 0.30 | 2 / 100 | 0.47 |

Closed-loop operations for Qwen3-4B: updates right op + target 14 / 21, retractions found 4 / 8 (precision 0.40),
skip traps stored **0 / 100** (zero-shot: 31 / 100). Languages (closed F1, small slices, descriptive): 4B en 0.30,
Roman Urdu 0.33, Urdu script 0.35, mixed 0.54; Gemma 0.26 / 0.32 / 0.31 / 0.34; control 0.16 / 0.18 / 0.15 / 0.15.

## 3. Reading

* **Qwen3-4B is the strongest system on every quality measure**: precision, recall, F1, end-state, equal-volume
  precision (+0.21 over the control at the same storage volume), update and retraction handling, skip decisions.
  Fine-tuning removed the zero-shot problems that §1 of the proposal expected it to (skip traps 31 → 0 stored).
* **It did not reduce the absolute number of false memories**, the goal the owner set. It stores about 40 % more than
  the control (307 vs 217 ops), so a higher share of correct memories still leaves about as many false ones (155 vs 141
  per 100 sessions; the interval includes zero). This is the same pattern as 0.6B → 1.7B (REPORT §1): more capacity
  finds more true facts and also stores more noise.
* **Gemma 4 E2B** sits between them, with the lowest false-memory count (130) but an interval that crosses zero, valid
  output 73 %, 12.5 % of closed-loop sessions at the 900-token cap, and the slowest serving time in this run.
* **Guard rules R1-R4 (secondary, `PILOT-S1-GUARD-RULES-SECONDARY.json`)** change closed-loop false memories by at most
  6 per 100 sessions for any model (4B 155.0 → 152.5, Gemma 130.0 → 124.2, control 140.8 → 137.5) and do not change the
  comparison.

## 4. Limitations

* **One seed.** Training-seed variance is unknown; the bootstrap covers episodes only.
* **The retrained control is weaker than the historical 1.7B runs** (closed F1 0.164 here vs 0.311 / 0.333 for r2 / r3).
  Those runs differ in backend (HF fp16, unconstrained), data (drills included) and epochs (3), so they are not
  comparable, but the gap is large and not explained here. The candidate-vs-control comparison is matched, so it stays
  valid; the absolute level of all three systems may be held down by something in the shared recipe (Q4 export,
  constrained decoding, drill removal, two epochs). Not investigated in this run.
* Validation only; labels have the known noise (Opus shards) and naming conventions that penalise correct paraphrases
  for every model equally.
* Serving times on the T4 (p50 per closed-loop session: 1.7B 2.1 s, 4B 6.1 s, Gemma 10.8 s) are planning figures; the
  CPU latency of record is in EVAL-PLAN A1.

## 5. Compute

Kaggle GPU today: P0 smoke 16 min, P1 training 85 min (4B 79 min; 1.7B 39 min, then Gemma 43 min), P3 evaluation 61 min:
about 2.7 session-hours. P2 export ran on a CPU kernel (26 min, no GPU quota). All runs: 826 identical training
examples (ids sha256 `29ab65a9…`), 208 steps, no out-of-memory or non-finite skips; best checkpoint = last (validation
loss still falling).

## 6. What the protocol allows next

The pre-registered rule says: report as is, no extra arms, no adoption. Any next step is a new experiment that needs its
own pre-registration before it runs, for example: (a) seeds 2-3 anyway to measure seed variance; (b) a precision-oriented
operating point for Qwen3-4B (store only ops above a confidence threshold fixed on training data), tested with the same
five criteria; (c) diagnosing why the retrained control is weaker than r2 / r3; (d) the r4 data work. None of these is
started.
