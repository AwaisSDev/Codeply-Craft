# PASTE v2: architecture specification

Profile-Addressed Segment-memory Transformer, version 2. Status:
**specification; nothing trained.** Date 2026-11-01, branch
`research/paste-architecture`.

This document supersedes PASTE v1
(`research/architecture/PASTE-FORMAL-SPECIFICATION.md`) for this branch. v1
itself is left unchanged. Prior art for each mechanism is in
`LITERATURE-REVIEW.md`, and the falsifiable claims are in
`ARCHITECTURE-HYPOTHESES.md`. Nothing here is claimed to be novel; §14 says
what the experiments can and cannot establish.

## 0. Summary

PASTE reads a conversation **one segment at a time**. For each segment it
proposes structured memory operations against the Brain's persistent
records, and it maintains its own temporary state. It never writes to the
Brain: the Brain validates and executes, as it does today.

| Component | v2 mechanism | Why this one (short) |
|---|---|---|
| Segment encoder | Ettin-32M (MIT, pretrained), reimplemented in PyTorch to control masks and positions; weights loaded unchanged | ~5K-50K examples cannot teach language; Ettin-32M keeps the total inside 20-50M |
| Persistent memory (input) | Brain records arrive on every call as **soft tokens**: 1 per profile (entity) + 2 per record (attribute, value). All share one position id, so they form an unordered set. Each record is encoded once per version and cached | Auditable store stays outside the network; ~3× fewer tokens than records as text |
| Addressing | **Hierarchical profile addressing**: P(record) = P(entity) · P(record \| entity), with NEW-ENTITY and NEW-ATTRIBUTE outcomes; learned bilinear + interaction scores | Separates "same entity?" from "similar text?" |
| Identity and relation | Relation head over the addressed record: SAME / UPDATE / CORRECTION / CONTRADICTION | Maps onto the Brain's reinforced / replaced / corrected / challenged |
| Temporary state | ≤ 8 **explicit temporary items** (vector + source text + type + TTL) and r = 4 **recurrent memory tokens** (GRU-gated; reset at every session boundary) | Continuity without re-reading history; nothing latent crosses a session |
| Persistent write control | A dedicated **write gate**, cost-weighted 3:1 and calibrated on validation; temporary → persistent only by an explicit **PROMOTE** | "Temporary state must never silently become persistent memory" |
| Other operations | FORGET (reuses the addressing), RETRIEVE (per-record head), MERGE (record-pair head) | Complete operation vocabulary |

**Central scientific test (owner decision 5):** PASTE against **M1c**: the
same encoder, run segment by segment, with the Brain's records and the
temporary items fed forward **as text**, and **identical heads, losses, data,
seeds, budget and calibration**. Only the memory pathway differs.

Parameters (exact, `tools/param_count.py`):

| | Ettin-32M | Ettin-17M |
|---|---|---|
| PASTE | **39.26M** | 20.70M |
| M1c | 36.42M | 19.43M |
| M1c-m (matched) | 39.07M | 20.61M |

## 1. Changes from v1, and why

| v1 | v2 | Reason |
|---|---|---|
| Ettin-150M backbone | Ettin-32M; 17M for the scale check | Owner: start at 20-50M; 32M is the only Ettin size inside the range |
| Gated-DeltaNet matrix state inside 3 encoder layers | r memory tokens with a GRU gate, plus explicit temporary items | No custom kernel, so it runs in plain PyTorch / ONNX. The memarch critique and v1 §4 note that llama.cpp cannot run a delta-rule state. A delta-rule temporary memory remains an exploratory variant (§9, X1) |
| Type-conditioned decay ρ_τ | Dropped | Input-dependent gates already include it; it adds no expressive power (memarch critique §2) |
| Profile slots written by the network | Records come from the Brain on every call; the network only proposes | Auditability: the user can see, edit and delete every persistent memory |
| Cosine addressing with hand thresholds | Learned hierarchical addressing with hard negatives | The brief: "Do not assume ordinary cosine similarity is sufficient" |
| Segment-type controller | Per-unit decisions (a unit is a value-bearing span) | v1's own open question: one segment can hold a fact and a joke |
| No temporary/persistent boundary | Separate pathways, write gate, explicit PROMOTE, session reset | Brief §2C |
| Teacher-forced only | Plus closed-loop scheduled sampling (§6.3) | SOM-DST: feeding a model its own predicted state multiplies errors 2.47× |
| M1c is "the bar" | M1c with **shared heads** is the central test; plus parameter-matched and windowed variants | Owner decision 5; isolates the memory pathway |

## 2. Task definition

### 2.1 Episodes

An **episode** is one user's conversation history:

* sessions σ = 1..Σ, separated by time gaps;
* segments s = 1..N, globally indexed, each 1-4 speaker-tagged turns
  (`User:` / `Assistant:`) of at most S = 256 tokens;
* each segment has a timestamp t_s and a flag β_s = 1 when it opens a new
  session.

### 2.2 Persistent store (the Brain; external)

Before segment s the Brain holds records. The adapter passes PASTE at most
K_max = 32 **candidate records** B_s = {r_1..r_K}: the records the Brain's
retrieval returns, as today's known memories are. Each record is

r_j = (id_j, ε_j, a_j, v_j, k_j, σ_j, g_j, e_j)

