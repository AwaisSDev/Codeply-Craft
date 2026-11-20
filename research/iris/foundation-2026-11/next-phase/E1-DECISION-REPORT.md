# Post-E1 decision report (2026-11-20)

**E1 is incomplete.** The GGUF half of the factorial ran; every Transformers cell crashed on an environment
incompatibility (`E1-RESULTS.md` §2), so the pre-registered decomposition is "not computable". This report answers the
owner's five questions with what was measured, marks what is exploratory, and says what remains open.
**M** = measured, pre-registered; **X** = exploratory (after results, not pre-registered); **H** = hypothesis.
No model is selected or adopted; E2 stays on hold; no R4 money was spent; the test split was not touched.

## 1. What caused the historical control vs pilot difference, and what remains uncertain?

The gap to explain, open loop:
* historical r2 (Transformers fp16) F1 0.404 vs pilot control (Q4, constrained) 0.292;
* in E1's own runs, r2 F16-U 0.397 vs pilot Q4-C 0.292.

* **M. Quantisation is a large part of it, for both adapters.** Q4_K_M vs F16 costs **0.048-0.059 F1 and 0.064-0.078
  recall**, intervals clear of zero. The Q4 models store fewer ops (r2 311 → 271, pilot 276 → 216), and the pilot's
  no-store sessions rise from 34 to 47. This matches the pilot's "skips real facts" behaviour (M3), part of which is
  therefore a quantisation effect, not only training.
* **M. Constrained decoding is not a cause of lower F1** (intervals include 0 for both adapters). For the pilot it
  *raises* false memories by 17-23 per 100 sessions, mostly because it rescues invalid outputs that would otherwise
  store nothing.
* **X. With F16-U standing in for the missing Transformers anchor:**
  * the pilot's own stack (F16-U → Q4-C) carries **0.079 of the 0.105 F1 gap, about three quarters**
    [0.43, 1.25];
  * the remaining recipe difference at F16-U is small and not distinguishable from zero (+0.025 [−0.016, +0.067]).
  * Cross-run support for the substitution: E1's r2 F16-U reproduces the historical r2 Transformers number to within
    0.007 F1 (+0.8 false / 100).
* **X. Closed loop tells a different story.** At the same Q4-C stack, r2 beats the pilot by **0.100 F1
  [+0.052, +0.153]** in closed loop vs 0.050 in open loop. So the recipe difference (drills, 3 epochs, raw format)
  compounds when the model reads its own store. No closed-loop F16 or Transformers cell exists, so this cannot be
  split further.
* **Uncertain:**
  * the Transformers-vs-llama.cpp backend effect (pre-registered, unmeasured, since the cells crashed);
  * which part of the recipe matters (data incl. drills, epochs, template; E1 cannot split them by design);
  * the closed-loop stack effect for the pilot adapter;
  * the r2 / r3 base revision (not recorded; content identical across all revisions, so not a plausible cause).

**Summary:** in open loop, most of the pilot control's deficit is the inference stack, mainly Q4 quantisation (M for
quantisation itself; X for its share). In closed loop, a recipe gap of about 0.10 F1 remains on the same stack (X).
Both parts are real, so the label would be **"mixed"**. Formally the pre-registered label is "not computable" until
the Transformers cells run.

## 2. How much do backend, quantisation and decoding affect results?

| Factor | F1 | False / 100 | Recall | Status |
|---|---|---|---|---|
| Quantisation (F16 → Q4_K_M) | −0.05 to −0.06 | −12 to −23 (fewer stored, n.s.) | −0.06 to −0.08 | **M**, material for both adapters |
| Constrained decoding | ≈ 0 | pilot +17 to +23 (more false); r2 ≈ 0 | ≈ 0 | **M** |
| Backend (Transformers vs llama.cpp F16) | unmeasured in E1; cross-run r2 difference 0.007 | +0.8 | +0.008 | **X** only |
| Hardware / run reproducibility | pilot Q4-C re-run identical to seed 1 (F1 0.2924, all metrics) | | | **M** (G3) |

The hardware noise floor for P@60 (0.05) still applies. P@60 differences between cells here are mostly inside it.

## 3. Which comparisons are valid, and which remain confounded?

