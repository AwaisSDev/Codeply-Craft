# Iris foundation candidates: longlist of 30, shortlist of 10 (2026-11-19)

Purpose: choose which open-weight models of 5B parameters or fewer to put through **IrisBench (val, open loop,
zero-shot)** next, to replace or confirm Qwen3-0.6B (FOUNDATION.md). This was a web search, not a measurement:
every number below comes from a vendor model card unless it is marked [I] (independent). Nothing here was run in
this session (there is no GPU, and these were not CPU-evaluated).

## What Iris needs (from FOUNDATION.md, CONTRACT.md, IRISBENCH.md)

1. Strict JSON ops with verbatim quotes, which takes instruction following and format compliance.
2. English, **Urdu, Roman Urdu** and mixed input.
3. A licence that allows commercial use with **no revenue cap**.
4. **Stock llama.cpp** GGUF, CPU latency suitable for always-on use, and phones later.
5. Thinking mode can be switched off, since it costs latency and Iris is trained on direct answers.
6. LoRA-trainable with transformers + peft or unsloth (GPU later).
7. The primary endpoints are extraction F1, **false-memory share** (hallucination) and end-state F1.

## Longlist (30)

| # | Model | Released | Params (total) | Licence | Urdu named? | Stock llama.cpp | Key numbers (card) | Fate |
|---|---|---|---|---|---|---|---|---|
| 1 | Qwen/Qwen3.5-2B | 2026-02-28 | 2.27B incl. vision | Apache-2.0 | "201 languages" | yes (qwen35) | IFEval 78.6, IFBench 41.3, MMMLU 63.1, INCLUDE 55.4 | **TOP 10** |
| 2 | Qwen/Qwen3.5-4B | 2026-02-27 | 4.66B incl. vision | Apache-2.0 | "201 languages" | yes | IFEval 89.8, IFBench 59.2, BFCL-v4 50.3, MMLU-ProX 71.5, INCLUDE 71.0 | **TOP 10** |
| 3 | Qwen/Qwen3-4B-Instruct-2507 | 2025-08 | 4.02B | Apache-2.0 | yes (Qwen3 list) | yes (mature) | IFEval ~83-87, IFBench 50.4, INCLUDE 64.4 | **TOP 10** |
| 4 | google/gemma-4-E2B-it | 2026-04 | 2.3B effective / 5.12B with PLE | Apache-2.0 | 140+ pre-train langs, not named | official QAT Q4_0 GGUF | MMMLU 67.4, MMLU-Pro 60.0 | **TOP 10** (cap borderline) |
| 5 | LiquidAI/LFM3-1.7B | 2026-10-23 | 1.73B | LFM Open v1.0, **$10M cap** | no (16 langs incl. Hindi, Arabic) | yes, ≥ b11960 | IFEval 96.7, IFBench 73.0, BFCL-v4 71.4 (vendor blog) | **TOP 10** |
| 6 | ibm-granite/granite-4.2-3b | 2026-08-25 | ~3.7B | Apache-2.0 | no (12 langs) | official quants, standard `granite` arch | IFBench 74.3, BFCL-v4 52.4, MMLU-ProX-lite 27.8 | **TOP 10** |
| 7 | LiquidAI/LFM2.5-2.6B | 2026-07-28 | 2.69B | LFM Open v1.0, $10M cap | no | yes | IFEval 95.4, IFBench 60.5; [I] AA on-phone: IFBench 59 %, **79 % non-hallucination** | **TOP 10** |
| 8 | Qwen/Qwen3.5-0.8B | 2026-02-28 | 0.87B incl. vision | Apache-2.0 | "201 languages" | yes | IFEval 44-52; earlier repo zero-shot F1 0.47 / 75 % false memories | **TOP 10** |
| 9 | Qwen/Qwen3-1.7B | 2025-04 | 2.03B | Apache-2.0 | yes | yes | IFEval 68.2, IFBench 26.7 | **TOP 10** (control) |
| 10 | microsoft/Aion-1.0-Instruct-2.3B | 2026-11-18 | 2.29B | **MIT** | no (8 langs) | quants announced, upstream arch support unverified; `trust_remote_code` | IFEval 83.9, IFBench 32.0, Multi-IF 64.7 | **TOP 10** (wildcard) |
| 11 | Qwen/Qwen3-0.6B | 2025-04 | 0.75B | Apache-2.0 | yes | yes | current foundation; zero-shot val F1 0.02 | reference baseline, already measured |
| 12 | LiquidAI/LFM2.5-1.2B-Instruct | 2026-01-06 | 1.17B | $10M cap | no (8 langs) | yes | — | cut: covered by LFM3-1.7B and LFM2.5-2.6B |
| 13 | LiquidAI/LFM2.5-1.2B-Thinking | 2026-01-20 | 1.17B | $10M cap | no | yes | — | cut: thinking-only, adds latency |
| 14 | LiquidAI/LFM2.5-350M | 2026-03-31 | 0.35B | $10M cap | no | yes | — | cut: too small for multilingual |
| 15 | LiquidAI/LFM2.5-230M | 2026-06-24 | 0.23B | $10M cap | no | yes | — | cut: too small |
| 16 | LiquidAI/LFM2-1.2B-Extract | 2025-09 | 1.2B | $10M cap | no | yes | extraction-tuned | cut: template filling, not update/duplicate decisions (FOUNDATION §2) |
| 17 | mistralai/Ministral-3-3B-Instruct-2512 | 2025-11-24 | 3.4B + 0.4B vision | Apache-2.0 | no (11 langs incl. Arabic) | official GGUF | no IFEval/BFCL on card | cut: no IF evidence, no Urdu; first reserve |
| 18 | microsoft/Phi-4-mini-instruct | 2025-02 | 3.8B | MIT | no | yes | older; slow on CPU (~6.9 tok/s anecdotal [I]) | cut: age, latency |
| 19 | HuggingFaceTB/SmolLM3-3B | 2025-07 | 3.1B | Apache-2.0 | no (6 langs) | yes | — | cut: no Urdu, no newer SmolLM |
| 20 | meta-llama/Llama-3.2-3B-Instruct | 2024-09 | 3.2B | Llama CL | no (Hindi only) | yes | — | cut: old, licence |
| 21 | Nanbeige/Nanbeige4.2-3B | 2026-07-21 | 4B (looped) | Apache-2.0 | no (en, zh) | **fork only** | IFBench 54.6; [I] 33 % non-hallucination | cut: fork, hallucination |
| 22 | nvidia/Nemotron-Labs-Dory1.0-4B | 2026-10-16 | 4B looped | OpenMDW-1.1 | English only | **special build** | IFBench 74-79 | cut: English only, always reasons |
| 23 | nvidia/Nemotron-Labs-Sigma-3B-instruct | 2026-10-05 | 3B diffusion | NVIDIA OML | English | none, no CPU | — | cut: unusable on CPU |
| 24 | nvidia/Nemotron-3.5-Bolt-E4B | 2026-10-05 | 8B total | OpenMDW-1.1 | no | unverified | IFBench 63.8, BFCL-v3 68.5 | cut: over 5B |
| 25 | CohereLabs/tiny-aya-global | 2026-02-13 | 3.35B | **CC-BY-NC-4.0** | **yes** | GGUF exists | weak MGSM | cut: non-commercial (only model that names Urdu) |
| 26 | prism-ml/Ternary-Bonsai-2-4B | 2026-09-23 | 4.2B ternary (Qwen3.5-4B) | Apache-2.0 | inherits Qwen | Q2_0 only upstream, rest fork | — | cut: same as Qwen3.5-4B minus quantisation loss; revisit for phones |
| 27 | prism-ml/Ternary-Bonsai-2-2B | 2026-09-23 | 1.9B ternary (Qwen3.5-2B) | Apache-2.0 | inherits Qwen | same | 0.52 GB | cut: same; phone follow-up |
| 28 | ai21labs/AI21-Jamba2-3B | 2026-01-06 | 3B SSM hybrid | Apache-2.0 | none listed | unverified | scores only in an image | cut: languages undocumented |
| 29 | tiiuae/Falcon-H1-1.5B / Falcon-E-3B | 2025 / 2026-04 | 1.5B / 3B BitNet base | TII licence | 1.5B lists Urdu | yes / BitNet lib | — | cut: licence terms, Falcon-E is base only |
| 30 | LGAI-EXAONE/EXAONE-4.0-1.2B | 2025-07 | 1.2B | EXAONE licence (non-commercial history) | no | yes | — | cut: licence |

