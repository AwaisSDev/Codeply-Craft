# PASTE: formal specification (paper only)

Profile-Addressed Segment-memory Transformer. Status: **specification for
review; nothing is built.** Date 2026-10-31. Companion to the external
proposal (PASTE / M-Gate / TIDE, ablation plan M0-M10) and to this branch's
Decide-then-Write work (`research/dtw/`).

## 0. When PASTE is relevant to Codeply (and when it is not)

What Codeply does today (checked in the code):

* Memory extraction reads **short inputs**: a batch of at most 8 events
  (`context-engine.js` `maxBatchEvents: 8`), each at most 6,000 characters
  (`context-schema.js` `MAX_EVENT_TEXT`), plus up to 8 known memories. In
  practice a few hundred to ~2,000 tokens.
* Calls (`call-listen.js`) are transcribed on the device, but the transcript
  stays sealed in Life; only the call's **summary (≤ 800 characters) and
  to-dos** reach the memory pipeline (`context-collectors.js`).
* Persistent memory lives **outside the network**, in the Brain
  (`brain.js`): readable rows the user can see, edit, undo and delete.

At these lengths PASTE's advantages (bounded state, long-range recall) do not
apply, and full attention over ~2k tokens is cheap (Ettin-150M reads 256
tokens in ~286 ms at 4 threads).

PASTE becomes relevant if Codeply extracts memories from **long streams**:
full call or meeting transcripts, videos, always-on listening. A one-hour
call is ~9-10k words, ~12k tokens. Then two designs compete:

* **M1c, explicit memory (the baseline PASTE must beat):** Ettin + Decide
  heads over chunks of ≤ 2k tokens; after each chunk the Brain is updated and
  its relevant memories become the next chunk's known memories `[m1]..[mK]`.
  Memory between chunks is explicit, auditable rows.
* **PASTE, implicit memory:** one pass over the stream with bounded internal
  state (segment state + profile slots) carrying information across chunks.

PASTE is worth building only if it beats M1c on long-input memory metrics at
equal or lower cost. That is the central hypothesis, sharpened: **does typed
internal memory beat the Brain used as explicit memory between chunks?**

## 1. Notation and shapes

Default sizes are for an Ettin-150M-class backbone (d = 768, 12 heads).

| Symbol | Meaning | Default |
|---|---|---|
| $T$ | input tokens | up to ~16k (long stream) |
| $s = 1..N$ | segments: utterance / event boundaries, each ≤ $S$ tokens | $S = 256$ |
| $L$ | backbone layers | Ettin's |
| $\mathcal{L}_G \subset \{1..L\}$ | layers with a segment state | every 4th layer |
| $\mathcal{L}_P \subset \{1..L\}$ | layers that read the profile store | 2 upper layers |
| $\ell_c$ | controller layer | middle layer |
| $d, h, d_k, d_v$ | width, heads, key and value size per head | 768, 12, 64, 64 |
| $W$ | local attention window (tokens, previous segment cached) | 512 |
| $\mathbf{S}^{\ell}_s \in \mathbb{R}^{h \times d_v \times d_k}$ | segment state after segment $s$ | 12 × 64 × 64 |
| $\mathbf{P} \in \mathbb{R}^{M \times d}$ | profile slots | $M = 16$ |
| $\mathcal{T}$ | memory types | 5 (below) |

Memory types $\mathcal{T}$ = {**persistent fact**, **preference**, **plan**,
**session context**, **noise**}, mapped from Codeply's labels:

| Type | From labels |
|---|---|
| persistent fact | kinds fact, decision, idea, requirement, todo, routine, style; certainty stated / implied |
| preference | kind preference; certainty stated / implied |
| plan | a plan (meeting, trip, deadline) |
| session context | kind context, certainty temporary |
| noise | no observation, or certainty joking / hypothetical / quoting |

A segment's gold type is the type of its highest-importance observation
(noise if none). $\Pi$ = {persistent fact, preference, plan} are the
**persistent types**.

State bytes (FP32): segment state $3\ \text{layers} \times 12 \times 64 \times
64 \times 4$ B ≈ 590 KB; profile $16 \times 768 \times 4$ B ≈ 49 KB. Bounded and
independent of $T$.

## 2. Forward pass

The backbone stays a bidirectional encoder **within** a window; information
moves **across** segments only forward, through the segment state, the
profile store and the cached previous segment. Segments are processed in
order $s = 1..N$.

### 2.1 Block $\ell$, token $t$ in segment $s$

Let $x_t^{\ell-1}$ be the input, $q_t, k_t, v_t$ the block's per-head
projections ($k_t, q_t$ L2-normalised as in Gated DeltaNet).

