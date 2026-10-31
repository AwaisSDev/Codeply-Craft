# Experiment roadmap

How to find out, with numbers, whether a proposed architecture
(`PROPOSED-ARCHITECTURES.md`) is better than today's best: LFM3-1.7B QAD
Q4_0 with prompt v2. Labels: [M] measured, [I] estimate.

## 1. Rules for every experiment

1. **One harness.** Every candidate runs through `ml/eval/run.mjs` (or a
   provider plugged into it): same events, same redaction, same guard, same
   fresh brain, same metrics. A non-generative design is a new provider
   that returns the extraction contract.
2. **Identical conditions.** Same sets, same known memories, same `now` and
   time zone, temperature 0, same machine, one model job at a time, threads
   fixed (4), the prompt cache warm for decoders (as in production).
3. **Splits never mix.** Train, validation and test come from separate
   seeds and held-out templates (`unseen`); gold and real-world sets are
   never used for training, prompt tuning or threshold picking. Calibration
   temperatures and the importance threshold are fitted on validation only.
4. **Template overfitting is measured, not assumed.** Report every metric on
   generated test, its unseen-template part, gold and real-world separately.
   A design that gains on generated test and not on gold has learned the
   templates. (A bag-of-words classifier already reaches 97–100 % on the
   generated test set and drops on gold [M, `analysis/decision_probe.py`].)
5. **Uncertainty is reported.** 95 % bootstrap intervals for every rate;
   McNemar's test for paired decision accuracy between two candidates on the
   same examples; three seeds for every training run.
6. **Prompt, fine-tuning, architecture and runtime changes are separated.**
   Each comparison changes one of them; the result table names which.

## 2. Datasets

| ID | Set | Size | Use | Status |
|---|---|---|---|---|
| D0 | Generated train / val / test / test-mini (seed 7) | 8000 / 800 / 800 / 92 | train / select / test | exists |
| D1 | Generator v2: the same tasks with **character spans** for value, time, person and plan phrases, and memory ids for merge targets | same sizes | trains heads (Designs A, C) | change to `ml/data/generate.mjs`; labels stay exact |
| D2 | Teacher-paraphrased and free-form events (a strong model rewrites user lines of D1 with labels fixed, and writes free-form chats, emails and transcripts which the teacher labels), filtered by the guard, 10 % hand-checked | 20k–50k | training realism | ~$3–40 with a cheap API teacher, ~$100–1,000 with a frontier one [I] |
| D3 | **Gold v2**: hand-written, double-annotated, ≥ 400 examples, at least 30 per failure category: jokes, sarcasm, hypotheticals, quotes, reported speech, plans with relative dates, temporary context, contradictions, duplicates, refinements, noise, emails with injections, secrets, people facts, projects, Roman Urdu, multi-item | 400+ | the primary test | to write (2–3 person-days) |
| D4 | **Real-world**: opt-in events from the team's own use of Codeply (chats, mail, heard), redacted, labelled by two people, frozen | 200–500 | the final test | needs consent and the Life collectors |

Gold v2 is the most important item on this page: today's gold has 39
examples, so a single rate measured on it (say 70 %) has a 95 % interval of
about ±15 points. With 400 examples it shrinks to about ±5 points overall
(per-category rates on 30 examples stay at about ±16, so categories are
compared in groups).

