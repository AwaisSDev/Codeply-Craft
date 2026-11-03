# Model card: Codeply memory model v1 (LFM3-1.7B, fine-tuned)

**Status: release candidate, not shipped.** Final numbers for the exported
artifact are filled in from `results/` once the post-export evaluation is
done; until then the numbers below are from the same weights with the
adapter applied at load time (`research/dtw/LORA-RESULTS.md`).

## What it does

Reads a batch of conversation events (chat turns, notes) with Codeply's
extraction prompt (prompt v2, **full style**) and answers with JSON under the
extraction schema: observations (kind, slot, value, text, certainty,
importance, about, project, until) and plans. The answer then goes through
the production guard (`context-schema.js`) and the Brain decides what to
store. It replaces the prompt-only base model `lfm3-1.7b-qad-q4` as the
local extraction backend.

## Model

| | |
|---|---|
| Base | LiquidAI/LFM3-1.7B, revision `ac2586a3` (LFM Open License v1.0) |
| Fine-tuning | LoRA r 32, alpha 64, dropout 0.05, on q/k/v/o, in_proj/out_proj, w1/w2/w3 (`ml/finetune/config-lfm3.yaml`); 2 epochs, effective batch 16, lr 2e-4 cosine, max 2,048 tokens; fp16 on a T4 |
| Data | frozen realistic train split, 4,072 examples after truncation (`research/dtw/data/real`, `SPLIT.json` hashes), Claude-labelled; full-style prompt |
| Seeds | 1 and 2 trained (val loss 0.1125 / 0.1129); seed 3 pending GPU quota |
| Export | merged (PEFT `merge_and_unload`, fp16), GGUF f16, importance matrix on 200 × 2,048 tokens of the realistic val prompts, **Q4_K_M** (shipping) and Q8_0 |
| Runtime | llama.cpp `llama-server` at commit `aa588a3` (Codeply runtime), `--swa-full`, `-ctk q8_0 -ctv q8_0`, ctx 8,192, `enable_thinking: false`, JSON Schema decoding |

## Evaluation (frozen sets, never tuned on)

Mean of seeds 1-2, adapter at load time on the LFM3 Q4_K_M base (final
exported-artifact numbers: see `results/EXPORT-PARITY.md`).

| | test-real (549) | Benchmark-520 | natural-300 (20 gold, supporting) |
|---|---|---|---|
| F1 / precision / recall | **0.657** / 0.78 / 0.57 | **0.653** / 0.73 / 0.59 | 0.445 / 0.61 / 0.35 |
| vs production LFM3 (paired bootstrap, 95 %) | +0.356 (+0.298, +0.412) | +0.079 (+0.045, +0.115) | +0.352 (+0.084, +0.598) |
| Kind / certainty accuracy | 0.86 / 0.88 | 0.80 / 0.85 | 0.93 / 1.00 |
| False-memory rate | 0.30 | 0.30 | 0.17 |
| Secrets stored (Benchmark-520) | – | 0 / 13 (production 5) | – |
| Median / p95 latency, 4 CPU threads | 5.5 s / 21.9 s | 6.1 s / 19.9 s | 2.8 s / 7.3 s |

The gain is from fine-tuning: the untrained model on the same base file
scores 0.317 on test-real. The lead holds on the user-disjoint part of
test-real (+0.365 against production).

## Limitations

* **Jokes and quotations are not recognised as such** (it almost never
  outputs `joking` or `quoting`; `JOKES-AND-QUOTES.md`). About a third of
  jokes and quotes are stored as facts, the same rate as the production
  model. Fix: v2 with more joke/quote training data.
* **Precision 0.73-0.78**: about one stored memory in four is wrong or not
  in the gold. The automatic / pending / discard tiers (`TIERS.md`) are the
  mitigation.
* **Latency**: seconds per batch on CPU (p95 ~20 s); fine for background
  extraction (the engine runs at a 25 % duty cycle), not for interactive use.
* **Language**: trained mostly on English, with some Urdu and mixed
  Roman Urdu; other languages untested.
* **Two seeds**, not the protocol's three.
* **Training data rights**: most training examples come from WildChat-1M;
  licensing and privacy questions are open (`WILDCHAT-OPEN-ISSUES.md`).
* Long inputs: trained up to 2,048 tokens per example; batches are capped
  by the engine's token budget (1,800).

## Deployment requirements

* Disk: ~1.1 GB (Q4_K_M). RAM: llama-server with the model, ctx 8,192,
  q8_0 KV cache (measured peak in `results/`).
* CPU: 4 threads used in all measurements; no GPU needed.
* Codeply runtime: `llama-server` at llama.cpp `aa588a3` or a version known
  to run LFM3 (tri-hybrid conv + attention) with `--swa-full`.
* The **full** prompt style (the catalog entry sets `style: 'full'`); the
  compact prompt was never trained and must not be used with this model.

## Attribution

Fine-tuned from LFM3-1.7B (Liquid AI, LFM Open License v1.0). Training data
contains information from WildChat-1M, which is made available under the
ODC Attribution License (ODC-BY 1.0), and from MultiWOZ 2.2 (MIT),
Topical-Chat (CDLA-Sharing 1.0) and the UCI Roman Urdu Data Set (CC BY 4.0).
