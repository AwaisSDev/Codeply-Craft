# Model selection: Codeply's local context model

Status: 2026-10-30. Recommendation in §6. Every number here is measured on
this branch; the raw results are in `ml/results/` and the tables in
`ml/results/RESULTS.md`, `docs/local-intelligence/BENCHMARKS.md`.

## 1. What the model has to do

Read a batch of user-approved events (chat turns, things heard, emails) and
return the extraction contract (`context-schema.js`): observations with
kind, slot, value, certainty and importance, plus plans. It runs in the
background on the user's PC, on the CPU, next to the app. So it must be:

* small enough to sit in RAM beside Electron (≤ ~2 GB resident),
* fast enough for background batches on 3 cores (p95 ≤ 30 s per batch),
* good at *judgement*, not knowledge: is this a lasting preference or a
  joke, the user's words or someone else's, a plan or a fact,
* licensed for a commercial desktop app, including fine-tuning and
  redistributing the fine-tuned weights.

## 2. Architecture: decided by measurement, not by type

The original plan asked for a dense transformer around 1B. That came from
an assumption: dense models are the best-supported, simplest to fine-tune
and run. **The owner's decision (2026-10-30): pick the architecture that
measures best; do not reject a better one because it is not what was
first imagined.** The candidates therefore cover three families:

| Family | Models evaluated | What it means locally |
|---|---|---|
| Dense transformer (GQA) | Qwen3-1.7B, Qwen3-0.6B, Qwen2.5-1.5B, Llama-3.2-1B, Gemma-3-1B | KV cache grows with every token of context; the best-trodden path in llama.cpp and fine-tuning tools |
| Hybrid, linear + full attention | Qwen3.5-0.8B | Most layers keep a fixed-size state; cheap long context |
| Hybrid, short convolution + attention (Liquid) | LFM2.5-1.2B, **LFM3-1.7B** (13 conv + 5 sliding-window + 6 global attention layers, 256K context) | Fixed-size conv state, small KV cache; designed for on-device agents and structured output |

What the hybrid architecture costs in practice, found here:

* **Prompt caching needs care.** Conv and sliding-window state cannot be
  rewound to any point, so out of the box llama.cpp reused only ~45 % of the
  fixed system prompt. One server flag per model fixes it (`--swa-full` for
  LFM3, `-ub 128` for LFM2.5): now 87 %, same as the dense models
  (BENCHMARKS.md).
* **Fine-tuning tooling is newer.** LFM3's modelling code ships in its Hub
  repository (`trust_remote_code`), not yet in a pinned `transformers`
  release. Liquid publishes SFT/DPO/GRPO notebooks with TRL and PEFT, the
  same stack as `ml/finetune/train_lora.py`; `config-lfm3.yaml` has the LoRA
  target modules for its layers. llama.cpp's converter at the pinned commit
  supports LFM3, so `export_gguf.sh` works unchanged. Not yet run on a GPU.
* **Thinking is on by default** in LFM3's chat template. Turned off with
  `enable_thinking: false` (as for Qwen3); with it on, every answer spent
  its whole budget reasoning and never reached the JSON. Liquid notes the
  switch "can be inconsistent" for reasoning-heavy tasks; in 92 + 39
  extraction examples it held every time.

What it buys: at 4K context the KV cache is small for all candidates, so
the hybrid's main advantage, cheap long context, does not show in these
numbers. It matters for the planned consolidation jobs that read long
documents (RUNTIME.md: a dense 1.7B model at 32K needs ~2 GB of KV cache
in q8_0).

## 3. Quality (off the shelf, prompt v1; v2 below)

`test-mini`: 92 generated examples, every task 4 times. `gold`: 39
hand-written examples in natural phrasing, the check for template
overfitting. Full metric definitions: `ml/eval/README.md`.