| Field | Meaning |
|---|---|
| ε_j | Profile (entity) key, e.g. `user`, `sister:Ayesha`, `coworker:Ali`, `project:Atlas` |
| a_j | Attribute text, e.g. `home city` |
| v_j | Value text |
| k_j | Kind, one of 9: preference, fact, routine, style, decision, idea, requirement, todo, context |
| σ_j | Status: confirmed / tentative / locked |
| g_j | Age bucket |
| e_j | Evidence bucket |

**Profiles** 𝓔_s are the distinct ε_j plus `user`, which is always present.
|𝓔_s| = E ≤ E_max = 16. Each profile has a display text
(e.g. "Ayesha (sister)").

The production Brain has no entity field; profile keys must be derived from
slot naming. This is an integration open question (§11), and it does not
affect the research data, which carries explicit entities.

### 2.3 Temporary state (PASTE-managed; not the Brain)

Z_s = {ζ_1..ζ_T}, T ≤ T_max = 8. Each item has:

| Field | Values |
|---|---|
| vector z_i | ∈ ℝ^d |
| type τ_i | PLAN, TASK, CONTEXT, REFERENCE, FRAME (hypothetical or joking frame), PENDING (an offer to remember awaiting confirmation) |
| TTL class ℓ_i | SESSION, UNTIL (with a time u_i), OPEN (until completed; hard cap 14 days, as `brain.js:52`) |
| creation segment c_i | |
| source text | ≤ 280 characters |

Recurrent memory tokens: h_s ∈ ℝ^{r×d}, r = 4.

### 2.4 Outputs per segment (the operation vocabulary)

