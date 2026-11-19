# Wave A results: zero-shot screen on Kaggle T4 (2026-11-19)

Validation only (24 episodes, 120 observe sessions per loop); test untouched; nothing trained. All systems ran in one
Kaggle session (`codeply-iris-wave-a-run` v1, 2 x T4, 61 min, both GPU queues exit 0) with the settings of
EVAL-PLAN §4 and amendments A1-A2: prompt v1.1, each model's own chat template, thinking off, greedy, JSON-Schema
constrained, 900-token cap, llama.cpp 7a4117e CUDA, Q4 GGUFs (sha256-verified). Code and data are identical to this
branch (dataset commit `4d615e1`, no diff in `codeply_iris`, `report_run.py`, the val data). Generated with
`summarize_wave_a.py` → `WAVE-A-RESULTS.json`; per-system details in `results/foundation-2026-11/<system>/`.

**Zero-shot scores are low for every model, as expected. This screen ranks aptitude; it does not choose the
fine-tuning foundation (EVAL-PLAN §1).**

## 1. Closed loop (primary setting)

| System | Content ops stored | Strict P | R | F1 | **False memories / 100 sessions** | **P@60** | **F0.5** | Validity | Cap hit (900) | End-state F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| Qwen3-4B-Instruct-2507 | 263 | 0.232 | 0.164 | **0.192** | 150.8 | **0.350** | **0.214** | 0.78 | 1 % | 0.134 |
| Gemma 4 E2B | 133 | 0.173 | 0.062 | 0.091 | 85.0 | 0.183 | 0.127 | 0.48 | 7 % | 0.067 |
| Qwen3.5-2B | 80 | 0.075 | 0.016 | 0.026 | 59.2 | 0.100 | 0.043 | 0.08 | **28 %** | 0.025 |
| Qwen3-0.6B (baseline) | 48 | 0.104 | 0.013 | 0.024 | 31.7 | under-covering | 0.044 | 0.84 | 3 % | 0.034 |
| Qwen3-1.7B (baseline) | 14 | 0.000 | 0.000 | 0.000 | 11.7 | under-covering | 0.000 | 0.97 | 1 % | 0.000 |

## 2. Open loop

| System | Content ops | Strict P | R | F1 | False / 100 | P@60 | F0.5 | Validity | Ungrounded quotes |
|---|---|---|---|---|---|---|---|---|---|
| Qwen3-4B-Instruct-2507 | 243 | **0.383** | **0.259** | **0.309** | 114.2 | **0.417** | **0.349** | **0.87** | **4 %** |
| Gemma 4 E2B | 145 | 0.241 | 0.097 | 0.139 | 89.2 | 0.317 | 0.186 | 0.58 | 22 % |
| Qwen3.5-2B | 73 | 0.260 | 0.053 | 0.088 | 43.3 | 0.300 | 0.146 | 0.14 | 9 % |
| Qwen3-1.7B, prompt v1.1 | 109 | 0.248 | 0.075 | 0.115 | 61.7 | 0.283 | 0.170 | 0.85 | 21 % |
| Qwen3-1.7B, prompt v1 | 107 | 0.206 | 0.061 | 0.094 | 60.8 | 0.217 | 0.140 | 0.91 | 23 % |
| Qwen3-0.6B, prompt v1.1 | 45 | 0.133 | 0.017 | 0.030 | 30.0 | under-covering | 0.056 | 0.82 | 72 % |
| Qwen3-0.6B, prompt v1 | 37 | 0.189 | 0.019 | 0.035 | 20.8 | under-covering | 0.069 | 0.80 | 77 % |

No system emitted reasoning text (think leaks 0 everywhere).

## 3. The pre-registered selection rule

Rule (EVAL-PLAN §7): a foundation qualifies for the LoRA pilot when, against zero-shot Qwen3-1.7B in closed loop, the
95 % interval of Δ false memories / 100 sessions is ≤ 0 **and** Δ P@60 or Δ F0.5 is > 0.

| Candidate | Δ false / 100 (95 % CI) | Δ F0.5 (95 % CI) | Qualifies |
|---|---|---|---|
| Qwen3-4B-2507 | [+117.5, +161.7] | [+0.156, +0.277] | no |
| Gemma 4 E2B | [+51.7, +92.5] | [+0.052, +0.219] | no |
| Qwen3.5-2B | [+23.3, +75.0] | [0.000, +0.113] | no |
| Qwen3-0.6B | [+0.8, +36.7] | [+0.009, +0.082] | no |