| Model | F1 mini | F1 unseen | F1 gold | Kind | False mem. | Noise ok | Mem. actions | Plans R | Secrets / injections |
|---|---|---|---|---|---|---|---|---|---|
| **lfm3-1.7b-qad-q4** | **0.83** | **0.92** | **0.73** | 84 % | 42 % | 100 % | 72 % | 0 % | 0 / 0 |
| lfm3-1.7b-q4 | 0.78 | 0.79 | – | 86 % | 58 % | 100 % | 66 % | 50 % | 0 / 0 |
| lfm2.5-1.2b-q4 | 0.73 | 0.58 | – | 69 % | 83 % | 75 % | 38 % | 13 % | 0 / 0 |
| qwen2.5-1.5b-q4 | 0.71 | 0.75 | 0.54 | 42 % | 92 % | 75 % | 47 % | 100 % | 0 / 0 |
| qwen3-1.7b-q4 | 0.64 | 0.73 | – | 71 % | 58 % | 100 % | 63 % | 0 % | 0 / 0 |
| gemma3-1b-q4 | 0.61 | 0.67 | – | 75 % | 92 % | 25 % | 53 % | 75 % | 0 / 0 |
| llama3.2-1b-q4 | 0.54 | 0.57 | – | 50 % | 67 % | 25 % | 53 % | 100 % | 0 / 0 |
| qwen3.5-0.8b-q4 | 0.47 | 0.57 | – | 44 % | 75 % | 50 % | 47 % | 0 % | 0 / 0 |
| qwen3-0.6b-q4 | 0.00 | 0.00 | – | – | – | 100 % | 38 % | 0 % | 0 / 0 |
| rules (no model) | 0.45 (test) | 0.49 | 0.17 | 100 % | 0 % | 100 % | 39 % | 0 % | 0 / 0 |

* **LFM3-1.7B is the best model on every quality measure that matters most**
  (F1, held-out phrasing, gold, memory actions, noise), by a wide margin on
  unseen phrasing and gold.
* **The quantization-aware Q4_0 build (QAD) beats the standard Q4_K_M** of
  the same model (F1 0.83 vs 0.78, false memories 42 % vs 58 %) at a
  slightly smaller file. Liquid trained it to be quantized; use it.
* **Qwen2.5-1.5B is the best Apache-2.0 model** and finds plans, but it
  falls apart on natural phrasing (gold 0.54, 100 % false memories, 40 %
  noise rejected).
* **Qwen3-0.6B cannot do the task untrained**: it returns empty lists with
  or without the JSON Schema, and with no examples in the prompt it invents
  plans from the event headers (`ml/results/*qwen3-0.6b*`). Not a
  candidate unless fine-tuning fixes it, which is a risky bet at this size.
* **Safety holds for every model**: no secret reached memory and no
  injected instruction was followed, because redaction happens before the
  model and the guard (`checkExtraction`) runs after it.
* **Every model fails the release gate untrained** (false memories,
  certainty, memory actions). That is the fine-tune's job.

### Prompt v2

Every model in v1 put meetings in observations instead of plans, split
"back by 5" from the live context, or recorded the event time stamp as a
memory. Prompt v2 (`context-prompt.js`, `PROMPT_VERSION = 2`) adds three
rules for exactly that and one worked example with a date to compute. On
the two models carried forward:

| Model, set | F1 | Kind | Plans R | Temporal | Mem. actions | Noise ok | False mem. |
|---|---|---|---|---|---|---|---|
| lfm3-1.7b-qad-q4, test-mini, v1 → v2 | 0.83 → 0.80 | 84 → 74 % | 0 → 25 % | 0 → 20 % | 72 → 78 % | 100 → 100 % | 42 → 42 % |
| lfm3-1.7b-qad-q4, gold, v1 → v2 | 0.73 → 0.70 | 44 → 50 % | 0 → 33 % | 0 → 33 % | 59 → 59 % | 100 → 100 % | 25 → 25 % |
| qwen2.5-1.5b-q4, test-mini, v1 → v2 | 0.71 → 0.78 | 42 → 33 % | 100 → 100 % | 20 → 40 % | 47 → 41 % | 75 → 25 % | 92 → 100 % |
| qwen2.5-1.5b-q4, gold, v1 → v2 | 0.54 → 0.58 | 50 → 32 % | 100 → 100 % | 0 → 33 % | 47 → 47 % | 40 → 60 % | 100 → 100 % |

**Kept: v2 is the prompt now.** On the recommended model, plans and live
context went from never working to working some of the time (with dates
and times right when found), and the brain's actions improved, for 0.03 F1,
mostly kind labels on person and idea examples (4 examples per task, so
partly noise). Kind labels are what fine-tuning fixes best; a plan the
model never emits cannot be fixed by the brain. The v1 results stay in
`ml/results/` (files without `-p2`). The training data export
(`ml/data/export-sft.mjs`) renders with this builder, so a fine-tune now
learns the v2 rules.

## 4. Speed and memory (4-core Xeon, 4 threads, no GPU)

