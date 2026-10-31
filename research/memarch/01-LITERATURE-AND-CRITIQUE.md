# Is conversational memory a different neural computation? Literature and critique

Question from the brief: should conversational memory be treated as a
fundamentally different neural computation, and can a 20M-150M model show
that advantage experimentally? This document answers the first half from the
literature and our own data; `02-ARCHITECTURE-PROPOSAL.md` and
`03-EXPERIMENT-PLAN.md` answer the second.

Tags: **[V]** read in the primary source (arXiv text, dataset card, code);
**[M]** measured or counted in this repository; **[I]** inference.

## 1. Short answer

**Not at the level of a new neural primitive.** Every mechanism PASTE
proposes exists, mostly validated on synthetic tasks or at 125M-8B decoder
scale; the parts relevant to Codeply exist as *tasks over an explicit store*,
where the canonical small-model solution is an encoder that reads the store
as text. What *is* different about memory, and under-studied, is narrower:
the **readout and supervision** of decisions against a store (one decision
per stored record, dense "untouched" negatives), the **operating point**
under ~95 % "nothing to keep" traffic, and **closed-loop robustness** when
the model's own past writes become its future input. Those are testable with
modest compute; a new recurrent memory architecture is neither needed by the
current data nor testable on it.

## 2. PASTE, component by component

| PASTE component | Closest prior art (mechanism) | How close | Verdict for Codeply |
|---|---|---|---|
| **A** Segment processing | Transformer-XL (cached previous segment, 1901.02860); RMT, including **on a pretrained BERT encoder**, memory tokens carried between 512-token segments, trained on 7 segments, run on 4,096 (2207.06881, 2304.11062) [V]; Block-Recurrent (2203.07852); HMT (2405.06067) | Same idea, already on encoders | **Not needed**: every input ≤ 1,462 tokens, Ettin context 7,999 [M] |
| **B** Persistent typed slots | EntNet: gated per-entity slots, keys tied to entities, `h_j ← h_j + g_j ⊙ φ(Uh_j + Vw_j + Ws)` (1612.03969) [V]; Relational Memory Core (1806.01822); LM2 (2,048 slots, 2502.06049); Slot Attention; typed partitions exist only in explicit-store systems (MIRIX, MemoryOS) [V] | Mechanism exists; semantic typing of *neural* slots untested [I] | Conflicts with an auditable store: latent slots hold state the database cannot show, edit or delete |
| **C** Write controller | NTM/DNC erase-add writes; Titans surprise-gated write with data-dependent forgetting (2501.00663) [V]; for explicit stores: Mem0 ADD/UPDATE/DELETE/NOOP (2504.19413), Memory-R1 RL-trained manager (2508.19828) [V] | Covered, including for explicit stores | The decision exists today as Decide heads; the open part is calibration (§5) |
| **D** Addressing: new / existing / contradiction | NTM content addressing; KV-MemNN; **Keep Me Updated**: (stored memory, new sentence) → PASS/REPLACE/APPEND/DELETE, T5 83.7-84.1 % vs human 87.5 % (2210.08750) [V]; **SOM-DST**: per-slot CARRYOVER/DELETE/DONTCARE/UPDATE read from each slot's marker in a flat input (1911.03906) [V]; Dialogue NLI | Covered as classification over an explicit store | The closest, most useful prior art |
| **E** Per-category retention | Gated DeltaNet `S_t = α_t S_{t-1}(I − β_t k k^T) + β_t v k^T` (2412.06464); Titans α_t; xLSTM; MemoryBank's Ebbinghaus decay on an explicit store (2305.10250) [V] | α_t is already input-dependent: conditioning it on a type label adds no expressive power [I] | Retention of an explicit memory is a TTL / evidence rule in the Brain, not a network state |
| **F** Cross-segment retrieval | Memorizing Transformers (kNN memory, 2203.08913); M+; RETRO; Infini-attention (an independent reproduction found quality falls as compressions grow, HF blog 2024-08-14) [V] | Covered | Retrieval from the Brain into the input already exists (known memories) |

**On novelty**: no component of PASTE is new as a mechanism. "Type-conditioned
decay" is a re-parameterisation of existing data-dependent gates. The only
untested element we found is semantic typing of neural slots, and it is
untested partly because explicit stores do the same thing auditably.

## 3. What the evidence says about learned vs explicit memory

* Learned memory wins where the task is **synthetic, end-to-end supervised,
  and the "store" is the long context itself**: bAbI (EntNet 0.5 % error, DNC
  3.8 %), BABILong (RMT/ARMT on GPT-2 137M beat GPT-4 and generic RAG; RAG
  "below random" on 2-3-fact tasks) [V].