(Δ P@60 cannot be computed: the baseline stores too little in closed loop.)

**Nothing qualifies, and the reason is the baseline, not the candidates.** Zero-shot Qwen3-1.7B answers `{"ops":[]}`
in 113 of 120 closed-loop sessions (when its own memory list is empty or short), against 58 of 120 in open loop, so it
makes almost no false memories by storing almost nothing. A rule that requires fewer false memories than a near-silent
baseline cannot be met by any model that stores anything. Per EVAL-PLAN §7 this is reported as is; the rule is not
changed after the fact. The decision passes to the owner (§5 below).

## 4. What the screen does show (descriptive)

* **Qwen3-4B-Instruct-2507 is the clear zero-shot leader** on every measure of telling facts from noise when it does
  store: P@60 0.35 closed / 0.42 open (the next best is 0.18 / 0.32), F0.5 0.21 / 0.35, valid output 78-87 %, 96 % of
  quotes exact. It stores the most, so its absolute false-memory count is also the highest; ranking by its own token
  confidence (P@60) is what separates it.
* **Gemma 4 E2B is second**: P@60 0.18 / 0.32, but weaker format compliance (valid 48-58 %) and 20-22 % ungrounded
  quotes. Its Urdu-script F1 (closed 0.07) is not better than the others on this tiny slice (2 episodes).
* **Qwen3.5-2B is the weakest candidate**, contrary to its provisional first place in REPORT.md: it runs away (28 % of
  closed-loop sessions hit the 900-token cap with ever smaller facts), valid output 8-14 %, closed F1 0.03, end-state
  false share 0.94. Under this prompt and cap it over-extracts badly.
* **Prompt v1.1** (one sentence on quoting) helped Qwen3-1.7B a little (open F1 0.094 → 0.115, ungrounded 23 % → 21 %)
  and did not fix Qwen3-0.6B (ungrounded 77 % → 72 %; it still copies the speaker label).
* **Hardware noise floor** (Qwen3-1.7B, open loop, same settings): CPU vs T4 F1 0.108 vs 0.115, false / 100 66.7 vs
  61.7, P@60 0.233 vs 0.283, F0.5 0.153 vs 0.170. Differences between systems smaller than about 0.05 P@60 or 5 false
  memories / 100 sessions are within hardware noise. The 4B-vs-rest gaps are well beyond it.
* **Unconstrained format screen** (30 sessions): no candidate wraps JSON in markdown fences except Qwen3-0.6B (6 of
  45 outputs); native validity 4B 0.50, 1.7B 0.60, Gemma 0.23, Qwen3.5-2B 0.03. Constrained decoding is required for
  every model zero-shot.
* **Cost** (reference CPU, stage 0): Qwen3-4B is about 2x the per-batch latency of Qwen3-1.7B (est. 31.5 s vs 13.8 s
  per fine-tuned batch); Gemma 4 E2B is the fastest (11.8 s).

## 5. Decision for the owner (not taken here)

The pre-registered rule produced no qualifier because of a near-silent baseline. Options:

1. **Recommended:** amend the pilot selection (dated amendment, before any training) to rank by closed-loop P@60 with
   the hardware noise margin, which advances **Qwen3-4B-Instruct-2507** and **Gemma 4 E2B** into the matched LoRA
   pilot alongside the incumbent **Qwen3-1.7B**. Qwen3.5-2B is not advanced.
2. Follow EVAL-PLAN §7 literally: a pilot of Qwen3.5-2B alone, or no pilot. The evidence now argues against Qwen3.5-2B.
3. No pilot: keep Qwen3-1.7B and put the effort into r4 data, the dominant cause of false memories (REPORT §1).

Reminder from REPORT §1: false memories are mostly a data and labelling problem; a foundation change is expected to
help with format compliance, dates, entity values and Urdu script, not to remove false memories by itself.

## 6. Compute

Kaggle GPU sessions today: checks and parity about 0.8-1.0 h (one-time CUDA build 35 min), wave A 1.0 h. About
2 session-hours in total (more if Kaggle bills a 2-GPU session double). Remaining before the 21 November reset:
roughly 10 h. CPU (this container): parity references and the hardware noise run, no quota.
