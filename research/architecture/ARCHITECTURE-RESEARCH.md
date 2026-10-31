# Architecture research: what would make Codeply's local model better

Status: research, 2026-10-31. Branch `codeply-li-architecture-research`.
Nothing in the production pipeline was changed. Companion documents:
`PROPOSED-ARCHITECTURES.md`, `ARCHITECTURE-COMPARISON.md`,
`EXPERIMENT-ROADMAP.md`, `FINAL-RECOMMENDATION.md`.

Evidence labels used throughout:

| Label | Meaning |
|---|---|
| **[M]** | Measured by us on this branch (scripts in `analysis/`, results in `ml/results/`) |
| **[V]** | Verified in a primary source (paper, model card, config, source code) |
| **[C]** | Vendor or author claim, not independently checked |
| **[S]** | From secondary sources (search summaries, aggregators); check before spending money |
| **[I]** | Our inference |

## 0. The question and the short answer

> Can we create a 1B–2B parameter local intelligence model that understands,
> filters, organizes and updates a user's digital context more reliably than
> today's small general-purpose language models, while remaining fast enough
> for continuous local operation?

**Yes, but not by inventing a new backbone.** The evidence points somewhere
less glamorous and more certain:

1. **Our errors are decisions, not language.** Almost every failure of the
   current model is a wrong label among a handful of options: keep or
   discard, joke or fact, plan or observation, which memory this updates
   (§1.2). Generative decoders are the weakest known tool for that at a fixed
   size; bidirectional encoders with classification heads are the strongest
   (§4.1).
2. **Most of the generated tokens are not needed.** 44 % of what the model
   writes is JSON structure the grammar already fixes, 17 % is a sentence that
   can be templated, and 61 % of the observations it writes are thrown away by
   the guard (§1.1, §1.2). Speed is a format and runtime problem first.
3. **At our context lengths, the backbone type barely matters for speed.**
   With ~850-token prompts, CPU decode speed tracks the bytes of weights read
   per token, not whether a layer is attention, convolution or a state-space
   scan (§3.1). LFM3's conv + attention hybrid is a good backbone, and
   nothing published beats it at 1–2B on short-context CPU work.
4. **Training a new backbone is out of reach and would lose anyway.** A 1.5B
   pretraining run costs roughly $16k–$176k in compute for 1–4T tokens [S/I],
   and today's leaders at this size were trained on 10–36T tokens [V].

So the strongest defensible design is a **task-specific compound model**: a
small bidirectional encoder that makes every decision with calibrated
classification heads and selects which existing memory an observation
updates, deterministic resolvers for dates, and a generator only for the few
words that must be written. It reuses pretrained weights and existing
runtimes. `PROPOSED-ARCHITECTURES.md` gives three designs;
`FINAL-RECOMMENDATION.md` picks one.

## 1. The workload, measured

### 1.1 Where the output tokens go [M]

`analysis/token_anatomy.py` re-tokenizes every answer LFM3-1.7B (QAD Q4_0,
prompt v2) gave in our evaluation with its own tokenizer and splits it:

| Part of the answer | Tokens / answer (test-mini) | Share | (gold) | Share | Can it be avoided? |
|---|---|---|---|---|---|
| JSON structure and key names | 66.9 | 44.5 % | 59.5 | 42.6 % | Yes: the grammar forces them (runtime "jump-forward") |
| Decisions: `kind`, `certainty`, `about`, `importance` | 23.7 | 15.8 % | 20.8 | 14.9 % | Yes: a classifier head decides them in one pass |
| `text` (a sentence restating kind + slot + value) | 25.4 | 16.9 % | 25.2 | 18.1 % | Yes: a template renders it |
| `value`, `slot`, `until`, `project`, plan fields | 34.4 | 22.9 % | 34.1 | 24.4 % | Partly: `slot` can be selected, `until` resolved by rules; `value` and plan `what` need words |
| **Total** | **150.5** | | **139.5** | | |

Decode dominates CPU time: after our prompt-cache fix an LFM3 batch spends
~1.2 s reading the prompt and ~9 s writing ~150 tokens at 16.4 tok/s
(`docs/local-intelligence/BENCHMARKS.md`) [M]. Writing only the ~20–35 tokens
that carry new words would cut decode time 4–7× **with no change of
architecture**.

