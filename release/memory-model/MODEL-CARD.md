# Model card: Codeply memory model v1 (LFM3-1.7B, fine-tuned)

**Status: release candidate, not shipped.** Artifact
`codeply-memory-lfm3-s1-Q4_K_M.gguf` (seed 1), 1,099,627,456 bytes, SHA-256
`7360aaed7410cac445d9901f8a85b876bee6b76d1cb83b05404480b5b9ac14f9`, private
Kaggle dataset `awaissididique/codeply-memory-model-gguf` (`s1.tar`).
Full evaluation: `results/EXPORT-PARITY.md`.

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

The shipped artifact (exported seed 1, Q4_K_M), through the production
local backend on 4 CPU threads:

| | test-real (549) | Benchmark-520 |
|---|---|---|
| F1 / precision / recall | **0.658** / 0.792 / 0.563 | **0.675** / 0.733 / 0.624 |
| vs production LFM3 (paired bootstrap, 95 %) | +0.358 (+0.302, +0.414) | +0.100 (+0.064, +0.136) |
| vs the adapter at load time (export loss) | (−0.029, +0.057) | (−0.007, +0.038) |
| Kind / certainty accuracy | 0.86 / 0.89 | 0.78 / 0.82 |
| False-memory rate | 0.25 | 0.24 |
| Secrets stored / injections followed | – | 1 / 13 (production 5) / 1 / 11 |
| Median / p95 latency | 3.3 s / 15.5 s | 5.5 s / 18.8 s |
| Peak memory (llama-server) | 1,944 MB | 1,972 MB |

Integration suite (48 live cases through the production path): 41 / 48
(production LFM3 35 / 48); malformed backend output 18 / 18. The gain is
from fine-tuning: the untrained model on the same base scores 0.317 on
test-real. Seeds 1 and 2 with the adapter at load agree (mean 0.657 /
0.653), so seed 1 is not a lucky draw.

## Limitations

* **Jokes and quotations are not recognised as such** (it almost never
  outputs `joking` or `quoting`; `JOKES-AND-QUOTES.md`). About a third of
  jokes and quotes are stored as facts, the same rate as the production
  model. Fix: v2 with more joke/quote training data.
* **Precision 0.73-0.79**: about one stored memory in four is wrong or not
  in the gold. On Benchmark-520 precision (0.733) is below the 3:1
  break-even (0.75). The tiers (`TIERS.md`) are the mitigation; at 3:1 the
  frozen rule puts everything in the automatic tier.
* **Duplicates**: a known fact is often not repeated, or is rephrased, so the
  Brain replaces or adds instead of reinforcing (integration suite 1 / 4,
  production 0 / 4). This slows promotion of pending memories by
  recurrence.
* **Roman Urdu**: a wedding announcement was missed and a Roman Urdu joke
  stored as fact in the integration suite.
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

* Disk: ~1.1 GB (Q4_K_M). RAM: llama-server peak ~2.0 GB (ctx 8,192,
  q8_0 KV cache).
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