* Explicit, structured stores win on exactness: KV-MemNN on WikiMovies, KB
  93.9 vs raw documents 76.2 hits@1 [V]. Fixed-size state is provably weak at
  recall/copying (Zoology: a 70M attention model beats a 1.4B gated-conv model
  on recall; Based; Repeat After Me) [V].
* In conversational systems the explicit store wins on **cost**, not accuracy:
  Mem0 66.9-68.4 vs full context 72.9 on LoCoMo, with ~1.8K vs ~26K tokens and
  91 % lower p95 [V]. Supersede: a bounded self-maintained memory drops a
  frontier model on LongMemEval knowledge updates from 92 % to 77 % [V].
* **No paper compares learned latent memory with an explicit store on real
  conversational state at 20M-150M.** For Codeply the store must be explicit
  (audit, edit, "forget this"), which makes the latent side a non-starter for
  production regardless of accuracy [I].

## 4. The task-level prior art that actually matters

**Dialogue state tracking (DST)** is "update a typed explicit state from a
conversation", with fifteen years of results:

| Model | How the state enters | Joint goal accuracy |
|---|---|---|
| TRADE (1905.08743) | slot as decoder query | 48.6 (MultiWOZ 2.0) |
| DS-DST (1910.03544) | slot and context cross-encoded | 51.2 (2.1) |
| **SOM-DST** (1911.03906) | **previous state flattened into one BERT input**, one op per `[SLOT]` marker | 51.7 (2.0), 53.0 (2.1) |
| TripPy (2005.02877) | 5-way slot gate, "refer" copies from the state | 55.3 (2.1) |
| D3ST (2201.08904) | schema as natural-language descriptions | SGD 72.9-86.4 (T5 220M-11B) |

Three results transfer directly [V, SOM-DST error analysis]:
1. **Operation prediction is the bottleneck**: 78-93 % of errors; with gold
   operations accuracy rises from 53 % to 90 %.
2. **Feeding the model its own predicted state multiplies error by 2.47×**
   (53.0 → 81.0 with the gold previous state).
3. **Shuffling slot order** in training and **descriptive slot text** (D3ST)
   help; slot identity alone does not.

**Memory systems** are evaluated almost only end-to-end on QA. HaluMem
(2511.03506) is the exception: operation-level extraction and update;
extraction recall < 60 %, **update omission > 50 %, mostly because the
memory was never extracted in the first place** [V]. The smallest trained
memory writers are 0.5B+ (MemLoRA, Qwen2.5-0.5B, +138 % on LoCoMo judge from
LoRA experts) [V]; nothing at 20M-150M. Keep Me Updated's data is not
released [V].

## 5. Precision at a 5 % base rate is an operating-point problem first

precision = TPR·π / (TPR·π + FPR·(1−π)). At π = 0.05, TPR 0.9: FPR 0.02 →
precision 0.70; FPR 0.01 → 0.83 [I, arithmetic]. Natural traffic here is ~95 %
nothing-to-keep [M: natural-300 has 281 / 298 empty]. Under imbalance,
"adjusting only the classifier gives strong results" and representations
learned with natural sampling are fine (Decoupling, 1910.09217); temperature
scaling, bias-corrected EM prior estimation (1901.06852), BBSE (1802.03916) and
cost thresholds are standard and cheap [V]. Any architecture comparison that
does not fix the operating point the same way for every system confounds
architecture with calibration.

## 6. Challenging the assumptions in the brief

| Assumption | What the evidence says |
|---|---|
| "Conversational memory needs a memory-native network" | The store already lives outside the network by design; per-call decisions read it as input. The open problems are readout, supervision density, calibration and closed-loop robustness, not a new state mechanism |
| "PASTE's long-input advantage is the reason to build it" | No input in our data or in production is long [M]; PASTE v1's own trigger (M1c falling short on long inputs) cannot even be evaluated. M1c ≡ Ettin on every current set |
| "Typed slots and adaptive retention are novel" | EntNet, LM2, Titans, Gated DeltaNet, MemoryBank [V]; type conditioning adds no expressive power over input-dependent gates [I] |
| "~5,000 labelled examples can support a new architecture" | Enough to fine-tune heads and small adapters on a pretrained encoder; far from enough to train an encoder from scratch (BERT-base without pretraining: GLUE 45.5 vs 80.9, Cramming 2212.14034 [V]) |
| "Architecture is the bottleneck now" | Measured bottlenecks [M]: 15 jokes and 11 quotes in train against 62 / 66 in Benchmark-520; 219 merge observations; secrets leak through the guard (5 / 13 for LFM3); the realistic-trained Ettin baselines have not finished yet. Data coverage and the guard bind before architecture |
| "Learned forgetting should replace rules" | Testing it needs longitudinal data with delayed outcome labels (was the memory still true later?). None exists in the repository [M]; candidate sources in `03-EXPERIMENT-PLAN.md` §6 |