| Comparison | Status |
|---|---|
| Quantisation within an adapter (F16-U vs Q4-U; weights shown byte-identical, `E1-PREFLIGHT.md` §6) | **valid, measured** |
| Constraint within an adapter | **valid, measured**; for the pilot, confounded with output validity (the grammar rescues invalid outputs) |
| Backend (Transformers vs GGUF F16) | **not measured** (crash); cross-run evidence only, mixing run, date and environment |
| r2 vs pilot under the same setup | **confounded** by data (drills, 1,255 vs 826 examples), epochs (3 vs 2), template, checkpoint |
| Seed-1 pilot comparisons (4B / Gemma vs control) | **still valid as matched comparisons** (same stack for all). But every absolute pilot number is depressed by Q4 (≈ 0.05 F1 here), and Q4's cost may differ by model size (not measured for 4B / Gemma) |
| Format swaps X1 / X2 | exploratory only (train / eval format mismatch). The pilot loses 0.04 F1 without its think block; r2 is unaffected by adding one |

## 4. Should R4 address annotation quality, data coverage or both?

**Both, with annotation quality first.**
* E1 shows that part of the control's weakness is inference precision (Q4), not data. So R4 should not be sold as the
  fix for the pilot gap.
* But the closed-loop recipe gap (0.10 F1, X) and the measured label facts point at data:
  * no label is human-verified;
  * the Opus and Sonnet shards label the storage threshold differently (skips per shard 32-47 vs 82-88);
  * ≈ 23 % of false memories are naming-convention penalties and ≈ 19 % are not worth storing (exploratory audit).
* Coverage gaps (own-memory updates, retractions, `conflict`) matter for closed-loop recall, not mainly for false
  memories.

Recommended order: the human audit (Phase A of `R4-DATA-QUALITY-PROPOSAL.md`, $0 API), then convention repair, then
human-verified calibration and evaluation sets, then coverage shards only where AI labels prove reliable.
Nothing is spent until the owner approves a budget based on Phase A's measured numbers.

## 5. What experimental design is needed before the three-seed E2?

Details: `E2-DESIGN-REQUIREMENTS.md`.

1. **Stack decision from E1.** E2's primary evaluation should not be Q4_K_M alone: it removes ≈ 0.06 recall from a
   1.7B adapter, and its effect on other sizes is unknown. Evaluate at F16 (or Q8_0 if pre-registered) as primary,
   with Q4_K_M as the deployment cell. Report constrained and unconstrained, because for some models the grammar
   trades validity for false memories.
2. **Three disjoint episode sets:**
   * development (current val, already over-used);
   * calibration C (≥ 24 episodes);
   * independent evaluation V (≥ 75-100 episodes for a 30-per-100 effect).

   All by episode and human-verified.
3. **Measure seed variance first.** Three seeds of one system on development. It sets V's size and the seed count.
   With σ_seed ≈ 10, a 20-per-100 effect is not detectable with three seeds at any V size.
4. **Five original criteria unchanged** for the model comparison. The threshold is a separate exploratory hypothesis.
   Its rule is fixed on C in a recall-capped or volume-capped form (owner's choice). F0.5 argmax is not used, because
   it conflicts with the recall limit. It is tested once on V with the same recall limit, never relaxed.
5. **Finish E1's Transformers cells** (if approved, §6), so that E2's stack choice rests on the pre-registered
   measurement rather than the exploratory substitute.

## 6. Decision needed: re-run the crashed Transformers cells?

* **Proposed fix:** one setup line, `pip uninstall -y torchao` before peft loads, exactly as the historical r2 / r3
  kernel did. Nothing else changes: same cells, gates (SC1, G2 first), order, metrics and analysis script.
* **Cost:** cells 1, 6, 13, 15, 11 ≈ 5 x 30 min.
  * Run on one GPU in the protocol's order, that is ≈ 2.7 h of kernel time with setup.
  * Split over the two T4s (GPU0: 1 → 13 → 11; GPU1: 6 → 15), ≈ 1.5 h.
* **Budget:**
  * E1 used 1.72 of the 3.5 approved GPU-hours, so ≈ 1.78 h remain.
  * The two-GPU split fits; the single-queue order does not.
  * The GPU assignment is a scheduling change only (same T4s, greedy decoding), and would be recorded.
* **What it buys:** the pre-registered G / S / Tr decomposition, the backend component, and the closed-loop stack
  effect for the pilot. It turns §1's exploratory share into a measured one.
* **Not doing it is defensible:** the exploratory evidence already points the same way, and E2 is on hold for data
  reasons regardless. In that case E1 is closed as "incomplete; GGUF factors measured; backend unmeasured".