### 1.2 What the current model gets wrong [M]

`analysis/failure_taxonomy.py` on LFM3 QAD (prompt v2):

| | test-mini (92 generated) | gold (39 hand-written) |
|---|---|---|
| Gold memorable observations | 72 | 33 |
| Matched | 58 | 22 |
| Missed (decision: should have kept) | 14 | 11 |
| Extra kept (decision: should have discarded) | 16 | 8 |
| **Kind wrong on matched** | 15 / 58 (26 %) | 11 / 22 (50 %) |
| **Certainty wrong on matched** | 13 / 58 (22 %) | 9 / 22 (41 %) |
| Plans missed | 6 / 8 | 2 / 3 |
| Plan found but date wrong | 0 | 0 |
| Brain action differs from gold | 7 / 32 (jokes 3, quotes 2, duplicate 1, contradiction 1) | 7 / 17 (contradiction 3, preference 2, joke 1, duplicate 1) |
| **Observations written then dropped by the guard** | **116 of ~190 (61 %)**: 73 not grounded in the events, 28 below the importance floor, 14 outside text claiming user preferences, 1 injection | 40 of ~70 |

Every failure category the owner listed maps onto a **decision**:

| Owner's failure category | What is actually wrong | Fix class |
|---|---|---|
| Jokes and quotations stored as facts | certainty label (`joking`/`quoting` vs `stated`) | decision |
| Incorrect certainty labels | certainty label | decision |
| Incorrect merge and update actions | which existing memory an observation refers to (expressed today by re-generating its slot name) and whether it agrees or contradicts | selection + decision |
| Meetings as observations instead of plans | plan vs observation | decision |
| Temporary context split into unrelated memories | one span vs two; `until` as a separate observation | segmentation + rule |

**Generation errors are rare**: when a plan is found its date and time are
right every time, and secrets/injections were never leaked or followed.

### 1.3 How much of the decision is in a cheap representation? [M]

`analysis/decision_probe.py` trains a logistic regression on 3,000 training
examples (events text only) to predict one decision label per example
(`none`, `plan`, `stated`, `implied`, `temporary`, `joking`, `hypothetical`,
`quoting`) and, separately, the kind; it is scored on the generated test set,
its held-out-template part, and the hand-written gold set, next to LFM3's own
generated decisions on the same examples.

| Decision accuracy | generated test (757) | held-out templates (154) | hand-written gold (34) |
|---|---|---|---|
| TF-IDF + linear | 0.971 | 0.864 | 0.706 |
| nomic-embed 137M encoder, frozen + linear | 0.974 | 0.916 | 0.706 |
| **LFM3-1.7B, frozen hidden states + linear** | **0.984** | **0.922** | **0.824** |
| LFM3-1.7B generating its answer (as today) | – | – | 0.47–0.50 |

On gold, the frozen-LFM3 probe is right on 14 examples the generative model
gets wrong and wrong on 3 it gets right (exact McNemar p = 0.013); for kind,
all three probes beat generation (p = 0.012–0.039). Full tables:
`analysis/RESULTS.md` §3.

Three conclusions [M]:

1. **The model already "knows" more than it says.** The same network,
   read through a linear layer trained in seconds on generated data, gets
   the decision right far more often than when it has to generate it.
   Generating labels inside a JSON answer is the weak link, not the
   backbone's understanding.
2. **The generated data is template-learnable** (TF-IDF reaches 97–100 % on
   it). Only hand-written and real-world sets can rank architectures.
3. **A small encoder without any task training already matches TF-IDF on
   gold**; Design A's bet is that fine-tuning it (not done here) closes the
   rest of the gap at 1/8 of the cost (§6 of `PROPOSED-ARCHITECTURES.md`).

Caveats: 34 gold examples; single-decision examples only; the generative
label is a heuristic over its items.

### 1.4 What is prompt, fine-tuning, architecture, runtime?