Inter-annotator agreement (Cohen's κ per field) is reported for D3 and D4;
a field with κ < 0.6 is redefined before it is used to rank models.

## 3. Metrics

All existing metrics (`ml/eval/README.md`) plus the ones the new designs make
measurable:

| Group | Metric |
|---|---|
| Extraction | precision, recall, F1 of memorable observations; F1 on unseen templates; per-kind F1 |
| Decisions | accuracy and macro-F1 of the per-example decision (none, plan, stated, implied, temporary, joking, hypothetical, quoting); kind accuracy; certainty accuracy |
| Filtering | noise rejection; false-memory rate (jokes, hypotheticals, quotes kept as memorable) |
| Plans | plan recall and precision; plan vs observation confusion; date and time accuracy |
| Memory | brain-action agreement with gold (added, reinforced, replaced, challenged, ignored); contradiction detection P/R; duplicate detection P/R |
| Calibration | expected calibration error (10 bins) of certainty and of "memorable"; Brier score |
| Format | valid contract rate (target 100 %) |
| Safety | secrets reaching memory (must be 0); injected instructions followed (must be 0) |
| Cost | ms per batch p50 / p95; tokens generated per batch; peak RSS; model files on disk; CPU-seconds per event; share of events that stop at the gate |
| Energy | CPU-seconds per 100 events (proxy); package energy from RAPL (`/sys/class/powercap`) where the machine exposes it |

## 4. Experiments

Ordered so that the cheap ones can stop the expensive ones.

### E0. Freeze the baseline (CPU, 1 day, $0)
LFM3-1.7B QAD Q4_0, prompt v2, on test (800), gold v2 (D3) and, when it
exists, D4. Also Qwen3-1.7B (Apache fallback) on the same sets. These are
the numbers every design must beat.

### E1. Encoder cost on our CPU (CPU, hours, $0)
`llama-bench` prompt processing for Ettin-encoder-150m / 400m and mmBERT-base
(Q8_0) at 128–1024 tokens, against LFM3's prefill, plus RSS. Partly done
here (§5 of `PROPOSED-ARCHITECTURES.md`). Success: a 400M encoder pass over
a 512-token input under 1 s at 4 threads.

### E2. Frozen-feature probes (CPU, hours, $0)
Linear probes on frozen encoder and decoder states for the per-example
decision and kind (done here, `analysis/decision_probe.py`). Extend to:
(a) the merge decision on (new statement, known memory) pairs; (b) span
tagging with a per-token linear layer. Tells us which backbone carries the
signal before any GPU is rented.

### E3. Design A, stage 1: fine-tune the encoder with heads (1 GPU, $5–20)
* Data: D1 (+ D2 when ready). Model: Ettin-encoder-150m and -400m, mmBERT-base
  for Roman Urdu. Full fine-tuning, multi-task loss, 3 seeds.
* GPU: one 24 GB card (RTX 4090 / L4 / A10G) or a Kaggle T4; < 2 h per run
  [I].
* Values copied from spans, dates by the resolver, text templated; no writer.
* Success (on gold v2, vs E0): decision accuracy +15 points or more;
  certainty accuracy ≥ 85 %; false memories ≤ 10 %; plan recall ≥ 80 %;
  merge-action agreement ≥ 85 %; calibration error ≤ 0.05; p95 ≤ 1.5 s per
  batch; RSS ≤ 600 MB.

### E4. Design B1: LFM3 with the compact code output (1 GPU, $15–50)
* LoRA SFT (r = 32, all projections) on D1/D2 rendered in the compact
  format, then the same eval. 3 seeds.
* Also the plain-JSON fine-tune (today's `config-lfm3.yaml`) as the
  "fine-tuning only" control: this separates the gain from fine-tuning
  from the gain from the output format.
* Success: the same decision bars as E3; generated tokens per batch ≤ 50;
  p95 ≤ 8 s.

### E5. Head-to-head and ablations (CPU, 2 days, $0)
A vs B1 vs the plain fine-tune vs E0 on test, gold v2 and D4, with the
paired tests from §1. Ablations: A with and without the merge head (slot
generated by the writer instead), A with and without the gate, B1 with
JSON vs codes. Output: one table per metric group with intervals.

### E6. Reinforcement with exact rewards (1–4 GPUs, $40–400)
GRPO (or DPO on the winner's own mistakes) with a reward computed against
gold labels: decision correct, merge action correct, date correct, no
false memory. Applies to the decoder (B) or the writer (A); for the encoder
the equivalent is hard-example mining. Success: false memories and merge
errors halved again without losing recall.

### E7. Quantization (1 GPU, $5–160)
Encoder: INT8 post-training, compare with F16 on gold (expected < 1 point
loss [I]). Decoder: QAD to Q4_0 (Liquid's recipe or QAT with the BF16 model
as teacher), compare Q4_K_M, Q8_0 and QAD Q4_0.

### E8. Runtime (CPU, days of engineering, $0)
For the decoder path: jump-forward over grammar-forced tokens and n-gram
self-speculation in llama.cpp; heads on hidden states (B2). Measure p50/p95
before and after on the same answers.

### E9. Design C, only if triggered (GPUs, $300–1,500 + 4–8 weeks)
Run only if E5 shows that copied spans lose clearly on value quality
(human rating of values on D4) **and** B1 misses the latency bar. Stage 1
adaptation of an Ettin decoder to cross-attention on general seq2seq data
plus teacher distillation (1–5B tokens), then E3/E6-style task training.

## 5. Compute and cost summary

| Experiment | Hardware | Time | Cost |
|---|---|---|---|
| E0, E1, E2, E5, E8 | this CPU / any laptop | ~1 week elapsed | $0 |
| D2 teacher data | API | hours | $3–1,000 depending on teacher |
| D3 gold v2 | people | 2–3 person-days | — |
| E3 | 1 × 24 GB GPU or Kaggle | < 2 h per run, 3 seeds × 3 encoders | $5–20 |
| E4 | 1 × 24–80 GB GPU | 1–3 h per run, 3 seeds × 2 formats | $15–50 |
| E6 | 1–4 GPUs | 10–100 GPU-h | $40–400 |
| E7 | 1 GPU | a few hours | $5–160 |
| E9 (conditional) | 4–8 GPUs | days | $300–1,500 |
| **Total without E9** | | **~3–4 weeks elapsed** | **~$70–1,600** |

GPU prices from aggregators, Oct 2026 [S]: H100 $2.2–4.3/h, A100 80GB
$1.4–2.8/h, L40S $0.8–1.1/h, RTX 4090 $0.34–0.89/h.

## 6. Release gate v2

A model or compound model ships when, on gold v2 and the real-world set
(each with 95 % intervals reported):

| Bar | Value |
|---|---|
| Valid contract | 100 % |
| Secrets reaching memory | 0 |
| Injected instructions followed | 0 |
| Extraction F1 (gold v2) | ≥ 0.80 and ≥ E0 + 0.10 |
| Extraction F1 (real-world) | ≥ 0.75 |
| Certainty accuracy | ≥ 85 % |
| False-memory rate | ≤ 10 % |
| Noise rejection | ≥ 90 % |
| Plan recall / date accuracy | ≥ 80 % / ≥ 95 % |
| Memory-action agreement | ≥ 85 % |
| Calibration error (memorable) | ≤ 0.05 |
| p95 latency per batch, 4 cores | ≤ 10 s (≤ 2 s for the gate stage) |
| Peak RSS of all model processes | ≤ 2 GB |

The current gate (`ml/finetune/gate.mjs`) has F1 ≥ 0.80 on generated data;
LFM3 off the shelf already scores 0.80–0.83 there, so the bar must move to
gold v2 and real-world data to mean anything.
