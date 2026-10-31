# Analysis results (measured 2026-10-31)

Machine: Intel Xeon @ 2.80 GHz, 4 cores, AVX-512, 16 GB RAM, no GPU.
llama.cpp `aa588a3`. One job on the CPU at a time.

## 1. Output token anatomy (`token_anatomy.py`)

LFM3-1.7B QAD Q4_0, prompt v2, its own tokenizer.

| | test-mini (92) | gold (39) |
|---|---|---|
| Tokens per answer | 150.5 | 139.5 |
| JSON structure and keys | 66.9 (44.5 %) | 59.5 (42.6 %) |
| Decision values (kind, certainty, about, importance) | 23.7 (15.8 %) | 20.8 (14.9 %) |
| Free text | 59.8 (39.8 %) | 59.3 (42.5 %) |
| of which `text` sentence | 25.4 | 25.2 |
| of which `value` | 17.0 | 16.3 |
| of which `slot` | 9.0 | 8.7 |
| of which `until` | 6.3 | 7.2 |
| Observations per answer (raw) | 2.07 | 1.79 |

```
python3 -I token_anatomy.py ml/results/details/local_lfm3-1.7b-qad-q4-test-mini-p2.jsonl   # needs llama-server on :18090 with the model
```

## 2. Failure taxonomy (`failure_taxonomy.py`)

LFM3-1.7B QAD Q4_0, prompt v2.

| | test-mini | gold |
|---|---|---|
| Gold memorable / matched | 72 / 58 | 33 / 22 |
| Missed / extra kept | 14 / 16 | 11 / 8 |
| Kind wrong on matched | 15 (26 %) | 11 (50 %) |
| Certainty wrong on matched | 13 (22 %) | 9 (41 %) |
| Plans missed / date wrong when found | 6 of 8 / 0 | 2 of 3 / 0 |
| Brain action differs from gold | 7 of 32 | 7 of 17 |
| Observations dropped by the guard | 116 (73 ungrounded, 28 low importance, 14 outside text as user preference, 1 injection) | 40 |

## 3. Decision probe (`decision_probe.py`, raw output in `decision_probe-results.json`)

Logistic regression (C = 4, class-balanced) on 3,000 training examples, the
events' text only. Decision label per example: none, plan, stated, implied,
temporary, joking, hypothetical, quoting. Generative = LFM3's own answer
(highest-importance item; "after guard" uses what the guard kept).

| Decision accuracy | test (757) | test unseen (154) | test-mini (89) | gold (34) |
|---|---|---|---|---|
| TF-IDF (word + char n-grams) | 0.971 | 0.864 | 0.966 | 0.706 |
| nomic-embed v1.5 (137M encoder, frozen, mean-pooled) | 0.974 | 0.916 | 0.989 | 0.706 |
| LFM3-1.7B QAD (frozen, mean-pooled hidden states) | **0.984** | **0.922** | 0.989 | **0.824** |
| LFM3-1.7B QAD generating (raw / after guard) | – | – | 0.607 / 0.528 | 0.471 / 0.500 |

| Kind accuracy | test (614) | test unseen (134) | test-mini (77) | gold (26) |
|---|---|---|---|---|
| TF-IDF | 1.000 | 1.000 | 1.000 | 0.846 |
| nomic-embed (frozen) | 0.992 | 0.985 | 1.000 | 0.808 |
| LFM3 (frozen) | 0.982 | 0.955 | 1.000 | 0.808 |
| LFM3 generating (raw / after guard) | – | – | 0.571 / 0.571 | 0.500 / 0.500 |

Paired exact McNemar tests against the generative model (after guard), gold:

| Probe | Decision: probe-only right / generative-only right, p | Kind: same, p |
|---|---|---|
| TF-IDF | 14 / 7, p = 0.19 | 10 / 1, p = 0.012 |
| nomic (frozen) | 13 / 6, p = 0.17 | 10 / 2, p = 0.039 |
| LFM3 (frozen) | 14 / 3, **p = 0.013** | 10 / 2, p = 0.039 |

Reading:
* The same LFM3 network, read through a linear layer trained in seconds on
  generated data, decides correctly far more often on hand-written text than
  when it generates the answer itself (0.82 vs 0.50, p = 0.013). The
  information is in the representation; generating labels is the weak link.
* The generated data is template-learnable: TF-IDF reaches 0.97–1.00 on it.
  Only gold (and later real-world data) separates the candidates.
* A frozen 137M embedding model without any task training already matches
  TF-IDF on gold; fine-tuning (E3) is what the encoder design needs.
* Caveats: 34 / 26 gold examples; one decision per example (multi-item
  examples excluded); the generative label is a heuristic over its items.

## 4. Encoder vs decoder cost on CPU

`llama-bench -p 128,256,512 -n 0 -t 4` (prompt processing only), and peak
RSS of `llama-server --embedding --pooling none` after one ~300-token input.
Encoder GGUFs: third-party Q8_0 conversions (keisuke-miyako/ettin-encoder-gguf,
keisuke-miyako/mmBERT-base-gguf-q8_0), used for timing only.

| Model | Params | File | 128 tok | 256 tok | 512 tok | Peak RSS |
|---|---|---|---|---|---|---|
| Ettin-encoder-150m (ModernBERT-base shape) | 150M | 151 MB | 178 ms | 286 ms | 599 ms | 219 MB |
| mmBERT-base (multilingual, 256K vocab) | 307M | 311 MB | 207 ms | 410 ms | 970 ms | 406 MB |
| Ettin-encoder-400m (ModernBERT-large shape) | 395M | 400 MB | 428 ms | 805 ms | 1759 ms | 480 MB |
| LFM3-1.7B QAD Q4_0 (prefill) | 1.7B | 993 MB | 1078 ms | 2285 ms | 4775 ms | ~1990 MB (server) |

At 4 threads the 150M encoder reads text ~8× faster than LFM3 prefills it,
the 400M encoder ~2.7× faster; neither has to generate anything.