| Model | Resident MB | Generate tok/s | p50 s / batch | p95 s / batch |
|---|---|---|---|---|
| lfm3-1.7b-qad-q4 | 1889 | 16.4 | 10.9 | 18.0 |
| lfm2.5-1.2b-q4 | 1242 | 24.9 | 7.4 ¹ | 13.7 ¹ |
| qwen2.5-1.5b-q4 | 1797 | 18.7 | 6.6 | 11.9 |
| qwen3-1.7b-q4 | 2006 | 16.5 | 11.2 | 17.6 |
| gemma3-1b-q4 | 938 | 20.2 | 7.7 | 17.1 |

¹ before the prompt-cache fix; about 3 s faster after it.

All fit beside the app and under the 30 s p95 bar. LFM3 is the slowest of
the strong models because it writes longer answers (153 tokens against
90 for Qwen2.5); fine-tuning on compact answers is the main lever.

## 5. Licences

| Model | Licence | Commercial use | Fine-tune and ship weights | Conditions that matter for Codeply |
|---|---|---|---|---|
| LFM3-1.7B, LFM2.5-1.2B | LFM Open License v1.0 (Liquid AI) | **Yes, while the company's annual revenue is under US$10M** | Yes (derivative works allowed) | Above the threshold, commercial use is not licensed: a separate licence from Liquid is needed. Ship the licence text with the weights; mark modified files; keep notices |
| Qwen2.5-1.5B, Qwen3-1.7B / 0.6B, Qwen3.5-0.8B | Apache-2.0 | Yes, no threshold | Yes | Keep the licence and notices |
| Llama-3.2-1B | Llama 3.2 Community License | Yes, under 700M monthly users | Yes | "Built with Llama" attribution, the acceptable-use policy, derived model names start with "Llama" |
| Gemma-3-1B | Gemma Terms of Use | Yes | Yes | Prohibited-use policy must be passed on to users; Google may restrict use it believes breaks the terms |

The LFM licence is Apache-2.0 in its structure, with one addition (§5 of
the licence): the grant for commercial use only holds while "You or Your
Legal Entity" stays under US$10M annual revenue. "Legal Entity" includes
companies that control or are controlled by Codeply. Read the licence text
shipped in the model repository (`LICENSE`) before relying on this summary.

## 6. Recommendation

**Fine-tune LFM3-1.7B** (from `LiquidAI/LFM3-1.7B`,
`ml/finetune/config-lfm3.yaml`). Until a fine-tuned model passes the gate,
the off-the-shelf **lfm3-1.7b-qad-q4** is the best model for `local` mode.

Quantization matters for this model: Liquid's quantization-aware Q4_0
beats the plain Q4_K_M by 5 F1 points. Our LoRA export makes Q4_K_M and
Q8_0 (`export_gguf.sh`); gate both against the QAD baseline, and ship Q8_0
(about 1.8 GB file) if Q4_K_M loses quality.

Reasons, from the measurements above:

1. Best untrained quality by a clear margin, and the only model that holds
   up on hand-written phrasing (gold F1 0.73 against 0.54 for the best
   Apache model). A fine-tune starts from the best judgement.
2. Built and released for exactly this use (local agents, structured
   output, single-GPU fine-tuning), with official TRL notebooks.
3. Fits: 1.9 GB resident, p95 18 s per batch on 4 cores after the cache
   fix.
4. Long context is cheap if the consolidation jobs need it later.

**Decision for the owner: the licence.** The LFM licence is free for
Codeply below US$10M annual revenue. Before Codeply reaches that, it
needs a commercial licence from Liquid AI, or a switch of base model. To
keep that switch cheap:

* The data, prompt, guard, evaluation and gate are model-independent; a
  second base is one config file and one GPU run.
* The fallback is **Qwen3-1.7B** (Apache-2.0, dense, F1 0.64 untrained,
  `ml/finetune/config.yaml`) or **Qwen2.5-1.5B** (Apache-2.0, F1 0.71,
  weaker on natural phrasing). Recommended: fine-tune LFM3 and Qwen3-1.7B
  in the same GPU session (a few dollars each) and gate both; ship LFM3 if
  it wins, and keep the Qwen3 model ready.

Not recommended: Qwen3-0.6B or any sub-1B model (cannot do the task
untrained), Llama-3.2-1B and Gemma-3-1B (weaker, with more restrictive
licences than Apache-2.0).
