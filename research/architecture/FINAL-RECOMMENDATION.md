# Final recommendation

Decision document, 2026-10-31. Evidence: `ARCHITECTURE-RESEARCH.md`,
`analysis/RESULTS.md`; designs: `PROPOSED-ARCHITECTURES.md`; comparison:
`ARCHITECTURE-COMPARISON.md`; plan: `EXPERIMENT-ROADMAP.md`. Labels: [M]
measured by us, [V] verified source, [I] estimate.

## The answer

**Yes.** A 1–2B-budget local model can understand, filter and update a
user's context more reliably than today's small general-purpose language
models while staying fast enough for continuous use, **but the gain comes
from changing what the model is asked to output and which architecture
makes each kind of output, not from a new backbone.**

The strongest evidence we have:

1. **Our failures are decisions.** Kind wrong on 26–50 % of matched items,
   certainty on 22–41 %, 6 of 8 plans missed, while dates are right whenever
   a plan is found and nothing secret ever leaked [M].
2. **The knowledge is already in the network; generation is the weak
   link.** LFM3's own frozen hidden states, read by a linear layer trained in
   seconds, make the per-example decision correctly on 82 % of hand-written
   examples; LFM3 generating its answer gets 50 % (paired exact test,
   p = 0.013) [M].
3. **Encoders are the best tool for decisions at a fixed size.** Same data,
   same recipe: a 150M encoder beats a 400M decoder, a 400M encoder beats a
   1B decoder on classification (Ettin) [V]; supervised small models beat
   LLMs on sarcasm (SarcasmBench) [V].
4. **Most generated tokens are waste.** 44 % are forced JSON, 17 % a
   templatable sentence, and 61 % of the observations written are discarded
   by the guard [M].
5. **The backbone type does not decide CPU speed at our lengths.** Speed
   tracks bytes per token; Liquid's CPU architecture search and IBM's
   dense-vs-Mamba-2 pair show no win for SSM / linear attention below 2K
   tokens [V]; our own decode speeds order by size, not type [M].
6. **A small encoder is cheap on our CPU.** A 150M ModernBERT-shaped
   encoder reads 256 tokens in 286 ms at 4 threads with 219 MB resident;
   LFM3 needs 2.3 s and 2 GB just to read the same [M].

## The recommended architecture: Decide-then-Write

```
 events + now + top-K known memories + projects
        │
   rules pre-filter ──► nothing to do: stop
        │
   ENCODER 150–400M (Ettin / ModernBERT; mmBERT for Roman Urdu), INT8
     heads: spans (observation, plan, time, person) · kind · certainty ·
            about · importance · "anything to keep?" gate ·
            merge pair (span × each known memory → new / same / update / contradict)
        │
   code: date resolver (now, tz) · slot from the selected memory ·
         text from templates · project selection
        │
   WRITER, only when new words are needed (new slot names, plan titles,
   value normalisation): LFM3-1.7B with a short constrained prompt, or a
   smaller model later
        │
   extraction contract → guard → brain.observe (unchanged)
```

**Why it wins**

| Need | How Decide-then-Write meets it | Evidence |
|---|---|---|
| Jokes, quotes, hypotheticals not stored as facts | certainty is a trained, calibrated classification head on the class of model best at it | [V] Ettin, SarcasmBench, calibration studies; [M] probe |
| Correct certainty labels | same head; probabilities usable by the brain | [V] 2003.07892 |
| Correct merge and update actions | the model selects an existing memory (or NEW) and classifies the relation; the slot is inherited, so it cannot drift | [V] BLINK, DECODE, Memory-R1; [M] merge errors today |
| Meetings as plans | plan vs observation is a span type; the date is computed by code (already 100 % correct when found) | [M] |
| Temporary context not split | one span with a time sub-span; `until` resolved by code | [M] failure taxonomy |
| Fast on 4–8 cores | 0.3–1.8 s per batch instead of 10.9 s; most events stop at the gate | [M] encoder bench; [I] |
| 1–2 GB RAM | 0.2–0.5 GB for the decision stage; the writer loads only when needed | [M] |
| Privacy | everything local; the decision stage is MIT/Apache | [V] |
| Auditable | every decision has a probability; the brain stays the only store | design |

**Is this a new architecture or an adaptation?** Both, deliberately. The
*system* architecture is new: decisions, selection, rules and writing are
separate components, each done by the kind of model (or code) that is best
at it. The *networks* are adapted, not invented: a pretrained encoder
fine-tuned with task heads, and the existing LFM3 as the writer. That is the
cheapest route to the biggest measured gap, and it keeps every component
replaceable.

**Fallback inside the same architecture (A′)**: if the fine-tuned small
encoders do not reach the frozen-LFM3 probe on hand-written text, put the
same heads on LFM3's hidden states. That variant is already measured
(0.82 frozen) and still removes generation from every decision; it costs
LFM3's prefill (~2.5–4.5 s, 2 GB).

