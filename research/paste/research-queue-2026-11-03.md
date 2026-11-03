# PASTE research queue: four answers (2026-11-03)

Answers to four questions set after E21-E23 (head-input scale, addressing, closed-loop schedules, threshold transfer; they supersede items 1-3 of the earlier queue in `RESEARCH.md`; item 2, soft-token detail loss, remains open). Tags: **[V]** verified in the primary source
during this task; **[S]** secondary (search summary, abstract snippet or another paper's report); **[U]**
unverified. Each section ends with "Implication for PASTE", which separates evidence from my own suggestion.
Sections are appended as each is finished.


---

## Q1. Pretrained-encoder hidden states into newly initialised heads: outliers and remedies

**Evidence**

* **Outlier dimensions are a known property of BERT-family encoders.** Kovaleva et al., "BERT Busters: Outlier
  Dimensions that Disrupt Transformers" (Findings of ACL 2021; arXiv 2105.06990) [V abstract]: a very small set of
  high-magnitude **LayerNorm scaling factors and biases** emerges early in pre-training, sits in the same dimension
  throughout the model, and disabling it significantly degrades MLM loss and downstream tasks (BERT-family models,
  BART, XLNet, ELECTRA). Puccetti et al. (Findings of EMNLP 2022; arXiv 2205.11380) [V abstract]: the magnitude in
  the outlier dimensions correlates with token frequency in pre-training; they support the "vertical" attention
  pattern to special tokens; disabling 48 of BERT-base's 110M parameters drops MNLI by nearly 30 %. Rudman et al.
  (EMNLP 2023; arXiv 2310.17715) [V abstract]: outlier dimensions persist through fine-tuning and can carry
  task-specific knowledge. Macocco et al. (BlackBox NLP 2025; arXiv 2503.21718) [V abstract]: last-layer outlier
  dimensions (extreme for most inputs) implement a "predict frequent tokens" heuristic.
* **Massive activations** (Sun et al., COLM 2024; arXiv 2402.17762) [V HTML] are a related but different
  phenomenon: studied only in autoregressive models and ViTs, located on the starting token and delimiters, and
  they "disappear in the last layer". The paper also notes that in normalisation "the large denominator will push
  all normal values to zero", so the massive feature stays dominant after LayerNorm [V].
* **No ModernBERT/Ettin-specific analysis was found** [U]. In ModernBERT the returned `last_hidden_state` is the
  output of `final_norm` (a LayerNorm) [V: HF `modeling_modernbert.py`; same in `paste/modernbert.py`]. The
  project's numbers (median |x| ≈ 1.4, yet row norm ≈ 113 on typical rows) look like the BERT-style case
  (outlier dimensions present on most tokens) rather than token-specific massive activations — my inference.
* **Does a parameter-free LayerNorm remove the dominance? No.** LayerNorm without affine is a per-row shift and
  scale, so it preserves the *relative* sizes of centred coordinates. Every output row has norm √d = √384 = 19.6
  (exactly the measured value). With max |x| ≈ 17, one coordinate holds 17²/384 ≈ 75 % of the squared norm
  (arithmetic, mine). This matches Sun et al.'s observation. What LN *does* fix is absolute scale: bilinear
  scores ⟨W_q q, W_k k⟩ are quadratic in input scale, so the raw states give roughly (113/19.6)² ≈ 33× larger
  initial logits than LN'd ones (derivation, mine), consistent with merge loss 220 → 9.
* **Remedies in the literature.** (a) Per-dimension standardisation (z-scoring with corpus mean/std): Timkey and
  van Schijndel (EMNLP 2021; arXiv 2109.04404) [V abstract] show 1-3 "rogue" dimensions dominate cosine/Euclidean
  measures and that standardisation corrects this. (b) A norm inside the head: HF's own ModernBERT classification
  and token-classification heads are `LayerNorm(GELU(Linear(h)))` on top of `final_norm` output [V code] — the
  normalisation is *after* a learned projection. (c) LP-FT: Kumar et al. (ICLR 2022; arXiv 2202.10054) [V
  abstract] — over 10 shift datasets, LP-FT beats full fine-tuning by ≈ 1 point ID and ≈ 10 points OOD; mostly
  vision. Tomihari and Sato (NeurIPS 2024; arXiv 2405.16747) [V abstract] confirm LP-FT dynamics on Transformer
  NLP models: head norm grows during LP, which reduces feature change but hurts calibration (fixable by
  temperature scaling). (d) Removing outlier dimensions is contra-indicated by Kovaleva, Puccetti and Rudman
  (they carry information) [V abstracts]; note those papers ablate internal LN weights, not the head input [U for
  the head-input case].
* **A caution on the E22 diagnosis (my analysis, not literature).** Adam is invariant to a global rescaling of the
  gradient as long as per-coordinate gradients stay well above eps (1e-8). Clipping a 12k-19k norm to 1.0 over
  ~39M parameters leaves a typical coordinate near 1/√(3.9e7) ≈ 1.6e-4, far above eps. So "clipping pushes
  gradients to eps scale" probably explains only a few coordinates. A more likely mechanism: Adam moves every
  weight by roughly lr per step, so weights reading the ≈ 100-magnitude dimension change logits ~70× more per
  step than weights reading median dimensions, and the informative directions learn ~70× more slowly while the
  saturated softmax (loss 220) is being unwound. Not verified; a cheap check is the per-group pre-clip gradient
  norm and the share of Adam's `exp_avg_sq` below 1e-16.

**Implication for PASTE**

* *Evidence-based:* parameter-free LN is the minimal remedy that fixes scale and is easy to apply identically
  (it is already the pre-registered D2 "on" arm). It does **not** stop one dimension holding ≈ 75 % of each head
  input's energy. For bilinear and dot-product addressing this matters less than it seems if that dimension is
  nearly constant across candidates (a constant key component adds the same score to every candidate and
  cancels in the softmax), but it shrinks the effective variance of the informative directions at
  initialisation.
* *Suggestion:* do not change D2 mid-pilot. If a later, labelled revision is allowed, the most defensible
  shared remedy is **frozen per-dimension standardisation** (mean/std of each output dimension of the
  *pretrained* encoder, computed once on training text, then parameter-free LN), applied to every head input of
  every system. It is parameter-free, removes the dominance, and has a citable rationale (Timkey and van
  Schijndel). Second choice: LN with learnable affine (768 parameters per stream, identical across systems).
  LP-FT (e.g. 10 % of steps with the encoder frozen) is a cheap, shared add-on with OOD evidence relevant to
  the template → API wording shift (see Q4). Avoid dropping outlier dimensions. Optionally read
  `final_norm.weight` from the checkpoint: if a few gains are large, the outliers originate there, as Kovaleva
  et al. found for BERT [U for Ettin].

---

## Q2. Raising addressing accuracy over a small, changing candidate set

**Evidence**

* **Entity linking.** BLINK (Wu et al.; arXiv 1911.03814) [V ar5iv]: the bi-encoder is trained with a softmax
  over in-batch negatives (batch 128 in the best runs), then adds hard negatives taken as "the top 10 predicted
  entities for each training example"; no ablation isolates the hard-negative gain. The cross-encoder
  concatenates context and candidate and re-ranks ≤ 100 candidates; it beats the bi-encoder by 1.6-3.7 points
  (already [V] in `LITERATURE-REVIEW.md`). Gillick et al. (CoNLL 2019; arXiv 1909.10506) [V abstract + ar5iv]:
  iterative mining of entities ranked above the gold one gives a "dramatic" gain, large in the first round,
  levelling off later (figure only, no table numbers); they note a dual encoder "cannot directly compare" the
  mention span to the entity title.
* **NIL / "none" options.** Lee et al., end-to-end coreference (arXiv 1707.07045) [V ar5iv]: the dummy antecedent
  ε has score **fixed at 0**, so the model links to the best antecedent "if any non-dummy scores are positive,
  and it abstains if they are all negative"; loss is the marginal log-likelihood over gold antecedents. Zhu et
  al., "Learn to Not Link" (Findings of ACL 2023; arXiv 2305.15725) [V abstract]: NIL prediction is
  under-studied; including both NIL types in training "significantly" affects NIL accuracy (no numbers in the
  abstract).
* **Dialogue state tracking.** TRADE (arXiv 1905.08743) [V ar5iv] uses a separate three-way slot gate
  {ptr, none, dontcare} read from an attention context vector, loss weight 1; no gate ablation is reported.
  SOM-DST [V, earlier review] predicts an operation from each slot's own marker state inside one BERT pass.
  The Schema-Guided DST baseline (arXiv 1909.05855) [V ar5iv] encodes each slot's natural-language description
  with BERT and scores status {none, dontcare, active} by projecting the utterance embedding with each slot
  embedding: per-slot keys come from attribute *descriptions*.
* **Structure of PASTE's gold (facts given in the brief).** 228/456 (50 %) of validation targets are
  NEW-ATTRIBUTE, 184 (40 %) existing records, 44 (10 %) NEW-ENTITY. Within the correct profile, choosing between
  "record j" and NEW-ATTRIBUTE is, in this generator, largely the question "does this profile already have a
  record of the unit's attribute class?" (my reading of DATASET-DESIGN: record attributes are ontology class
  names). The attribute head is already at 0.83, while addressing is at 0.30.