| Lever | What it can fix here | Evidence |
|---|---|---|
| **Prompt** | Behaviours the model can already do but was not told: plans as plans, `until` inside context. Prompt v2 took LFM3 plans recall 0 → 25–33 % and temporal 0 → 20–33 %, at a cost of 0.03 F1 [M]. Ceiling reached: further rules shift errors around | `docs/local-intelligence/MODEL-SELECTION.md` §3 |
| **Fine-tuning** (same model, same output) | Label calibration on our taxonomy (kind, certainty), noise rejection, slot reuse, consistent format. Will help a lot; cannot remove the wasted tokens or make a decoder's labels calibrated | §4.1, §5 |
| **Architecture** (what the model is and what it outputs) | Decisions as classification heads (calibrated, one pass), merges as selection among known memories, a smaller model for decisions, adaptive computation (cheap gate first) | §4 |
| **Runtime** | Prompt-cache reuse (done: −29 % p50 [M]), skipping grammar-forced tokens, applying heads to hidden states, n-gram speculation | §6 |

## 2. Constraints that decide the design

* CPU-first, 4–8 cores, INT4, ~1–2 GB model RAM, low idle cost [owner].
* Inputs are short: ~100–300 tokens of events plus a fixed ~740-token system
  prompt today; long inputs only for occasional consolidation [M].
* Outputs are structured and must be auditable; the brain (`brain.js`) stays
  the only store and the only place that merges [owner rule].
* Training budget: rented GPUs or Kaggle; a small team [owner].
* The license must allow a commercial desktop app.

## 3. Backbone architectures

### 3.1 The CPU fact that frames everything

At batch 1 and short context, token generation is bound by memory bandwidth:
each new token reads (almost) every weight once. The size of the cache or
recurrent state is small next to ~1 GB of INT4 weights at ~1K tokens
(LFM3 ≈ 15–17 MB; Qwen3-1.7B dense ≈ 117 MB) [I, from configs]. So **speed
tracks non-embedding parameter bytes and kernel quality, not the mixer type**.

Measured support for this (llama.cpp Q4_0, batch 1, AMD Ryzen AI 9 HX 370,
from the LFM2 technical report, vendor-run) [V, arXiv 2511.23404 Table 3]:

| Model | Type | Prefill tok/s @1K | Decode tok/s @1K | Decode @4K |
|---|---|---|---|---|
| Gemma-3-1B | dense + sliding window | 3972 | 103.6 | 99.3 |
| LFM2-1.2B | conv + 6 GQA | 2784 | 99.7 | 89.0 |
| Llama-3.2-1B | dense | 2912 | 97.3 | 73.5 |
| Granite-4.0-1B | dense | 1823 | 64.5 | 43.6 |
| Granite-4.0-H-1B | Mamba-2 + 4 attention | 1565 | 59.6 | 57.1 |
| Qwen3-1.7B | dense | 2019 | 60.8 | 38.5 |
| LFM2-8B-A1B | MoE, 1.5B active | 1320 | 74.9 | – |

The IBM pair is the cleanest control (same ~15T tokens, dense vs Mamba-2
hybrid): **the hybrid is slower at 1K on x86 and only wins at 4K** [V]. Our
own runs agree: decode speed ordered by size, not type (LFM2.5-1.2B 24.9,
Gemma-3-1B 20.2, Qwen2.5-1.5B 18.7, LFM3-1.7B 16.4–17.8, Qwen3-1.7B 16.5
tok/s at 4 threads) [M].

### 3.2 Hybrid architectures

**Liquid LFM2 / LFM2.5 / LFM3** (gated short convolution + a few GQA layers;
LFM3 adds sliding-window layers)
* Mechanism: y = Out(C ⊙ DepthwiseConv_k(B ⊙ x)) in most layers; GQA with
  QK-norm in the rest [V, 2511.23404 §2.2]. LFM3-1.7B: 24 layers = 13 conv
  (kernel 7) + 5 sliding-window (256) + 6 global attention, GQA 16/4, hidden
  2048, 256K context, head-wise sigmoid-gated attention "to suppress
  activation outliers that hurt quantization" [V config; C blog].
* How it was chosen: hardware-in-the-loop search on a phone and a Ryzen
  laptop CPU (llama.cpp Q4_0, ExecuTorch) over gated convolutions, sliding
  window, linear attention, S4/S5/Mamba/Mamba-2, CfC. Liquid's conclusion:
  most of the benefit of SSM and linear-attention blocks "can be captured by
  their short convolutional submodules plus a small number of global
  attention layers", and adding SSM/linear attention on CPU "does not
  improve aggregate quality … and typically worsens device metrics" [V as
  their stated conclusion; per-operator tables not published].
