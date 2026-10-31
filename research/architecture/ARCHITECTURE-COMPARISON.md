# Architecture comparison

LFM3 today vs alternative backbones vs the proposed designs, on what decides
this product: decision quality on our failure categories, CPU cost, RAM,
license, runtime support, training cost and risk. Labels: [M] measured by
us, [V] verified source, [C] claim, [S] secondary, [I] estimate.

## 1. Candidates

| ID | Candidate | What changes vs today |
|---|---|---|
| T0 | **LFM3-1.7B QAD Q4_0, prompt v2** (today) | — |
| T1 | LFM3-1.7B fine-tuned, same JSON output (`config-lfm3.yaml`) | fine-tuning |
| B1 | LFM3-1.7B fine-tuned on compact codes (Design B1) | fine-tuning + output format |
| B2 | LFM3-1.7B with heads on hidden states + jump-forward (Design B2) | + architecture (heads) + runtime fork |
| A | Decide-then-Write: 150–400M encoder with heads, rules, optional writer (Design A) | architecture |
| A′ | Decide-then-Write with LFM3 as the decision backbone (heads on prefill states, no generation for decisions) | architecture, larger backbone |
| C | Encoder–decoder, ~0.55B (Design C) | new architecture + runtime |
| X1 | Dense transformer of the same size (Qwen3-1.7B) | backbone |
| X2 | Mamba-2 hybrid (Granite-4.0-H-1B) | backbone |
| X3 | Gated DeltaNet hybrid (Qwen3.5-0.8B / 2B) | backbone |
| X4 | RWKV-7 1.5B | backbone |
| X5 | MoE, 1.5B active (LFM2-8B-A1B) | backbone |
| X6 | Ternary (BitNet b1.58 2B4T) | backbone + runtime |
| X7 | Recurrent depth (Ouro-1.4B) | backbone |

## 2. Evidence table

| ID | Decision quality on our failures | Generation of words | p50 / p95 per batch, 4 cores | Model RAM | License | Runs in our runtime | Training cost | Main risk |
|---|---|---|---|---|---|---|---|---|
| T0 | gold decision 0.47–0.50, kind 0.50, F1 0.70; test-mini F1 0.80 [M] | yes | 10.9 / 18.5 s [M] | 2.0 GB [M] | LFM (< $10M revenue) | yes | — | fails the gate [M] |
| T1 | unknown; fine-tuning helps labels most (§4.1 research) [I] | yes | ~11 / 18 s (same output) [I] | 2.0 GB | LFM | yes | < $15 SFT [I] | decisions stay generated; no calibration; same cost |
| B1 | unknown; same backbone; labels as one token each with logprobs [I] | yes | ~3.5–4.5 / ~7 s [I from M] | 2.0 GB | LFM | yes | < $50 [I] | decoder decisions weaker than encoder at equal size (Ettin) [V] |
| B2 | frozen-LFM3 + linear: gold decision **0.82**, kind 0.81 [M]; fine-tuned heads should do better [I] | yes | ~3–4 / ~6 s [I] | 2.0 GB | LFM | **fork needed** | < $50 + fork | maintaining a llama.cpp fork |
| A (150M) | frozen 137M encoder + linear: gold decision 0.71, kind 0.81 [M]; fine-tuned encoders beat same-size decoders on classification (Ettin: 150M encoder > 400M decoder) [V]; fine-tuned: **untested** | spans + templates; writer optional | **0.3–0.6 / ~1 s** [I from M] | **0.22 GB** [M] | MIT / Apache | yes (`modern-bert`; heads in host code) [M] | $5–20 [I] | span-copied values less polished; needs span labels; untested fine-tuned accuracy |
| A (400M) | Ettin: 400M encoder > 1B decoder on MNLI [V]; untested here | as above | 0.8–1.8 / ~2.5 s [I from M] | 0.48 GB [M] | MIT / Apache | yes | $10–30 [I] | as above |
| A′ | as B2 (frozen 0.82) [M] | via LFM3 writer | ~2.5–4.5 / ~6 s (prefill of 250–500 tokens, no decode) [I] | 2.0 GB | LFM | per-token states via `--pooling none` [M]; heads in host | < $50 | LFM cost for every event |
| C | heads as A; generation by a 60–150M decoder | yes, small | ~1–2 / ~3 s [I] | ~0.65 GB [I] | MIT | **new arch in a fork or ONNX** | $300–1,500 + weeks [I] | nobody has trained this shape for this task; adaptation stage |
| X1 Qwen3-1.7B | F1 0.64 test-mini off the shelf [M] | yes | 11.2 / 17.6 s [M] | 2.1 GB [M] | Apache-2.0 | yes | as T1 | weaker base; the Apache fallback |
| X2 Granite-H-1B | parity with its dense twin at 15T tokens [V]; not run by us | yes | slower than dense at 1K on x86 [V] | ~1 GB | Apache-2.0 | yes | as T1 | no quality or speed gain over LFM-class at short context |
| X3 Qwen3.5-0.8B | F1 0.47 test-mini [M]; pure linear attention loses recall [V] | yes | 9.0 / 23.7 s [M] | 0.96 GB [M] | Apache-2.0 | yes | as T1 | weak at this size |
| X4 RWKV-7 1.5B | MMLU 43 vs Qwen2.5-1.5B 61 [V]; Q4 risk [V] | yes | not measured | ~1 GB | Apache-2.0 | yes | as T1 | quality and quantization |
| X5 LFM2-8B-A1B | 3–4B-class quality [C] | yes | slower than dense 1.2B [V] | **~4.7 GB** [V] | LFM | yes | as T1 | RAM budget |
| X6 BitNet 2B | IFEval 53.5, below 1–2B peers [V] | yes | 29 ms/token on i7 [V] | 0.4 GB non-embedding [V] | MIT | bitnet.cpp | as T1 | quality; second runtime |
| X7 Ouro-1.4B | MMLU above Qwen3-1.7B [V] | yes | ~4× decode cost per token [I] | ~1.4 GB | research use [V] | no | — | not deployable |

