# PASTE: architecture hypotheses (pre-registered)

Date 2026-11-01. Written **before** any data is generated or any model is
trained. Each hypothesis has:

* the mechanism it tests;
* the prior art behind it, from `LITERATURE-REVIEW.md` (F-numbers refer to
  its §2);
* the experiment that tests it;
* a falsification criterion;
* my prior expectation, recorded now so it can be checked later.

Experiment IDs, metrics and statistics follow `ARCHITECTURE-SPEC.md` §9-10.
"CI" means a 95 % paired bootstrap interval over test episodes, on the
seed-mean of 3 seeds, Holm-adjusted within each hypothesis family.

The hypotheses are **claims about this task, this data and this scale**
(about 39M parameters, synthetic and licence-clean sequential conversations).
None of them is a claim of mechanism novelty (literature review §1).

## H0: the central test (owner decision 5)

**Claim.** PASTE's memory pathway beats chunked explicit memory with
identical heads:

* soft-token store;
* recurrent memory tokens;
* explicit temporary items.

**Test.**

* Primary endpoint PE: closed-loop persistent-operation micro-F1 on the
  frozen test set.
* PASTE against M1c and against M1c-m.
* Decision rule: spec §10.5, unchanged here.

**Falsified if** either Holm-adjusted CI includes 0, or lies below it.

**Companion check.** PASTE against M1c+W. If M1c+W ≥ PASTE, the report says
"a raw-text window recovers the gain".

**Prior expectation.**

| Outcome | My probability |
|---|---|
| PASTE beats M1c and M1c-m | about 30 % |
| PASTE also beats M1c+W | about 15 % |

Why: joint text reading is strong for identity (F4, F1); the store is short
at K ≤ 32; SOM-DST's flattened-state design works.

## H1: continuity (recurrence carries what explicit items do not)

**Mechanism.** r = 4 GRU-gated memory tokens (spec §4.3, §5.12).

**Claim.** On units whose decision depends on context **outside the current
segment** that is **not represented in an explicit temporary item or
record**, PASTE is more accurate than A2 (PASTE without memory tokens). The
gap grows with dependency distance.

**Test.**

* Unit-level decision accuracy (route + target + relation), stratified by
  distance bucket (1, 2-4, ≥ 5 segments).
* Comparisons: PASTE vs A2; RMT vs M1c.

**Falsified if** the CI for PASTE − A2 includes 0 in every bucket ≥ 2. A
gap only at distance 1 counts as "a text window would do" (compare M1c+W).

**Learnability check (F2, F3).** The A6b recall probe and the
distance-stratified validation accuracy must improve during training. If
they do not, the report says "recurrence was not learned" rather than "not
useful".

**Prior expectation.** A small positive effect at distance 1-4. No effect
across sessions, by construction: h is reset (invariant I3).

## H2: identity (hierarchical addressing separates identity from similarity)

**Mechanism.** P(record) = P(entity) · P(record | entity), trained on stores
that contain look-alike profiles (spec §5.5).

**Claim.** On the **look-alike subset** (units whose store contains a record
with the same attribute and a similar value under a different profile),
PASTE makes fewer wrong-entity operations than A1 (flat pointer). Its overall
addressing accuracy is not lower.

**Test.**

* Wrong-entity rate and target accuracy on the look-alike subset.
* Comparison: PASTE vs A1, and A4 (no look-alike negatives in training) vs
  PASTE.

**Falsified if** the CI for wrong-entity(A1) − wrong-entity(PASTE) includes
0.

**Prior expectation.** A moderate effect, mostly carried by the hard
negatives rather than the factorisation: A4 may lose more than A1.

## H3: separation (temporary state does not leak into persistent memory)

**Mechanism.** Separate temporary pathway, write gate, explicit PROMOTE
(spec §5.3-5.4, §5.11).

**Claim.** The single-pool ablation A3 creates more false permanent memories
from temporary content than PASTE does, without PASTE losing persistent
recall.

**Test.**

* FPM restricted to false writes whose source is a gold TEMP, FRAME,
  joking, hypothetical or uncertain unit.
* Persistent recall.
* Comparison: PASTE vs A3; M1c reported for reference (it is also a single
  pool).

**Falsified if** the CI for leak(A3) − leak(PASTE) includes 0, or PASTE's
persistent recall is lower (CI < 0).

**Prior expectation.** Likely positive. This is the hypothesis with the most
direct mechanism-to-metric link.