* Training: LFM2 10–12T tokens with top-K distillation from a 7B teacher;
  LFM2.5-1.2B 28T; LFM3-1.7B 22T + 1.75T SFT + RL [V cards].
* Quantization: Liquid's quantization-aware Q4_0 (QAD) retains 96.5–97.4 %
  of BF16 vs 86.8–92.6 % for post-training quantization [S, Liquid blog];
  on our task QAD Q4_0 beat Q4_K_M by 5 F1 points [M].
* Runtime: llama.cpp supported [V]; we found and fixed its prompt-cache gap
  (`--swa-full` for LFM3, `-ub 128` for LFM2.5) [M].
* License: LFM Open License v1.0, free below US$10M annual revenue [V].
* **Verdict: a strong, CPU-searched backbone. The best off-the-shelf
  decoder for us [M]. Not a reason to design our own mixer.**

**Mamba-2 / attention hybrids** — Granite 4.0 H (Apache-2.0, llama.cpp
`granitehybrid`), Falcon-H1 (parallel attention + Mamba-2 heads; Falcon
license; llama.cpp), Nemotron-H / Nemotron 3 Nano 4B (NVIDIA licenses),
Zamba2 (Apache-2.0, **no llama.cpp**), Jamba (≥3B), Hymba (no llama.cpp),
Samba (no llama.cpp).
* Quality per parameter at 1–2B: the only controlled same-data comparison
  (Granite-4.0-H-1B vs Granite-4.0-1B, ~15T tokens each) is a wash: hybrid
  ahead on IFEval 78.5 vs 77.4 and MBPP, dense ahead on GSM8K 76.4 vs 69.8
  and BFCL 54.8 vs 50.2 [V vendor-measured]. Larger hybrid wins are at 8B
  (Waleffe et al., arXiv 2406.07887) or MoE scale [V].
* Weakness relevant to extraction: fixed-state models are provably limited at
  copying from context ("Repeat After Me", arXiv 2402.01032) and lag on
  associative recall (Zoology, arXiv 2312.04927) [V]; hybrids with some
  attention recover it.
* **Verdict: no advantage over LFM-class hybrids for short-context CPU work;
  several lack llama.cpp support.**

**Delta-rule / linear-attention hybrids** — Gated DeltaNet, Qwen3.5 small
(3 × Gated DeltaNet : 1 gated attention; 0.8B and 2B, Apache-2.0, llama.cpp
`qwen35`), Kimi Linear / KDA (48B-A3B only).
* Controlled 1.3B / 100B-token result (same data): commonsense average
  Transformer++ 52.25, Gated DeltaNet 55.32, hybrid GDN-H1 56.40; **recall
  tasks at 2K: Transformer++ 37.0, pure Gated DeltaNet 30.6, hybrids
  39.0–40.1** [V, arXiv 2412.06464]. Pure linear attention loses exactly on
  copying facts from the context, which is what extraction is.
* Our measurement: Qwen3.5-0.8B scored F1 0.47 on test-mini, below every
  dense 1–1.7B model we tried [M].
* **Verdict: confirms "hybrid with real attention" as the right family; no
  small instruct model that beats LFM3 here.**

**Kimi hybrid attention (KDA + MLA, 3:1)**: beats full MLA under an
identical 1.4T-token recipe including short-context tasks [V, arXiv
2510.26692, vendor-run], but only a 48B-A3B MoE exists. **Verdict: idea
relevant, weights irrelevant.**

### 3.3 Recurrent and linear-attention models

