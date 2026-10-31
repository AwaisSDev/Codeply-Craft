# Proposed architectures

Three designs that follow from the evidence in `ARCHITECTURE-RESEARCH.md`,
from least to most new engineering, plus the directions we examined and
rejected. Labels: [M] measured by us, [V] verified source, [C] claim,
[S] secondary, [I] inference / estimate.

All three keep the existing contract around the model: events in, the
guard (`checkExtraction`) and the brain (`brain.observe`) after. What
changes is what the model is and what it outputs.

## Design principles (from the evidence)

1. **Decide with heads, write only words.** Kind, certainty, importance,
   plan-vs-observation and "which memory does this update" are
   classification or selection; produce them with trained heads in one
   pass, not by generating label tokens (ARCHITECTURE-RESEARCH §1.2, §4.1).
2. **Select, don't re-name.** A new observation points at an existing memory
   id (or NEW); the slot name is inherited, so merges cannot drift (§4.2).
3. **Compute dates, don't generate them.** A time-expression span plus a
   deterministic resolver against "now" and the time zone.
4. **Spend compute where it matters.** A cheap gate discards nothing-to-keep
   events before any expensive stage (§3.5).
5. **Reuse pretrained backbones and existing runtimes.** No pretraining, no
   new kernels unless a measurement demands it (§5, §6).

## Shared output protocol (all designs)

The brain needs, per observation: kind, slot, value, text, certainty,
importance, project, until, about; per plan: what, when, where, who. In the
proposals these come from:

| Field | Source |
|---|---|
| kind, certainty, about | classification head (softmax, temperature-scaled) |
| importance | ordinal head (5 bins → 0.2 … 0.9), or regression |
| memorable | derived: certainty ∈ {stated, implied, temporary} and importance ≥ threshold |
| merge target | selection head over the K known memories shown + NEW |
| slot | inherited from the selected memory; for NEW, a closed-vocabulary head (the brain's existing slots plus the dataset's ~200 canonical slots) with "other" falling back to a few generated words |
| value | span copied from the events, optionally normalised by the writer |
| text | rendered from a template per kind ("The user prefers {value} for {slot}.") |
| until, plan when | time-expression span + rule-based resolver (now, tz) |
| plan what, where, who | spans (who = person-name spans) + writer for the title |
| project | selection over known projects + none |

## Design A: Decide-then-Write (DtW), a compound model

```
 events + now + top-K known memories (with [M1]..[MK] markers) + known projects
                                │
                     ┌──────────▼───────────┐
 stage 0  (≈ µs)     │ rules pre-filter     │  empty / duplicate / pure small talk → stop
                     └──────────┬───────────┘
                     ┌──────────▼───────────┐
 stage 1             │ ENCODER (bidirectional, ~150–400M, INT8)                      │
                     │  token heads: BIO spans {OBS, PLAN, TIME, PERSON}             │
                     │  span heads: kind · certainty · about · importance            │
                     │  pair head:  span × [Mi]  → {new, same, update, contradict}   │
                     │  event head: "anything to keep?"  → stop early if no         │
                     └──────────┬───────────┘
                     ┌──────────▼───────────┐
 stage 2  (code)     │ resolvers: dates/until from TIME spans; text templates;       │
                     │ slot from selected memory or slot-vocabulary head             │
                     └──────────┬───────────┘
                     ┌──────────▼───────────┐
 stage 3 (only when  │ WRITER (optional): short constrained generation of new slot   │
  words are needed)  │ names, plan titles, value normalisation, given the decisions   │
                     └──────────┬───────────┘
                                ▼
                 extraction contract → guard → brain.observe
```

**Stage 1, the encoder (the new model).**

| Choice | Option 1 (fast) | Option 2 (quality) |
|---|---|---|
| Backbone | Ettin-encoder-150m (MIT) or ModernBERT-base (Apache-2.0, 149.7M): 22 layers, hidden 768, 12 heads; multilingual: mmBERT-base (MIT, same shape, 256K vocabulary) | Ettin-encoder-400m (MIT) or ModernBERT-large (Apache-2.0, 395.9M): 28 layers, hidden 1024, 16 heads |
| Attention | ModernBERT layout: global attention every third layer, local (128-token window) in the others, RoPE, ~8K context [V configs on Hugging Face: Ettin encoders are `modernbert` models with identical shapes] | same |
| Parameters | ~150M backbone + ~3M heads | ~395M backbone + ~5M heads |
| Weights on disk | ~150 MB INT8 | ~400 MB INT8 |
| Input length | ~150–600 tokens (events + K = 8 known memories) | same |