## 7. What would genuinely be a contribution

Ranked by evidence and testability:

1. **A write-level benchmark** for personal memory: per-turn keep / kind /
   certainty / plan / relation against a store, with false-memory and
   natural-prevalence metrics. Benchmark-520 + test-real + natural-300 already
   are this, and nothing public matches it (HaluMem is non-commercial and
   QA-centred; Keep Me Updated is unreleased) [V].
2. **Store-relational readout**: per-record operation heads with dense
   supervision, and a cached set-encoded store, measured against flat
   concatenation on counterfactual store swaps, store-size scaling and
   permutation invariance. Mechanisms exist (SOM-DST, Set Transformer,
   Flamingo-style gated cross-attention); the contribution is the empirical
   answer for an open-vocabulary, certainty-aware personal store at 20M-150M.
3. **Closed-loop training for memory writers**: train on the model's own
   predicted store over multi-session rollouts, so it learns to cope with
   duplicates, stale values and its own misses (SOM-DST's 2.47× propagation;
   HaluMem's omission cascade). Scheduled sampling is old; applying and
   measuring it for explicit-store memory writers is not done [I]. Needs
   multi-session data.
4. **Calibrated abstention** for writes under prior shift, reported as
   precision at fixed recall on natural-prevalence data.

None of these is "a new neural computation". Claiming one would not survive
review against the literature above.

## Sources

Memory architectures: NTM 1410.5401 · MemN2N 1503.08895 · KV-MemNN 1606.03126
· EntNet 1612.03969 · DNC (Nature 538:471, 2016) · RMC 1806.01822 · Slot
Attention 2006.15055 · Set Transformer 1810.00825 · Perceiver 2103.03206 /
2107.14795 · Transformer-XL 1901.02860 · Compressive 1911.05507 · RMT
2207.06881 / 2304.11062 · ARMT 2407.04841 · Block-Recurrent 2203.07852 ·
Memorizing Transformers 2203.08913 · Infini-attention 2404.07143 (+ HF
reproduction blog) · HMT 2405.06067 · Titans 2501.00663 · ATLAS 2505.23735 ·
TTT 2407.04620 · DeltaNet 2406.06484 · Gated DeltaNet 2412.06464 · xLSTM
2405.04517 · FoX 2503.02130 · fast weights 1610.06258 · delta-rule FWP
2102.11174 · Hopfield 2008.02217 · LM2 2502.06049 · MemoryLLM 2402.04624 · M+
2502.00592 · Larimar 2403.11901 · RETRO 2112.04426 · ACT 1603.08983 ·
PonderNet 2107.05407 · DeeBERT 2004.12993 · PABEE 2006.04152 · FastBERT
2004.02178 · BABILong 2406.10149 · Zoology 2312.04927 · Based 2402.18668 ·
Repeat After Me 2402.01032.
State tracking and memory systems: TRADE 1905.08743 · SUMBT 1907.07421 ·
DS-DST 1910.03544 · SOM-DST 1911.03906 · TripPy 2005.02877 · SGD 1909.05855 ·
D3ST 2201.08904 · IC-DST 2203.08568 · LDST 2310.14970 · bAbI 1502.05698 ·
ProPara 1805.06975 · OpenPI 2011.08092 / 2305.14603 · TRIP 2109.04947 · entity
tracking in LMs 2305.02363 · Mem0 2504.19413 · Memory-R1 2508.19828 · MemGPT
2310.08560 · A-MEM 2502.12110 · Zep 2501.13956 · MemoryBank 2305.10250 ·
HaluMem 2511.03506 · MemLoRA 2512.04763 · Mem-α 2509.25911 · Supersede
2606.27472 · Memora 2604.20006 · Keep Me Updated 2210.08750 · Dialogue NLI
1811.00671 · MSC 2107.07567 · PerLTQA 2402.16288 · MIRIX 2507.07957 ·
MemoryOS 2506.06326.
Benchmarks and data: LongMemEval 2410.10813 · LoCoMo 2402.17753 ·
Conversation Chronicles 2310.13420 · DialSim 2406.13144 · MemoryAgentBench
2507.05257 · PersonaMem 2504.14225 · MemBench 2506.21605 · WildChat 2405.01470.
Calibration: 1706.04599 · BBSE 1802.03916 · BCTS+EM 1901.06852 · selective
classification 1705.08500 · decoupling 1910.09217 · logit adjustment 2007.07314.
Encoders and compute: BERT miniatures 1908.08962 · ELECTRA 2003.10555 ·
MiniLM 2002.10957 · Cramming 2212.14034 · ModernBERT 2412.13663 · Ettin
2507.11412 · NeoBERT 2502.19587.
