# PASTE evaluation protocol (pre-registered)

Date 2026-11-02. Status: **for owner approval before any training run.** It refines `ARCHITECTURE-SPEC.md`
§10 and `ARCHITECTURE-HYPOTHESES.md` with the dataset's concrete schema (`DATASET-DESIGN.md`). After
approval it changes only by recorded, dated deviations in `PROGRESS.md`.

## 1. What every system is evaluated on, and how

* **Systems:** PASTE and every baseline in `BASELINE-PLAN.md`. All receive the same inputs per segment:
  the segment text, the Brain's records and the system's own temporary state. Every system uses the same
  decoding interface (spec §5.13) and the same Brain simulator.
* **Closed loop (primary).** Each test episode is replayed segment by segment:
  1. the system's own proposals are executed by `paste.brain_sim` (the Brain's semantics);
  2. its temporary state transitions under the adapter rules;
  3. the resulting store and temporary state are its input for the next segment.
  Systems are therefore scored on the stores they create themselves, as in deployment.
* **Teacher forced (diagnostic).** Each segment is read with the gold store and gold temporary state. This
  isolates per-segment accuracy from error compounding (H5).
* **Record provenance.** A record created by a system's WRITE that matches a gold WRITE carries that gold
  fact id; any other created record is `spurious`.
* **Closed-loop gold.** Gold operations of later segments are re-expressed against the system's own store:
  * a gold operation on fact f targets the system's record with provenance f;
  * if the system never wrote f, the expected operation becomes a WRITE of the same entity, attribute and
    value. This is the omission-recovery rule the trainer uses (spec §6.3).
  * Gold for spurious records is "untouched".

## 2. Data access

| Split | Who reads it | When |
|---|---|---|
| train | trainers | always |
| val | trainers, calibration, D2 choice, early stopping, every model-selection decision | always |
| test, stress (frozen) | `evaluate.py --final` only | once per system, after its checkpoint, thresholds and data hashes are committed in `results/final/FROZEN-RUNS.json` |

* `results/FROZEN.json` holds the SHA-256 of every frozen file. It is committed **before the first training
  run**.
* Each final evaluation appends a line to `results/final/ACCESS-LOG.md`: time, system, seed, checkpoint
  hash, data hash.
* A rerun after a bug fix is logged as a **deviation**, with the reason. Both results are reported.

## 3. Matching rules (persistent operations)

A predicted operation matches a gold operation (closed-loop gold, §1) when:

| Operation | Must agree on |
|---|---|
| WRITE (including PROMOTE→WRITE) | Entity, attribute class, value |
| UPDATE (subtypes UPDATE, CORRECTION, CONTRADICTION) | Target record, value. The subtype is scored separately |
| MERGE_INTO | Target record |
| FORGET | Target record |
| FORGET_PROFILE | Profile |
| MERGE (record pair) | The unordered pair |

* **Entity** means the same existing profile, or NEW-ENT with the mention resolving to the gold entity.
  The mention text must overlap the gold mention span.
* **Value** matches when the token-F1 between normalised predicted and gold values is ≥ 0.5.
  Normalisation: lower case, punctuation removed, whitespace collapsed.
* Each gold operation matches at most once, greedily in order of the prediction's confidence.

## 4. Metrics

**Primary endpoint (PE):** micro-F1 of persistent operations (§3), closed loop, pooled over all test
segments, seed-mean over 3 seeds.

**Co-primary safety endpoint:** FPM, false permanent memories per 100 segments. These are predicted
WRITE/PROMOTE operations with no gold match. Each is attributed to its source unit's gold route (temporary,
joke, hypothetical, quote, uncertain, none); the leak-rate H3 uses comes from this attribution.

Secondary metrics (all reported with 95 % CIs):