## What to build first

In order; each step can stop the next.

1. **Gold v2 (2–3 person-days, $0).** ≥ 400 hand-written, double-annotated
   examples covering every failure category, plus a frozen real-world set
   from the team's own opt-in use. Today's 39 examples cannot separate
   designs that differ by less than ~15 points. Nothing below is decidable
   without it.
2. **Generator v2 with spans (days, $0).** `ml/data/generate.mjs` already
   knows which phrase produced each observation; emit character spans and
   merge targets. Add teacher-paraphrased and free-form data (D2,
   $3–1,000 depending on the teacher).
3. **E3: fine-tune the encoder with heads (1 GPU, < $50 for all runs).**
   Ettin-encoder-150m, -400m and mmBERT-base, three seeds each; values
   copied from spans; no writer. Compare on gold v2 against:
4. **The controls, same week:** E0 (LFM3 today), T1 (LFM3 LoRA on the same
   data, plain JSON: the existing `config-lfm3.yaml`) and A′ (heads on
   frozen and LoRA-tuned LFM3). This separates fine-tuning from
   architecture.
5. **Decide with the gate** (`EXPERIMENT-ROADMAP.md` §6): ship the cheapest
   candidate that clears it. Then add the writer only where values or plan
   titles measurably need it, and GRPO/hard-example training on the
   remaining errors.

Production integration is a new provider behind the existing contract
(`context-model.js` already accepts any object with `extract()`), so the
engine, guard, brain and settings do not change; the runtime needs only
per-token states from `llama-server --embedding --pooling none` (supported
at our pinned commit [M]) and heads in host code.

## What not to build

| Don't | Why |
|---|---|
| A new backbone from scratch (any mixer) | $16k–176k per 1–4T-token run [I/S], under-trained versus 10–36T-token leaders [V], and no CPU speed to gain at our lengths [V/M] |
| A custom SSM / linear-attention / RWKV backbone, or a conversion to one | pure linear models lose in-context recall, the core of extraction [V]; hybrids tie dense at 1–2B [V]; LFM3 already is a CPU-searched hybrid |
| Mixture-of-Experts | buys quality for 4–5 GB RAM, not speed [V] |
| Recurrent-depth / looped models | multiply per-token decode cost on CPU; no runtime [V/I] |
| A memory-carrying recurrent model | the brain is the memory: explicit, editable, forgettable; a hidden state cannot honour "forget this" |
| Our own inference engine | llama.cpp runs every component; a fork only if B2-style in-loop heads become necessary |
| More prompt engineering | v2 already traded F1 for plans; further rules move errors around [M] |
| Design C (encoder–decoder) now | the highest risk; only if copied spans prove inadequate **and** the writer is too slow (EXPERIMENT-ROADMAP E9) |
| BitNet / ternary today | instruct quality below 1–2B peers and a second runtime [V]; revisit later |

## Prompt vs fine-tuning vs architecture vs runtime

| Change type | What it fixes here | Status |
|---|---|---|
| Prompt | plans and live context partly (v2) | done; at its ceiling |
| Fine-tuning | label calibration to our taxonomy, noise rejection, slot reuse | next (T1 is the control) |
| Architecture | decisions by heads, merges by selection, gate before any expensive work, small decision model | recommended (Decide-then-Write) |
| Runtime | prompt-cache reuse (done, −29 % p50); per-token states for heads (already supported); jump-forward and n-gram speculation for the writer | small, upstream-first |

## Unknowns that could change this recommendation

* **Fine-tuned encoder accuracy on hand-written and real text** (E3). If
  150–400M encoders stay well below the frozen-LFM3 probe, use A′.
* **Value quality of copied spans** in real use (human rating on the
  real-world set). If poor, the writer runs more often (cost rises toward
  B1's ~4 s).
* **How noisy real event streams are.** The gate's savings depend on it.
* Numbers marked [S] in the research (prices, some training costs) were
  taken from secondary sources and should be checked before money is
  spent.

## Expected outcome if E3 succeeds [I]

| | Today (T0) | Decide-then-Write target |
|---|---|---|
| Gold decision accuracy | 0.50 [M] | ≥ 0.85 |
| Certainty accuracy (gold) | 0.59 [M] | ≥ 0.85 |
| False memories | 25–42 % [M] | ≤ 10 % |
| Merge-action agreement | 59–78 % [M] | ≥ 85 % |
| p50 / p95 per batch, 4 cores | 10.9 / 18.5 s [M] | ≤ 1 / ≤ 2 s (no writer), ≤ 3 / ≤ 6 s (with writer) |
| Model RAM | 2.0 GB [M] | 0.2–0.5 GB (+ writer when loaded) |
| License of the decision model | LFM (< $10M revenue) | MIT / Apache-2.0 |