* **Not found:** a controlled comparison of "learned NEW logit vs fixed-zero dummy" in entity linking or DST [U].
  Note that PASTE already uses a full softmax over *all* candidates, so in-batch/hard negatives (needed in BLINK
  and Gillick because candidate pools are huge) add only cross-episode negatives here.

**Ranked cheap changes (my suggestions; evidence level noted)**

1. **Attribute-agreement term in record scoring.** Apply the existing unit attribute classifier to each record's
   attribute-field state ã_j as well (labels are free: the record's own class), and add
   λ · log Σ_c p_u(c) p_j(c) to S^A(u, j); give S^A(u, ∅_e) the complementary term
   log(1 − max_{j∈e} Σ_c p_u(c) p_j(c)). This reuses the strongest head (0.83) for the decision that half the
   gold set depends on. Analogy: slot-specific keys in SGD and SOM-DST [V]; the exact mechanism is mine [U]. It
   uses no class ids at inference, so it also works on free-text production attributes.
2. **Candidate-relative NEW logits.** Replace S^E(∅) = wᵀq + b and S^A(∅_e) = wᵀ[q; π̃_e] + b by a fixed 0 (Lee
   et al.) or by b + (features of the candidate scores, e.g. their max). The current NEW logits cannot see how
   well any candidate matches, and with 50-60 % NEW gold they may learn to absorb uncertainty. One-line change;
   evidence for the fixed dummy is a design precedent [V], not an ablation.
3. **Enable L_idc (spec §6.1) with same-attribute look-alike negatives**, which is exactly Gillick/BLINK
   hard-negative mining at the entity level [V that mining helps there; U at this scale]. It targets the entity
   factor, on which 90 % of gold depends.

Ranked lower: cross-attention scoring of q against record field tokens (BLINK: +1.6-3.7, costlier); a
learnable logit scale (`bil` averages heads and divides by √d_a, so initial logits are small; CLIP-style
learnable temperature is common [S], untested here).

**Implication for PASTE**

* *Evidence:* successful systems either read each candidate with its own marker in a joint pass (SOM-DST),
  give "none" a calibrated relation to candidate scores (fixed-0 dummy), or mine hard negatives (BLINK,
  Gillick). None of these isolates gains at PASTE's scale.
* *Suggestion:* before changing the head, log **per-level teacher-forced accuracy** (entity factor; record
  factor given gold entity; per gold type) and a **rule reference** (gold entity + predicted attribute → existing
  record of that class, else NEW-ATTRIBUTE). If the rule beats 0.30 by a wide margin, change 1 is justified.
  Heads are shared by PASTE and M1c (spec §9.1), so any change must be applied to both and recorded as a spec
  amendment before the main runs; also wait for E24's 1,000-step addressing accuracy, since 300 steps may simply
  be too few for a pointer supervised only on PERSIST/FORGET units.

---

## Q3. Closed-loop / scheduled-sampling schedules for models that consume their own decisions

**Evidence**

* **Bengio et al. 2015** (arXiv 1506.03099) [V ar5iv]. ε_i = probability of feeding the *truth*; schedules
  linear max(ε, k − c·i), exponential k^i, inverse sigmoid k/(k + exp(i/k)); no numeric constants are given.
  Captioning and parsing used inverse sigmoid; speech used linear ramps over ten epochs, then constant.
  **Always sampling from the start fails**: captioning BLEU-4 11.2 vs 28.8 baseline vs 30.6 scheduled; parsing
  gave invalid trees (scheduled 88.08 F1 vs 86.54). In speech, configurations ending at 0 % truth decoded best
  (FER 34.5-35.0), and 0.9 → 0.5 decoded worst among sampled ones (42.0) though best at next-step prediction.
  The coin is flipped **per token**; flipping **once per sequence "gave much worse results"**. No
  backpropagation through samples.
* **Mihaylova and Martins 2019, "Scheduled Sampling for Transformers"** (arXiv 1906.07651; venue [U]) [V ar5iv]:
  linear decay "works best for our data"; exponential and inverse sigmoid "degrade too fast". Feeding the argmax
  token was far worse than teacher forcing (DE-EN dev BLEU 23.99 vs 35.05); soft mixtures roughly matched the
  baseline; backpropagating through the first pass degraded badly.
* **Zhang et al. 2019, "Bridging the Gap between Training and Inference for NMT"** (arXiv 1906.02448; venue [S]
  ACL 2019) [V ar5iv]: per-word choice, truth probability μ/(μ + exp(e/μ)) by epoch with μ = 12 (so truth stays
  above ≈ 0.8 for the first ten epochs, my arithmetic); +0.5 to +2.4 BLEU; no sensitivity analysis.
* **DAgger** (Ross et al., AISTATS 2011; arXiv 1011.0686) [V ar5iv]: mix β_i π* + (1 − β_i) π̂_i with β_1 = 1;
  the indicator β_i = I(i = 1) "often performs best in practice"; p = 0.5 decay slightly better on Mario; data
  from all iterations is aggregated. Supervised-only training "did not show the learner how to recover".
* **Dynamic oracles with exploration** (Ballesteros et al., arXiv 1603.03793; venue [S] EMNLP 2016) [V ar5iv]:
  needs an oracle that gives optimal actions from *any* state reached after an error; the next transition is
  **sampled** from the model's distribution sharpened by α = 0.75; following the one-best action "did not work
  well" because the parser became accurate early and saw "very few error states". Gains 0.5-0.8 UAS.
* **DST.** FPDSC (arXiv 2107.05168) [V ar5iv]: phase 1 teacher forcing, phase 2 "uniform scheduled sampling" with
  previous states "half predicted ... and half true labels"; about +3 JGA on MultiWOZ 2.1 (e.g. 54.08 → 59.07);
  the sampling phase costs 2× per epoch. Correctable-DST (Xie et al., EMNLP 2022) [V PDF]: instead of rollouts, a
  "Predictive State Simulator" corrupts the gold previous state per slot with probability β (delete a value;
  insert a value into an empty slot). +1.77 JGA; insertion (+1.14) helps more than deletion (+0.58); **β = 0.06
  best, 0.09-0.12 worse** (81.27 → 80.25 → 79.30). These β values are reported on the test set.
* **Theory caveat:** Huszár (arXiv 1511.05101) [V abstract] shows the scheduled-sampling objective is "improper
  and leads to an inconsistent learning algorithm"; gains are empirical, not guaranteed.

**Failure modes reported:** sampling from step 0 (Bengio); per-sequence rather than per-step mixing (Bengio);
argmax/one-best rollouts that produce too few errors (Ballesteros, Mihaylova); backpropagating through sampled
decisions (Mihaylova); too high a corruption rate (Correctable-DST); fast-decaying schedules (Mihaylova).

**Implication for PASTE**

* *Evidence vs spec §6.3:* a teacher-forced phase first (0-40 %), a linear ramp, and a cap of 0.5 are all within
  reported practice (Bengio, Mihaylova, FPDSC). PASTE's provenance remapping plays the role of a dynamic oracle
  (Ballesteros), which the reported successes require. **However, `train.py` flips the closed-loop coin once per
  episode** — the per-sequence variant that Bengio found much worse.
* *Suggestions (untested):* (1) mix **per segment**: before each segment, with probability ε_t execute the model's
  own operations for the previous segment instead of gold, so stores are partially corrupted rather than
  all-or-nothing; (2) add a **Correctable-DST-style corruption of the gold store** (spurious insertions and
  deletions at a low rate, e.g. 3-6 % per record, cheaply relabelled by provenance remapping) from the start of
  the closed-loop phase — no rollouts, so cheap on CPU, and it targets false-memory recovery; (3) start the ramp
  on a **competence condition** (e.g. teacher-forced address accuracy above a preset level), not a fixed 40 %,
  because at today's 0.30 the model's own stores would be mostly wrong; (4) if rollouts are used, sample
  operations from the model's distributions rather than taking thresholded argmax, to get error states as the
  model improves. Each is a training change and must be identical for PASTE and all baselines; closed-loop
  training is also ablation A5, so its effect is measured separately.

---

## Q4. Transferring a cost-weighted write-gate threshold across a wording shift

**Evidence**

* **Calibration and confidence thresholds degrade under shift.** Ovadia et al. (NeurIPS 2019; arXiv 1906.02530)
  [V abstract]: under dataset shift "traditional post-hoc calibration does indeed fall short"; methods that
  marginalise over models (e.g. ensembles) hold up better. Kamath, Jia and Liang, "Selective Question Answering
  under Domain Shift" (ACL 2020; arXiv 2006.09462) [V abstract]: abstaining by softmax probability works poorly
  out of domain because models are overconfident there; a separate calibrator that has seen the model's
  behaviour on *some* out-of-domain data (even a different domain from test) answers 56 % of questions at 80 %
  accuracy vs 48 % for raw probabilities.
* **Pre-trained encoders are comparatively robust.** Desai and Durrett, "Calibration of Pre-trained
  Transformers" (EMNLP 2020; arXiv 2003.07892) [V abstract]: BERT/RoBERTa are calibrated in domain; out of
  domain their calibration error is up to 3.5× lower than non-pretrained baselines; temperature scaling helps in
  domain, and **label smoothing** helps out-of-domain calibration.
* **Prior (label) shift** is separable from covariate shift: if the share of units that should be persisted
  differs between wordings, the optimal threshold moves even with perfect calibration. Alexandari et al. (ICML
  2020; arXiv 1901.06852) [V abstract]: EM prior re-estimation with bias-corrected calibration beats BBSL/RLLS and
  needs no retraining, but it needs unlabeled target inputs and calibrated probabilities.
* **Estimating behaviour on unlabeled target data.** Garg et al., ATC (ICLR 2022; arXiv 2201.04234) [V
  abstract]: a confidence threshold learned on source predicts target accuracy 2-4× more accurately than prior
  methods. Again requires target inputs.
* **Analytic threshold (decision theory; Elkan, IJCAI 2001 [S]; derivation mine).** With calibrated P(persist)
  = p and cost 3·FP + FN, persist iff 3(1 − p) < p, i.e. p > 0.75. PASTE's L_gate weights negatives by 3, whose
  minimiser is g = p / (p + 3(1 − p)); p > 0.75 then corresponds to **g > 0.5**. If temperature scaling is then
  fitted with *unweighted* NLL, the analytic threshold becomes 0.75 on the rescaled probability. An analytic
  threshold depends only on calibration, not on a validation-specific score distribution.
* **Not found [U]:** a study of cost-weighted threshold transfer for memory-write or admission gates under a
  paraphrase shift specifically.
* **Project facts.** Test PE pools 600 plans × {programmatic, API} wording (EVALUATION-PROTOCOL §7); validation
  is "same mix as train" and has API wording for 572/600 plans (E19); train/val templates use families A/B,
  test programmatic wording uses family C (DATASET-DESIGN). So the API half of test shares its generator with
  API validation; the main unseen shift is family-C templates plus test-only values/entities.

**Implication for PASTE**

* *Evidence:* a threshold tuned on one distribution tends to be over-permissive (too many false positives) on
  shifted inputs (Kamath; Ovadia), which here would raise FPM, the co-primary safety endpoint. Seeing *any*
  shifted data during calibration helps (Kamath).
* *Suggestions (all validation-only, identical for every system, pre-registerable):*
  1. **Calibrate on a wording mix that matches the test pooling** (50 % programmatic, 50 % API validation
     episodes of the same plans), and log θ_W fitted on each wording separately as a diagnostic.
  2. **Measure transfer inside validation before test:** fit θ_W on family-A episodes, evaluate on family-B (and
     programmatic → API, and the reverse). The PE/FPM loss at the transferred threshold vs the oracle threshold
     estimates how fragile θ_W is to the family-C shift.
  3. **Report the analytic threshold alongside the tuned one** (g = 0.5 under the 3:1-weighted loss, or 0.75
     after unweighted temperature scaling). If tuned and analytic thresholds differ a lot, the gate is
     miscalibrated; a pre-registered rule such as "use the analytic threshold if the transfer gap in (2) exceeds
     X" is cheap and avoids test peeking.
  4. Optional training-side change: label smoothing (Desai and Durrett) for every system. EM prior correction or
     ATC on test inputs would read unlabeled test data before the final evaluation; allow it only as a
     pre-registered step inside `evaluate.py --final`, reported as a labelled variant.
