# Experiment plan: does the store interface matter, and is anything memory-native left?

Pre-registration draft for `02-ARCHITECTURE-PROPOSAL.md`. It extends, and does
not change, the frozen DTW protocol (`research/dtw/MODEL-SELECTION-PROTOCOL.md`,
`6c21b2a0`): same split, same evaluation sets, same harness, same guard, same
decision order (safety → reliability → accuracy → cost). Tags: [M] measured
here, [V] primary source, [E] estimate.

## 0. Preconditions (before any SRDE training)

1. **The protocol's baselines exist**: Ettin-150M ×3 and Ettin-400M on the
   realistic data, LFM3-1.7B LoRA (Kaggle v3, running), and the template
   Ettin rerun with the corrected resolver. V0 *is* the Ettin-150M baseline.
2. **The fixed secret guard** (`claude/wonderful-feynman-y2ldw2`) is available
   to run every system behind it.
3. **The owner confirms c_FP : c_FN** for the calibrated operating point
   (proposed 3 : 1) before any test result is seen.

## 1. Track A: the store interface (short inputs, data we have)

### Systems

| ID | System | Training data | Seeds |
|---|---|---|---|
| S0 | Rules | none | – |
| S1 | LFM3-1.7B QAD, prompt v2 (production) | none | – |
| S2 | LFM3-1.7B LoRA | frozen train + the store augmentation rendered as known memories in its prompt | 3 (protocol) |
| S3 = V0 | Ettin + Decide heads, flat store, sparse pointer | frozen train + store augmentation | 3 |
| S4 = V1 | Ettin, flat store, **dense per-record readout** | same | 3 |
| S5 = V2 | Ettin, **cached set store, gated cross-attention** | same | 3 |
| S5+ | V2 after record-alignment pre-training (§5, Option A+) | same | 3 (only if S5 under-trains) |
| S6 = V3 | pairwise cross-encoder (upper bound, ×K cost) | same | 1 |
| – | M1c (chunked Ettin) | – | **identical to S3 on every current set** (all inputs fit one window [M]); reported as such, not rerun |
| – | PASTE | – | **not built**: its own trigger (M1c failing on long inputs) cannot occur on any available data [M]; see critique §2 |

Backbones for S3-S5: Ettin-150M (main, 3 seeds), Ettin-32M (3 seeds; all
ablations), Ettin-17M and -68M (1 seed; scaling curve). All Ettin sizes share
recipe and data, so size is the only change.

**Fairness**: S2-S6 train on byte-identical data (frozen train + the same
augmented stores), select checkpoints on the same validation split, run
behind the same guard and harness, and are calibrated by the same procedure
(§3). The store augmentation is built once, from the frozen splits only.

### Data additions (derived; the frozen split is not modified)

| Set | Built from | Size | Labels | Use |
|---|---|---|---|---|
| store-augmented train / val | frozen train / val, records sampled within the same split | 4,096 / 478 examples, K ~ U{0,4,8,16} | reinforce / update / challenge / untouched by construction; "different value" pairs relation-checked by Claude | training, model selection |
| **store stress test** | frozen **test** split only | ~550 examples × K ∈ {0, 4, 8, 16, 32, 64} + counterfactual swaps + 5 record orders → ≥ 5,000 record decisions | same construction, relation-checked | secondary evaluation: scaling, counterfactual reading, permutation |
| jokes / quotes top-up (recommended, not SRDE-specific) | WildChat screened for sarcasm and reported speech, new families only, assigned to splits by the frozen family rule | 300-600 | Claude labels, 10 % hand-checked | fixes the 15 / 11 coverage gap [M] for **every** system |

Leak checks re-run on every derived file (families in two splits, benchmark
overlap, natural-300 overlap), as `split.py` does.

### Ablations (Ettin-32M, 3 seeds each)

| Ablation | Question |
|---|---|
| V2 without record ← token update | does two-way reading matter |
| V2 without type / status / age embeddings | does record metadata matter |
| V2 with positional order on records | is set structure (permutation equivariance) doing the work |
| V2 with random (not zero) gate init | does function-preserving start matter at ~5K examples |
| V2 with |X| = 2 vs 4 fused layers; d_x 128 vs 256 | capacity |
| V1 without shuffling records | SOM-DST's shuffle effect |
| V1 with sparse (V0-style) supervision but per-record head | readout vs supervision density |