| Model | Key fact | Verdict for us |
|---|---|---|
| Mamba / Mamba-2 / Mamba-3 (2312.00752, 2405.21060, 2603.15569) | O(1) state per token; Mamba-3 claims Mamba-2 perplexity at half the state and +1.8 avg at 1.5B over Gated DeltaNet on 100B tokens [V]; its own paper says transformers retrieve "substantially" better and linear layers belong in hybrids [V] | Pure SSMs: no. Small production weights: none (mamba2-1.3b: 300B tokens) |
| RWKV-7 "Goose" (2503.14456) | 0.19–2.9B, Apache-2.0, 3.1T tokens, llama.cpp supported; 1.5B ≈ Qwen2.5-1.5B on English average but MMLU 43.3 vs 61.0 [V]; RWKV wiki warns Q4 "may severely degrade" [V] | No: quality and INT4 risk; constant state only pays at long context |
| RetNet (2307.08621) | Superseded; no usable weights | Not relevant |
| Griffin / Hawk / RecurrentGemma-2B (2402.19427, 2404.07839) | RG-LRU + local attention; RecurrentGemma-2B below Gemma-2B (MMLU 38.4 vs 42.3); gains measured on TPU at long sequences; no llama.cpp | Not relevant |
| xLSTM 7B (2503.13427) | 7B only, GPU kernels, NXAI license | Not relevant |
| Hyena / StripedHyena (2302.10866) | Long-convolution; advantage at 8K–64K; 7B only | Not relevant |

### 3.4 Mixture-of-Experts

MoE cuts compute per token, not memory. On a CPU, decode reads the active
experts' weights, but all experts must sit in RAM. LFM2-8B-A1B (1.5B active)
decodes at 74.9 tok/s vs 99.7 for dense LFM2-1.2B on the same laptop and
needs a ~4.7 GB Q4_0 file vs ~0.7 GB [V]. OLMoE-1B-7B Q4_K_M is 4.2 GB;
Qwen3-30B-A3B Q4 is 17–19 GB [V]. **Verdict: MoE buys 3–4B-class quality
for 4–5 GB of RAM, not speed. Outside the 1–2 GB budget; keep as a "high
quality tier" option for 16 GB machines only.**

### 3.5 Adaptive computation

| Approach | Evidence | CPU reality |
|---|---|---|
| Recurrent depth: Huginn-3.5B (2502.05171), Ouro/LoopLM 1.4B–2.6B (2510.25741) | Ouro-1.4B at 4 loops: MMLU 67.4 vs Qwen3-1.7B 62.5 [V] | Each loop re-reads the weights: ~4× decode cost per token [I]; no llama.cpp; Ouro "research purposes only" [V]. Wrong direction for CPU |
| Mixture-of-Depths (2404.02258), Mixture-of-Recursions (2507.10524) | Better perplexity / throughput at equal training FLOPs, 135M–1.7B [V] | Research code; no CPU runtime |
| Early exit / LayerSkip (2404.16710) | Up to 2.16× on GPU with special training [V] | Not in llama.cpp; needs retraining |
| **System-level cascade**: cheap filter → small classifier → generator only when needed | Standard practice; our data: 1,279 of 8,000 generated examples have no observation to keep (some have only a plan), and real ambient streams are likely far noisier [M/I] | Works with today's runtimes; the cheapest stage handles the most traffic |

**Verdict: adaptive computation is worth having at the system level
(a cascade), not inside the network.**

### 3.6 Low-bit and on-device designs

* **BitNet b1.58 2B4T** (2504.12285; MIT): native ternary, 0.4 GB
  non-embedding memory, 29 ms/token on an i7 vs 41–65 ms for 1–1.5B models in
  llama.cpp, but the baselines' precision is unstated and likely not Q4 [V];
  IFEval 53.5, far below modern 1–2B instruct models [V]. Needs bitnet.cpp.
  **An experiment, not a base.**
* **ParetoQ** (2502.02631): 2–3-bit QAT beats 4-bit on the size/accuracy
  frontier [V]. Relevant later for a smaller deployed model.
* **MobileLLM** (2402.14905): at 125–350M, depth beats width [V]. Relevant if
  we size a small encoder or generator ourselves.
* **Gemma 3n** (MatFormer, per-layer embeddings): interesting for nesting
  sizes; Gemma terms; benefit on llama.cpp CPU unverified.

## 4. Task formulation: the decisive part

### 4.1 Encoders vs decoders for decisions

