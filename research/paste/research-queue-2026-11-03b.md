# Research queue 2026-11-03 (b): closed-loop error classes after PR

Context: E27 error taxonomy (`tools/error_diag.py`, 100 + 100 val episodes, θ_W 0.9) for PASTE-PR. Largest false
positives:
1. WRITE to the wrong entity (≈100 per 100 episodes; teacher-forced entity factor is 0.88);
2. add vs update confusion (duplicate WRITE where gold is UPDATE/MERGE_INTO ≈45; UPDATE/MERGE_INTO where gold is
   WRITE ≈30);
3. FORGET addressed to a profile instead of a record (≈12 per file);
4. on API wording, predicted spans matching no gold unit (WRITE 209, UPDATE 100).

A literature agent searched for verifiable techniques. Its sources are listed below. Numbers are as the agent
reported them from the papers; items it could not verify are marked UNVERIFIED. I re-checked none of the numbers
myself, so they are claims to verify before any citation in a report.

| Class | Technique | Source | Evidence (as reported) | Mapping onto PASTE | Cost / risk |
|---|---|---|---|---|---|
| 1 | NIL as a fixed-score candidate; train on cases where the gold entity is absent | ReFinED (Ayoola et al., NAACL Industry 2022, arXiv 2207.04108); Zhu et al., "Learn to Not Link", Findings ACL 2023 | Without NIL training examples, NIL accuracy collapses; a few NIL examples restore it (figure, values not extracted) | PASTE already has NEW-ENT in Ω. The missing ingredient is **training cases where the gold profile is absent**. Teacher forcing never shows one. Profile-drop corruption (drop all records of one profile, so the target becomes NEW-ENT) supplies them | Cheap; shifts NEW-ENT frequency, so recalibrate |
| 1 | Auxiliary type/feature loss on mention and candidate | Zhu et al. 2023 | NEL accuracy 83.67 → 87.41 (cross-encoder) | A relation-type head on unit and profile rows (relation known from the profile key) | Low; needs a schema |
| 1 | Hard-negative mining / confusable distractors | Gillick et al., CoNLL 2019 (arXiv 1909.10506); Zhang & Stratos, NAACL 2021 | Large Recall@1 gains in the first mining round (figure) | Insert distractor profiles with the same relation or same attribute values into training stores | Cheap |
| 2 | Per-record operation classifier (CARRYOVER / UPDATE / DELETE …) | SOM-DST (Kim et al., ACL 2020, arXiv 1911.03906) | Operation prediction is ≥78.4 % of the error; gold operations lift JGA 53.01 → 89.85 | Unit × record classification. PASTE's record factor already does this via Ω; error_diag says the confusion is at the record-vs-NEW-ATTR boundary | Moderate |
| 2 | Similarity check of a new fact against existing records before ADD | Mem0 (Chhikara et al., 2025 preprint, arXiv 2504.19413) | No ablation (UNVERIFIED effect) | Decoding rule: WRITE → UPDATE when the best same-entity record's address probability exceeds τ (tuned on val) | Very cheap |
| 2 | State-copy and history features | TripPy (Heck et al., SIGDIAL 2020) | Ablation JGA 42.63 → 55.29 | "Mentioned in an earlier segment" bit per record | Low |
| 3 | Rare deletion ops are badly learned | SOM-DST Table 5 | DELETE F1 2.86 vs UPDATE 80.10 | Upsample FORGET episodes; contrastive record-forget vs profile-forget pairs | Cheap |
| 4 | Boundary smoothing | Zhu & Li, ACL 2022 (arXiv 2204.12031) | +0.17 to +0.59 F1; ECE 0.072 → 0.013 | Soft BIO labels ±1 token | Low; small gains |
| 4 | Perturbation / paraphrase augmentation | RockNER (Lin et al., EMNLP 2021) | Robustness drops 92.4 → 58.5; augmentation partly recovers | More API-worded training (budget spent), value swapping, masking | Cheap |
| 4 | Span prediction instead of BIO | SpanNER (Fu et al., ACL 2021) | Margins UNVERIFIED | Not before a partial-overlap analysis shows boundary errors dominate | Moderate |

## Priority (my judgement)

1. **Profile-drop corruption** (class 1, NIL training) as a variant of the existing `corrupt_store`. It is a
   training-data change applied identically to every system, so it is fair and needs no architecture change. It
   enters the training-variant experiments as V4.
2. **FORGET upsampling** (class 3): only if the variants (closed loop or corruption create "nothing to forget"
   cases) do not already fix FORGET_PROFILE false positives.
3. **Add-vs-update decoding rule** (class 2): a validation-tuned rule; only if measured to help both systems; it
   is shared decoding, so it is fair.
4. Span changes (class 4): the learning curve first. API-worded training data is limited by the spent budget;
   the learning curve shows whether more of the existing mix closes the gap.