## H4: efficiency (soft-token store is cheaper at equal accuracy)

**Claim.** PASTE's end-to-end CPU p50 latency per segment (4 threads, fp32
and int8) is ≤ 0.5 × M1c's at K = 32, and the ratio falls as K grows (K = 8,
32, 128). Its PE is within 1 F1 point of M1c, or better.

**Test.** Measured latency, peak RAM and throughput (spec §8, §10.3),
together with the H0 accuracy result.

**Falsified if** the latency ratio is > 0.5 at K = 32, or accuracy is more
than 1 point below M1c (then the efficiency gain has an accuracy cost, and
the trade-off is reported).

**Prior expectation.**

* The encoder-only measurements give 45 ms against 169 ms, so ≤ 0.5 at
  K = 32 is likely.
* At K = 8 the advantage may vanish (F11).
* Accuracy parity is the uncertain half.

## H5: closed-loop training reduces error compounding

**Mechanism.** Scheduled sampling through the Brain simulator (spec §6.3).

**Claim.** The drop from teacher-forced to closed-loop PE is smaller for
PASTE than for A5 (teacher forcing only).

**Test.** (TF-PE − CL-PE) for PASTE vs A5, and the error-compounding curve
against segment index.

**Falsified if** the CI for the difference in drops includes 0.

**Prior expectation.** Positive but small. SOM-DST's 2.47× compounding
(F6) suggests there is room.

## H6: generator realism (API-written vs programmatic data)

Owner decision 2: do not assume API data is better.

**Claim.** A model trained on programmatic data alone loses more PE on
API-realised test episodes than a model trained on API-realised data loses
on programmatic episodes. The DtW template lesson predicts this.

**Test.**

* Validation-scale runs, Ettin-17M to save quota: cross-generator
  train/test grid.
* Diversity metrics: distinct-n, self-BLEU, template entropy, embedding
  spread.

**Falsified if** the generalisation gaps do not differ (CI includes 0).

**Decision use.** This decides the generator mix for the full dataset. That
choice is made on validation only, and the cost estimate goes to the owner
before any spend beyond the pilot.

**Prior expectation.** Programmatic-only generalises worse. The size of the
gap is unknown.

## H7: scale (a much smaller model is competitive)

**Claim.** PASTE-17M's PE is within 2 points of PASTE-32M's.

**Test.** S17, 1-3 seeds depending on quota.

**Falsified if** the gap is > 2 points (CI). With fewer than 3 seeds the
result is exploratory.

**Prior expectation.** A larger gap than 2 points: Ettin-17M has only ~3.9M
non-embedding parameters.

## H8: write precision at the owner's operating point

**Claim.** At θ_W chosen on validation for cost 3:1, PASTE's persistent-write
precision on in-distribution test is ≥ 0.75, the break-even precision
r/(r+1) for r = 3. Recall at that threshold is reported next to it (F8:
omission is the dominant real-world failure).

**Test.** Precision, recall and cost 3·FP + FN against the "store nothing"
policy, in-distribution and on real-text segments.

**Falsified if** precision < 0.75 (CI upper bound below 0.75)
in-distribution.

**Prior expectation.**

* In-distribution: likely met, because synthetic data is cleaner.
* Real-text segments: likely not met. The DtW encoders reached 0.24-0.32
  precision on real text.

## Auxiliary-objective hypotheses (brief §7: keep only objectives that help)

| ID | Objective | Kept only if |
|---|---|---|
| H9a | L_idc (identity contrastive) | Look-alike wrong-entity rate falls (CI excludes 0) without a PE loss |
| H9b | L_rec (continuity probe) | Distance ≥ 2 continuity accuracy rises (CI excludes 0) without a PE loss |

Core losses are not ablated individually: each supervises a required output.

## What would change the plan

* **H0 fails and H4 holds:** report PASTE as an efficiency option with an
  accuracy cost or no accuracy gain. The recommendation stays explicit
  memory (M1c-style) unless the owner prioritises latency.
* **H0 fails and H1 holds only at distance 1:** recommend M1c+W, which needs
  no new runtime.
* **H2 holds but H0 fails:** port the hierarchical addressing heads and
  look-alike training to M1c. That is a head change and needs no new
  architecture.
* **H3 holds:** keep the separate temporary pathway and the PROMOTE contract,
  whatever H0 shows. They are interface rules, and they can also be
  implemented around M1c.