Also checked and out of scope: Gemma 4 E4B (8B total), Gemma 3 / 3n (gated Gemma licence),
granite-swash-3b-a600m (English base preview), FrogNano-4B (coding, Qwen-derived), and Tiny Aya thinker
variants (non-commercial). No vendor has a newer small text model than those listed. Qwen's 2026 releases
after 3.5 (3.6, 3.8) are 27B and larger, and there is no SmolLM4, Phi-5 or new small Llama.

## Top 10 and why

1. **Qwen3.5-2B**: the best overall fit. It is Apache-2.0, comes from the same vendor as the current pipeline, and
   covers the widest language set (Qwen3 names Urdu; Qwen3.5 extends that to 201). Non-thinking is the default,
   IFEval 78.6 is well above Qwen3-1.7B's 68.2, and its size fits an always-on CPU model. Earlier this would have
   been rejected for CPU *training* (reference DeltaNet kernels, I2), but that does not apply to evaluation or GPU
   training.
2. **Qwen3.5-4B**: the quality ceiling under 5B, and the best multilingual numbers on any card (MMLU-ProX 71.5,
   INCLUDE 71.0, IFEval 89.8). It answers "how much does 2x the size buy?". Thinking must be forced off
   (`enable_thinking=False`).
3. **Qwen3-4B-Instruct-2507**: a dense transformer with non-thinking only, the most mature llama.cpp and peft
   support, and Urdu named. [I] Distil Labs found Qwen3-4B the best LoRA base of 12 (it matched a 120B teacher on
   8 of 9 tasks), and [I] a clinical extraction study measured 95-97 % JSON parse rate. The repo already has its GGUF
   (step0 generator).