* **Ettin** (arXiv 2507.11412): encoder and decoder suites trained with the
  same data and recipe at 17M–1B. Fine-tuned MNLI: encoder 89.2 / 91.3 / 91.8
  vs decoder 85.6 / 88.2 / 89.9 at 150M / 400M / 1B. **A 150M encoder beats a
  400M decoder; a 400M encoder beats a 1B decoder.** Continuing to train the
  decoder as an encoder does not close the gap (89.0). Decoders win on
  generation [V]. Weights MIT [V].
* **ModernBERT** (2412.13663; Apache-2.0; 150M / 396M; 8K context; 2T
  tokens) and **NeoBERT** (2502.19587; MIT; 250M) [V]. llama.cpp at our
  pinned commit includes `modern-bert`, `neo-bert`, `bert`, `t5encoder`
  models [M, source tree].
* **GLiNER2** (2507.18546; Apache-2.0; 205M / 340M): one encoder pass does
  entity spans, single/multi-label classification and structured extraction
  with choice constraints. CPU latency 130–208 ms for 5–50 labels where a
  zero-shot NLI cross-encoder takes 1.7–16.9 s [V; hardware unstated].
* **SarcasmBench** (2408.11319): LLMs underperform supervised small
  pretrained models on all six sarcasm datasets [V]. Fine-tuned small
  classifiers beat zero-shot GPT-4-class models on sentiment, stance and
  emotion (2406.08660) [V].
* **Classification heads on a decoder** (LS-LLaMA, 2310.01208) also beat
  generating labels [V], but a same-size encoder is still better (Ettin) [V].

### 4.2 Merges as selection, not generation

* Today the model must re-generate the exact slot name of a known memory for
  the brain to merge; any wording drift becomes a duplicate or a missed
  contradiction. Merge errors in our runs concentrate on contradictions and
  jokes [M].
* The established alternatives: retrieve candidates and score pairs with a
  cross-encoder (BLINK, 1911.03814) or constrain generation to valid
  existing ids (GENRE, 2010.00904) [V]; detect contradiction as NLI over
  dialogue (Dialogue NLI 1811.00671; DECODE 2012.13391) [V].
* Even an 8B memory manager mislabels updates as contradictions (Memory-R1,
  2508.19828: "adopted another dog named Scout" read as contradicting
  "adopted Buddy"); RL on 152 examples fixed much of it [V].
* Agent memory systems (Mem0 2504.19413, Zep 2501.13956, A-MEM 2502.12110,
  MemGPT 2310.08560) all use an LLM call for ADD/UPDATE/DELETE/NOOP; Zep's
  "invalidate, don't delete" and "compare only within the same entity pair"
  are directly useful [V]. Benchmarks: LongMemEval (2410.10813), LoCoMo
  (2402.17753), MemoryAgentBench (2507.05257: every method ≤ 28 % on
  multi-hop fact consolidation) [V]. **No public benchmark measures joke /
  hypothetical / quote gating for memory writes**; our gold set is the
  closest thing.

### 4.3 Calibration

Fine-tuned encoder classifiers are well calibrated in-domain and better
out-of-domain, and temperature scaling fixes the rest (2003.07892) [V].
RLHF-tuned LLMs' token probabilities are poorly calibrated (2305.14975) [V],
and grammar-constrained decoding distorts the distribution further
(2405.21047) [V]. The brain needs real certainty and importance, so this
favours heads.

### 4.4 Constrained decoding cost

Grammar mask cost is negligible on CPU now (XGrammar < 40 µs/token,
2411.15100; llguidance ~50 µs/token and merged in llama.cpp, MIT) [V]. The
cost is the number of generated tokens. Jump-forward over forced tokens gave
up to 2× lower latency on GPU (SGLang, 2024) [V]; on our answers 44 % of
tokens are forced [M].

### 4.5 Specialised extraction models

NuExtract 1.5/2.0 (0.5–8B, mostly MIT; NuExtract-2.0-4B's license is
inconsistent between card and metadata) supports enum, multi-label and
date-time fields with nulls [V]. Osmosis-Structure-0.6B (Apache-2.0) [V].
Both still generate tokens; neither addresses calibration or merges.

## 5. Training approaches and costs

GPU prices (aggregators, Oct 2026) [S]: H100 ~$2.2–4.3/h, A100 80GB
~$1.4–2.8/h, L40S ~$0.8–1.1/h, RTX 4090 ~$0.34–0.89/h. Kaggle: 12-hour
sessions, ~30 h/week, 2×T4 or P100 (16 GB, T4 has no bf16) [S].

