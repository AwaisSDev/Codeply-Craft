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

## Open hypotheses (mine; untested)

* **H-own-1.** M1c's advantage on identity (F4) could be partly recovered in PASTE by also giving the encoder
  the raw text of the *candidate* records whose addresses are uncertain (a two-stage "re-read"). This
  resembles bi-encoder retrieval followed by a cross-encoder rerank (BLINK). It is a candidate improvement
  to evaluate after the central test, as a labelled variant, never inside it.
* **H-own-2.** At short segment lengths (mean 34-46 tokens), PASTE's cost advantage over M1c is small in
  absolute terms. Its efficiency case (H4) rests on large stores (stress, K up to 128).

## Research queue (to investigate, in priority order)

1. Closed-loop training for state trackers: what schedule works (FPDSC, Correctable-DST, DSDN) and how big
   the gains are at BERT scale. This decides the scheduled-sampling schedule (spec §6.3).
2. Evidence on soft-token knowledge injection into small encoders (KBLaM, xRAG reproductions) at sub-100M:
   does pooled-token detail loss hurt exact-value matching? This decides whether X1-type variants or
   multi-vector record tokens are worth a run.
3. Calibration under prior shift for write decisions (BBSE, BCTS+EM) with synthetic → natural shift.