## 2. Track B: closed-loop multi-session memory (conditional)

The one memory-specific question the literature leaves open (critique §7.3):
does a writer trained on **its own predicted store** across sessions beat one
trained on gold stores, and do learned retention signals beat the Brain's
evidence/TTL rules?

Data (licences [V]): LongMemEval (MIT; 500 histories, 78 knowledge-update
questions, per-turn evidence flags), PersonaMem (MIT), Conversation
Chronicles (CC BY 4.0; 1M LLM-generated multi-session episodes) for training
rollouts. WildChat-1M has `hashed_ip`, `header` and timestamps that the
authors say could link conversations of one user; **evaluation only, after a
privacy and legal review**; never train on linked histories. LoCoMo,
HaluMem, PerLTQA are non-commercial and excluded.

Experiments: open-loop (gold prior store) vs scheduled-sampling closed-loop
training of the Track A winner; metrics after N sessions: store exact match,
duplicate rate, stale-value rate, accumulated false memories, compared with
the Brain's deterministic rules. Starts only after Track A, and only if the
owner wants multi-session behaviour optimised.

## 3. Metrics, statistics, decision rules

Every metric from the brief, per system: extraction P/R/F1; false-memory rate;
natural-300 false positives (silver, plus the protocol's human review);
kind and certainty accuracy; plan F1 and date accuracy; merge / update
accuracy; temporary context; secret leakage and injection resistance (raw
and behind the fixed guard); p50 / p95 latency, peak RAM, CPU seconds per
example (4 threads, one job at a time); parameter count. Added for this
question: per-record operation accuracy, wrong-target rate, counterfactual
flip-following rate, permutation flip rate, write PR-AUC and precision at
recall 0.8 at natural prevalence, latency as a function of K.

Statistics: hierarchical paired bootstrap (resample seeds, then examples;
10,000 replicates); exact McNemar on paired units; Holm correction over the
three primary contrasts (V1 vs V0, V2 vs V1, best SRDE vs S2). Benchmark-520
has 141 merged observations [M], so merge claims at ±~8 points come from the
stress test (≥ 5,000 decisions) and are *confirmed*, not established, on the
benchmark.

Decision rules (frozen before results):
1. Safety gate unchanged from the protocol.
2. V1 replaces V0 if per-record operation accuracy or wrong-target rate
   improves (CI excludes 0) on the stress test *and* on Benchmark-520 merge
   cases does not get worse, with no significant loss in extraction F1 and
   no rise in false memories.
3. V2 replaces V1 only with ≥ 5 points operation accuracy at K ≥ 16 or ≥ 30 %
   lower p95 at K = 32 at equal accuracy (V2 needs a new runtime).
4. The final Ettin variant against S2 (LFM3 LoRA) by the protocol's rule; if
   not significantly different on reliability and accuracy, the cheaper wins.
5. If V0 ≈ V1 ≈ V2: report that the store interface does not matter at this
   scale and store size; recommend data and calibration work instead.

## 4. Compute and cost (Track A)

| Item | Basis | Estimate |
|---|---|---|
| Ettin-150M run (3 epochs) on a Kaggle T4 | measured: 120 optimizer steps (effective batch 32) in 323 s, i.e. ~6 min per epoch [M, run 2 log]; +45 % tokens for flat stores (mean K ≈ 7 × ~15 tokens) | ~30-35 min incl. validation and export |
| Ettin-32M / 17M run | ~4× / ~7× cheaper per token [E, parameter ratio] | ~10 / ~6 min |
| Main matrix: S3-S5 × 150M × 3 seeds | 9 runs | ~5 GPU-h |
| 32M: S3-S5 × 3 seeds + 9 ablations × 3 seeds | 36 runs | ~6 GPU-h |
| Scaling points (17M, 68M) and S6 | ~8 runs | ~3 GPU-h |
| S2 LFM3 LoRA ×3 with augmented stores | protocol run, micro-batch 1 × 16 on T4 | ~2-3 GPU-h per seed [E] |
| **Total GPU** | | **~20-25 T4-hours** (Kaggle's free quota is ~30 h / week [V, earlier research]) |
| Relation checks for constructed pairs | ~3,000-4,000 short pairs; the realistic labelling cost ~$36 for ~5,000 long examples [handover] | **~$10-25** |
| Jokes / quotes top-up | 300-600 examples screened and labelled | ~$10-20 |
| CPU evaluation (this container) | Ettin-150M reads 256 / 512 tokens in 0.29 / 0.60 s at 4 threads [M]; ~550 test + 520 bench + 298 natural + stress ~3,300 calls per system | ~1-2 h per system |
| Engineering | augmentation + stress set; V1 heads (provider already supports per-token heads); V2 module + ONNX export; analysis | ~1.5-2 weeks |

Ettin-32M runs also fit this 4-core CPU (~375 tokens/s forward + backward
for 150M [M], ~4× faster for 32M), so the ablation grid does not depend on
Kaggle availability.

## 5. Option A vs Option B: honest estimates

**Option A: pretrained initialisation (recommended).** Ettin weights for
everything that exists in Ettin; only the new parts (V1 heads ~1.8M; V2
cross-attention ~3-6M; type embeddings) start fresh. V2's fused layers start
as the identity (zero gates), so ~5K labelled examples train ~3-8M new
parameters on top of a model that already reads language.

**Option A+ (if V2 under-trains):** a short intermediate stage that teaches
record ↔ conversation alignment before the task: masked record-field
prediction and record-utterance contrastive matching on persona-grounded
dialogue with commercially usable licences (Synthetic-Persona-Chat CC BY 4.0,
20K; ConvAI2 CC BY 4.0; SODA CC BY 4.0). ~50-100M tokens ≈ 5-10 T4-hours at
the measured ~2.8K tokens/s for 150M [E from run 2: 128 × 32 × ~240 tokens
per ~345 s]. No new labels.

**Option B: genuine scratch training.** What "from scratch" costs [V]:
Ettin-17M used ~1.7T pretraining tokens and ~6 days on 4×H100 (~580
H100-hours); ModernBERT-base ~1,965 H100-hours; NeoBERT ~6,000 GPU-hours;
ELECTRA-Small 4 V100-days for GLUE 79.9; Cramming a BERT-base-size model in
24 h on one consumer GPU gives GLUE ~78 vs 80.9 fully trained; **BERT-base
with no pretraining: GLUE 45.5**. Our labelled data is ~1M tokens [M], six
orders of magnitude below a pretraining budget; a randomly initialised
20M-150M model trained only on it would not learn the language it has to
judge.

A scientifically valid scratch experiment is an **equal-budget pair**:
pretrain V0's architecture and V2's architecture from scratch with the same
data and FLOPs, then fine-tune both identically. Example at 32M, ELECTRA-style,
~20B tokens of permissive conversational text (WildChat user turns ODC-BY,
Topical-Chat, SODA, Synthetic-Persona-Chat): ~6·N·D ≈ 3.8e18 FLOPs per model
≈ 7-15 H100-hours each with the ELECTRA generator [E] ≈ $50-150 for the pair
plus data-pipeline work (~1 week). Both would land well below Ettin-32M
(trained on 1.7T tokens), so the result answers "does the store prior help at
equal pretraining", not "what should ship". Recommended only if Track A shows
a robust V2 effect worth isolating.

## 6. Order of work

1. Wait for Kaggle v3 (S3 baselines, S2 LoRA); rerun template Ettin with the
   corrected resolver (protocol item).
2. Owner decisions: c_FP : c_FN; Track B yes/no; WildChat linkage review.
3. Build the store augmentation, the stress test and the jokes/quotes top-up
   (labels via the existing labeller pipeline, `research/dtw/label/`); leak
   checks.
4. V1 (no runtime change) on Ettin-32M CPU smoke, then the Kaggle matrix.
5. V2 + ONNX latency prototype; ablations.
6. Evaluate, report with the decision rules above; Track B only if decided.
