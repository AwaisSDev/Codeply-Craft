# Iris foundation model: selection (2026-11-09)

**Decision: `Qwen/Qwen3-0.6B`** (Apache-2.0, 0.6B parameters of which 0.44B outside the embeddings, 28-layer
transformer, 32K context), fine-tuned with LoRA and merged into standalone weights.
**Upgrade path, same pipeline: `Qwen/Qwen3-1.7B`** when a GPU is available (config change only).

One model is shipped. The comparison below is the evidence for the choice, not a set of product variants.

## 1. What the foundation has to do

Read one observation batch (chat, messages, email, calendar, note, screen text; English, Roman Urdu, Urdu) plus
a short list of existing memories as text, and emit strict JSON operations (CONTRACT.md). Run locally and
continuously on ordinary PCs through llama.cpp, with phones as a later target. Be commercially usable without a
revenue condition. Be trainable with the compute that actually exists: **4 CPU cores, 15 GB RAM, no GPU**.

## 2. Candidates

Licences, sizes and runtime support were read from the model cards, LICENSE files and the llama.cpp tree on
2026-11-09 (sources and the unverified items are listed in §6).

| Candidate | Params | Architecture | Licence | Urdu named by vendor | GGUF | Trainable here | Verdict |
|---|---|---|---|---|---|---|---|
| **Qwen3-0.6B** | 0.6B | transformer | Apache-2.0 | yes | official | **yes: 260-330 tok/s, 6.6 GB** [M] | **selected** |
| Qwen3-1.7B | 1.7B | transformer | Apache-2.0 | yes | official | marginal (~3x slower, ~11 GB est.) | upgrade path |
| Qwen3.5-0.8B | 0.8B | hybrid: 3 Gated DeltaNet + 1 attention, x6; vision encoder | Apache-2.0 | "201 languages" (Urdu not named) | community | 132 tok/s, 10.6 GB, reference kernels only [M] | rejected for now (§4) |
| Qwen3.5-2B | 2B | same | Apache-2.0 | same | community | no | future, with a GPU |
| LFM3-1.7B (production's model) | 1.73B | hybrid conv + attention | LFM Open License v1.0: commercial use only **below $10M annual revenue** | no (16 languages) | official, llama.cpp ≥ b11960 | no | licence and language |
| LFM2.5-350M / LFM2-350M-Extract | 0.35B | hybrid conv + attention | same cap | no | official | yes | licence and language |
| Gemma 3 270M / 1B | 0.27B / 1B | transformer | Gemma Terms (use policy, remote restriction clause), gated | not named | yes | yes | licence |
| Gemma 4 E2B | 5.1B raw | transformer, multimodal | Apache-2.0 | not named | official | no | too large |
| Granite 4.0 350M / 1B (and H hybrids) | 0.35-1.6B | transformer / Mamba-2 hybrid | Apache-2.0 | no (12 languages) | official | yes | no Urdu |
| SmolLM2-360M | 0.36B | transformer | Apache-2.0 | no (English) | official | yes | no Urdu |
| Falcon-H1-0.5B / 1.5B | 0.5B / 1.5B | Mamba-2 + attention | TII Falcon licence | 0.5B English only; 1.5B lists Urdu | official | 0.5B yes | licence terms, language |
| Phi-4-mini, SmolLM3-3B, Ministral-3B, Llama 3.2 | 3-4B / 1.2B | transformer | MIT / Apache / Llama CL | no | yes | no | size or licence |
| RWKV-7 G1 | 0.1-2.9B | RNN | Apache-2.0 | unnamed | yes | not with transformers + peft | tooling |
| NuExtract, GLiNER2 | 0.2-5B | fine-tunes / encoder | MIT / Apache | no | partly | — | template filling only: no update / duplicate decisions |

## 3. Why Qwen3-0.6B

1. **It is the only candidate at any small size that is Apache-2.0, names Urdu, has an official GGUF, and
   trains with stock `transformers` + `peft`.** Urdu and Roman Urdu are product requirements; every
   non-Qwen small model either omits Urdu or carries a restrictive licence.
2. **It can actually be trained here.** Measured on this machine (LoRA r=32 on all projections, sequence 768):
   329 tok/s at batch 2 and 260 tok/s at batch 1 with bf16 (AMX), 6.6 GB resident at batch 1. A 1.5M-token
   epoch takes about 1.5 hours. Nothing larger completes a multi-epoch run plus evaluation in the time available.
3. **Latency is the production blocker, and size is the lever.** The existing local model (LFM3-1.7B) measured
   p50 5-12 s and p95 18-28 s per batch on a 4-thread CPU, and no model passed the release gate. In the same
   harness Qwen3-0.6B measured p50 1.6-2.8 s and 0.92 GB peak (`ml/results`). An always-on context model that
   reads every batch should cost a third of that, not the same.
4. **Fine-tuning, not the checkpoint, decides quality at this size.** Zero-shot, Qwen3-0.6B scored F1 0.00 on
   the production prompt (it does not follow a long extraction prompt) while LFM3-1.7B scored 0.78-0.83; after
   LoRA on realistic data LFM3 went from 0.30 to 0.66 on real text. The task is narrow and structured, which is
   where small fine-tuned models close most of the gap. IrisBench measures whether that holds (EXPERIMENTS.md),
   including the untrained foundation as a baseline.

## 4. Why not the hybrid Gated-DeltaNet model (Qwen3.5-0.8B)

It is the architecturally interesting option: linear-time recurrent layers, 262K context, and a vision encoder
that could later read screens directly. Measured and read:

* Training on CPU falls back to reference PyTorch kernels for `causal_conv1d` and `chunk_gated_delta_rule`
  (transformers warns "correct but much slower"): **132 tok/s and 10.6 GB** against 260 tok/s and 6.6 GB.
  Half the throughput and 70 % of this machine's RAM leaves no room for evaluation alongside.
* Iris inputs are 0.3-2K tokens. Linear-time attention pays off at tens of thousands of tokens; here it buys
  nothing measurable.
* The model card warns the 0.8B is prone to thinking loops; the earlier zero-shot run in this repository had it
  at F1 0.47 with 75 % false memories.
* The vision tower is unused weight for a text contract; screen text reaches Iris as text today.

It stays the leading candidate for a later Iris with native screen input, to be trained on a GPU with the
optimised kernels, and compared on IrisBench under the same protocol.

## 5. Trade-offs accepted

* **Capacity.** 0.6B is below the 1-3B range the brief suggested investigating. The evidence that it is enough
  is IrisBench, not this document; if it is not, the same data, contract and scripts train Qwen3-1.7B
  (`train/iris-1.7b.json`), which needs a single T4-class GPU for a few hours.
* **Thinking mode.** Qwen3 thinks by default. Iris is trained on direct answers in plain ChatML, which equals
  the template's default rendering, so no template option is needed at inference.
* **Multilingual depth.** Qwen3 names Urdu; no vendor documents Roman Urdu. IrisBench reports multilingual
  results separately so the gap is visible rather than assumed.

## 6. Sources and unverified items

Opened 2026-11-09: Hugging Face cards and LICENSE files for Qwen3-0.6B / 1.7B, Qwen3.5-0.8B / 2B, LFM3-1.7B,
LFM2.5 and LFM2 small models, Gemma 3 / 3n / 4, SmolLM2 / 3, Granite 4.0 / 4.2, Phi-4-mini(-flash), Llama 3.2,
Falcon-H1 / Falcon3, RWKV-7, NuExtract, GLiNER2, Ministral 3; the Qwen3 blog and arXiv 2505.09388; the LFM3
post; the Gemma terms; the llama.cpp model sources (`qwen35.cpp`, `granite-hybrid.cpp`, `falcon-h1.cpp`,
`rwkv7.cpp`).

Not verified from a primary source: Roman Urdu support for any model; Urdu for Qwen3.5 and Gemma beyond a
language count; the minimum transformers version for Qwen3.5 and LFM3; which TII licence text governs
Falcon-H1; Gemma's commercial-use position beyond the general grant. Throughput numbers marked [M] were
measured in this session (`train/bench/`); everything else about speed is the vendors' claim or the earlier
`ml/results` measurements in this repository.