| Group | Metric | Definition |
|---|---|---|
| Memory quality | P, R, F1 per operation type; missed important memories | FN WRITEs, weighted by kind (preference/fact/routine/style 1.0; project 0.8) |
| Addressing | Target accuracy; wrong-entity rate on the **look-alike subset**; incorrect updates; duplicate creation | Look-alike subset: units whose store_before has a record with the same attribute and value under another profile, or a same-name profile. Incorrect update: UPDATE on the wrong record, or where gold is WRITE. Duplicate creation: WRITE where gold is MERGE_INTO or UPDATE |
| Relations | Subtype accuracy; contradiction F1 | Subtype accuracy on matched UPDATEs |
| Temporary state | T-op F1 (T-WRITE / T-UPDATE / T-EXPIRE / PROMOTE); temporary-state F1 at each segment end; expiry F1 | Expiry scored at the exact segment |
| Continuity | Unit decision accuracy by dependency distance (0, 1, 2-4, ≥5, cross-session) | Decision = route, target and relation all correct. The ≥5 bucket is too small to analyse (DATASET-DESIGN §8.2) and is reported as such |
| Retrieval | P, R, F1, recall@3 over the records given | |
| Merge (D1) | P, R, F1 **separately** | Every predicted MERGE is also checked for its licence |
| Deletion | FORGET and FORGET_PROFILE P/R | |
| Per-operation diagnostics | Confusion over WRITE / UPDATE / MERGE_INTO / FORGET / IGNORE; UPDATE prediction rate against gold (MemRouter collapse risk, F7) | Results also collapsed to ADD / UPDATE / DELETE / NOOP for comparability |
| Final state | End-of-episode store F1 against the gold final store | |
| Generalisation | PE on family-C wording, unseen entities and test-only values, Roman Urdu / mixed, real-text segments (false units), stress (long episodes, K up to 128), programmatic vs API wording | |
| Efficiency | Parameters; CPU p50/p95 per segment at K ∈ {8, 32, 128}, fp32 and int8, 4 threads, **interleaved repeated runs**; peak RSS; carried bytes; GPU-hours; peak GPU memory | `tools/bench_cpu.py` extended to trained systems |

## 5. Calibration (validation only; identical procedure for every system)

* Temperature scaling per binary head (write gate, FORGET, MERGE, expiry, RETRIEVE).
* **Thresholds:**

| Threshold | Chosen to | Also reported |
|---|---|---|
| θ_W (write) | Minimise 3·FP + FN over persistent proposals | 2:1, 5:1 |
| θ_M (merge, D1) | Minimise 3·FP + FN | 2:1, 5:1 |
| θ_F (forget) | Minimise 3·FP + FN (a wrong deletion is a false permanent change) | |
| θ_R (retrieve) | Maximise F1 (read only) | |
| θ_X (expire) | Maximise F1 | |

* Thresholds are frozen with the checkpoint in `FROZEN-RUNS.json`.

## 6. Statistics

* 3 seeds per system for every system in the central test and in H1-H3. Fewer seeds make a result
  **exploratory**, and it is labelled so.
* 95 % paired bootstrap over test **plans**: 10,000 resamples; each resample recomputes both systems'
  seed-mean metric over the same plans.
* Holm correction within each hypothesis family.
* Equivalence statement: both CIs within ±1.0 F1 point.

## 7. Test wording (decided with the owner after the pilot)

* **If test is realised in both wordings:** PE is computed over the 600 plans × 2 wordings, resampling
  plans (so both wordings of a plan move together). Each wording is also reported separately.
* **Otherwise:** PE is computed on programmatic wording, with family-C and real-text segments reported as
  generalisation. The report then states that the test wording is template-based.

## 8. Decision rules

* **Central test (H0, owner decision 5):** exactly spec §10.5. PASTE is compared against M1c and M1c-m
  (Holm). The FPM non-inferiority bound is 1.10×; latency must be ≤ 1.5× M1c at K = 32. M1c+W gives the
  "text window suffices" reading.
* **H1-H9:** exactly `ARCHITECTURE-HYPOTHESES.md`.

## 9. D2 selection (owner decision, before the main experiment)

* **Runs:** PASTE and M1c, each with `head_norm` off and on: 4 runs, seed 1, identical train data and
  budget.
* **Selection:** the variant with the higher **validation** PE averaged over PASTE and M1c is used for all
  systems.
* **Scale:** the pilot may run at reduced scale (fewer episodes, fewer epochs) to save quota. The reduced
  scale is fixed in `BASELINE-PLAN.md` §4 before the pilot is run.
* The choice and its numbers are written to `PROGRESS.md` before any 3-seed run.

## 10. What is reported even when it is unflattering

* Every system's test result, including PASTE losing.
* Every failed or diverged training run.
* Every deviation from this protocol.
* The UPDATE collapse check.
* Results on real-text segments (false units on real text).
* Every result whose CI includes 0, stated as inconclusive.