| Brief action | PASTE output | Brain action (`brain.js`) |
|---|---|---|
| WRITE | PERSIST unit addressed to NEW-ATTRIBUTE(e) or NEW-ENTITY | `added` |
| UPDATE | PERSIST unit addressed to record j with relation UPDATE / CORRECTION / CONTRADICTION | `replaced` / `corrected` / `challenged` (a contradiction needs repetition, `brain.js:55`) |
| MERGE | (a) PERSIST unit → record j with relation SAME; (b) record-pair merge | `reinforced`; consolidation |
| IGNORE | Unit routed IGNORE (or TEMP, which is IGNORE from the Brain's view) | `ignored` / nothing |
| FORGET | Unit routed FORGET → record j or a whole profile | `forgotten` |
| RETRIEVE | Per-record relevance above threshold | read path only |
| (temporary) | T-WRITE, T-UPDATE, T-EXPIRE, PROMOTE | not the Brain; PROMOTE emits a WRITE proposal |

Every proposal carries a target id, a payload (entity, attribute, value,
kind, certainty), a confidence and an evidence span.

### 2.5 Invariants (all systems, enforced in code and unit-tested)

* **I1.** Persistent proposals come only from the write gate (§5.3), or from
  FORGET with its own threshold.
* **I2.** Temporary content reaches the Brain only through an explicit
  PROMOTE, which itself passes the write gate.
* **I3.** No latent state crosses a session: h is reset to h₀ at every
  session boundary. Only temporary items with explicit text and a TTL survive.
* **I4.** Inference is deterministic for fixed inputs.
* **I5.** The Brain may reject any proposal. PASTE never writes.

## 3. Notation

| Symbol | Meaning | Ettin-32M value |
|---|---|---|
| d, L, H | Width, layers, heads | 384, 10, 6 |
| w | Local attention window (ModernBERT) | 128 (±64) |
| 𝒢 | Global-attention layers (ℓ mod 3 = 0) | {0, 3, 6, 9} |
| S | Max segment tokens | 256 |
| K, E, T, r | Records, profiles, temporary items, memory tokens | ≤32, ≤16, ≤8, 4 |
| P | Prefix length r + T + E + 2K | ≤ 92 |
| LN₀∘Emb | Ettin's token embedding + embedding LayerNorm (the layer-0 input map) | |
| Enc | The Ettin encoder (all layers + final norm) | |
| sg(·) | Stop-gradient | |
| H_a, d_a | Addressing heads and head width | 4, 64 |

## 4. Memory representations and input assembly

### 4.1 Record tokens (persistent store as soft tokens)

Record text: ρ_j = "⟨profile text of ε_j⟩ · ⟨a_j⟩: ⟨v_j⟩". F_j^att and
F_j^val are the token positions of the attribute and value fields in ρ_j's
tokenization.

**Static pooled embedding** (in the input space from step 0):

ā⁰_j = mean_{t∈F_j^att} LN₀(Emb(ρ_{j,t})), and v̄⁰_j likewise over F_j^val.

**Contextual pooled state**, computed once per record version, then cached
and stop-gradient:

ā^L_j = mean_{t∈F_j^att} sg(Enc(ρ_j))_t, and v̄^L_j likewise.

π̄⁰_e and π̄^L_e are the same two poolings over the profile's display text.

$$x^{att}_j = \bar a^0_j + \tfrac12\,\bar\pi^0_{\varepsilon_j} + W_{att}\,\bar a^L_j + W_{bind}\,\bar\pi^L_{\varepsilon_j} + \mu_j + \gamma_{att}$$

$$x^{val}_j = \bar v^0_j + \tfrac12\,\bar\pi^0_{\varepsilon_j} + W_{val}\,\bar v^L_j + W_{bind}\,\bar\pi^L_{\varepsilon_j} + \mu_j + \gamma_{val}$$

$$x^{prof}_e = \bar\pi^0_e + W_{prof}\,\bar\pi^L_e + \gamma_{prof}$$

* μ_j = E_kind[k_j] + E_status[σ_j] + E_age[g_j] + E_ev[e_j].
* γ are learned group embeddings.
* W_att, W_val, W_bind, W_prof and every metadata table are **zero-initialised**.

At step 0, therefore, each record token is the average input embedding of
its words plus half of its profile's: a bag-of-words token that the
pretrained encoder can already read. Training learns how much contextual
information to add. The ½ π̄⁰ term binds a record to its profile from step 0.

### 4.2 Temporary items

$$x^{tmp}_i = \mathrm{mean}_{t\in\text{text}_i}\mathrm{LN}_0(\mathrm{Emb}(\cdot)) + W_z z_i + E_{ttype}[\tau_i] + E_{tage}[\text{age}_i] + \gamma_{tmp}$$

W_z is zero-initialised.

### 4.3 Recurrent memory tokens

$$x^{mem}_m = W_h h_{s-1,m} + E_{mem}[m] + E_{dt}[\Delta_s],\qquad m = 1..r$$

* Δ_s is the time since the previous segment, in 16 log buckets.
* h₀ is learned.

### 4.4 Input, positions, mask

$$X^0_s = [\,x^{mem}_{1..r};\ x^{tmp}_{1..T};\ x^{prof}_{1..E};\ x^{att}_{1..K};\ x^{val}_{1..K};\ \mathrm{LN}_0(\mathrm{Emb}(x_s))\,]\in\mathbb R^{(P+n_s)\times d}$$

* **Positions:** every prefix token has position 0; segment tokens
  ([CLS] … [SEP]) have positions 1..n_s. RoPE is applied as in Ettin.
* **Mask in layer ℓ:** allowed(i, j) = [ℓ ∈ 𝒢] ∨ prefix(i) ∨ prefix(j) ∨
  |pos_i − pos_j| ≤ w/2, with padding masked. Prefix tokens are thus global
  tokens in every layer.
* **Consequence:** the encoder is permutation-equivariant over records,
  profiles and temporary items, because they share a position and no other
  order signal exists. Order shuffling is therefore unnecessary for PASTE
  (M1c needs it). Unit test T3 checks this.

### 4.5 Encoder

Enc is a PyTorch reimplementation of ModernBERT, loading the Ettin
checkpoint (`model.*` tensors; MLM head dropped). Test T1 requires it to
match Hugging Face `ModernBertModel` within 1e-4 when the prefix is empty.

Outputs: H_s = Enc(X⁰_s). Split by group:

* memory tokens h̃_m, temporary items z̃_i, profiles π̃_e;
* record fields ã_j, ṽ_j;
* segment tokens t̃_t.

The segment context is c_s = mean_t t̃_t.

## 5. Heads and the decision procedure

### 5.1 Units and entity mentions

* **Two BIO taggers over segment tokens** (overlap allowed):
  * units: O / B / I;
  * entity mentions: O / B / I.
* **Unit:** the minimal span naming a value or content, e.g. "Karachi",
  "dark mode", "call the bank at 3", "my address".
* **Unit query:**

$$q_u = \mathrm{LN}\big(W_2\,\mathrm{GELU}(W_1[\mathrm{mean}_{t\in u}\tilde t_t;\ \tilde t_{\text{first}(u)};\ \mathrm{mean}_{|t-u|\le16}\tilde t_t;\ c_s])\big)$$

### 5.2 Unit classification

A linear head on q_u gives:

* kind (9);
* certainty (6: stated, implied, temporary, joking, hypothetical, quoting);
* attribute class (|A| = 100 ontology classes + OTHER);
* temporary type (6) and TTL class (3);
* route3 over {TEMP, IGNORE, FORGET}.

### 5.3 Persistent write gate (explicit, separate)

$$g_u = \sigma\big(w^\top \mathrm{GELU}(W_g[q_u; c_s] + b) + b'\big)$$

$$P(\text{PERSIST}\mid u) = g_u,\qquad P(r\mid u) = (1-g_u)\,\mathrm{softmax}(\text{route3})_r$$

**Decision:** PERSIST iff g_u ≥ θ_W. Otherwise the argmax of route3, where
FORGET additionally requires its probability to be ≥ θ_F.

θ_W is chosen on **validation** to minimise 3·FP + FN over persistent
proposals (owner decision; 2:1 and 5:1 are also reported).

### 5.4 Source pointer (PROMOTE)

For PERSIST units:

* src ∈ {SELF} ∪ {temporary items};
* score(SELF) = w_selfᵀ q_u;
* score(i) = ⟨W_sq q_u, W_sk z̃_i⟩ / √128.

If src = i, the content query is q*_u = Query([z̃_i; z̃_i; z̃_i; c_s]) (the
same MLP), and the operation is PROMOTE(i). Otherwise q*_u = q_u.

### 5.5 Hierarchical profile addressing

Two scoring functions:

$$\mathrm{bil}(q,k) = \tfrac1{H_a}\sum_{h=1}^{H_a}\frac{\langle W^{(h)}_q q,\ W^{(h)}_k k\rangle}{\sqrt{d_a}}$$

$$\mathrm{int}(q,k) = w^\top\mathrm{GELU}(W[q; k; q\odot k] + b) + b'$$

Entity level, with NEW-ENTITY written as ∅:

$$S^E(u,e) = \mathrm{bil}_E(q^*_u,\tilde\pi_e) + \mathrm{int}_E(q^*_u,\tilde\pi_e),\qquad S^E(u,\varnothing) = w_\varnothing^\top q^*_u + b_\varnothing$$

$$\alpha^E(u,\cdot) = \mathrm{softmax}\ \text{over}\ \mathcal E_s\cup\{\varnothing\}$$

Record level, within entity e. The record key is κ_j = W_κ[ã_j; ṽ_j] + b_κ:

$$S^A(u,j) = \mathrm{bil}_A(q^*_u,\kappa_j) + \mathrm{int}_A(q^*_u,\kappa_j)\ \ (\varepsilon_j = e),\qquad S^A(u,\varnothing_e) = w_A^\top[q^*_u;\tilde\pi_e] + b_A$$

$$\alpha^A(u,\cdot\mid e) = \mathrm{softmax}\ \text{over}\ \{j:\varepsilon_j=e\}\cup\{\varnothing_e\}$$

Joint outcome over Ω_s = records ∪ {NEW-ATTRIBUTE(e)} ∪ {NEW-ENTITY}:

$$P(j\mid u) = \alpha^E(u,\varepsilon_j)\,\alpha^A(u,j\mid\varepsilon_j),\quad P(\varnothing_e\mid u) = \alpha^E(u,e)\,\alpha^A(u,\varnothing_e\mid e),\quad P(\varnothing\mid u) = \alpha^E(u,\varnothing)$$

* These sum to 1.
* Decoding is the argmax over Ω_s.
* Training is factorised cross-entropy: −log α^E(e*) − log α^A(j* | e*).

**Why the factorisation (hypothesis H2, not a claim).** A record with an
identical attribute and value under the **wrong** profile can receive no
more probability than α^E gives that profile. The entity scorer is trained
on stores that deliberately contain look-alike profiles. In a flat pointer
(ablation A1), attribute/value similarity can dominate.

### 5.6 Relation

For PERSIST units addressed to a record j (the gold j in training, the
predicted j at inference):

$$P(\text{rel}\mid u,j) = \mathrm{softmax}\big(W_2\,\mathrm{GELU}(W_1[q^*_u;\tilde a_j;\tilde v_j;q^*_u\odot\tilde v_j;|q^*_u-\tilde v_j|])\big),\quad \text{rel}\in\{\text{SAME, UPDATE, CORRECTION, CONTRADICTION}\}$$

### 5.7 New-entity mention pointer

For the NEW-ENTITY outcome, a pointer over the entity-mention spans in the
segment, plus NONE:

* score(m) = ⟨W_mq q*_u, W_mk m̄⟩ / √128;
* the new profile's text is the chosen mention.

### 5.8 FORGET

FORGET units reuse the addressing. Outcome j means FORGET(j); outcome ∅_e
means FORGET-PROFILE(e); outcome ∅ means nothing matched, so nothing is
proposed.

### 5.9 RETRIEVE

$$p^{ret}_j = \sigma\big(\mathrm{MLP}([\tilde\pi_{\varepsilon_j};\tilde a_j;\tilde v_j;c_s;c_s\odot\tilde v_j])\big)$$

RETRIEVE(j) if p ≥ θ_R. This re-ranks the K candidates the Brain supplied;
the Brain's own retrieval remains the first stage.

### 5.10 MERGE (record pairs)

* **Candidate pairs:** all pairs within a profile, plus the 32 cross-profile
  pairs with the highest cos(κ_j, κ_k). This bounds the cost at large K.
* **Score:**

$$p^{mrg}_{jk} = \sigma\big(\mathrm{MLP}([\tilde v_j\odot\tilde v_k;\ |\tilde a_j-\tilde a_k|;\ \tilde\pi_{\varepsilon_j}\odot\tilde\pi_{\varepsilon_k};\ c_s])\big)$$

* **Execution:** the Brain keeps the record with more evidence (ties go to
  the newer one) and folds in the other's evidence.

### 5.11 Temporary-state controller (separate pathway)

**Addressing** for TEMP units, over items ∪ {NEW}:

* S^T(u, i) = bil_T(q_u, z̃_i) + int_T(q_u, z̃_i);
* S^T(u, NEW) = wᵀ q_u.

**Operations:**

* **T-WRITE (NEW):** creates the item ζ = (W_new q_u, τ̂, ℓ̂, c = s, u = resolve(span), span text).
* **T-UPDATE (i):** z_i ← GRU_T(q_u, z_i), and the text becomes the last two spans.
* **T-EXPIRE (learned):** p^exp_i = σ(MLP([z̃_i; c_s])) ≥ θ_X.

**Deterministic expiry:**

* SESSION items are removed when the session ends;
* UNTIL items are removed when t > u_i;
* every item is capped at 14 days.

**Capacity:** above T_max, evict the oldest SESSION item, then the oldest
item, and log the eviction.

**PROMOTE(i):** item i expires once its content has been proposed.

Untouched items keep their vector unchanged, so stored items do not drift.

### 5.12 Segment transition

$$h_{s,m} = \mathrm{GRU}_H(\tilde h_m,\ h_{s-1,m})\quad(\text{input }\tilde h_m,\ \text{hidden }h_{s-1,m})$$

The update gate z = σ(W_iz h̃ + W_hz h + b) is an input-dependent retention
gate: z → 1 keeps the state, z → 0 overwrites it.

* If β_{s+1} = 1, then h_s ← h₀ (invariant I3).
* Carried state: (h_s, Z_s).
* The persistent store comes back from the Brain at the next call.

### 5.13 Decoding procedure (deterministic)

**For each predicted unit u:**

1. **If g_u ≥ θ_W (PERSIST):** take src and the argmax outcome ω.
   * ω = j: SAME → MERGE_INTO(j); UPDATE or CORRECTION → UPDATE(j, value = span); CONTRADICTION → UPDATE(j, challenge).
   * ω = ∅_e: WRITE(e, attribute class, value = span, kind, certainty).
   * ω = ∅: WRITE(NEW-ENTITY(mention), …).
   * If src = i: PROMOTE(i), with value = text_i.
2. **Otherwise:** apply route3. TEMP → temporary operations; FORGET (if ≥ θ_F) → FORGET; IGNORE → nothing.

**Then:**

* RETRIEVE(j) for p^ret_j ≥ θ_R;
* MERGE(j, k) for p^mrg_jk ≥ θ_M;
* T-EXPIRE for p^exp_i ≥ θ_X.

At most one operation per record per segment, in priority FORGET > UPDATE >
MERGE_INTO > MERGE. Confidence is the product of the probabilities along the
decision path.

## 6. Training

### 6.1 Losses

Per episode, averaged over segments.

**Core losses** (always on; equal weights λ = 1 unless stated):

| Term | Definition | Supervises (brief §7 objective) |
|---|---|---|
| L_tag | CE of both BIO taggers | units and entity mentions |
| L_cls | CE of kind, certainty, attribute (PERSIST/TEMP units), temporary type and TTL (TEMP units), route3 (non-PERSIST units) | memory action prediction |
| L_gate | Cost-weighted BCE: −[y log g + 3 (1−y) log(1−g)] | **persistent-write precision** |
| L_addr | −log P(ω* \| u) for PERSIST and FORGET units, factorised (§5.5) | addressing and **identity matching** |
| L_rel | CE of the relation for units whose gold target is a record | relation prediction (update, contradiction, equivalence) |
| L_src | CE of the source pointer | PROMOTE |
| L_ment | CE of the mention pointer for NEW-ENTITY | new-entity naming |
| L_tmp | CE of temporary addressing + BCE of expiry | **temporary-state loss** |
| L_ret | BCE (positive weight min(10, n₋/n₊)) | **retrieval relevance** |
| L_mrg | BCE over candidate pairs (weighted) | merge correctness |

**Auxiliary losses** (off by default; each is tested by ablation, brief §7:
"determine which objectives provide measurable improvements"):

| Term | Definition | Brief objective |
|---|---|---|
| L_idc | InfoNCE between q*_u and its gold profile π̃_{e*}, with in-batch profiles from other episodes that share the attribute as hard negatives (temperature 0.1) | identity contrastive |
| L_rec | From h_s, predict a multi-hot of the attribute classes and entity roles mentioned in segments s−3..s (BCE) | **segment continuity** |

**Consistency** (brief: "discourage duplicated or contradictory memory") is
not a separate loss. Duplicates are already penalised by L_addr: gold is
SAME → record, not NEW-ATTRIBUTE. They are also supervised by L_mrg and
**measured** (duplicate-creation rate). An extra loss would duplicate L_addr's
gradient.

### 6.2 Backpropagation through segments

Episodes are cut into windows of 8 segments. The carried state passes
between windows detached. Within a window, gradients flow through h and the
temporary-item vectors for up to 4 segments (truncated BPTT). The cached
record encodings are stop-gradient (as in Transformer-XL's cache).

### 6.3 Teacher forcing, then closed loop

The store and temporary items at segment s come from one of two sources:

* **gold:** B*_s from the generator, and temporary items rebuilt from gold
  operations with the model's own vectors; used with probability 1 − ε_t;
* **closed loop:** the model's own operations from earlier segments,
  executed by the Brain simulator (§10.1); used with probability ε_t.

ε_t = 0 until 40 % of the steps, then rises linearly to 0.5 by 80 %, then
stays at 0.5.

**Provenance remapping:** every simulated record carries the gold fact id
that created it, or `spurious`. Gold targets of later units are remapped to
the record with that provenance. If none exists, the gold becomes
NEW-ATTRIBUTE / NEW-ENTITY: the model is taught to recover from its own
earlier omission.

### 6.4 Curriculum

For the first 20 % of steps, windows are limited to ≤ 4 segments and a
single session. After that, full windows.

### 6.5 Optimisation (pre-registered defaults; identical for every system)

| Setting | Value |
|---|---|
| Optimiser | AdamW (0.9, 0.98), weight decay 0.01 |
| Learning rates | encoder 5e-5; new modules and heads 5e-4 |
| Schedule | 6 % warm-up, cosine decay |
| Batch | 16 windows |
| Clipping | gradient clip 1.0 |
| Precision | fp16 autocast + GradScaler on T4 |
| Length | ≤ 4 epochs; early stopping on the validation primary metric, patience 1 |
| Seeds | {1, 2, 3} |

**Tuning budget (equal per system):** learning rate ∈ {3e-5, 1e-4} for the
encoder, 1 seed, chosen on validation. No other tuning.

### 6.6 Calibration

* Temperature scaling per binary head (write gate, FORGET, MERGE, expiry,
  RETRIEVE), fitted on validation.
* θ_W at cost ratio 3:1 is the primary operating point; 2:1 and 5:1 are
  reported.
* The same procedure is used for every system, so architecture and threshold
  are never confounded.

## 7. Parameter count (exact; `tools/param_count.py`)

| Module group | Ettin-32M | Ettin-17M |
|---|---|---|
| Backbone encoder (no MLM head) | 31,883,136 (embeddings 19,341,312) | 16,797,440 (embeddings 12,894,208) |
| PASTE-only: input projections (6), embedding tables, h₀, GRU_H, GRU_T, W_new | 2,837,760 | 1,269,248 |
| Shared heads (§5.1-5.11; identical in every encoder baseline) | 4,535,702 | 2,632,342 |
| **PASTE** | **39,256,598** | **20,699,030** |
| M1c | 36,418,838 | 19,429,782 |
| M1c-m: M1c + 2 extra ModernBERT-style layers + d×d projection | 39,074,966 | 20,610,710 |
| RMT baseline | 36,568,214 | 19,496,598 |
| KV baseline | 36,862,358 | 19,627,158 |

The prototype must reproduce these counts (test T11).

## 8. Cost

**Measured** (this container; Hugging Face ModernBERT; fp32; 4 CPU threads;
p50 over 7 runs; encoder only):

| Tokens | 128 | 212 | 256 | 512 | 704 | 960 |
|---|---|---|---|---|---|---|
| Ettin-32M | 32 ms | 45 ms | 52 ms | 118 ms | 169 ms | 196 ms |
| Ettin-17M | 10 ms | 11.5 ms | 13.6 ms | 21.5 ms | 41 ms | 85 ms |

**Input size per segment**, at K = 32, E = 8, T = 8 and a 128-token segment:

| System | Tokens | Encoder latency (from the table) |
|---|---|---|
| PASTE | ≈ 212 (prefix 84) | ≈ 45 ms |
| M1c | ≈ 704 (records ~14 tokens each, temporary rows ~16 each) | ≈ 169 ms |
| M1c+W | ≈ 960 | ≈ 196 ms |

PASTE also encodes new or changed records once (~14 tokens each; usually
0-2 per segment) and runs its heads. **End-to-end latency, peak RAM and
throughput are measured in Phase 7, not assumed** (hypothesis H4).

**Carried state per conversation:**

| System | Contents | Size |
|---|---|---|
| PASTE | h (r·d fp32) | 6 KB |
| PASTE | ≤ 8 temporary items (vector + ≤ 280 chars) | ≤ 15 KB |
| PASTE | record cache (recomputable) | ≈ 140 KB |
| M1c | temporary rows as text | ≤ 2.3 KB |

**Training cost:** a PASTE segment is ~3× fewer encoder tokens than an M1c
segment. The per-run cost is measured in the CPU pilot, and the quota plan in
§9.3 is fixed from that measurement.

## 9. Baselines, ablations and the central test

### 9.1 Systems

Every encoder system uses Ettin-32M, the shared heads, the same data, losses,
seeds, step budget, tuning budget and calibration.

| ID | System | Memory pathway | Role |
|---|---|---|---|
| **M1c** | Chunked explicit memory | Segment text + records as text (`[R] entity · attribute: value`) + temporary items as text (`[T] type: span text`). Record and profile representations are pooled field-token states; temporary updates append the span (last two kept); row order shuffled in training | **Central test** (owner decision 5) |
| **M1c-m** | M1c, parameter-matched | M1c + 2 extra layers (residual zero-init) | Central test (parameter control) |
| **M1c+W** | M1c + window | M1c + raw text of the previous 2 segments | "Does a text window suffice?" |
| RMT | Recurrent segment baseline | M1c + r = 4 memory tokens carried by replacement (no GRU), no temporary vectors | Brief baseline 6 |
| KV | Learned key-value memory | Segment encoded alone; records as cached vectors, read only by the heads (late fusion), flat bilinear addressing | Brief baseline 7 |
| FC | Conventional full-context transformer | All previous segments' text (≤ 2,048 tokens, oldest dropped first) + records as text | Brief baseline 5 |
| R0 | Rules | Patterns for statements, negation, "forget", time; Brain guard rules (`brain.js`, `context-schema.js`); string-match addressing | Brief baseline 1 |
| Z1 | Existing DtW Ettin-150M / 400M checkpoints, zero-shot, chunk by chunk with known memories | Their native format, mapped through the Brain simulator | Brief baselines 3-4. Trained on WildChat-derived data: **evaluation only**, labelled as such |
| Z2 | LFM3-1.7B QAD, production prompt v2, CPU, chunk by chunk | — | Brief baseline 2. Optional (CPU hours only) |
| **PASTE** | §4-5 | | Hypothesis |

### 9.2 Ablations of PASTE

| ID | Change | Tests | Brief item |
|---|---|---|---|
| A1 | Flat pointer: one bilinear score over all records + NEW | Hierarchical addressing | "PASTE without addressing" |
| A2 | No memory tokens (r = 0); temporary items kept | Latent recurrence | "without recurrent segment memory" |
| A3 | Single pool: temporary items become records with status = temporary; one addressing and update pathway; no GRU_T or expiry head (TTL by status) | Temporary/persistent separation | "without separate temporary/persistent state" |
| A4 | Training stores without look-alike profiles | Value of hard negatives | identity |
| A5 | Teacher forcing only (ε = 0) | Closed-loop training | |
| A6a / A6b | + L_idc / + L_rec | Auxiliary objectives | loss ablations |
| S17 | PASTE and M1c on Ettin-17M | "Could a much smaller model compete?" | §5 of the brief |
| X1 (exploratory) | Delta-rule associative temporary memory instead of GRU memory tokens | Alternative recurrence | |

### 9.3 Seeds and compute priority (≤ 1 week of free T4 quota)

Runs are scheduled in priority order and stop at the quota. Anything run
with fewer than 3 seeds is labelled **exploratory**.

1. **PASTE, M1c, M1c-m, M1c+W:** 3 seeds each (the central test).
2. RMT, KV, A1, A2, A3: 3 seeds.
3. FC, A4, A5, A6a, A6b, S17: 1-3 seeds as quota allows.
4. R0, Z1, Z2: CPU here (no GPU).

## 10. Evaluation protocol (pre-registered)

### 10.1 Brain simulator

`paste/brain_sim.py` is a deterministic executor that mirrors `brain.js`
semantics:

* add, reinforce, replace, correct, challenge (replace on the second
  challenge), forget, merge;
* capacity with eviction by lowest evidence, then oldest;
* every record tracks provenance.

All systems are evaluated **closed loop**: their own operations build the
store and temporary state they see next. They are also evaluated **teacher
forced** (gold store), as a diagnostic.

### 10.2 Data access

* Train and validation are used for everything.
* The **frozen test** and **stress** sets are generated with separate
  generator seeds, held-out templates, held-out entity names and held-out
  scenario families.
* They are SHA-256-hashed into `FROZEN.json`, committed before any system
  is trained, and stored privately.
* `evaluate.py --final` refuses to run unless the checkpoint, thresholds and
  data hashes are committed in `results/final/FROZEN-RUNS.json`. Each final
  run is appended to `results/final/ACCESS-LOG.md`.
* Every system is evaluated once on test. A rerun after a bug fix is
  recorded as a deviation.

### 10.3 Metrics (brief §9)

| Group | Metrics |
|---|---|
| Memory quality | Persistent-operation P / R / F1; **false permanent memories** per 100 segments (and their source: temporary, joke, hypothetical, quote, uncertain); missed important memories (importance-weighted) |
| Addressing | Correct target; identity accuracy on look-alike subsets; incorrect updates (wrong record, or UPDATE where gold is WRITE); duplicate creation (WRITE where gold is SAME) |
| Temporal | Temporary retention (item present when gold needs it); expiry F1 (exact segment); continuity accuracy by **dependency distance** (0, 1, 2-4, ≥5 segments, cross-session); metrics against segment index and episode length |
| Consistency | Contradiction F1, update correctness, merge P/R, FORGET P/R |
| Efficiency | Parameters; CPU p50/p95 per segment at K ∈ {8, 32, 128} (4 threads, fp32 and int8); peak RAM; segments/s; carried bytes; GPU-hours; peak GPU memory |
| Generalisation | Unseen templates, entities and families; long episodes (stress); Roman Urdu / multilingual; noisy text; generator shift (programmatic ↔ API-realised); clean-licence real-text segments |
| Final state | End-of-episode store F1 against the gold store (closed loop) |
| Per-operation diagnostics | Confusion matrix over WRITE / UPDATE / MERGE_INTO / FORGET / IGNORE (literature F6: operation prediction dominates errors); UPDATE prediction rate against gold (F7); results also collapsed to ADD / UPDATE / DELETE / NOOP for comparability with Mem0-style systems (F9); recall reported at the chosen threshold next to precision (F8: omission is the dominant real-world failure) |

### 10.4 Primary endpoint

**PE = micro-F1 of persistent operations, closed loop, on the frozen test
set**, pooled over segments; seed-mean over 3 seeds.

**Matching rule.** Persistent operations are WRITE, UPDATE (all subtypes),
MERGE_INTO, MERGE-pair, FORGET and PROMOTE→WRITE. A prediction matches a gold
operation if:

* the type is the same;
* the target is the same: record identity via provenance, or, for WRITE, the
  same entity (an existing profile, or NEW with a matching mention) and the
  same attribute class;
* for WRITE and UPDATE, the value matches: normalised token-F1 ≥ 0.5.

Each gold operation is matched at most once, greedily by confidence.

**Co-primary safety endpoint:** FPM = false permanent memories per 100
segments.

### 10.5 Decision rule for the central test

* For B ∈ {M1c, M1c-m}, Δ_B = PE(PASTE) − PE(B).
* 95 % paired bootstrap over test **episodes** (10,000 resamples; each
  resample recomputes both systems' seed-mean PE), Holm-adjusted over the
  two comparisons.

| Outcome | Condition | Reported conclusion |
|---|---|---|
| **Pass** | Both adjusted CIs > 0; FPM(PASTE) ≤ 1.10 × FPM(B) (one-sided 95 % bound); end-to-end CPU p50 ≤ 1.5 × M1c at K = 32 | "Memory-native pathway beats chunked explicit memory" |
| Pass, but M1c+W ≥ PASTE | as above, but PE(M1c+W) − PE(PASTE) CI includes or exceeds 0 | "Beats M1c, but a raw-text window recovers the gain; prefer the simpler system unless efficiency favours PASTE" |
| Equivalent | Both CIs within ±1.0 F1 point | "No difference within 1 point; explicit memory preferred for auditability and simplicity (efficiency reported separately)" |
| Inconclusive | Otherwise, a CI includes 0 | "No evidence of an advantage" |
| Fail | A CI < 0 | "PASTE is worse than chunked explicit memory" |

Secondary analyses (every metric in §10.3, ablations, stratifications) are
reported with CIs as **exploratory**. They do not change the outcome above.

**Power check (pre-registered):** if the frozen test set has fewer than
3,000 gold persistent operations, it is enlarged **before** freezing.

## 11. Integration boundary (experimental adapter; production untouched)

`paste/adapter.py`, `PasteAdapter.step(...)`, is pure: no I/O and no Brain
access.

```text
input  segment:    {turns: [{speaker, text}], at: ISO-8601, session_id}
       persistent: [{id, entity, attribute (or slot), value, kind, status, updatedAt, evidence}]
       temp_state: {version, items: [{id, type, ttl, until, created_at, text, vector_b64}], h_b64}
output operations: [{op: WRITE|UPDATE|MERGE|FORGET, target_ids, payload:{entity, attribute, value,
                     kind, certainty, challenge?}, confidence, evidence:{start, end, text}}]
       retrieval:  [{id, score}]
       temp_ops:   [{op: T-WRITE|T-UPDATE|T-EXPIRE|PROMOTE|EVICT, item_id, ...}]
       temp_state: (next state)
```

* Mapping to the Brain (proposal only):
  * WRITE / UPDATE / MERGE_INTO → `brain.observe({kind, slot, value, text, certainty})`, where the Brain itself decides added, reinforced, replaced or challenged;
  * FORGET → the Brain's forget path;
  * RETRIEVE → the read path.
* `brain.observe()` and production code are **not changed** in this research
  phase.
* Open integration questions, for after the evaluation report: deriving
  entity keys from Brain slots; whether temporary items follow the Brain's
  sealing rules for sensitive sources.

## 12. Implementation plan and unit tests (Phase 3)

Code lives under `research/paste/paste/`: `modernbert.py`, `model.py`,
`heads.py`, `brain_sim.py`, `adapter.py`, `losses.py`, `data.py`,
`train.py`, `evaluate.py`.

| Test | Checks |
|---|---|
| T1 | ModernBERT reimplementation = HF `ModernBertModel` (max abs diff < 1e-4), empty prefix |
| T2 | With the prefix fully masked, PASTE's segment states equal the encoder's |
| T3 | Permutation equivariance over records, profiles and temporary items (per-record outputs permute; unit outputs unchanged; tol 1e-5) |
| T4 | Addressing: the joint distribution sums to 1; factorisation; absent records masked; NEW-ENTITY always available |
| T5 | Separation: with g ≡ 0, no persistent operation for any temporary state; temporary → persistent only via PROMOTE; session boundary resets h and drops SESSION items |
| T6 | Write gate: thresholds respected; cost-weighted loss gives the false-positive side 3× gradient |
| T7 | CONTRADICTION → UPDATE(challenge); simulator replaces on the second challenge |
| T8 | Serialisation: the temporary state round-trips exactly (JSON + base64 fp32); a step on deserialised state equals a step in memory |
| T9 | Determinism: identical outputs on repeated runs (fixed threads, deterministic algorithms) |
| T10 | Incremental processing with a checkpoint/restore mid-episode equals uninterrupted processing |
| T11 | Parameter counts equal §7 |
| T12 | Brain simulator rules match `brain.js` semantics on hand-written cases |

## 13. Risks

| Risk | Mitigation, or how it is reported |
|---|---|
| Synthetic artefacts dominate (DtW template lesson) | Generator diversity; API vs programmatic comparison (owner decision 2); held-out families; real-text segments from licence-clean sources; generator-shift test |
| The dataset's dependency-distance mix decides whether recurrence helps | Stratified reporting. Production relevance is uncertain: production memory inputs today are short batches (≤ 8 events) |
| Soft tokens lose lexical detail (names), hurting identity | Static bag-of-embeddings term kept; identity measured on look-alike subsets; KV and M1c show the alternatives |
| Closed-loop training is unstable | Teacher-forced fallback (A5) |
| Quota too small for every ablation at 3 seeds | Priority order (§9.3); fewer seeds labelled exploratory |
| Integration mismatch (no entity field in the Brain) | Adapter mapping; open question for the owner after the evaluation |
| Collapse toward UPDATE: a small learned memory router reportedly over-predicted UPDATE (MemRouter, literature F7, secondary source) | UPDATE rate monitored on validation from epoch 1; class-balanced relation loss if UPDATE exceeds its gold share by > 50 % (decided on validation, recorded as a deviation) |
| Recurrence silently not learned (RMT needs a curriculum; Infini-attention reproduction failed; literature F2-F3) | Curriculum (§6.4); distance-stratified validation accuracy tracked during training; if it does not improve, the report says "not learned", not "not useful" |
| Soft tokens are only semi-joint; text cross-encoding wins identity by 1.6-3.7 points in entity linking (BLINK, F4) | This is exactly what the central test measures. Distillation from M1c is allowed only after the central test, as a labelled variant |
| Threshold at 3:1 pushes recall down until omissions dominate (HaluMem, F8) | Recall reported at the chosen threshold; 2:1 and 5:1 operating points reported |

## 14. What the experiments can and cannot establish

* They can show whether, at ~39M parameters and on this sequential data, the
  memory-native pathway beats chunked explicit memory with identical heads,
  and which components carry the difference.
* They cannot show that PASTE is novel as a mechanism. Each component has
  close prior art (`LITERATURE-REVIEW.md` §1):
  * Toshniwal et al. 2020 and Zep/Graphiti (addressing);
  * Keep Me Updated (relation → operation);
  * KBLaM, LUKE and Set-Encoder (soft-token store);
  * RMT on BERT, MemoryOS and MemRouter (temporary/persistent split);
  * SOM-DST (dense per-record heads);
  * scheduled sampling / FPDSC (closed loop);
  * cost thresholds and A-MAC / ConsistencyGate (write gate).
  At most, the contribution is an integration and an empirical answer for
  this task and scale.
* They cannot show production value on their own, because the data is
  synthetic and licence-clean rather than real Codeply traffic. A positive
  result justifies an integration discussion; it does not justify a launch.
