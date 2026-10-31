# Store-Relational Decide Encoder (SRDE): a proposal

Status: proposal; nothing built. Read `01-LITERATURE-AND-CRITIQUE.md` first:
SRDE is **not** a new neural primitive. It is the strongest testable
architectural opportunity the evidence leaves open: change how a small
encoder *reads* an explicit store and *reports* decisions against it, and
measure whether that matters. Every mechanism used has prior art, cited
inline.

## 1. The computation we want, stated precisely

Input: a conversation `x = (x_1..x_T)` (T ≤ ~1.5K tokens) and a retrieved
slice of the Brain `R = {r_1..r_K}`; each record
`r_j = (kind k_j, slot s_j, value v_j, status σ_j ∈ {confirmed, tentative,
temporary}, age Δt_j, evidence count e_j)`.

Output (one call):
1. spans of the conversation that carry an observation or a plan, each with
   kind, certainty, importance (the Decide heads, unchanged);
2. **for every record j an operation** `o_j ∈ {untouched, reinforce, update,
   challenge}`;
3. a link from each span to the record it operates on, or ADD.

The Brain then applies the operations, as today. Nothing persists in the
network between calls.

Today's DtW model flattens `R` into the token stream (`[m1] kind · slot:
value`) and supervises only spans that have a merge target (pointer over
records). Two things are therefore *not* tested yet:
* **readout / supervision density**: every record gets a decision, so "this
  turn does not touch record j" is a trained negative (SOM-DST's design);
* **store representation**: records encoded once, cached, and read through
  attention as a set, instead of re-encoded as tokens on every call.

## 2. Variants (one backbone, three store interfaces)

All variants use the same pretrained encoder `E` (Ettin-17M/32M/68M/150M:
7/10/19/22 layers, width 256/384/512/768, same recipe and data, MIT), the same
span heads and the same training data.

### V0: flat store, sparse pointer (today's DtW, the baseline)

Records rendered as text lines in the input; merge head scores
(span, record-marker) pairs only for spans with a gold merge target.

### V1: flat store, dense per-record readout (SOM-DST-style)

Same input as V0, with record order shuffled in training (SOM-DST shuffles
with p = 0.5). Let `h_j` be the final state of record j's marker token and
`c` the pooled conversation state. Per record:

$$p(o_j \mid x, R) = \mathrm{softmax}\big(W_2\,\mathrm{GELU}(W_1[h_j;\ c;\ h_j \odot c]) \big) \in \Delta^{4}$$

Link for span i (pooled `u_i`) among records with `o_j ≠ untouched`:

$$j^*(i) = \arg\max_j \; u_i^\top B\, h_j \quad\text{or ADD if no record is touched or } \max_j u_i^\top B h_j < \tau_{\text{link}}$$

Adds ~3·d² parameters (≈1.8M at d = 768). **Runs on today's runtime**: the
token states come from `llama-server --embedding --pooling none` and the heads
run in Node, exactly as the DtW provider does.

### V2: cached set store with gated cross-attention

Each record is encoded **once per version** and stored with its row (like a
search index):

$$m_j^{0} = \mathrm{Pool}\big(E_{\le L_r}(\text{"}k_j\ ·\ s_j\text{: }v_j\text{"})\big) + e_{\text{kind}}(k_j) + e_{\text{status}}(\sigma_j) + e_{\text{age}}(\lfloor \log_2(1+\Delta t_j/\text{1 h})\rfloor) + e_{\text{ev}}(\min(e_j, 7))$$

`E_{≤L_r}` is the first `L_r` layers of the same encoder (shared weights);
`m_0` is a learned **null record**, always present, so attention has a sink
and an empty store gives a defined output (the NaN case PASTE v2 had to fix).

The conversation runs through all `L` layers of `E` unchanged. In the top
`|X|` layers (X = last 4) two gated cross-attention sublayers are inserted
after each block, through a bottleneck of width `d_x = 256`:

$$H \leftarrow H + \tanh(\alpha_\ell)\odot \mathrm{MHA}\big(HW^{q}_\ell,\ MW^{k}_\ell,\ MW^{v}_\ell\big)W^{o}_\ell \qquad\text{(tokens read records)}$$

$$M \leftarrow M + \tanh(\beta_\ell)\odot \mathrm{MHA}\big(MU^{q}_\ell,\ HU^{k}_\ell,\ HU^{v}_\ell\big)U^{o}_\ell \qquad\text{(records read tokens)}$$

with `α_ℓ, β_ℓ ∈ ℝ^d` initialised to **0** (Flamingo's gated cross-attention,
2204.14198), so at step 0 the model computes exactly V0's encoder on the
conversation: training starts from the pretrained function. The per-record
head of V1 then reads `m_j^L` instead of a marker token.

**Properties** (each is a claim the experiments test):
* *Permutation equivariance in R*: no positional encoding on `M`; the
  token update is invariant to record order and the record update is
  equivariant (standard for attention over sets, Set Transformer 1810.00825).
  V1 only approximates this through shuffling.
* *Bounded per-call cost in K*: records are not re-encoded per call.
* *No new persistent state*: `M` exists for one call; the Brain stays the
  store.

Parameters added at d = 768, d_x = 256, |X| = 4: per layer two attention
blocks of ≈ 4·d·d_x ≈ 0.79M → **≈ 6.3M**, plus type embeddings (< 0.1M) and
heads (≈ 1.8M): ~8M on a 150M backbone (5 %). At d = 384 (Ettin-32M): ≈ 3M.

**Runtime cost**: llama.cpp has no cross-attention for ModernBERT. V2 needs
ONNX Runtime (or a llama.cpp graph change) for the four fused layers. This is
the price of V2 and the reason V1 exists: V2 must beat V1 clearly to justify it.

### V3 (upper bound, not a candidate): pairwise cross-encoder

Each (conversation, record) pair encoded jointly, DS-DST / Keep Me Updated
style. Cost ×K per call. It bounds what relation accuracy any single-pass
readout can reach on our data.

## 3. Training objective (all variants)

$$\mathcal{L} = \mathcal{L}_{\text{tag}} + \mathcal{L}_{\text{span}} + \lambda_{o}\sum_{j=1}^{K} w_{o_j}\,\mathrm{CE}(o_j) + \lambda_{l}\,\mathrm{CE}(\text{link}) + \lambda_g\,\mathrm{BCE}(\text{gate})$$

* `L_tag`, `L_span`: unchanged Decide losses (V0's merge term is replaced by
  the per-record and link terms in V1-V3).
* Class weights `w_o` inverse-square-root frequency (untouched dominates).
* Defaults λ_o = 1, λ_l = 0.5, λ_g = 0.5; not tuned on any test set.

**Data for dense per-record labels**, built only inside each frozen split
(no cross-split records, the lesson of the 206 dropped merges):
for every example, a store of size K ~ U{0, 4, 8, 16} sampled from records of
the **same split**; the gold memorable observations of the example create
targets:
* a record with the same slot and value → `reinforce`;
* a record with the same slot and another value of that slot from the same
  split (1,818 of 2,464 memorable train observations have a recurring slot;
  351 slots have ≥ 2 distinct values [M]) → `update` or `challenge` by the
  observation's certainty (stated → update, implied → challenge, the Brain's
  rule);
* everything else → `untouched`.
Constructed "different value" pairs are relation-checked by the labeller
(Claude Sonnet, batch) because same slot with another value is not always a
contradiction ("travel: Lisbon" vs "travel: Rome" can coexist). Estimated
cost below.

## 4. Calibration layer (identical for every system, including LFM3)

A write is an observation that would reach `brain.observe()`. For every
system, on validation data only:
1. temperature scaling of the write and per-record logits (1706.04599);
2. deployment prior `π̂` from the **unlabelled** natural pool disjoint from
   natural-300 and train (~1,550 conversations [M]) by bias-corrected EM
   (1901.06852); logit shift `log(π̂/π_train)`;
3. threshold at the Bayes cost point `p* = c_FP/(c_FP + c_FN)`, with
   **c_FP : c_FN = 3 : 1** proposed (a false memory costs more than a miss;
   owner to confirm before results are seen).

Reported both raw and calibrated, so architecture and operating point are
never confounded.

## 5. What would count as evidence for the architecture

From `03-EXPERIMENT-PLAN.md`, pre-registered:
* **V1 over V0** if per-record operation accuracy and wrong-target rate
  improve on Benchmark-520 merge cases and the store stress test (paired
  bootstrap CI excludes 0) without a significant loss in extraction F1 or a
  rise in false memories.
* **V2 over V1** only if it adds ≥ 5 points of operation accuracy at K ≥ 16
  *or* ≥ 30 % lower p95 at K = 32 at equal accuracy (CI excludes 0); otherwise
  V1 wins because it needs no new runtime.
* **Either over LFM3-1.7B LoRA** on the protocol's decision rule (safety,
  reliability, accuracy, cost).
* If V0 ≈ V1 ≈ V2: the store interface does not matter at this scale and
  store size; the remaining gains are data and calibration, and the report
  says so.

## 6. What is deliberately left out, and why

| Left out | Why |
|---|---|
| Segment recurrence, persistent latent slots, learned decay (PASTE A, B, E, F) | No long or longitudinal inputs to train or test them [M]; latent state conflicts with an auditable, deletable store; mechanisms already exist (§2 of the critique) |
| Training from scratch | ~5K labelled examples cannot teach language; pretraining a useful 17M-32M encoder costs hundreds of H100-hours (§ estimates in the plan) |
| Early exit / adaptive compute | Useful for latency later (DeeBERT, PABEE), orthogonal to the question; add after the readout question is settled |
| Closed-loop multi-session training | The most memory-specific open idea, but it needs multi-session data first; staged in the plan (Track B) |