**Variant A′ (measured fallback)**: the same heads on LFM3-1.7B's hidden
states instead of a small encoder (llama.cpp returns per-token states with
`--pooling none`). A frozen LFM3 read through a linear layer already makes
the per-example decision correctly on 82 % of hand-written gold examples,
against 50 % when LFM3 generates the answer (`analysis/RESULTS.md` §3). It
costs an LFM3 prefill (~2.5–4.5 s, 2 GB) instead of 0.3–1.8 s, and keeps the
LFM license; it is what Design A becomes if the small encoders lose in E3.

Heads (all small MLPs over final hidden states):

| Head | Input | Output | Params (option 2) |
|---|---|---|---|
| Span tagger | each event token | BIO × {OBS, PLAN, TIME, PERSON} (9 classes) | ~10K |
| Kind | mean of span tokens ⊕ [CLS] | 9 + none | ~2M (2-layer MLP, 1024) |
| Certainty | same | 6 | shared trunk |
| About, importance | same | 3; 5 ordinal bins | shared trunk |
| Merge pair | span vector ⊕ [Mi] marker vector ⊕ product | {new, same, update, contradict} per i; NEW if all "new" | ~2M |
| Slot vocabulary | span vector | ~200 canonical slots + other | ~0.2M |
| Gate | [CLS] | P(anything to keep) | ~1K |

**Stage 3, the writer.** Optional in v1: values are copied spans and plan
titles are templated ("{event} with {people}"). If the gold set shows copied
spans are not good enough, add a small generator conditioned on the
decisions, producing ≤ 20 tokens under a grammar: LFM2.5-350M or LFM3-1.7B
itself with a short prompt.

**Inference cost** [I, from our measurements]: see the latency table at the
end of this document. Most events stop after stage 1 (nothing to keep).

**Training.**
1. Labels: the generator (`ml/data/generate.mjs`) already knows which phrase
   produced each observation; emitting character spans for value, time and
   people is a change to the generator, not new annotation. Real-text labels
   come from a strong teacher model on paraphrased and free-form events
   (sequence-level distillation), filtered by the guard and spot-checked;
   gold stays hand-written and held out.
2. Multi-task full fine-tuning of the encoder (cross-entropy per head,
   class-balanced), 3–5 epochs: minutes to an hour on one 24 GB GPU, or a
   Kaggle T4 [I].
3. Calibration: temperature per head on the validation set.
4. Quantization: INT8 post-training (encoders lose little at INT8 [I; verify
   in E1]).

**Advantages**: decisions made by the architecture class that is best at
them at a fixed size (Ettin); calibrated probabilities for the brain's
certainty; merges by selection; no free-running generation for most
events; small RAM; the expensive model (if any) runs rarely.