Local attention (exact, window over segment $s$ and the cached segment
$s-1$; cache is stop-gradient as in Transformer-XL):

$$a_t = \mathrm{LocalAttn}\big(x_t^{\ell-1};\ \{x_u : u \in s \cup (s-1),\ |u-t| \le W\}\big)$$

Segment-state read ($\ell \in \mathcal{L}_G$), per head, reading the state
left by the previous segment:

$$r^{\mathrm{seg}}_t = \mathbf{S}^{\ell}_{s-1}\, q_t \in \mathbb{R}^{d_v}$$

Profile read ($\ell \in \mathcal{L}_P$), attention over occupied slots, with
$K^P = \mathbf{P}W^P_K$, $V^P = \mathbf{P}W^P_V$ and a mask $\mu_j = -\infty$
for empty slots:

$$r^{\mathrm{prof}}_t = \sum_{j=1}^{M} \mathrm{softmax}_j\!\Big(\tfrac{q_t^\top K^P_j}{\sqrt{d_k}} + \mu_j\Big) V^P_j$$

Combination with per-head gates, **zero-initialised** so that at the start
of training the block computes exactly what Ettin computes:

$$g_t = \sigma(W_g x_t^{\ell-1} + b_g) \in (0,1)^{2h},\quad b_g \text{ initialised to } -\infty \text{ (practically } -10\text{)}$$

$$o_t = a_t + g^{\mathrm{seg}}_t \odot W_O^{\mathrm{seg}} r^{\mathrm{seg}}_t + g^{\mathrm{prof}}_t \odot W_O^{\mathrm{prof}} r^{\mathrm{prof}}_t$$

then the block's FFN and norms as in Ettin.

### 2.2 Controller (end of segment $s$, layer $\ell_c$)

Pooled segment representation $u_s = \mathrm{mean}_{t \in s}\, x_t^{\ell_c}$.

$$\pi_s = \mathrm{softmax}(W_\tau u_s + b_\tau) \in \Delta^{|\mathcal{T}|} \qquad \text{(type)}$$

$$w_s = \sigma(w_w^\top u_s + b_w) \in (0,1) \qquad \text{(write confidence)}$$

$$\tilde p_s = W_p u_s \in \mathbb{R}^{d} \qquad \text{(candidate profile content)}$$

Parameters: $W_\tau$ 768×5, $w_w$ 768, $W_p$ 768×768: ≈ 0.6M.

### 2.3 Segment-state update (each $\ell \in \mathcal{L}_G$, token by token over $t \in s$)

Gated delta rule (Gated DeltaNet), with the gates **conditioned on the
segment's type**. Per head, learned per-type decay $\rho_\tau \in (0,1]$
and write strength $\kappa_\tau \in [0,1]$ (vectors over heads):

$$\bar\rho_s = \exp\Big(\sum_{\tau} \pi_{s,\tau} \log \rho_\tau\Big), \qquad \bar\kappa_s = w_s \sum_\tau \pi_{s,\tau}\, \kappa_\tau$$

$$\alpha_t = \sigma(W_\alpha x_t)\odot \bar\rho_s, \qquad \beta_t = \sigma(W_\beta x_t)\odot \bar\kappa_s$$

$$\mathbf{S}_t = \alpha_t\, \mathbf{S}_{t-1}\big(I - \beta_t k_t k_t^\top\big) + \beta_t\, v_t k_t^\top$$

with $\mathbf{S}$ at the first token of segment $s$ equal to
$\mathbf{S}^\ell_{s-1}$ and $\mathbf{S}^\ell_s$ the state after the last token.

Intended behaviour, learned, not hard-coded: noise has $\kappa \approx 0$
(writes nothing); session context has $\rho < 1$ (fades over segments);
persistent types have $\rho \approx 1$. Initialisation encodes the prior:
$\kappa_{\text{noise}} = 0.05$, others 0.5; $\rho_{\text{session}} = 0.9$,
$\rho_{\text{noise}} = 0.5$, persistent 0.99.

### 2.4 Profile write (end of segment $s$)

Write probability, only for persistent types:

$$z_s = w_s \sum_{\tau \in \Pi} \pi_{s,\tau}$$

Each slot $j$ carries a type tag $\theta_j \in \Pi \cup \{\varnothing\}$,
confidence $c_j \in [0,1]$ and last-write segment $\lambda_j$.

Address scores, restricted to slots of the same predicted type
$\hat\tau_s = \arg\max_{\tau \in \Pi} \pi_{s,\tau}$:

$$e_{s,j} = \cos\big(W_A \tilde p_s,\ W_A \mathbf{P}_j\big) \text{ if } \theta_j = \hat\tau_s, \text{ else } -\infty$$

**Inference (hard):** if $z_s < \theta_w$ do nothing. Otherwise let $j_1, j_2$
be the two best slots.

* **Update / merge** if $e_{s,j_1} \ge \theta_m$ and $e_{s,j_1} - e_{s,j_2} \ge \delta$ and
  $z_s \ge c_{j_1} - \epsilon_{\text{lock}}$: $\mathbf{P}_{j_1} \leftarrow (1-\eta_{\hat\tau})\mathbf{P}_{j_1} + \eta_{\hat\tau}\tilde p_s$,
  $c_{j_1} \leftarrow \max(c_{j_1}, z_s)$.
* **Allocate** otherwise: the empty slot, else the slot with the lowest
  $c_j$ (ties: oldest $\lambda_j$), gets $\tilde p_s$, tag $\hat\tau_s$, $c = z_s$.

**Collision protection** (the failure mode "similar facts overwrite each
other"):

1. Type partition: a write only addresses slots of its own type.
2. Ambiguity margin $\delta$: when two slots match almost equally, allocate
   instead of overwriting.
3. Confidence lock: a confident slot is overwritten only by evidence at least
   as strong ($\epsilon_{\text{lock}}$ small).
4. Write budget: at most $B = 2$ profile writes per segment.
5. Training regulariser on slot keys (§3): pushes different slots apart.

**Training (soft, differentiable):**

$$\mathrm{addr}_{s} = \mathrm{softmax}_j\big(e_{s,j}/T_a\big), \qquad \mathbf{P}_j \leftarrow \mathbf{P}_j + z_s\,\eta_{\hat\tau}\,\mathrm{addr}_{s,j}\,(\tilde p_s - \mathbf{P}_j)$$

with an extra "allocate" column (score $\theta_m$) that writes into the next
empty slot. $T_a$ anneals from 1 to 0.05; the last 20 % of training uses the
hard rule with straight-through gradients.

### 2.5 Codeply integration: slots are a cache of the Brain, not a second memory

To keep memory auditable, the profile store is **initialised from the known
memories**: $\mathbf{P}_j = \mathrm{Enc}(\text{memory}_j)$ (mean-pooled encoder
states of the memory's text), $\theta_j$ = its type, $c_j = 1$, and slot
$j \leftrightarrow$ Brain memory id. A merge is then **a profile address**:
the Decide merge head becomes $\mathrm{addr}_s$ over slots, so "update m3"
literally means "write into slot 3". New allocations are emitted as new
observations. After the input, nothing stays in the network: the Brain
stores what was decided, as today, and slots are rebuilt for the next input.

## 3. Training objective

Same data as Decide-then-Write (realistic labelled set, `research/dtw/label/`)
plus a **long-input set** (below). Total loss:

$$\mathcal{L} = \mathcal{L}_{\text{task}} + \lambda_\tau \mathcal{L}_{\text{type}} + \lambda_w \mathcal{L}_{\text{write}} + \lambda_a \mathcal{L}_{\text{addr}} + \lambda_r \mathcal{L}_{\text{recall}} + \lambda_o \mathcal{L}_{\text{orth}} + \lambda_z \mathcal{L}_{\text{sparse}}$$

| Term | Definition | Supervises |
|---|---|---|
| $\mathcal{L}_{\text{task}}$ | the existing Decide heads: BIO span tags, kind, certainty, about, importance, gate | backbone |
| $\mathcal{L}_{\text{type}}$ | $\mathrm{CE}(\pi_s, \tau^*_s)$, gold segment type (§1) | controller |
| $\mathcal{L}_{\text{write}}$ | $\mathrm{BCE}(z_s, \mathbb{1}[\tau^*_s \in \Pi])$ | write gate |
| $\mathcal{L}_{\text{addr}}$ | $\mathrm{CE}(\mathrm{addr}_s, j^*_s)$: the gold merge target's slot, or "allocate" | addressing (merges, contradictions) |
| $\mathcal{L}_{\text{recall}}$ | task loss on observations whose evidence or merge target lies **outside the local window** (earlier segment) | the information flow through state and slots |
| $\mathcal{L}_{\text{orth}}$ | $\sum_{i \ne j} \cos(W_A\mathbf{P}_i, W_A\mathbf{P}_j)^2$ over occupied slots of the same type | collision protection |
| $\mathcal{L}_{\text{sparse}}$ | $\mathrm{mean}_s\, z_s$ | write frequency |

How gradients reach the new pathways (the training problem the review raised):

* **Function-preserving start.** Read gates start closed ($b_g \approx -10$),
  so step 0 equals Ettin + heads (M1). No language-model pretraining stage
  is needed to begin: pathways open only if the losses reward them.
* **Something to reward.** $\mathcal{L}_{\text{recall}}$ is the only term that
  can be solved *only* through the state / slots: the evidence is outside
  the window. Without such examples the pathways stay closed (and the
  ablation will show it). Long-input data therefore is not optional.
* **Teacher forcing for the controller.** For the first 30 % of steps the
  updates use the gold type $\tau^*_s$ instead of $\pi_s$ (probability decays
  1 → 0), so the state and slots learn useful content before the controller
  is accurate.
* **Backpropagation through segments** is truncated to 8 segments; the local
  attention cache is stop-gradient.

**Long-input set.** Needed for $\mathcal{L}_{\text{recall}}$ and for
evaluation. Built like the realistic set: long real transcripts or
conversations (licence-checked; candidates: LongMemEval (MIT), concatenated
multi-session chats), labelled by Claude with evidence spans, where later
segments update, repeat or contradict earlier ones. Held-out long evaluation
set built the same way, never trained on; Benchmark-520 stays the
short-input authority.

## 4. Minimal implementation (only the essential mechanisms)

1. Ettin-150M, unchanged weights, + Decide heads (= M1).
2. Add segment state to 3 layers, profile store ($M = 16$) read in 2 layers,
   controller at the middle layer. No MoD routing, no new tokenizer, no
   change to attention in the minimal version except the local window and
   previous-segment cache needed for long inputs.
3. Train with §3 on the realistic set + long-input set, 3 seeds.
4. Runtime: llama.cpp has no gated delta rule or profile store. **Building
   PASTE means a new CPU runtime** (custom ggml ops or ONNX Runtime custom
   ops). This conflicts with the mission's "no new runtime"; it needs an owner
   decision before any implementation.

Cost per token, added: the delta update is $h\,d_k d_v$ multiply-adds per
state layer (12 × 64 × 64 ≈ 49k, ×3 layers ≈ 150k MACs), small next to the
~150M MACs per token of the backbone. Attention for a 12k-token call:
window 512 instead of full is ~23× less attention compute.

## 5. Experiments and decision rules (pre-registered)

| ID | Model | Question |
|---|---|---|
| M1 | Ettin + Decide heads, full attention, ≤ 2k inputs | the bar (short inputs) |
| **M1c** | M1 over ≤ 2k chunks, Brain memories fed forward as known memories | **explicit memory: the main baseline for long inputs** |
| M4 | reproducible Gated DeltaNet hybrid (an open implementation at this scale, same layers as PASTE, no controller, no slots) | best existing mechanism |
| M5 | PASTE (minimal, §4) | the hypothesis |
| M6 | M5 with $\pi_s$ fixed uniform | does type conditioning matter |
| M7 | M5 with $M = 0$ | do slots matter |
| M8 | M5 with fixed $\alpha, \beta$ (no type gates) | does gating matter |

Primary endpoints on the long held-out set: extraction F1, false-memory
rate, merge / contradiction accuracy, plan F1; plus latency and peak RAM at
2k / 8k / 16k tokens; INT4 vs INT8. Paired bootstrap, 3 seeds.

* Build nothing until **M1 is trained on the realistic data** and evaluated
  on Benchmark-520 (short) and the long held-out set via M1c.
* **Trigger to build M5:** M1c falls short on long inputs (e.g. F1 on long
  inputs ≥ 5 points below short inputs, or merge accuracy across chunks below
  0.85) while M1 is good on short inputs.
* **M5 wins** only if it beats M1c and M4 by ≥ 3 F1 points or ≥ 20 % relative
  false-memory reduction on long inputs, within 10 % of M1c latency and the
  RAM budget.
* M6 ≈ M5 → drop type conditioning (keep M4). M7 ≈ M5 → drop slots.
  M4 ≥ M5 → existing mechanisms suffice; no novelty claim.
* If M1c is good enough on long inputs: **PASTE is not needed**; Codeply
  keeps explicit, auditable memory.

## 6. Open questions

* Is per-segment typing too coarse when one utterance holds a fact and a
  joke? (Alternative: per-span typing from the Decide tags.)
* Should session context also go to slots with a TTL instead of the decaying
  state?
* Privacy: slots hold user facts in RAM during one input only; they are
  never saved. Confirm this matches the Brain's sealing rules for sensitive
  sources (calls are local-only).