| Approach | Reported anchors | Estimate for a ~1.5B model (or a 150–400M encoder) | Realistic for us? |
|---|---|---|---|
| Pretraining from scratch | TinyLlama 1.1B: 3T tokens, ~34.5k A100-h [S]; SmolLM3 3B: 11.2T, ~220k H100-h [S]; leaders at 1–2B use 10–36T [V] | 8k–44k H100-h for 1–4T tokens: **$16k–$176k per run**, 2–5× with ablations [I] | **No** |
| Continued pretraining 50–100B tokens | Llama-3.2-1B on 400M tokens: 9.5 h on 1 H100 [S] | 400–1,100 H100-h, $0.8k–4.4k [I] | Not needed: our domain is ordinary language |
| Architecture conversion by distillation | Llamba 1B/3B/8B into Mamba-2 with < 0.1 % of usual data [V]; X-EcoMLA: Llama-3.2-1B, 3.6B tokens, 70 MI300 GPU-h [V]; RADLADS: 350–700M tokens, 72B for < $2,000 [V]; Zebra-Llama 1B/3B: ~100 % of base with 2–4 % of the KV cache [S] | 60–400 H100-h, $120–1,600 compute, plus weeks of engineering and possibly llama.cpp kernels [I] | Possible, **but no CPU speed gain over LFM3 to buy** (§3.1) |
| LoRA SFT, 5–50M tokens | LoRA ≈ full FT for instruction tuning at high rank, all layers (2405.09673; Thinking Machines 2025) [V/S] | < 3 H100-h, < $15; fits a Kaggle T4 [I] | **Yes** |
| Full fine-tuning (encoder 150–400M) | — | Minutes to an hour on one 24 GB GPU [I] | **Yes** |
| Distillation from a strong teacher | API teachers give sequence-level data only; logit / on-policy distillation needs an open-weight teacher on GPUs; Qwen3 on-policy distillation: 74.4 % AIME in ~1.8k GPU-h vs RL 67.6 % in 17.9k [S] | Teacher labelling of 8k–80k examples: ~$3–40 with a cheap API model, ~$100–1,000 with a frontier one [S/I] | **Yes** (labels for real text) |
| Preference / RL with exact rewards (DPO, GRPO) | Open-RS: 1.5B, 4×A40 for 24 h, ~$42 [S]; GRPO with F1 rewards on 1.5B extraction (2507.15586) [S]; Memory-R1: RL fixes merge actions [V] | $40–400 [I] | **Yes**, after SFT |
| Quantization-aware training | Gemma 3 QAT ~5k steps [S]; Liquid QAD 96.5–97.4 % retained [S]; ParetoQ: QAT saturates ~10B tokens at 3–4 bit [V] | $5–160 [I] | Yes for the generator; encoders run fine at INT8 |
| Curriculum learning | Mixed or null for SFT (2603.27226, 2510.19099) [S] | — | Low priority |

## 6. Runtime: llama.cpp or our own?

* **llama.cpp already runs every component the proposals need**: the LFM
  decoders, encoder models (`modern-bert`, `neo-bert`, `bert`, `t5encoder`),
  per-token embeddings (`--pooling none`) for span heads, rerank pooling for
  cross-encoders, grammar-constrained decoding with llguidance, n-gram and
  draft-model speculation [M source tree; V].
* **What it lacks for us**: running a small linear head on the hidden state
  of a chosen token during generation, and skipping grammar-forced tokens
  with one batched forward. Both are a few hundred lines in a fork
  (RUNTIME.md phase 2), not a new engine.
* **Not worth it**: our own kernels, our own model format, or a different
  engine. ONNX Runtime is a reasonable alternative for the encoder if the
  heads are easier to ship there; it does not run the LFM decoders as well.

## 7. Unknowns and assumptions

* **Real traffic.** All our data is generated or hand-written; how noisy a
  real user's event stream is, and how far gold (39 examples) generalises,
  is unknown. This is the biggest risk for every proposal.
* No published CPU latency for ModernBERT / Ettin / GLiNER2 on our hardware;
  §1.3 and `EXPERIMENT-ROADMAP.md` E1 measure it.