## 3. What each lever buys (separated)

| Lever | Candidate | Expected effect on the owner's failure categories | Evidence |
|---|---|---|---|
| Prompt | T0 (v1 → v2) | plans 0 → 25–33 %, temporal 0 → 20–33 %, F1 −0.03 | [M] |
| Fine-tuning | T1 | better labels, fewer false memories, slot reuse; no change in cost or calibration | [I], LoRA ≈ full FT at this data size [S] |
| Output format | B1 | ~4× fewer generated tokens; labels as one token each (logprob = probability) | [M] token anatomy |
| Architecture: decisions by heads | A, A′, B2 | decision accuracy: 0.50 → 0.82 already with a frozen backbone on gold | [M] probe, p = 0.013 |
| Architecture: merges by selection | A, A′, B2, C | slot drift and duplicate memories impossible by construction; contradiction as a trained pair decision | [V] BLINK, DECODE, Memory-R1 |
| Architecture: small encoder backbone | A | 8× cheaper reading than LFM3; 9× less RAM; best class for classification at a fixed size | [M] bench; [V] Ettin |
| Architecture: new mixer or SSM backbone | X2–X4 | none measurable at < 2K tokens on CPU | [V] Liquid search, Granite pair |
| Runtime: prompt cache | T0 | p50 −29 % (done) | [M] |
| Runtime: jump-forward, heads in-loop | B2 | −44 % of generated tokens skipped; heads without code tokens | [M] token anatomy; [V] SGLang |

## 4. Feasibility for a small team

| ID | New code | New data | GPU | Elapsed time | Reversible? |
|---|---|---|---|---|---|
| T1 | none (exists) | D2 helps | < 3 GPU-h | days | yes |
| B1 | output decoder + logprob calibration (~300 lines) | D1/D2 rendered | < 10 GPU-h | 1–2 weeks | yes |
| B2 | B1 + llama.cpp fork | same | same | +2–4 weeks | fork upkeep |
| A | encoder provider (heads over per-token states, ~500 lines), span-aware generator, date resolver, templates | D1 spans (generator change), D2 | < 20 GPU-h | 2–3 weeks | yes: a provider behind the same contract |
| A′ | A's heads on LFM3 states | same | < 20 GPU-h | 2–3 weeks | yes |
| C | new architecture + runtime | D1, D2 + general seq2seq | 50–300+ GPU-h | 1–3 months | costly |
| X* | none (swap model) | — | as T1 | days | yes, but no expected gain |

## 5. Risk register

| Risk | Affects | Mitigation |
|---|---|---|
| Generated data overstates every design (template-learnable) | all | gold v2 (≥ 400) and a real-world set decide; never ship on generated-test numbers |
| Span-copied values read badly ("loves early mornings" vs "early mornings: loves") | A | value normaliser rules; optional writer; human rating on D4 |
| A small encoder misses world knowledge ("Monal" is a restaurant, "Q3" is a deadline) | A (150M) | 400M or A′; knowledge mostly not needed for decisions (probe: frozen 137M ties TF-IDF, fine-tuning untested) |
| Teacher-labelled data copies teacher mistakes on jokes and quotes | all trained | gold is hand-labelled; κ agreement; hard-example review |
| Roman Urdu and code-switching | A (English encoders) | mmBERT-base (multilingual, 406 MB RSS [M]) |
| LFM license threshold | T*, B*, A′, writer in A | A's decision stage is MIT/Apache; the writer can be swapped for an Apache model |
| llama.cpp fork drift | B2, C | prefer designs that run on upstream (A, A′, B1) |

## 6. Summary

* **Backbone changes (X1–X7)** offer no measurable gain for this workload;
  LFM3 stays the best general decoder we have.
* **Fine-tuning alone (T1)** is cheap and will help, but leaves the cost and
  the calibration problem where they are; it is the control every design
  must beat.
* **Moving decisions into heads** is the change with measured support
  (0.50 → 0.82 on gold with a frozen backbone).
* **Design A** is the only candidate that is simultaneously the best class
  for decisions, 6–35× faster per batch than today and 4–9× smaller in RAM
  (400M / 150M encoder),
  license-free, and runnable on upstream llama.cpp. Its open question is
  whether a fine-tuned 150–400M encoder matches the frozen-LFM3 probe on
  hand-written text; experiment E3 answers it for under $50, and A′ (LFM3
  as the decision backbone) is the measured fallback inside the same
  architecture.
