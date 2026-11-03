# PASTE research notes (living)

The verified literature review is `LITERATURE-REVIEW.md` (four parts, sources tagged [V]/[S]/[U]). This file
is the working layer on top of it:

* the findings that drive decisions, with their sources;
* open hypotheses (mine, marked as such);
* research questions still to investigate.

Pre-registered hypotheses are in `ARCHITECTURE-HYPOTHESES.md` and are not edited here.

## Findings that currently drive the design (from LITERATURE-REVIEW.md §2)

| # | Finding | Source tag | Used in |
|---|---|---|---|
| F1 | Fixed-size recurrent state is weak at exact recall and near-duplicate keys | [V] Zoology, Based, Repeat After Me | Addressing uses explicit record tokens; memory tokens carry context only |
| F2 | Memory tokens on BERT need a segment curriculum | [V] RMT 2304.11062 | Curriculum (spec §6.4) |
| F4 | Joint reading beats separate embeddings on identity by 1.6-3.7 points | [V] BLINK | Central-test risk for PASTE |
| F6 | Operation prediction causes 78-93 % of state-tracking errors; own-state input multiplies error 2.47× | [V] SOM-DST | Per-operation diagnostics; closed-loop training |
| F7 | A small memory router collapsed toward UPDATE | [S] MemRouter (search summary only) | Monitored risk |
| F8 | Omission is the main failure of memory systems | [V] HaluMem | Recall reported at the operating point |

## Own findings from this project (evidence in EXPERIMENTS.md)

* Templates carry non-transferable cues: a bag-of-words probe trained on templates falls below the majority
  baseline on natural wording of the same plans (E08). This matches the DtW template collapse.
* Training cost is dominated by framework overhead, not by the encoder: one embedding lookup per record made
  the backward pass 6× the forward pass (E10, E11).
* **Head-input scale decides trainability (E21-E23).** Raw Ettin-32M outputs reach row norm ≈ 113 with a few
  dimensions near |x| ≈ 100. Fed raw into new heads, 300 steps leave every head at chance (E22). With
  parameter-free LayerNorm the identical run reaches val PE 0.13, gate 0.92, attribute 0.83 (E23). LayerNorm
  fixes the scale but not the dominance: one dimension still holds ≈ 75 % of each normalised vector's energy
  (research-queue Q1). The exact optimisation mechanism is not established.
* **Addressing is the weakest head** (teacher-forced 0.30 after 300 steps vs ≈ 6 % chance; E23). Half the gold
  targets are NEW-ATTR on an existing profile (val: 228 NEW-ATTR, 184 record, 44 NEW-ENT). E25 splits it:
  the entity factor (which profile) is 0.43, while given the gold entity a rule using the model's own predicted
  attribute picks the right record or NEW-ATTR 98 % of the time (the head: 0.72). Entity resolution is the
  bottleneck, which is also where soft-token profiles (PASTE) and text rows (M1c) differ most.
* **The PASTE vs M1c gap in the D2 pilot is entity resolution (E24, E26).** At 1,000 steps M1c reaches val PE
  0.69 vs PASTE 0.36-0.40. Teacher-forced, the entity factor is 0.89 for M1c and 0.50 for PASTE (both head_norm
  settings), while the record factor given the entity is ≈ 0.96-0.98 for both. In v2.1 a profile enters as ONE
  soft token: the mean of its input embeddings ("Bushra", "(", "cousin", ")") plus a projection of its pooled
  final-layer states, so the name-role binding that separates "brother Adeel" from "manager Adeel" is blurred
  before any attention happens. M1c's segment tokens attend to name and role tokens individually.
  Proposal A3 (below) tests this directly.

## Open hypotheses (mine; untested)

* **H-own-1.** M1c's advantage on identity (F4) could be partly recovered in PASTE by also giving the encoder
  the raw text of the *candidate* records whose addresses are uncertain (a two-stage "re-read"). This
  resembles bi-encoder retrieval followed by a cross-encoder rerank (BLINK). It is a candidate improvement
  to evaluate after the central test, as a labelled variant, never inside it.
* **H-own-2.** At short segment lengths (mean 34-46 tokens), PASTE's cost advantage over M1c is small in
  absolute terms. Its efficiency case (H4) rests on large stores (stress, K up to 128).

## Research queue (to investigate, in priority order)

0. **A3: verbatim profile rows (PASTE v2.2 candidate).** Profiles enter as token rows after the segment, as in
   M1c; records and temporary items stay soft tokens (the store's size, and PASTE's efficiency case, scale with
   records, not profiles: E median 5, max 9). Profile vectors for the heads become the row-token means, as in
   M1c. v2.1 stays as an ablation. Run PASTE-v2.2 for the same 1,000-step pilot budget and compare entity factor
   and val PE with v2.1 and M1c. If it closes the gap, the finding is that identity needs verbatim tokens while
   attribute/value content can be compressed; the report must state that v2.2 is no longer a pure soft-token
   memory.

Answers to the 2026-11-03 queue are in `research-queue-2026-11-03.md` (evidence-tagged). Planned work drawn from
them, in order; each change to training or to the shared heads applies to PASTE and every baseline identically
and is recorded as a spec amendment before the main runs:

1. ~~Addressing diagnostics first~~ done (E25, E26): the record factor is solved, so (a) below is not needed;
   the entity factor is the target (A3, then (b)/(c) if needed). Original item: teacher-forced accuracy per level (entity
   factor; record factor given gold entity; per gold type) on E24 checkpoints, plus a rule reference (gold
   entity + predicted attribute → existing record of that class, else NEW-ATTR). Only if the rule clearly beats
   the head: (a) an attribute-agreement term in the record score; (b) NEW-* scores that depend on the best
   candidate score (fixed-zero dummy, Lee et al. 2017); (c) L_idc with same-attribute hard negatives.
2. **Closed-loop mixing per segment, not per episode** (`train.py` currently flips one coin per episode, the
   variant Bengio et al. 2015 found much worse). Cheaper complement: low-rate corruption of the gold store
   (Correctable-DST: about 6 % per slot worked best). Start the ramp on a competence condition, not at a fixed 40 %.
3. **Threshold transfer inside validation:** fit θ_W on template family A, evaluate on B (and programmatic ↔
   API); report the analytic threshold (g = 0.5 under the 3:1 loss) next to the tuned one.
4. **Optional shared remedies to evaluate after D2:** frozen per-dimension standardisation before head LN
   (Timkey & van Schijndel 2021); LP-FT warm start (heads first, encoder frozen; Kumar et al. 2022).
5. Still open: does pooled soft-token detail loss hurt exact-value matching at sub-100M (KBLaM, xRAG)?