* Secondary-source numbers (marked [S]) should be checked against the
  primary PDFs before money is spent.
* Liquid's architecture-search conclusions are stated, not published with
  data.
* Labels from a teacher model inherit the teacher's errors on jokes and
  quotes; hand-checked gold stays the arbiter.

## 8. Sources

Papers (arXiv IDs): Ettin 2507.11412; ModernBERT 2412.13663; NeoBERT
2502.19587; GLiNER 2311.08526; GLiNER2 2507.18546; DeBERTaV3 2111.09543;
LS-LLaMA 2310.01208; fine-tuned vs zero-shot 2406.08660; LoRA Land
2405.00732; Distilling step-by-step 2305.02301; Dialogue NLI 1811.00671;
DECODE 2012.13391; BLINK 1911.03814; GENRE 2010.00904; Mem0 2504.19413;
Memory-R1 2508.19828; A-MEM 2502.12110; MemGPT 2310.08560; Zep 2501.13956;
LongMemEval 2410.10813; LoCoMo 2402.17753; MemoryAgentBench 2507.05257;
SarcasmBench 2408.11319; PrefEval 2502.09597; calibration 2003.07892,
2207.05221, 2305.14975; Grammar-Aligned Decoding 2405.21047; XGrammar
2411.15100; DOMINO 2403.06988; LFM2 2511.23404; Mamba 2312.00752; Mamba-2
2405.21060; Mamba-3 2603.15569; Repeat After Me 2402.01032; Zoology
2312.04927; Mamba-based LMs study 2406.07887; Quamba 2410.13229; Jamba
2403.19887; Zamba2 2411.15242; Falcon-H1 2507.22448; Nemotron-H 2504.03624;
Nemotron-Flash 2511.18890; Hymba 2411.13676; Samba 2406.07522; Gated DeltaNet
2412.06464; GLA 2312.06635; DeltaNet 2406.06484; Kimi Linear 2510.26692;
MiniMax-01 2501.08313; hybrid linear attention analysis 2507.06457; RetNet
2307.08621; RWKV-5/6 2404.05892; RWKV-7 2503.14456; Griffin 2402.19427;
RecurrentGemma 2404.07839; xLSTM 2405.04517; xLSTM 7B 2503.13427; Hyena
2302.10866; OLMoE 2409.02060; Huginn 2502.05171; Ouro 2510.25741;
Mixture-of-Depths 2404.02258; LayerSkip 2404.16710; Mixture-of-Recursions
2507.10524; Relaxed Recursive Transformers 2410.20672; BitNet b1.58 2B4T
2504.12285; bitnet.cpp 2410.16144, 2502.11880; ParetoQ 2502.02631; MobileLLM
2402.14905; MobileLLM-R1 2509.24945; TinyLlama 2401.02385; SmolLM2
2502.02737; Qwen3 2505.09388; Mamba in the Llama 2408.15237; Llamba
2502.14458; LoLCATs 2410.10254; RADLADS 2505.03005; X-EcoMLA 2503.11132;
Zebra-Llama 2505.17272; Liger 2503.01496; LoRA Learns Less 2405.09673; GKD
2306.13649; Open-RS 2503.16219; GRPO extraction 2507.15586; EfficientQAT
2407.11062.

Model cards and code: huggingface.co/LiquidAI/LFM3-1.7B (config, LICENSE,
README), LiquidAI/LFM3-1.7B-GGUF, LiquidAI/LFM2-8B-A1B,
ibm-granite/granite-4.0-h-1b, ibm-granite/granite-4.0-1b-base,
Qwen/Qwen3.5-2B, microsoft/bitnet-b1.58-2B-4T, numind/NuExtract-2.0-2B,
fastino-ai/GLiNER2, ByteDance/Ouro-1.4B, fla-hub/rwkv7-1.5B-world;
github.com/ggml-org/llama.cpp (pinned `aa588a3`: `src/models/`,
`conversion/`, `src/llama-arch.cpp`, `src/llama-quant.cpp`);
github.com/guidance-ai/llguidance; liquid.ai/blog/lfm3; liquid.ai/blog/qad;
lmsys.org/blog/2024-02-05-compressed-fsm.