4. **Gemma 4 E2B**: the strongest Urdu bet. [I] The Gemma family tops UrduBench (Gemma-3-12B, 59.4 %). It is
   Apache-2.0 now, has official QAT GGUFs and was built for phones. Caveats: 5.12B total with per-layer embeddings
   (compute is about 2.3B), so it is over a strict 5B cap, and Gemma tends to wrap JSON in markdown fences, so use
   schema-constrained decoding.
5. **LFM3-1.7B**: the newest model (Oct 2026), the best vendor instruction-following numbers at any size here, and
   the fastest on CPU. It is also production's own model, so it must be on the board. Blockers: the $10M revenue cap,
   no Urdu, and the card says thinking-off is "inconsistent".
6. **Granite 4.2 3B**: the newest Apache-2.0 model with top-tier instruction following (IFBench 74.3, the highest
   uncapped number on the list). It uses a standard architecture with official quants and a thinking toggle. Weak
   point: multilingual (MMLU-ProX-lite 27.8), so it tests whether instruction following or language coverage
   matters more for Iris.
7. **LFM2.5-2.6B**: [I] Artificial Analysis measured it at 79 % non-hallucination on a phone (against 33 % for
   Nanbeige 3B) with the best on-device IFBench. False-memory share is a primary endpoint. It shares LFM3's licence
   and language caveats.
8. **Qwen3.5-0.8B**: the phone-class successor to Qwen3-0.6B. The repo's own zero-shot (F1 0.47, 75 % false memories,
   thinking loops) says watch hallucination, but it is the only recent sub-1B Apache model with broad languages.
9. **Qwen3-1.7B**: the control. `train/iris-1.7b.json` is already the planned upgrade, so its number is needed to
   judge whether a Qwen3.5 architecture switch beats simply scaling up within Qwen3.
10. **Aion-1.0-Instruct-2.3B** (Microsoft, released yesterday): MIT, IFEval 83.9 at 2.3B, hybrid sliding-window
    attention for CPU. It is a wildcard: no Urdu, custom code, and llama.cpp support is unconfirmed. If it does not
    load in stock llama-server, swap in **Ministral-3-3B-Instruct-2512**.

## How to run them (when compute is available)

* Same harness as I11: `evaluate.py --system zeroshot`, val split, open loop, llama-server backend, one fixed
  instruction prompt plus one example, thinking off, schema-constrained decoding on, Q4_K_M (Gemma: the official
  QAT Q4_0), 4 CPU threads.
* Report per model: extraction F1, false-memory share, output validity, ungrounded-evidence rate, the
  **Urdu / Roman Urdu / mixed** slice (metric 14), and p50 / p95 latency and peak RSS.
* Zero-shot scores will be low (Qwen3-0.6B scored 0.02). Use them to rank aptitude and choose 2-3 for LoRA on a GPU;
  the decision stays the fine-tuned IrisBench result (IRISBENCH §4).

## Main uncertainties

* No small model except the non-commercial Tiny Aya names Urdu on its card; Roman Urdu is documented nowhere.
  IrisBench's multilingual slice is the only real evidence.
* Most instruction-following numbers are vendor-reported; the LFM3 numbers above all.
* Upstream llama.cpp support was confirmed from sources for LFM3 (b11960+) and Qwen3.5. For Granite 4.2 it is
  inferred from the standard arch, and for Aion it is unknown.