**Limitations and risks**: needs span-level labels; two or three components
instead of one; copied spans are less polished than generated paraphrases;
English-centric encoders (ModernBERT, Ettin) need a multilingual
alternative for Roman Urdu: mmBERT (MIT, ModernBERT architecture, 256K
vocabulary) exists [V config]; its Urdu quality is untested here; multi-event reasoning ("the meeting moved to
Friday" referring to an earlier event) depends on the input window.

## Design B: one decoder, decisions as single-token codes and heads

Keep a pretrained decoder (LFM3-1.7B, or LFM2.5-1.2B for speed), change
what it outputs and how it is trained.

```
 prompt (fixed, cached) + now + known memories as [M1]..[MK] + events
                                │
                     ┌──────────▼───────────┐
                     │ LFM3-1.7B + LoRA (or full FT)                      │
                     │ compact output, one line per item:                 │
                     │   O <kind-code><cert-code><imp-code> @M3|+slot :: value [| until-span]
                     │   P <title> :: <time-span> :: <place> :: <people>  │
                     │ codes are single tokens; the grammar forces the    │
                     │ layout; enum positions read top-k logprobs         │
                     └──────────┬───────────┘
                                ▼
            decoder of the compact form (code) → resolvers → contract
```

* **B1, no runtime change**: each decision is one token from a small
  allowed set (e.g. `K3`, `C1`, `I4`), so its logprob distribution (llama.cpp
  `n_probs`) gives class probabilities, calibrated afterwards by temperature
  scaling. Merge target is an enum over the shown `@M1..@MK` plus `+new`.
  `text` is templated; dates resolved by rules from the copied time span.
  Expected answer length ~35–45 tokens instead of ~150 [M from §1.1].
* **B2, with a small llama.cpp fork**: linear heads on the hidden state at
  each item's first token replace the code tokens; forced tokens are
  appended in one batched forward (jump-forward). Adds calibration and a
  little speed; costs a maintained fork (RUNTIME.md phase 2).

**Layer composition**: unchanged LFM3-1.7B (24 layers: 13 conv, 5 SWA,
6 global; 1.7B params). Added: LoRA (r = 32 on attention, conv in/out and
MLP projections, ~20–40M trainable) and, for B2, heads (~3M).

**Training**: SFT on the compact format (same data as Design A, rendered
compactly; 5–50M tokens; < $15 on an H100 or a Kaggle T4 [I]); then GRPO
with an exact field-level reward (F1 + correct merge action + correct
certainty; $40–400 [I]); then QAD/QAT to Q4_0 ($5–160 [I]).

**Advantages**: one model; generation available everywhere (paraphrased
values, multilingual inherited from the base); smallest change to today's
pipeline; every training stage is standard tooling.

**Limitations**: decisions still made by a decoder (weaker per parameter
than an encoder, per Ettin); 1.7B RAM and decode cost for every event, even
noise; LFM license threshold; B2 needs a fork.

## Design C: purpose-built encoder–decoder ("read wide, write narrow")

The one genuinely new architecture worth considering: our workload reads
~10× more tokens than it writes and most outputs are decisions. An
encoder–decoder fits that shape: a bidirectional encoder carries the
decision heads; a small decoder writes the few words, cross-attending to
the encoder.

```
             events + now + known memories + projects
                              │
     ┌────────────────────────▼─────────────────────────┐
     │ ENCODER ~400M, bidirectional                       │
     │ 28 layers, hidden 1024: local attention (window 128) │
     │ in 2 of 3 layers, global attention in every 3rd     │
     │ (+ optional gated short conv in local layers)       │
     │ heads: spans · kind · certainty · importance ·      │
     │        merge pair · gate                            │
     └──────────────┬─────────────────────┬─────────────┘
                    │ (heads)             │ encoder states
                    ▼                     ▼
        decisions, spans,         ┌──────────────────────────┐
        merge targets  ─────────► │ DECODER ~120–150M causal │
                                  │ 8 layers, hidden 768,    │
                                  │ self-attn + cross-attn   │
                                  │ writes: new slot names,  │
                                  │ values, plan titles      │
                                  └──────────────────────────┘
```

| Part | Composition | Params |
|---|---|---|
| Encoder | Ettin-encoder-400m / ModernBERT-large-shaped (28 × 1024) | ~395M |
| Decoder | Ettin-decoder-150m (`modernbert-decoder`, 22 layers, hidden 768 [V config]) with added cross-attention to a 1024→768 projection of encoder states; or its first 8 layers to cut decode cost | ~60–150M (+ ~25M cross-attention) |
| Heads | as Design A | ~5M |
| Total | | **~0.55B** (~0.5 GB at INT8, ~0.3 GB at INT4) |

**Initialisation**: encoder from Ettin-encoder-400m; decoder from
Ettin-decoder-150m (same tokenizer and data as the encoder) with newly
initialised cross-attention. Precedent: Google's T5Gemma adapts pretrained
decoder-only Gemma models into encoder–decoders (weights exist under the
Gemma license, e.g. t5gemma-2b-2b, 5.6B total [V model API]); the recipe's
details should be read before relying on it.

**Inference cost** [I]: encoder pass as Design A option 2; a 60–150M decoder
reads 1/10–1/25 of LFM3's bytes per token, so ~20 generated tokens cost
~0.1–0.3 s.

**Training**: (1) adapt the decoder to cross-attention on general
seq2seq data plus distillation from a teacher (~1–5B tokens, ~50–300 H100-h,
$100–1,200 [I]); (2) multi-task SFT on our data (heads + generation);
(3) RL with exact rewards; (4) INT8/INT4 export.

**Runtime**: llama.cpp has T5 encoder–decoder and ModernBERT encoders but
not this combination; it needs a new architecture in a fork (~500–1,000
lines, reusing `t5.cpp` and `modern-bert.cpp`), or ONNX Runtime with the
generation loop in the host [I].

**Advantages**: everything of Design A in one network; real generation where
needed at a fraction of a 1.7B decoder's cost; smallest RAM of the designs
that can paraphrase.

**Limitations**: the highest risk: a model nobody has trained in this shape
at this size for this task; needs a pretraining-like adaptation stage and
runtime work; quality of a 150M decoder for free text is unproven; only
worth it if Design A's copied spans and Design B's speed both fall short.

## Directions examined and not proposed

| Direction (from the brief) | Finding | Where it lives instead |
|---|---|---|
| Memory-oriented recurrent model that carries state across observations | The brain already is the long-term memory: explicit, editable, auditable, undoable, forgettable per item. A hidden recurrent state would be opaque, could not honour "forget this", and would leak private content across contexts. No evidence it beats retrieval of known memories into the input (agent-memory work uses explicit stores: Mem0, Zep, MemGPT) [V/I] | Retrieval of the top-K known memories into the encoder input (all designs) |
| Multi-timescale pathways inside the model (immediate, short-term, durable, behavioural) | The timescales are properties of the memory, not of the computation that recognises it: `until` for live context, layers in the brain, consolidation jobs for patterns [I] | Heads for certainty = temporary + `until`; brain layers; a separate offline consolidation job (can use the generator, long context) |
| Adaptive computation inside the network (recurrent depth, early exit, MoD) | Looping re-reads weights (≈ 4× decode cost); no CPU runtime; needs special training [V/I] | A cascade: rules → encoder gate → writer only when needed (Design A stages 0–3) |
| New hybrid mixer (conv + SWA + global, SSM) designed by us | Liquid ran exactly this search on CPU and published the conclusion; at 1–2B and < 2K tokens mixer type does not decide speed; training one needs pretraining [V/S] | Use LFM-class backbones as they are |
| Mixture-of-Experts | Costs 4–5 GB RAM for 3–4B-class quality, not speed [V] | Possible future "high-quality tier" for 16 GB machines |
| BitNet / ternary | Fast and small, but instruct quality well below 1–2B peers; separate runtime [V] | Revisit when a strong ternary instruct model exists |

## Latency and memory estimates (4-core Xeon, 4 threads)

Inputs from `analysis/RESULTS.md` §4 [M]: encoder prompt processing
(150M: 286 ms per 256 tokens, 599 ms per 512; 400M: 805 / 1759 ms),
LFM3 prefill ~110 tok/s, LFM3 decode 16.4 tok/s, today's measured p50
10.9 s / p95 18.5 s. A typical encoder input (events + 8 known memories +
now) is 250–500 tokens; it needs no instructions, so it is shorter than a
decoder's prompt. Everything below except "today" is an estimate [I].

| Design | Stages per batch | p50 estimate | p95 estimate | Model RAM | Noise events cost |
|---|---|---|---|---|---|
| Today: LFM3 QAD, JSON (measured) | prefill ~100 new tokens + ~150 generated | 10.9 s [M] | 18.5 s [M] | ~2.0 GB [M] | full price |
| A, 150M encoder, no writer | encoder 250–500 tokens + code | **0.3–0.6 s** | ~1 s | **~0.22 GB** | same 0.3–0.6 s, then stop |
| A, 400M encoder, no writer | encoder | 0.8–1.8 s | ~2.5 s | ~0.5 GB | 0.8–1.8 s, then stop |
| A, 400M encoder + LFM3 writer on ~30 % of batches | encoder; writer: ~150-token prompt + ~20 tokens | ~1.5–3 s | ~6 s | ~2.5 GB while both loaded (writer unloaded when idle) | encoder only |
| B1, LFM3 compact codes | prefill ~100–200 new tokens + ~40 generated | ~3.5–4.5 s | ~7 s | ~2.0 GB | full price |
| C, 400M encoder + 150M decoder | encoder + ~20 decoder tokens | ~1–2 s | ~3 s | ~0.65 GB | encoder only |
