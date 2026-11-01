# PASTE: literature review

Date 2026-11-01. Branch `research/paste-architecture`. Scope: work through
**October 2026** on the mechanisms PASTE proposes, and on the systems,
benchmarks and datasets it could be compared with or trained on.

## How this review was made, and how to read it

* Two research passes searched and read primary sources (arXiv abstract or
  full text, dataset cards, LICENSE files), each writing its findings to
  file as it went:
  * **prior art for each PASTE mechanism**, plus explicit memory and identity;
  * **recurrence, linear attention and state-space models**, plus memory
    systems, benchmarks and licences.
* An earlier pass of five agents was stopped before it produced output; it
  contributed nothing to this file.
* I wrote the synthesis below from those findings and checked it against the
  architecture spec. The detailed sections follow unchanged as **Parts I-IV**.
* Tags:
  * **[V]** verified in the primary source during this review;
  * **[S]** secondary source only (search summary, survey, blog);
  * **[U]** unverified (memory or the earlier bibliography).
  Claims tagged [S] or [U] are **not** used as evidence for any design
  decision below unless the text says so.
* The earlier bibliography (`research/memarch/01-LITERATURE-AND-CRITIQUE.md`)
  was re-checked where it overlapped. One correction: it says Keep Me
  Updated's data is unreleased, but the paper states "We release the newly
  collected dataset" [V]. Whether the data can actually be downloaded is
  still unchecked.

| Part | Content | Length |
|---|---|---|
| I | Adversarial prior-art search, mechanism by mechanism (M1-M7) | ~4,300 words |
| II | Explicit memory, addressing, identity, DST, contradiction, continual learning | ~5,900 words |
| III | Segment recurrence, compression, linear attention, SSMs, associative memory, recall limits | ~6,200 words |
| IV | Conversational memory systems, trained controllers, benchmarks, dataset licences | ~3,900 words |

## 1. Answer first: is any part of PASTE novel?

**No mechanism is new.** For every component the closest prior art is close
(Part I):

| PASTE mechanism | Verdict | Closest prior art |
|---|---|---|
| M1 hierarchical profile addressing (entity → record, NEW at both levels, look-alike hard negatives) | Same mechanism in a different setting (entity level); partial overlap for the two-level learned form | Toshniwal et al. 2020 (coreference: existing / new / ignore with an FFNN over [x; e; x⊙e]) [V]; Zep/Graphiti (entity-then-fact resolution, but by prompting an LLM) [V]; dense entity retrieval with hard negatives (Gillick 2019) [V] |
| M2 relation classifier → store operation | **Same mechanism exists** | Keep Me Updated (pairwise PASS / REPLACE / APPEND / DELETE; T5 84.1 % against human 87.5 %) [V]; Dialogue NLI, DECODE [V] |
| M3 records as cached, set-positioned soft tokens inside the encoder | Partial overlap; every part exists separately | KBLaM (one cached token per KB triple, read in every layer) [V]; LUKE (entity tokens processed jointly in an encoder) [V]; Set-Encoder (shared position for set invariance) [V, positional detail S]; xRAG [S] |
| M4 temporary state separated from persistent memory, with promote and write gates | Partial overlap | RMT on BERT (memory tokens across segments) [V]; MemoryOS, LightMem (tiered memory with promotion by rule or LLM) [V/S]; MemRouter (a learned 12M admission head) [V]; learned promotion (2609.33013) [V] |
| M5 dense per-record heads, pairwise merge | Same mechanism in a different setting | SOM-DST (an operation per slot, read from slot markers in one BERT pass) [V]; coreference and entity matching for merges [S] |
| M6 closed-loop training through a store simulator | Same mechanism in a different setting | Scheduled sampling, DAgger [V]; FPDSC and Correctable-DST in DST [V/S]; Memory-R1 and Mem-α rollouts with executed operations [V] |
| M7 cost-weighted, calibrated write threshold | **Same mechanism exists** | Bayes cost threshold (Elkan 2001) [U]; temperature scaling and selective classification [V]; 2026 admission gates A-MAC and ConsistencyGate [V] |

**What can honestly be claimed, if the experiments support it:**

* an **integration**: a 20-50M CPU encoder that does learned, factorised
  entity-then-record addressing and dense per-record operations over an
  *open, auditable* store, with a calibrated write gate;
* an **empirical answer** at this scale to whether that integration beats the
  same encoder reading the store as text.

Part IV (§2 below) shows this setting is sparsely populated:

* no trained writer under 0.5B parameters was found;
* no system trains a dedicated identity or duplicate model;
* no paper reports duplicate rates.

That is a gap in the evidence, not a novelty of mechanism. "Novel memory
architecture" and "first learned memory addressing" must not be claimed.

## 2. Findings that change or confirm the PASTE v2 design

| # | Finding | Evidence | Consequence for PASTE |
|---|---|---|---|
| F1 | Fixed-size recurrent state is weak at many distinct bindings, exact strings and near-duplicate keys | Zoology / MQAR, Based, Repeat After Me, Hopfield metastable states [V] | **Confirms** the v2 split. Identity and addressing use attention over explicit record tokens; the recurrent memory tokens carry dialogue context only. v1's in-layer delta-rule state as the main memory would have been the wrong tool for identity |
| F2 | Memory tokens on a pretrained BERT across segments work only with a curriculum (1 → 7 segments); without it, training fails | RMT 2304.11062 [V] | **Confirms** the curriculum (§6.4). Adds a pre-registered check: if the recall probe or the continuity-by-distance metric does not improve over training, recurrence is reported as **not learned**, not as "not useful" |
| F3 | Recurrent-memory training failures hide behind a falling loss (Infini-attention reproduction failed); interference and curricula, not state size, set recall (2026) | HF reproduction [V]; 2609.16183 [V] | Per-operation validation metrics from the first epoch; continuity stratified by distance on validation during training |
| F4 | Joint reading beats separate embeddings on identity: cross-encoder > bi-encoder by 1.6-3.7 points; distillation recovers about half | BLINK [V] | **Risk for M3**: soft tokens are "semi-joint" (records attend and are attended in all layers, but are pooled first). M1c reads records as text, so it is fully joint. This is the core of the central test. Distilling from M1c is allowed only **after** the central test, as a separate, labelled variant |
| F5 | Structured stores beat text, but a store built by automatic extraction is much worse (KB 93.9 vs documents 76.2 vs IE-built KB 68.3 hits@1) | KV-MemNN [V] | PASTE's store is model-written. Closed-loop evaluation (§10.1 of the spec) is mandatory, and the final-store F1 is reported |
| F6 | Operation prediction, not value extraction, is where state trackers fail (78-93 % of errors; gold operations lift accuracy 53 → 90); own-state input multiplies error 2.47× | SOM-DST [V] | Per-operation confusion matrices are required in the evaluation report (especially WRITE vs UPDATE vs SAME); closed-loop training (M6) is ablated |
| F7 | A small learned memory router reportedly collapsed toward UPDATE when trained with UPDATE labels | MemRouter [S] (search summary only) | Treated as a **risk, not evidence**. Watch the UPDATE prediction rate on validation; class-balanced relation loss if UPDATE dominates. Added to spec §13 |
| F8 | The dominant measured failure of memory systems is **omission** (HaluMem: 52-98 % update omission, mostly from missed extraction); stale values persist; forgetting on request almost never works (Bemula ≤ 1.5 %) | HaluMem, Supersede, TEPA, Bemula [V] | The primary endpoint counts misses and false writes. FORGET gets its own reported P/R. The 3:1 cost threshold must not push recall so low that omissions dominate, so recall at the chosen threshold is reported next to precision |
| F9 | Operation vocabularies have converged on ADD / UPDATE / DELETE / NOOP; the closest analogue of a temporary/persistent split is MemReader's "buffer" | Mem0, Memory-R1, MemLoRA, MemReader [V] | PASTE's MERGE, RETRIEVE and the temporary operations are extensions. Results are also reported collapsed to ADD / UPDATE / DELETE / NOOP, for comparability |
| F10 | Trained writers stop at 0.5-0.6B (MemLoRA, MemReader); RL controllers are 3B+ | [V] | Nothing to compare against at 20-50M; the parameter-matched in-house baselines (M1c, M1c-m, RMT, KV) carry the comparison |
| F11 | Cost advantages of recurrent or compressed memory appear only at long contexts; for short segments, text rendering is not compute-bound | Part III, cross-cutting [I] | Efficiency (H4) is measured at K ∈ {8, 32, 128}, not assumed. At K = 8 PASTE may have no advantage |
| F12 | Decay can down-weight without deleting (Forgetting Transformer); gating is decay, and the delta rule is targeted overwrite | FoX, Gated DeltaNet [V] | The GRU update gate is PASTE's decay. A delta-rule temporary memory stays exploratory (X1) |

## 3. Datasets and licences (for `DATASET-DESIGN.md`)

From Part IV §4. Each licence was checked against the card or LICENSE file [V]
unless tagged otherwise.

| Use for PASTE | Sources |
|---|---|
| **Allowed** (commercial use permitted; attribution or share-alike terms apply) | MultiWOZ (MIT) · Taskmaster-1/2/3 (CC BY 4.0) · Schema-Guided Dialogue (CC BY-SA 4.0: derivatives must share alike) · Topical-Chat (CDLA-Sharing-1.0) · SODA (CC BY 4.0; LLM-generated, generator terms [U]) · Synthetic-Persona-Chat (CC BY 4.0; same caveat) · Conversation Chronicles (CC BY 4.0; same caveat) · LongMemEval (MIT) · MemoryAgentBench (MIT) · PersonaMem v1 (MIT) / v2 (CC BY 4.0) · UCI Roman Urdu (CC BY 4.0, from the DTW audit) |
| **Excluded** (non-commercial or no-derivatives) | LoCoMo (CC BY-NC 4.0) · PerLTQA (CC BY-NC 4.0) · HaluMem (CC BY-NC-ND 4.0) · DailyDialog (CC BY-NC-SA 4.0) · PersonaMem v3 (CC BY-NC 4.0) |
| **Excluded until a licence is found** | MSC, PersonaChat/ConvAI2 (code is MIT, but no data licence found) · DialSim (none found; TV scripts) · Supersede, Memora, TANGLE, Bemula data (not stated) |
| **Excluded by owner decision** | WildChat and anything derived from it |

Owner decision 4 also applies: generated datasets and any copied real text
are stored privately. The licences above govern whether a source may be used
at all.

## 4. What the literature says about the central test

The question "does a memory-native pathway beat the same encoder reading the
store as text?" has no direct answer in the literature at this scale.

**In favour of explicit text (M1c):**

* full joint reading of records and segment (F4);
* the strength of exact-match storage (F1);
* SOM-DST's success with exactly that design (flattened state into BERT,
  per-slot heads).

**In favour of PASTE:**

* cheaper input at large K (F11; small at K ≤ 8);
* set structure without order artefacts (Set Transformer, Set-Encoder);
* recurrent context that the explicit rows do not hold (F2, if it can be
  trained).

My recorded prior expectation, made **before** any data exists and stated
here so it can be checked: **M1c is at least as accurate as PASTE on
addressing and identity. PASTE's chances rest on cross-segment continuity
(H1) and on efficiency at large K (H4).** `ARCHITECTURE-HYPOTHESES.md`
turns this into falsifiable predictions.

---

# Part I

## E. Adversarial prior-art search for PASTE mechanisms M1-M7

Date of search: 2026-11-01. Purpose: find the closest existing work for each proposed PASTE mechanism, so that no novelty claim is made that the literature does not support.

Tags: **[V]** verified in the primary source during this task (arXiv abstract page or HTML); **[S]** secondary source read during this task (search snippet, survey, blog); **[U]** unverified, from memory. arXiv ids are given only where seen during this task.

Verdict scale: "same mechanism exists" > "same mechanism in a different setting" > "partial overlap" > "no close prior art found".

### M1. Hierarchical profile addressing (entity, then attribute record; NEW options; in-store hard negatives)

#### Closest prior art

1. **Toshniwal et al., "Learning to Ignore: Long Document Coreference with Bounded Memory Neural Networks" (EMNLP 2020; arXiv 2010.02807) [V].** Each candidate mention is either added to an existing entity cluster, added to a new cluster, or ignored. The score is `s_c(x_i, e_j) = f_c([x_i; e_j; x_i ⊙ e_j; g(x_i, e_j)]) + s_m(x_i)`, a learned FFNN over exactly the `[u; e; u*e]` interaction that M1 proposes, plus distance and count features. A bounded variant also learns which entity to evict. Training is teacher forcing with cross-entropy on both decision steps. **Overlap:** an entity-level "existing vs NEW" pointer with the same interaction MLP, over memory built incrementally from a frozen SpanBERT encoder. **Difference:** there is one level only (entity), with no attribute records inside an entity and no store of facts, and the setting is document coreference rather than an auditable store.
2. **Xia, Sedoc and Van Durme, "Incremental Neural Coreference Resolution in Constant Memory" (EMNLP 2020; arXiv 2005.00128) [S, search snippet].** Online clustering of mentions into a bounded set of active entity representations, losing 0.3% relative F1 on OntoNotes. **Overlap:** incremental entity addressing with a NEW option. **Difference:** entity level only, no attribute level.
3. **Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" (arXiv 2501.13956, 2025) [V, HTML].** Graphiti first resolves extracted entities against existing nodes (cosine and full-text search, then an LLM duplicate decision), then deduplicates facts with a search "constrained to edges existing between the same entity pairs". **Overlap:** this is the same two-level factorisation as M1: entity first, then the fact within that entity's scope, with NEW at both levels. **Difference:** it is done by prompting an LLM with no learned scorer, no probabilistic factorisation and no hard-negative training. Zep reports DMR 94.8 vs MemGPT 93.4 [V].
4. **Chandar et al., "Hierarchical Memory Networks" (arXiv 1605.07427, 2016) [V].** The memory is organised hierarchically and read with (approximate) maximum inner product search, as a hybrid of soft and hard attention, on SimpleQuestions. **Overlap:** coarse-to-fine addressing to scale reading. **Difference:** the hierarchy is for efficiency, not entity identity, and there is no NEW option or write path.
5. **Gillick et al., "Learning Dense Representations for Entity Retrieval" (CoNLL 2019; arXiv 1909.10506) [V].** A dual encoder for mentions and entities with unsupervised hard-negative mining, which the authors credit with a large gain. **Overlap:** the hard-negative principle behind M1's in-store negatives. **Difference:** a flat entity space with no NEW entity and no attribute level.

Also relevant: EntityNLM (Ji et al., EMNLP 2017; arXiv 1708.00781) [S] keeps dynamic per-entity vectors and decides at each mention whether it starts a new entity [U on the exact decision form]. The probabilistic product `P(entity) * P(record | entity)` is the standard two-level (hierarchical) softmax pattern [U].

#### Verdict: **same mechanism in a different setting** (entity level); **partial overlap** for the full two-level form

The entity-level pointer with NEW, the `[u; e; u*e]` interaction MLP, cross-entropy with teacher forcing, and hard negatives all exist (coreference, entity linking). Two-level entity-then-fact addressing exists in LLM-prompted agent memory (Zep/Graphiti). We found no work that *learns* a factorised entity-then-attribute pointer over an external personal store, with in-store hard negatives of the form "same attribute, similar value, different entity". That combination is a defensible engineering contribution. It is not a new mechanism.

#### Queries used
- "hierarchical memory addressing entity then attribute dialogue personal knowledge graph population user utterances"
- "Hierarchical Memory Networks Chandar 2016 arXiv"
- "dense entity retrieval hard negatives bi-encoder Gillick 2019"
- "Learning to Ignore long document coreference bounded memory neural networks Toshniwal"
- "Incremental Neural Coreference Resolution in Constant Memory Xia"
- "Dynamic Entity Representations in Neural Language Models EntityNLM"
- (extended) "small trained model memory operation classifier ADD UPDATE DELETE NOOP existing memory record encoder 2025 2026"

### M2. Relation classifier between the new statement and the addressed record, mapped to store operations

#### Closest prior art

1. **Bae et al., "Keep Me Updated! Memory Management in Long-term Conversations" (Findings of EMNLP 2022; arXiv 2210.08750) [V, PDF].** For each (stored memory sentence, new sentence) pair, a T5 classifier predicts PASS / REPLACE / APPEND / DELETE. Test 4-class accuracy: 83.65 trained from scratch and 84.10 with NLI transfer, against an estimated human 87.52. The paper maps NLI labels to operations: entailment to PASS, contradiction to REPLACE, neutral to APPEND, with DELETE unmapped. **Overlap:** this is M2's design: a pairwise relation, mapped to a store operation, over an explicit text memory. **Difference:** 4 operations rather than 6 relations. It does not separate update over time from correction or contradiction, it has no addressing step (pairs are given), and it is Korean only. The paper states "We release the newly collected dataset" [V]; the earlier bibliography says the data is unreleased, so whether it is actually available needs checking.
2. **Welleck et al., "Dialogue Natural Language Inference" (arXiv 1811.00671; ACL 2019 [U]) [V abstract].** Treats persona consistency as NLI between utterances and persona sentences. **Overlap:** a contradiction classifier against stored persona facts. **Difference:** used for re-ranking responses, not for memory operations, and 3 labels.
3. **Chhikara et al., Mem0 (arXiv 2504.19413, 2025) [V abstract]; Yan et al., Memory-R1 (arXiv 2508.19828; ACL 2026 [S]) [V abstract].** An LLM, prompted (Mem0) or RL-trained with PPO/GRPO on 152 QA pairs at 3B-14B (Memory-R1), compares a new fact with retrieved similar memories and emits ADD / UPDATE / DELETE / NOOP. **Overlap:** relation to operation over retrieved records. **Difference:** the relation is implicit in the generated operation; there is no explicit relation label and no small model.
4. **Rasmussen et al., Zep/Graphiti (arXiv 2501.13956) [V].** An LLM finds contradictions between a new edge and related edges and sets the old edge's `t_invalid`, keeping history bi-temporally. **Overlap:** the "update over time" vs "same" distinction is operationalised as invalidation with validity times. **Difference:** prompted, not learned.
5. **Benchmarks that use M2's relation types.** MemConflict (Tao et al., arXiv 2605.20926, 2026) [V abstract] splits conflicts into dynamic (temporal validity), static (factual correctness) and conditional (contextual applicability). A search summary [S] reports that the TRACE stress test (arXiv 2607.00339) labels fact_override, contradiction_resolution and temporal correction, and that STALE (arXiv 2605.06527) tests implicit invalidation; neither was read during this task.

Older related lines: knowledge-graph updating from text (GUpdater, Tang et al., EMNLP 2019, D19-1265 [S]) and DST slot operations (SOM-DST, see M5).

#### Verdict: **same mechanism exists**

A pairwise classifier from (memory, new statement) to operation, initialised from NLI, is Keep Me Updated. The six-way taxonomy that separates temporal update, correction and contradiction is a finer label set. 2026 benchmarks already use similar distinctions as evaluation categories, not as a learned classifier. Claim the label design and the data, not the mechanism.

#### Queries used
- "Learning to Update Knowledge Graphs by Reading News Tang 2019"
- (extended) "conversational memory conflict types temporal update versus correction versus contradiction classification benchmark 2025"
- Direct reads: 2210.08750 (PDF), 1811.00671, 2504.19413, 2508.19828, 2605.20926

### M3. Store records as cached, pooled soft tokens in an unordered set, processed jointly with the segment

#### Closest prior art

1. **Wang et al., "KBLaM: Knowledge Base augmented Language Model" (ICLR 2025; arXiv 2410.10450) [V, HTML].** Each KB triple's key and value strings are encoded by a pre-trained sentence encoder, mapped by learned linear adapters into per-layer key/value vectors, and "stored on disk for later usage". Updating a fact replaces only its token. The tokens are "injected into each attention layer", the prompt attends to them, and "the knowledge tokens do not attend to each other". Triples are injected independently, so the method is implicitly order-free; the paper does not discuss positional encoding. **Overlap:** one cached token per record, computed once per record version, read in every layer, set-structured. **Difference:** a decoder LLM (8B) for QA; the records cannot attend to each other or be updated by the segment (rectangular attention); trained only on synthetic data; there is no profile/attribute/value split and no write path.
2. **Cheng et al., "xRAG" (NeurIPS 2024; arXiv 2405.13792) [S, search summary].** Reuses a frozen retriever's document embedding as one soft token through a trained projection ("modality bridge"). It reportedly lags on multi-hop reasoning (HotpotQA, FactKG). **Overlap:** pooled embedding plus learned projection replaces record text. **Difference:** a decoder, one token per document, and retrieval-time, not a persistent store.
3. **De Jong et al., "Mention Memory" / TOME (ICLR 2022; arXiv 2110.06176) [S]; Févry et al., "Entities as Experts" (EMNLP 2020; arXiv 2004.07202) [S]; Peters et al., KnowBERT (EMNLP 2019; arXiv 1909.04164) [S]; Yamada et al., LUKE (EMNLP 2020; arXiv 2010.01057) [V abstract].** These inject precomputed entity or mention vectors into a bidirectional encoder: as an attended memory table (TOME, about 150M mentions, updatable without retraining), as entity memory accessed at mentions (EaE, KnowBERT), or as extra entity tokens processed jointly with the words in every layer (LUKE). **Overlap:** M3's "entity tokens inside an encoder" is LUKE's input design, and "frozen, precomputed record vectors" is TOME's. **Difference:** the knowledge is static encyclopaedic knowledge. None of them encodes a mutable per-user store, uses profile/attribute/value granularity, or pools the same encoder's states over the record text.
4. **Schlatt et al., "Set-Encoder" (ECIR 2025; arXiv 2404.06912) [V abstract; positional detail S].** A cross-encoder in which passages interact through special tokens. According to a search summary, all passage [CLS] tokens share one positional encoding, which makes the model permutation-invariant. Ratner et al., "Parallel Context Windows" (ACL 2023; arXiv 2212.10947) [S], reuse position ids across windows. **Overlap:** a shared position id to encode an unordered set inside an encoder. **Difference:** applied to passages, not memory records.
5. **2026 latent-memory systems.** Memorilla (Fallahpour et al., arXiv 2610.21375) [V abstract] encodes chats once into reusable embeddings and produces 16 query-conditioned soft memory tokens for a frozen LLM; it reports FactKG 84.33 vs full context 80.43 with 108x fewer tokens. "Trained Persistent Memory for Frozen Encoder-Decoder LLMs" (arXiv 2603.16413) [S] prepends memory soft tokens to the encoder input.

#### Verdict: **partial overlap**, with every component already present

Cached per-record soft tokens (KBLaM, xRAG), entity tokens processed jointly in an encoder (LUKE), and shared position ids for set invariance (Set-Encoder, PCW) all exist. The combination that we found nowhere is: cached record tokens with profile, attribute and value granularity, pooled by the *same* encoder, set-positioned, attending *and attended to* jointly with the segment, for deciding store operations. The risks are documented: xRAG's weakness on reasoning, and the opacity and query-agnosticism of soft tokens noted in the search summaries. The main baseline (records as text) is the natural ablation.

#### Queries used
- "KBLaM knowledge base augmented language model rectangular attention knowledge tokens"
- "Mention Memory TOME ... de Jong"; "xRAG extreme context compression one token"
- "Parallel Context Windows shared position ids Ratner"
- "Set-Encoder permutation-invariant inter-passage attention cross-encoder"
- "Entities as Experts ...; KnowBERT ..."
- (extended) "memory records as soft tokens compressed embeddings into bidirectional encoder dialogue memory 2025 2026"

### M4. Temporary state separated from persistent memory (GRU slots with TTL, session-reset RMT tokens, gated persistent writes, explicit promote)

#### Closest prior art

1. **Bulatov et al., Recurrent Memory Transformer (arXiv 2207.06881) and "Scaling Transformer to 1M tokens and beyond with RMT" (arXiv 2304.11062) [V, HTML].** Memory tokens are carried between segments of a *pre-trained BERT* (10 memory slots, 512-token input with 499 usable). Trained on 1-7 segments, evaluated on up to 4,096 segments (2,048,000 tokens). Stated limitations: the curriculum "has a substantial impact on the generalization", scaling was shown "only on specialized tasks", and BPTT is costly. **Overlap:** the r recurrent tokens of M4 are RMT on an encoder. **Difference:** no reset policy tied to sessions, no external store, and no notion of persistence.
2. **Kang et al., "Memory OS of AI Agent" (MemoryOS; arXiv 2506.06326, 2025) [V abstract]; Fang et al., LightMem (ICLR 2026; arXiv 2510.18866) [S].** Explicit tiers: MemoryOS has short-term, mid-term and long-term personal memory, with FIFO promotion from short to mid term and segmented paging from mid to long term (+49.11% F1 on LoCoMo with GPT-4o-mini). LightMem has sensory, short-term and long-term memory with offline "sleep-time" consolidation. **Overlap:** M4's split into temporary and persistent memory, with promotion, is the organising principle of these systems. **Difference:** promotion is rule-based or done by an LLM, the temporary tier is text, not GRU vectors with TTL, and there is no calibrated gate.
3. **Packer et al., MemGPT (arXiv 2310.08560) [U, from earlier bibliography; not fetched].** OS-style main context vs archival storage, with LLM-issued paging calls. **Overlap:** working context vs persistent store. **Difference:** prompted LLM, no learned gate.
4. **Learned write and admission gates.** MemRouter (Hu et al., arXiv 2605.00356, 2026) [V abstract] trains about 12M parameters of embedding-based heads on a frozen backbone to decide whether a turn is stored (LoCoMo F1 52.0 vs 45.6 for an LLM manager; p50 latency 58 ms vs 970 ms). A search summary reports that adding UPDATE labels made the router over-predict UPDATE and collapse the store [S]. Titans (Behrouz et al., arXiv 2501.00663) [V abstract] pairs attention as short-term memory with a neural long-term memory; its surprise-gated write is [U] here. Mem-α (Wang et al., arXiv 2509.25911) [V abstract] RL-trains an agent to build core, episodic and semantic memory. **Overlap:** a learned decision about what becomes persistent. **Difference:** MemRouter's gate is binary admission at turn level, not calibrated for cost and not tied to a promote decision from temporary slots.
5. **"The Epistemics of Agent Memory" (Annapureddy and Thamatani, arXiv 2609.33013, 2026) [V abstract].** Learns *when to promote* experience and to which abstraction level under a token budget, wrapped in a "quality gate". It reports a distribution-shift failure ("lambda-prevalence coupling") and that its quality score does not predict transfer accuracy. **Overlap:** a learned, gated promote decision. **Difference:** an LLM-agent skill/rule consolidation setting.

Background: the complementary learning systems (CLS) view (a fast hippocampal store and slow neocortical consolidation) motivates all of these designs; see Part 2. EntNet and the DNC already use gated slot updates (GRU-like) and usage-based freeing [U here; see Part 2].

#### Verdict: **partial overlap**

Each part exists: RMT on BERT, tiered memory with promotion (MemoryOS, LightMem), learned admission gates (MemRouter), and a learned promote decision (2609.33013). We found no work that combines *neural* temporary state (GRU slots with TTL plus session-reset recurrent tokens) with an *external, auditable* persistent store reachable only through a calibrated write/promote gate. The novelty is the interface contract, not a primitive. MemRouter's report that a small classifier collapses on UPDATE is a direct warning for PASTE.

#### Queries used
- "LightMem lightweight memory augmented generation sensory short-term long-term sleep-time update"
- (extended) "learned consolidation gate promote working memory to long-term memory agent explicit store time-to-live temporary facts 2026"
- Direct reads: 2506.06326, 2304.11062 (HTML), 2501.00663, 2509.25911, 2605.00356, 2609.33013

### M5. Dense per-record readout (retrieve and forget heads per record, pairwise merge head)

#### Closest prior art

1. **Kim et al., SOM-DST, "Efficient Dialogue State Tracking by Selectively Overwriting Memory" (ACL 2020 [U on venue]; arXiv 1911.03906) [V, PDF].** The previous dialogue state is flattened into the BERT input, and an operation from {CARRYOVER, DELETE, DONTCARE, UPDATE} is predicted from *each slot's* `[SLOT]` marker. This is a dense per-record classification over an explicit memory, with slot order shuffled at rate 0.5 during training. Joint goal accuracy is 51.72 (MultiWOZ 2.0) and 53.01 (2.1). With ground-truth operations it rises to 89.85; at least 78.4-92.85% of errors come from operation prediction. **Overlap:** PASTE's retrieve and forget heads per record are SOM-DST's per-slot operation heads. **Difference:** a fixed ontology of slots rather than an open-ended, growing store, no retrieve semantics, and no pairwise head.
2. **Heck et al., TripPy (arXiv 2005.02877) [U, from earlier bibliography; not fetched].** A per-slot gate (none, dontcare, span, inform, refer) with copying from the state. **Overlap:** per-slot dense heads. **Difference:** as above.
3. **Pairwise merge heads.** Lee et al., end-to-end coreference (EMNLP 2017; arXiv 1707.07045) [S] scores all antecedent pairs; Li et al., Ditto (VLDB 2021; arXiv 2004.00584) [S] treats entity matching as sentence-pair classification with BERT-family models (up to 29% F1 over prior SOTA). **Overlap:** M5's merge head is pairwise coreference or entity matching applied to store records. **Difference:** applied to mentions or database rows, not personal-memory records, and not inside the same pass that reads a dialogue segment.
4. **Set-Encoder (arXiv 2404.06912) [V]** produces per-passage relevance scores in one permutation-invariant pass. **Overlap:** a dense per-item retrieve head over a set read jointly. **Difference:** ranking only.
5. **Keep Me Updated (2210.08750) [V]** includes DELETE as a pairwise operation; Toshniwal et al. (2010.02807) [V] learn per-entity *eviction* scores in a bounded memory, which is a dense per-record "forget" head.

#### Verdict: **same mechanism in a different setting**

Dense per-slot operation heads read from markers in one encoder pass are SOM-DST. Per-entity eviction scoring is Toshniwal et al. Pairwise merge is coreference or entity matching. What is new is the use on an open, user-specific store, plus measuring the benefit of dense "untouched" supervision. SOM-DST's error analysis also predicts where PASTE will fail: in operation prediction, not value generation.

#### Queries used
- "Ditto deep entity matching pre-trained language models; Lee 2017 end-to-end neural coreference resolution"
- Direct reads: 1911.03906 (PDF text), 2404.06912, 2010.02807 (PDF text)

### M6. Closed-loop training: predicted operations are executed by a deterministic store simulator whose output feeds the next segment

#### Closest prior art

1. **Bengio et al., "Scheduled Sampling for Sequence Prediction with Recurrent Neural Networks" (arXiv 1506.03099) [V abstract]; Ross, Gordon and Bagnell, "A Reduction of Imitation Learning and Structured Prediction to No-Regret Online Learning" (DAgger; AISTATS 2011; arXiv 1011.0686) [V abstract].** These are the general fixes for the train/test mismatch "where each prediction changes future inputs". **Overlap:** M6 is scheduled sampling, or DAgger with a simulator, applied to store state. **Difference:** generic; nothing specific to an executed memory store.
2. **Zhou et al., FPDSC (SIGDIAL 2021; arXiv 2107.05168) [V abstract; training detail S].** Fuses predicted previous dialogue states (JGA 55.03 on 2.0, 59.07 on 2.1). According to a search summary, training has a second phase with "uniform scheduled sampling", where previous states are half predicted and half gold. Related: Correctable-DST (EMNLP 2022) [S] simulates "predicted" previous states with a Predictive State Simulator; DSDN (AAAI 2023; arXiv 2302.08220) [V abstract] targets the train/test gap in using previous states. **Overlap:** this is closed-loop training of a state *writer* whose own output is its next input, in DST. **Difference:** fixed slot ontology; the "simulator" is just copying the predicted state (no execution semantics for MERGE or FORGET); single sessions.
3. **SOM-DST (1911.03906) [V]** trains with ground-truth previous state and operations (teacher forcing). Feeding its own predicted state multiplies error by 2.47 (JGA 53.01 vs 81.00 with gold previous state). Toshniwal et al. (2010.02807) [V] also use teacher forcing. **Relevance:** they quantify the problem M6 targets.
4. **RL-trained memory managers: Memory-R1 (2508.19828) [V], Mem-α (2509.25911) [V].** Operations are executed against a real memory bank during rollouts, and the reward comes from downstream QA. **Overlap:** fully closed-loop, with executed operations. **Difference:** RL on outcome reward with 3B-14B LLMs, not supervised scheduled sampling with dense per-operation labels against a deterministic simulator.

#### Verdict: **same mechanism in a different setting**

Scheduled sampling on predicted previous state exists in DST (FPDSC, Correctable-DST), and executed-operation rollouts exist in RL memory agents. Applying supervised scheduled sampling, with a deterministic store simulator that has rich operation semantics, to a small memory writer over multi-session data is an application, not a new method. The measurable contribution is the closed-loop *error-compounding curve* for memory writers, analogous to SOM-DST's 2.47x.

#### Queries used
- "dialogue state tracking error propagation train with predicted previous dialogue state scheduled sampling"
- Direct reads: 1506.03099, 1011.0686, 2107.05168, 2302.08220

### M7. Cost-sensitive training and threshold calibration for the precision of persistent writes (false memory costs 3x a miss)

#### Closest prior art

1. **Classical cost-sensitive decision theory [U]: Elkan, "The Foundations of Cost-Sensitive Learning" (IJCAI 2001).** With calibrated probabilities, the Bayes-optimal threshold for writing is `p* = c_FP / (c_FP + c_FN)`; for false-write cost 3 and miss cost 1, `p* = 0.75` [arithmetic]. **Overlap:** M7 *is* this rule. **Difference:** none in mechanism.
2. **Guo et al., "On Calibration of Modern Neural Networks" (ICML 2017; arXiv 1706.04599) [V]; Geifman and El-Yaniv, "Selective Classification for Deep Neural Networks" (arXiv 1705.08500) [V].** Modern networks are miscalibrated, and temperature scaling is "surprisingly effective". A reject option with a user-set target risk is guaranteed with high probability (ImageNet: 2% top-5 error at about 60% coverage). **Overlap:** the calibration and abstention machinery that M7 needs. **Difference:** generic classification.
3. **Zhang et al., "Adaptive Memory Admission Control for LLM Agents" (A-MAC; arXiv 2603.04549, 2026) [V abstract].** Memory admission as a structured decision over five factors (future utility, factual confidence, novelty, recency, content-type prior), with policies learned by cross-validated optimisation. LoCoMo F1 0.583, 31% lower latency, and the content-type prior is the most influential factor. A search summary reports that F1 peaks at threshold 0.55 and that thresholds of 0.65 and above miss over 40% of relevant memories [S]. **Overlap:** a learned, thresholded admission gate for persistent memory with a precision-recall trade-off. **Difference:** not explicitly cost-sensitive; the features are rules plus an LLM call; no calibration under prior shift.
4. **Zhang and Li, "ConsistencyGate" (arXiv 2607.22962, 2026) [V abstract].** A write-time admission gate: averaged LLM support over K samples (or a single-pass log-probability variant), compared with a threshold. It reduces contamination on LoCoMo-Contam, MSC-Contam and MemContam, at the cost of rejecting implicitly stated facts. Related 2026 work, read only as search summaries [S]: GovMem ("When Not to Write Memory", arXiv 2607.02579) on false promotion from correlated traces; and abstention for memory *retrieval* (arXiv 2604.27283), where forcing commitment raised false-positive injection from 0.0% to 17.5%.
5. **Memory-side measurement: HaluMem (arXiv 2511.03506) [U here, V in the earlier bibliography]** measures extraction and update hallucination at the operation level.

#### Verdict: **same mechanism exists**

Cost-weighted thresholds, temperature scaling and selective classification are textbook, and write-time admission gates with threshold trade-offs appeared in agent memory in 2026 (A-MAC, ConsistencyGate, GovMem). What is not standard is to report precision at fixed recall *on natural-prevalence traffic* (about 95% nothing-to-keep) with prior-shift correction. That is an evaluation contribution, not a mechanism.

#### Queries used
- (extended) "memory system false memories write precision calibrated threshold abstain storing LLM agent memory hallucination 2025 2026"
- Direct reads: 1706.04599, 1705.08500, 2603.04549, 2607.22962

### Overall novelty assessment

| Mechanism | Verdict |
|---|---|
| M1 profile addressing | same mechanism in a different setting (entity level); partial overlap for the two-level learned form |
| M2 relation classifier to operations | same mechanism exists |
| M3 cached record soft tokens as a set | partial overlap (all parts exist separately) |
| M4 temporary vs persistent with promote gate | partial overlap |
| M5 dense per-record heads, pairwise merge | same mechanism in a different setting |
| M6 closed-loop store simulation | same mechanism in a different setting |
| M7 cost-sensitive calibrated writes | same mechanism exists |

No mechanism is new as a primitive. Nearest papers: Toshniwal et al. 2020 (M1, M5, and teacher forcing as the baseline for M6), Keep Me Updated (M2), KBLaM plus LUKE plus Set-Encoder (M3), SOM-DST (M5, and the motivation for M6), and A-MAC and ConsistencyGate (M7). Zep/Graphiti already performs entity-then-fact resolution and temporal invalidation with an LLM.

A defensible claim is narrower. It is an **integration and an empirical result**: a 20-50M CPU encoder that performs learned, factorised entity-then-record addressing and dense per-record operations over an *open, auditable* personal store, reading that store as cached set-positioned tokens, trained closed-loop, and evaluated at a calibrated, cost-weighted operating point on natural-prevalence traffic. Each part must beat the records-as-text baseline (SOM-DST's design) under equal calibration. Known risks: soft tokens lose detail (xRAG), small classifiers collapse on UPDATE (MemRouter [S]), and operation errors dominate (SOM-DST). Avoid "novel memory architecture" and "first learned memory addressing".

### Sources

Verified [V] during this task: 2010.02807 (Toshniwal et al., PDF text) · 2501.13956 (Zep, HTML) · 1909.10506 (Gillick et al.) · 1605.07427 (Hierarchical Memory Networks) · 2210.08750 (Keep Me Updated, PDF text) · 1811.00671 (Dialogue NLI) · 2504.19413 (Mem0) · 2508.19828 (Memory-R1) · 2605.20926 (MemConflict) · 2605.00356 (MemRouter) · 2607.29377 (Zero-Mem) · 2410.10450 (KBLaM, HTML) · 2010.01057 (LUKE) · 2404.06912 (Set-Encoder) · 2610.21375 (Memorilla) · 2506.06326 (MemoryOS) · 2304.11062 (RMT 1M, HTML) · 2501.00663 (Titans) · 2509.25911 (Mem-α) · 2609.33013 (Epistemics of Agent Memory) · 1911.03906 (SOM-DST, PDF text) · 1506.03099 (scheduled sampling) · 1011.0686 (DAgger) · 2107.05168 (FPDSC) · 2302.08220 (DSDN) · 1706.04599 (Guo et al.) · 1705.08500 (Geifman and El-Yaniv) · 2603.04549 (A-MAC) · 2607.22962 (ConsistencyGate).

Seen only in search results or summaries [S]: 2005.00128 (Xia et al.) · 1708.00781 (EntityNLM) · 2405.13792 (xRAG) · 2110.06176 (Mention Memory) · 2004.07202 (Entities as Experts) · 1909.04164 (KnowBERT) · 2212.10947 (Parallel Context Windows) · 2603.16413 · 2510.18866 (LightMem) · 1707.07045 (e2e coreference) · 2004.00584 (Ditto) · 2607.00339 (TRACE) · 2605.06527 (STALE) · 2607.02579 (GovMem) · 2604.27283 · D19-1265 (GUpdater, ACL Anthology) · Correctable-DST (EMNLP 2022).

From memory or the earlier bibliography, not re-checked [U]: MemGPT 2310.08560 · TripPy 2005.02877 · HaluMem 2511.03506 · RMT 2207.06881 · Elkan 2001 (IJCAI).

Correction to the earlier bibliography (01-LITERATURE-AND-CRITIQUE.md): it says Keep Me Updated's "data is not released". The paper itself states "We release the newly collected dataset" [V]. Whether the data can actually be obtained should be checked before relying on either claim.

# Part II

## C. Explicit memory, addressing, identity, dialogue state tracking, continual learning

Date: 2026-11-01. Companion to `E-prior-art.md` (Part 1); works verified there are reused, not fetched again.

Tags: **[V]** verified in the primary source during this task; **[S]** secondary source read during this task (search summary, citing paper); **[U]** unverified, from memory. Cost figures are given only where a source states them; otherwise the asymptotic cost follows from the described mechanism and is tagged [U] or "(derived)".

### 1. Differentiable memory architectures (NTM, DNC, MemN2N, KV-MemNN, EntNet, RMC)

#### Neural Turing Machine (Graves et al., 2014; arXiv 1410.5401) [V]
- Problem solved: learning simple algorithms (copying, sorting, associative recall) from input-output examples, using a controller that reads and writes an external memory "through attentional processes" [V].
- Computational cost: O(N·M) per step for N memory rows of width M, since soft attention touches every row [U, derived].
- Memory mechanism: content-based plus location-based (shift) addressing, with erase/add writes [U; the abstract does not detail addressing].
- Limitations (with evidence): the authors call the results "preliminary" [V]; algorithmic toy tasks only. Training instability is widely reported [U].
- Useful for PASTE: the vocabulary of content addressing and erase/add writes. PASTE's WRITE/UPDATE/FORGET are discrete, auditable analogues.
- What PASTE would need to do differently: discrete operations over an external database, not soft writes; supervised operation labels instead of end-to-end gradients through memory.

#### Differentiable Neural Computer (Graves et al., 2016; Nature 538:471-476) [U]
- Problem solved: graph reasoning, bAbI, and London Underground route planning with an NTM-like controller [U].
- Computational cost: O(N²) temporal-link matrix per step, later sparsified [U].
- Memory mechanism: content addressing, dynamic allocation through usage vectors and free gates, and temporal links that record write order [U].
- Limitations (with evidence): synthetic tasks; on bAbI-10k EntNet reports a lower mean error than all the memory-augmented baselines it compares, the DNC included (EntNet table: 0 failed tasks, 0.5 mean error) [V, EntNet PDF].
- Useful for PASTE: usage-based freeing is the neural precursor of FORGET/TTL; temporal links resemble record version history.
- What PASTE would need to do differently: keep allocation and freeing in the store (deterministic, inspectable), with the model only proposing operations.

#### End-to-End Memory Networks (Sukhbaatar et al., 2015; NIPS 2015, arXiv 1503.08895) [V]
- Problem solved: QA and language modelling with recurrent attention ("hops") over an external memory, trained end-to-end with "much less supervision" than the original Memory Networks [V].
- Computational cost: O(hops · N · d) per query over N memories [U, derived].
- Memory mechanism: each sentence is embedded into separate input (address) and output (content) memories; soft attention with multiple hops [V for hops].
- Limitations (with evidence): synthetic QA results are only "competitive with Memory Networks" [V]. The memory is read-only per episode, with no write policy.
- Useful for PASTE: a separate address embedding vs content embedding per record; multi-hop reading for entity-then-attribute lookups.
- What PASTE would need to do differently: add a write path and an identity-aware NEW option, which MemN2N lacks.

#### Key-Value Memory Networks (Miller et al., 2016; EMNLP 2016 [U]; arXiv 1606.03126) [V]
- Problem solved: QA by reading memories with "different encodings for addressing and for output" [V].
- Computational cost: key hashing preselects candidate memories, then soft attention over them [U].
- Memory mechanism: (key, value) pairs; for a KB triple, key = subject + relation and value = object [U on encoding detail].
- Limitations (with evidence): on WikiMovies, hits@1 is **93.9 with a human-annotated KB vs 76.2 reading Wikipedia documents** (68.3 with an IE-built KB). Synthetic KB-as-sentences degrades from 93.9 (KB) to 82.9 (one template) to 72.5 (all templates plus conjunctions plus coreference) [V, PDF Tables 2 and 5]. Also, "only 56% of subject-object pairs in IE match the triples in the original KB" [V].
- Useful for PASTE: direct evidence that **structured records beat the same facts rendered as text**, and that the loss grows with linguistic variation (coreference, conjunctions). This is the strongest prior for M3 (records as structured tokens) over the records-as-text baseline.
- What PASTE would need to do differently: the store is written by the model, so IE errors (the 56% match) become the input distribution. PASTE must be robust to its own noisy keys (see M6).

#### Recurrent Entity Network, EntNet (Henaff et al., 2017; ICLR 2017, arXiv 1612.03969) [V, PDF]
- Problem solved: tracking world state while reading; "the first method to solve all the tasks in the 10k training examples setting" of bAbI [V].
- Computational cost: O(K·d²) per sentence for K memory cells (parallel gated RNNs with tied weights) [U, derived from the equations].
- Memory mechanism: each cell has a key w_j and value h_j. Gate `g_j = σ(sᵀh_j + sᵀw_j)` (content plus key/location term); candidate `h̃_j = φ(Uh_j + Vw_j + Ws_t)`; update `h_j ← h_j + g_j ⊙ h̃_j`, then normalisation [V]. Keys can be tied to entity embeddings, so each slot encodes one entity [V]. 20 slots, d = 100 [V].
- Limitations (with evidence): bAbI mean error 0.5, with 0 failed tasks [V]. The slot count is fixed, slots are latent and not inspectable without probing, and the results are on synthetic stories.
- Useful for PASTE: the closest neural precedent for M4's GRU-updated temporary slots, and for per-entity gating, which is an implicit "address by entity" (key term) vs "by content" (content term).
- What PASTE would need to do differently: the slots must have explicit provenance (source text, TTL) and must never hold persistent facts. EntNet's tied-key trick suggests initialising temporary slots from profile tokens.

#### Relational Memory Core (Santoro et al., 2018; arXiv 1806.01822; NeurIPS 2018 [U]) [V]
- Problem solved: relational reasoning over memories, using "multi-head dot product attention to allow memories to interact" [V]; gains on Mini PacMan, program evaluation and language modelling (WikiText-103, Project Gutenberg, GigaWord) [V].
- Computational cost: O(K²) attention among K memory slots per step [U, derived].
- Memory mechanism: a fixed set of memory slots updated by self-attention over [memory; input], with LSTM-style gating [U on gating].
- Limitations (with evidence): the slots are latent; the gains are on RL, program and LM benchmarks, not on entity identity.
- Useful for PASTE: motivates letting record tokens attend to each other (which KBLaM forbids), needed for the merge head and the contradiction relation.
- What PASTE would need to do differently: record tokens are fixed per version and computed outside the loop; only the segment's view of them is updated.

### 2. Parametric and retrieval memory at scale (PKM, Memory Layers at Scale, Larimar, kNN-LM, RETRO)

#### Product-key memory, PKM (Lample et al., 2019; NeurIPS 2019, arXiv 1907.05242) [V]
- Problem solved: adding up to a billion parameters to a transformer with "negligible computational overhead" [V].
- Computational cost: exact top-k over N = |K|² keys using two half-key codebooks, about O(√N) per query instead of O(N) [U on the exact form; the "fast, exact nearest-neighbor search" is V].
- Memory mechanism: the query is split in two halves; top-k in each sub-key set; the Cartesian product gives candidate slots; a sparse weighted sum of value vectors [U on details].
- Limitations (with evidence): on language modelling with up to 30B words, a 12-layer model with memory beats a 24-layer baseline and is twice as fast at inference [V]. The memory is parametric and trained by gradient descent, so it cannot be audited or edited per fact [U].
- Useful for PASTE: cheap sparse addressing if the profile set grows large. The two-stage product key is structurally like entity-then-attribute addressing.
- What PASTE would need to do differently: PASTE's "slots" are database rows written at inference time, not learned parameters. PKM is only relevant as an index for candidate records, not as memory.

#### Memory Layers at Scale (Berges et al., 2024; arXiv 2412.09764) [V]
- Problem solved: making trainable key-value lookup layers work at scale; they "add extra parameters to a model without increasing FLOPs" [V].
- Computational cost: FLOP-neutral parameter growth; scaling laws up to 128B memory parameters, pretrained on 1T tokens, against base models up to 8B [V].
- Memory mechanism: an improved product-key memory layer replacing some FFNs, with a fully parallelisable implementation [V].
- Limitations (with evidence): gains are "especially pronounced on factual tasks" [V]. It stores pretraining knowledge, not user state; there is no write at inference.
- Useful for PASTE: evidence that sparse key-value capacity helps factual recall, but at pretraining scale.
- What PASTE would need to do differently: not applicable to per-user memory at 20-50M parameters; cite it only to rule out "parametric memory" as an alternative for auditable state.

#### Larimar (Das et al., 2024; ICML 2024, arXiv 2403.11901) [V]
- Problem solved: one-shot knowledge updates to an LLM through a "distributed episodic memory", without retraining [V].
- Computational cost: updates are 8-10x faster than baseline editors, depending on the base LLM [V].
- Memory mechanism: a Kanerva-machine-style memory matrix written in one step and read to condition the decoder [U on Kanerva detail]; selective forgetting and leakage prevention [V].
- Limitations (with evidence): evaluated on fact-editing benchmarks with accuracy "comparable to strong baselines" [V]. The memory is distributed, so a single fact is not a row that can be audited.
- Useful for PASTE: shows that selective forgetting can be evaluated as a first-class operation (FORGET head).
- What PASTE would need to do differently: forgetting must remove an identifiable record, not interfere in superposition; PASTE inherits auditability from the external store.

#### kNN-LM (Khandelwal et al., 2020; ICLR 2020, arXiv 1911.00172) [V]
- Problem solved: improving an LM by interpolating with a k-nearest-neighbour distribution over a datastore of (context embedding, next token) pairs [V]; Wikitext-103 perplexity 15.79, 2.9 points better, with no additional training [V].
- Computational cost: one ANN search per generated token over a datastore with one entry per training token [U on size].
- Memory mechanism: a non-parametric datastore keyed by the LM's own hidden states; swapping the datastore gives domain adaptation [V].
- Limitations (with evidence): per-token retrieval cost and datastore size [U]; similarity in embedding space is not identity.
- Useful for PASTE: precedent for keys taken from the *same* model's hidden states (as in M3's pooled record tokens), so key and query live in one space.
- What PASTE would need to do differently: re-encode keys when the encoder is fine-tuned (stale keys); add identity-aware scoring on top of similarity.

#### RETRO (Borgeaud et al., 2022; arXiv 2112.04426; ICML 2022 [U]) [V]
- Problem solved: conditioning an LM on chunks retrieved from a 2-trillion-token database; comparable to GPT-3 and Jurassic-1 on the Pile with 25x fewer parameters [V].
- Computational cost: frozen BERT retriever with precomputed chunk embeddings; chunked cross-attention adds a modest overhead [V for components].
- Memory mechanism: neighbours are encoded by a differentiable encoder and attended through chunked cross-attention [V]; existing models can be retrofitted [V].
- Limitations (with evidence): retrieval by local similarity [V]; gains on knowledge-intensive tasks need fine-tuning [V].
- Useful for PASTE: frozen retriever plus precomputed embeddings is the pattern of M3 (cache per record version); retrofitting a pretrained model is PASTE's setting.
- What PASTE would need to do differently: PASTE's retrieved items are mutable, user-owned records, and the model must also *write* them.

### 3. Set and slot representations (Slot Attention, Set Transformer)

#### Slot Attention (Locatello et al., 2020; NeurIPS 2020, arXiv 2006.15055) [V]
- Problem solved: object-centric representations; slots bind to objects through a "competitive procedure over multiple rounds of attention" [V].
- Computational cost: O(T · N · K) for T iterations, N inputs and K slots [U, derived].
- Memory mechanism: exchangeable slots (no fixed order) refined iteratively, with softmax normalised over *slots* (competition) and a GRU update [U on GRU; exchangeability V].
- Limitations (with evidence): evaluated on unsupervised object discovery and property prediction on synthetic scenes [V]; slots are unsupervised and latent.
- Useful for PASTE: competition over slots is the right inductive bias for addressing. A statement should be claimed by one record or by NEW. The GRU slot update is the template for M4's temporary slots.
- What PASTE would need to do differently: slots are tied to existing records (supervised), with an explicit NEW slot. Slot competition replaces the independent per-record sigmoid that can address several records at once.

#### Set Transformer (Lee et al., 2019; ICML 2019, arXiv 1810.00825) [V]
- Problem solved: permutation-invariant modelling of interactions within sets; inducing points reduce self-attention "from quadratic to linear in the number of elements" [V].
- Computational cost: O(n·m) with m inducing points [V for linear].
- Memory mechanism: attention-based set encoder and decoder [V]; pooling by multi-head attention [U].
- Limitations (with evidence): evaluated on set-structured tasks (multiple instance learning, point clouds, few-shot) [V].
- Useful for PASTE: theory for M3's unordered record set. Shared position ids plus self-attention is permutation-equivariant over records; inducing points bound the cost when a user has many records.
- What PASTE would need to do differently: the set must be processed jointly with an ordered segment. Equivariance should be tested (shuffle records at inference), as SOM-DST did with slot shuffling.

### 4. Identity vs similarity: entity linking, bi-encoders vs cross-encoders, hard negatives

#### BLINK, "Scalable Zero-shot Entity Linking with Dense Entity Retrieval" (Wu et al., 2020; EMNLP 2020 [U]; arXiv 1911.03814) [V, HTML]
- Problem solved: zero-shot entity linking over 5.9M Wikipedia entities, using bi-encoder retrieval followed by cross-encoder re-ranking [V].
- Computational cost: exact FAISS search takes 9.2 ms per query for the top 100 (batch mode); HNSW takes 2.6 ms (accuracy 71.1 vs 71.5 exact) or 1.4 ms (70.7). Precomputing all entity embeddings takes about 2.8 h on 8 V100s [V].
- Memory mechanism: precomputed entity vectors from entity descriptions; the mention is encoded with its context. Hard negatives are the top 10 predicted entities per example [V].
- Limitations (with evidence): the **cross-encoder consistently beats the bi-encoder** on identity decisions: TACKBP-2010 94.5 vs 92.9; WikilinksNED Unseen-Mentions 75.2 vs 71.5 (Wikipedia-only training). Distilling into the bi-encoder recovers part of the gap (Unseen-Mentions 74.4 → 75.7 vs teacher 76.8; TACKBP 92.9 → 93.5 vs 94.5). Zeshel bi-encoder Recall@64 is 82.06 [V]. The paper reports no with-vs-without ablation of hard negatives [V].
- Useful for PASTE: quantifies the cost of addressing records with independent embeddings (bi-encoder, like pooled record tokens scored by a bilinear head) vs full joint attention (cross-encoder, like records-as-text in the segment). Expect a 1.5-4 point gap on hard identity cases, partly recoverable by distillation.
- What PASTE would need to do differently: M3 already gives a middle path. Record tokens are precomputed (bi-encoder cost), but they attend jointly with the segment in all layers (cross-encoder-like interaction over compact tokens). The records-as-text baseline is the "teacher" and should be used for distillation.

#### Poly-encoders (Humeau et al., 2020; ICLR 2020, arXiv 1905.01969) [V]
- Problem solved: the trade-off between cross-encoders, which "often perform better, but [are] too slow for practical use", and faster but less accurate bi-encoders [V].
- Computational cost: candidates are cached as single vectors; the context is summarised into m global codes; one attention step per candidate [U on detail].
- Memory mechanism: m learned codes attend over context tokens, and the candidate embedding attends over the codes [U].
- Limitations (with evidence): evaluated on dialogue response selection and retrieval tasks [U]; it sits between the two architectures in accuracy [V].
- Useful for PASTE: a direct template for M1's scoring. Cached record vectors (candidates) are scored against a few segment codes. This is cheaper than full joint attention and more expressive than one bilinear product.
- What PASTE would need to do differently: add a NEW candidate and train with in-store hard negatives; poly-encoders use in-batch negatives [U].

#### ColBERT (Khattab and Zaharia, 2020; SIGIR 2020, arXiv 2004.12832) [V]
- Problem solved: efficient passage search through late interaction; "two orders-of-magnitude faster" than BERT rankers and "four orders of magnitude fewer FLOPs per query" [V].
- Computational cost: documents are precomputed offline as token-level vectors; MaxSim per query token [V/U].
- Memory mechanism: multi-vector representations per document [V].
- Limitations (with evidence): storage of one vector per token [U]; effectiveness is "competitive with" BERT rankers, not superior [V].
- Useful for PASTE: per-record multi-vector tokens (profile + attribute + value), as in M3, are a ColBERT-like compromise that keeps field-level detail lost by single-vector pooling.
- What PASTE would need to do differently: none structurally; use it as the ablation between 1 token and 3 tokens per record.

#### Gillick et al. 2019 (arXiv 1909.10506) [V, Part 1] and Zhang and Stratos, "Understanding Hard Negatives in Noise Contrastive Estimation" (NAACL 2021; arXiv 2104.06245) [S]
- Problem solved: dense entity retrieval. Gillick et al. credit unsupervised hard-negative mining with a large gain [V]. Zhang and Stratos show that drawing negatives from the model's own distribution reduces the bias of the contrastive gradient estimate relative to the cross-entropy gradient [S].
- Computational cost: hard-negative mining requires periodic re-encoding of the candidate set [U].
- Memory mechanism: dual encoders; Zhang and Stratos also use a cross-attentional sum-of-max score [S]; reported Zeshel Recall@64 89.62 with mixed negatives [S, benchmark listing].
- Limitations (with evidence): the numbers come from search summaries, not the PDF.
- Useful for PASTE: theoretical backing for M1's in-store hard negatives. Mining negatives from the store under the current model is the bias-reducing choice. Mixing hard and random negatives is the reported best practice [S].
- What PASTE would need to do differently: PASTE's hard negatives are *structured* (same attribute, similar value, different entity), which is a constructed counterfactual rather than model-mined. Mining both kinds is the conservative design.

#### Entity Tracking in Language Models (Kim and Schuster, 2023; ACL 2023, arXiv 2305.02363) [V]
- Problem solved: probes whether LMs can infer an entity's final state from an initial description and a sequence of state-changing operations [V].
- Computational cost: evaluation study.
- Memory mechanism: none explicit; tests in-context state tracking.
- Limitations (with evidence): among Flan-T5, GPT-3 and GPT-3.5, only GPT-3.5 models showed the ability, which the authors attribute to code pretraining. Fine-tuned T5 "performs non-trivially" on unseen entities and longer sequences, but drops on harder splits [V].
- Useful for PASTE: small text-pretrained models do not track entity state out of the box but can learn it with fine-tuning. This supports explicit, supervised state (temporary slots and store) over implicit tracking in a 20-50M encoder.
- What PASTE would need to do differently: test generalisation to longer operation chains (many updates to the same record) and to unseen entities, as in their splits.

### 5. Dialogue state tracking (TRADE, SOM-DST, TripPy, D3ST, table-operation DST, 2024-2026 small models)

#### TRADE (Wu et al., 2019; ACL 2019, arXiv 1905.08743) [V]
- Problem solved: open-vocabulary multi-domain DST that "generates dialogue states from utterances using a copy mechanism", with an utterance encoder, slot gate and state generator shared across domains [V].
- Computational cost: decodes a value for every (domain, slot) pair at every turn, re-reading the full history [U, derived; SOM-DST cites this as inefficiency, V].
- Memory mechanism: none persistent; the state is regenerated from history each turn.
- Limitations (with evidence): JGA 48.62 on MultiWOZ (5 domains); 60.58 zero-shot on one domain [V].
- Useful for PASTE: the slot gate (none / dontcare / ptr) is an early per-slot IGNORE gate.
- What PASTE would need to do differently: PASTE must not re-read the history (requirement b). TRADE is the negative example for cost.

#### SOM-DST (Kim et al., 2020; arXiv 1911.03906) [V, PDF; details in Part 1, M5 and M6]
- Problem solved: efficient DST by treating the state as "an explicit fixed-sized memory" and selectively overwriting it [V].
- Computational cost: one BERT pass over [previous turn; current turn; flattened previous state], max length 256; values are generated only for slots predicted as UPDATE [V].
- Memory mechanism: per-slot operation {CARRYOVER, DELETE, DONTCARE, UPDATE} predicted from each `[SLOT]` marker; slot order shuffled at rate 0.5 in training "to make state operation predictor exploit the semantics of the slot names and not rely on the position" [V].
- Limitations (with evidence): JGA 51.72 (2.0) and 53.01 (2.1). With gold operations it reaches 89.85; at least 78.4-92.85% of errors come from operation prediction. Teacher-forced training (gold previous state) and inference on its own state give 2.47x error (53.01 vs 81.00 with gold previous state) [V].
- Useful for PASTE: **SOM-DST is PASTE's main baseline in DST form**: the store rendered as text inside a single encoder input, with one decision per record marker. Its error analysis says to invest in operation prediction and closed-loop robustness.
- What PASTE would need to do differently: open-ended, growing records instead of a fixed slot list, so record markers cannot be learned per slot. Hence pooled record tokens (M3) and NEW handling (M1).

#### TripPy (Heck et al., 2020; SIGDIAL 2020, arXiv 2005.02877) [V]
- Problem solved: value-independent DST with three copy mechanisms: a span from the user input, a copy from a memory of system inform operations, and a copy from another slot "to resolve coreferences" [V].
- Computational cost: a BERT encoder per turn with per-slot heads [U].
- Memory mechanism: an explicit DS memory of system informs plus slot-to-slot referral [V].
- Limitations (with evidence): JGA above 55% on MultiWOZ 2.1 [V]; fixed ontology of slots.
- Useful for PASTE: slot-to-slot "refer" is a learned pointer from one record to another, precedent for the MERGE head and for cross-record coreference.
- What PASTE would need to do differently: referral over an open record set with entity identity, not over a fixed slot list.

#### D3ST, Description-Driven DST (Zhao et al., 2022; arXiv 2201.08904) [V abstract]
- Problem solved: replaces schema names "entirely with natural language descriptions" with an "index-picking" mechanism, for zero-shot transfer [V].
- Computational cost: a seq2seq T5 over the full schema description plus history [U]; SGD JGA around 72.9-86.4 across T5 220M-11B [U, earlier bibliography, not re-checked].
- Memory mechanism: none persistent; the schema is in the prompt.
- Limitations (with evidence): evaluated on MultiWOZ, SGD and SGD-X [V]; the numbers above are unverified here.
- Useful for PASTE: descriptive record text matters more than identity markers. This argues for pooling record tokens from the attribute *text* (M3), not from learned attribute ids.
- What PASTE would need to do differently: an encoder instead of seq2seq; schema-free, open attributes.

#### Diable: DST as operations on tables (Lesci et al., 2023; Findings of ACL 2023, arXiv 2305.17020) [V]
- Problem solved: represents the state as a table and generates operations to update it instead of regenerating the state; "2.4x more time efficient" [V].
- Computational cost: input is the context plus the current table; output is only the changed operations [V].
- Memory mechanism: an explicit table as state [V].
- Limitations (with evidence): JGA "competitive", not best; robust to noisy annotations [V]. A search summary reports that Diable estimates an upper bound with the gold previous state [S].
- Useful for PASTE: the closest DST analogue of "propose operations to an external store, the store executes them".
- What PASTE would need to do differently: an encoder with classification heads, not a generator; open schema.

#### Small-model and recent DST, 2021-2025
- Lee et al., schema-driven prompting (EMNLP 2021; arXiv 2109.07506) [V abstract]: generative DST with schema descriptions in the prompt, SOTA on MultiWOZ 2.2. A search summary says T5-small (60M) gets mid-50s JGA on 2.2 [S].
- FPDSC (SIGDIAL 2021; arXiv 2107.05168) [V]: fuses predicted previous states; JGA 55.03 (2.0) and 59.07 (2.1) [V]; trained with scheduled sampling [S].
- Xu et al., "From Schema to State" (EMNLP 2025) [V abstract, ACL Anthology]: two-stage distillation of LLM DST reasoning into "a smaller model" trained on synthetic dialogues; SOTA zero-shot, scheme-only on MultiWOZ. The student size is not stated on the page.
- ECDG-DST (Computer Speech and Language, 2025) [S]: encoder, domain guide, operation predictor and value generator (SOM-DST-like); +2.44 / +2.05 JGA over baselines on 2.0 / 2.1.
- **Assessment:** 2024-2026 DST work is dominated by LLM prompting and distillation; we found **no 2025-2026 encoder-only sub-100M DST work with a notable new mechanism** (searches were thin). Small-model DST evidence is still SOM-DST/TripPy-era BERT-base (about 110M).
- Useful for PASTE: synthetic dialogue generation plus distillation from an LLM teacher (From Schema to State) is the current recipe for low-data small trackers.

### 6. Contradiction detection and memory update (Dialogue NLI, DECODE, Keep Me Updated)

#### Dialogue NLI (Welleck et al., 2019; arXiv 1811.00671; ACL 2019 [U]) [V abstract, from Part 1]
- Problem solved: casts persona consistency as NLI between dialogue utterances and persona sentences; a model trained on it improves dialogue consistency under human and automatic evaluation [V].
- Computational cost: pairwise classification, one pass per (utterance, persona sentence) pair [U].
- Memory mechanism: persona sentences act as a fixed memory; the NLI model re-ranks candidate responses [U on re-ranking detail].
- Limitations (with evidence): the abstract gives no figures; labels are entailment / neutral / contradiction, built from human-annotated persona triples [U].
- Useful for PASTE: NLI pretraining for the relation head (M2). Keep Me Updated shows NLI transfer helps (see below).
- What PASTE would need to do differently: separate "update over time" from "contradiction". In NLI both look like contradiction, which is the main confusion PASTE's six-way head must resolve.

#### DECODE (Nie et al., 2021; arXiv 2012.13391; ACL 2021 [U]) [V]
- Problem solved: dialogue contradiction detection, with a dataset of human-human and human-bot contradictory dialogues [V].
- Computational cost: the structured approach compares the last utterance with each previous utterance of the same speaker, so cost grows linearly with history [U on detail; "structured, utterance-based" is V].
- Memory mechanism: none persistent; history utterances act as memory.
- Limitations (with evidence): DECODE gives better supervision than existing NLI data, "including NLI data aimed at the dialogue domain". The structured (utterance-pair) approach is "more robust and transferable" out of distribution than the unstructured (whole-history) approach [V].
- Useful for PASTE: direct evidence for **pairwise structured comparison (statement vs record) over flat concatenation** for contradiction, the M2 design. It also argues that in-domain contradiction data beats generic NLI.
- What PASTE would need to do differently: compare against *store records* (one per entity-attribute) rather than all previous utterances, which bounds the cost.

#### Keep Me Updated! (Bae et al., 2022; Findings of EMNLP 2022, arXiv 2210.08750) [V, PDF; details in Part 1, M2]
- Problem solved: memory management across sessions of long-term conversation, removing outdated or redundant entries [V].
- Computational cost: a T5 classifier per (memory sentence, new sentence) pair, about 80 ms per operation on a V100 [V, PDF].
- Memory mechanism: unstructured text memory; operations PASS / REPLACE / APPEND / DELETE [V].
- Limitations (with evidence): test accuracy 83.65 from scratch and 84.10 with NLI transfer, against an estimated human 87.52; zero-shot NLI only 71.50 [V]. Korean only. The paper claims dataset release [V; availability not checked].
- Useful for PASTE: the closest supervised precedent for M2. It sets a realistic ceiling (human agreement about 88%) and shows NLI pretraining helps by about 0.5 points after fine-tuning and gives 71.5 zero-shot.
- What PASTE would need to do differently: add addressing (Keep Me Updated assumes the pair is given), finer relations (update vs correction), and profiles (entities other than the user).

### 7. Continual learning and complementary learning systems

#### Elastic Weight Consolidation, EWC (Kirkpatrick et al., 2017; PNAS, arXiv 1612.00796) [V]
- Problem solved: catastrophic forgetting across sequential tasks, by "selectively slowing down learning on the weights important for those tasks" [V]; permuted MNIST and sequential Atari [V].
- Computational cost: one diagonal Fisher estimate per task, plus a quadratic penalty with O(|θ|) memory per anchored task [U].
- Memory mechanism: none explicit; knowledge lives in weights, protected by a Fisher-weighted anchor.
- Limitations (with evidence): replay baselines often beat it (see Chaudhry et al. below) [V for that comparison class].
- Useful for PASTE: little. User memory lives in the store, so the encoder does not learn user facts and per-user forgetting in weights does not arise. EWC matters only if PASTE is fine-tuned again on new traffic distributions.
- What PASTE would need to do differently: N/A. Choosing an external store is precisely a way to avoid needing EWC for user facts.

#### Gradient Episodic Memory, GEM (Lopez-Paz and Ranzato, 2017; NIPS 2017, arXiv 1706.08840) [V]
- Problem solved: continual learning that "alleviates forgetting, while allowing beneficial transfer of knowledge to previous tasks"; introduces transfer metrics beyond accuracy [V].
- Computational cost: a quadratic program per step to project gradients so that losses on stored episodic examples do not increase [U].
- Memory mechanism: a small episodic store of past examples used as constraints [V for episodic memory].
- Limitations (with evidence): MNIST variants and CIFAR-100 only [V].
- Useful for PASTE: the backward/forward-transfer metrics are a model for evaluating PASTE re-training rounds (does a new model still handle old operation types?).
- What PASTE would need to do differently: N/A for user memory; relevant to model updates.

#### Experience replay with tiny episodic memories (Chaudhry et al., 2019; arXiv 1902.10486) [V]
- Problem solved: shows that simple joint training on the current data plus a tiny replay memory beats specialised CL methods on four benchmarks; one example per class gives 7-17% gains, and "repetitive training on even tiny memories of past tasks does not harm generalization" [V].
- Computational cost: negligible: a small buffer and mixed minibatches [V].
- Memory mechanism: an episodic buffer of raw examples.
- Limitations (with evidence): supervised image benchmarks [V].
- Useful for PASTE: when re-training PASTE on new traffic, keep a small replay set of rare operations (MERGE, FORGET, corrections) rather than adding regularisers.
- What PASTE would need to do differently: N/A.

#### Complementary Learning Systems updated (Kumaran, Hassabis and McClelland, 2016; Trends in Cognitive Sciences 20(7):512-534) [S, citation details from search]; original CLS (McClelland, McNaughton and O'Reilly, 1995, Psychological Review) [U]
- Problem solved: argues that intelligent agents need two learning systems, fast hippocampal and slow neocortical, with interleaved replay. It points out that deep RL agents "exploit a memory buffer akin to the hippocampus" [S].
- Computational cost: theory.
- Memory mechanism: a fast, instance-specific episodic store plus slow statistical learning, with consolidation through replay [S/U].
- Limitations (with evidence): conceptual; the mapping to artificial systems is by analogy.
- Useful for PASTE: the conceptual license for M4. Temporary slots and session-reset tokens play the role of a fast, transient buffer; the store is the durable system; "promote" is consolidation. In CLS, however, the *durable* system is slow and parametric. PASTE inverts this: the durable store is explicit and fast to write. The analogy should not be over-claimed.
- What PASTE would need to do differently: if the CLS framing is used, evaluate the consolidation (promote) decision explicitly, as 2609.33013 does (Part 1).

#### 2025-2026 work separating working or episodic memory from long-term memory
- **Pink et al., "Position: Episodic Memory is the Missing Piece for Long-Term LLM Agents" (arXiv 2502.06975, 2025) [V].** Argues for episodic memory supporting "single-shot learning of instance-specific contexts", organised around five properties (not listed on the abstract page), with a roadmap. Position paper, no experiments [V]. Useful for PASTE's framing: temporary slots are instance-specific context; the store is long-term memory.
- **Dorovatas et al., "Position: Modular Memory is the Key to Continual Learning Agents" (arXiv 2603.01761, 2026) [V].** Argues for combining in-weight learning (stable) with in-context learning (fast adaptation) through modular memory. No experiments [V]. The working-memory vs long-term mapping is our interpretation [I].
- **Zhao et al., RPMem (arXiv 2609.23466, 2026) [V].** Compiles each session into a latent memory in one forward pass. A *task-trained recurrent gate* consolidates it with retained cross-session memory, which is then mapped to LoRA parameters. PERMA 85.52% with Qwen3-8B, +5.32 over the best parametric and +12.98 over the best text-based baseline; the update cost is near-constant [V]. **This is the strongest recent evidence for a learned consolidation gate between session state and long-term state**, but its long-term state is parametric (not auditable).
- **Titans (arXiv 2501.00663) [V, Part 1]**: attention as short-term memory plus a neural long-term memory. **MemoryOS (2506.06326) and LightMem (2510.18866) [V/S, Part 1]**: explicit short, mid and long-term tiers with promotion rules. **"The Epistemics of Agent Memory" (2609.33013) [V, Part 1]**: learned promotion with a quality gate, plus a reported distribution-shift failure.
- What PASTE would need to do differently from all of these: keep the long-term side explicit and auditable (unlike RPMem and Titans), and make promotion a *learned, calibrated* decision (unlike MemoryOS and LightMem, which use rules).

### Cross-cutting observations

1. **Structure beats text, but the gap depends on noise.** KV-MemNN: KB 93.9 vs documents 76.2 hits@1; templated sentences of the same facts lose 11-21 points [V]. This is the best prior for M3. But an IE-built KB reached only 68.3 (56% of extracted pairs correct) [V], and PASTE's store is model-written.
2. **Joint reading beats independent embeddings on identity.** BLINK's cross-encoder beats its bi-encoder by 1.6-3.7 points; distillation closes about half [V]. DECODE: pairwise comparison transfers better than whole-history reading [V]. Use the records-as-text model as a distillation teacher.
3. **Operation prediction is the bottleneck, not values.** In SOM-DST, at least 78-93% of errors come from operations; gold operations lift JGA from 53 to 90 [V]. The human ceiling for pairwise memory operations is about 88% (Keep Me Updated) [V]. Report per-operation confusion, especially UPDATE vs WRITE: MemRouter's collapse on UPDATE [S] is a warning.
4. **Closed loop is where systems break.** Teacher forcing is standard (SOM-DST, Toshniwal) and costs 2.47x error in SOM-DST [V]. DST mitigations (scheduled sampling, simulated predicted states) exist but are not a solved problem [S].
5. **Set invariance must be tested, not assumed.** SOM-DST shuffles slots in training [V]; Set Transformer and Set-Encoder give principled invariance [V]. Test PASTE under record permutation and store-size scaling.
6. **Latent memory is the norm in recent work; auditability is the differentiator.** RPMem, Titans, Larimar and Memorilla all store long-term state in latent or parametric form [V]. Explicit tiered systems (MemoryOS, LightMem) use rules or LLMs for promotion. A small, learned, calibrated writer over an auditable store remains sparsely populated in the literature: 2026 admission gates (A-MAC, ConsistencyGate) are LLM-based or rule-feature based [V].
7. **Little sub-100M evidence.** Beyond BERT-base DST (about 110M) and MemRouter's 12M heads on a frozen LLM, we found no 2024-2026 memory writer under 100M parameters.

### Sources

Verified [V] in this part: 1410.5401 (NTM) · 1503.08895 (MemN2N) · 1606.03126 (KV-MemNN, PDF tables) · 1612.03969 (EntNet, PDF) · 1806.01822 (RMC) · 1907.05242 (PKM) · 2412.09764 (Memory Layers at Scale) · 2403.11901 (Larimar) · 1911.00172 (kNN-LM) · 2112.04426 (RETRO) · 2006.15055 (Slot Attention) · 1810.00825 (Set Transformer) · 1911.03814 (BLINK, HTML) · 1905.01969 (Poly-encoders) · 2004.12832 (ColBERT) · 2305.02363 (Entity tracking) · 1905.08743 (TRADE) · 2005.02877 (TripPy) · 2201.08904 (D3ST) · 2305.17020 (Diable) · 2109.07506 (schema-driven prompting DST) · ACL Anthology 2025.emnlp-main.85 (From Schema to State) · 2012.13391 (DECODE) · 1612.00796 (EWC) · 1706.08840 (GEM) · 1902.10486 (tiny episodic memories) · 2603.01761 (Modular memory position) · 2502.06975 (Episodic memory position) · 2609.23466 (RPMem).

Reused from Part 1 [V]: 1909.10506 · 1911.03906 · 2210.08750 · 1811.00671 · 2107.05168 · 2501.00663 · 2506.06326 · 2609.33013 · 2605.00356 (MemRouter UPDATE-collapse detail is [S]).

Secondary [S]: 2104.06245 (Zhang and Stratos, hard negatives) · Kumaran, Hassabis and McClelland, TiCS 20(7):512-534 (2016) · ECDG-DST (Computer Speech and Language, 2025) · 2510.18866 (LightMem).

Unverified [U]: DNC (Graves et al., Nature 538:471-476, 2016) · McClelland, McNaughton and O'Reilly (1995) · D3ST SGD numbers (from the earlier bibliography) · venue claims marked [U] in the text.

# Part III

## A/B. Segment recurrence, linear attention, state-space models and associative memory

Date of search: 2026-11-01. Scope: prior art relevant to PASTE's (a) record addressing, (b) cross-segment context without re-reading history, (c) separation of temporary state from persistent memory with a learned write gate.

Tags: **[V]** verified in the primary source during this task (arXiv abstract page, HTML full text, or official blog/model card); **[S]** secondary source read during this task (search snippet, survey, third-party blog); **[U]** unverified, from memory. arXiv ids are given only where seen during this task. Numbers are quoted only when seen in the source.

Notation: L = sequence length, d = model width, S = segment length, M = number of memory tokens/slots, N = SSM state size per channel.

### 1. Segment recurrence and context compression

#### Transformer-XL (Dai et al., 2019; ACL 2019, arXiv 1901.02860) [V]
- Problem solved: fixed-length context fragmentation in Transformer LMs.
- Computational cost: each segment attends to its own S tokens plus a cached, gradient-stopped copy of the previous segment's hidden states (per layer), so cost per segment is O(S·(S+S_mem)·d); cache size is O(layers·S_mem·d). Abstract claims up to 1,800+× faster evaluation than vanilla Transformers [V].
- Memory mechanism: segment-level recurrence on hidden states, h̃^{n-1}_{τ+1} = [SG(h^{n-1}_τ) ∘ h^{n-1}_{τ+1}], with relative positional encoding [U for equation, mechanism V].
- Limitations (with evidence): gradients stop at segment boundaries; RMT paper reports Transformer-XL "plunges close to the baseline without memory" on copy/reverse at 9 segments [V, 2207.06881]. Effective range grows only linearly with depth.
- Useful for PASTE: the cache-previous-segment pattern is the cheapest way to give the encoder short-range cross-segment context.
- What PASTE would need to do differently: PASTE's encoder is bidirectional and pretrained without a cache; cached states are opaque and not auditable, so they can only hold temporary state, never persistent memory.

#### Compressive Transformer (Rae et al., 2019; arXiv 1911.05507) [V]
- Problem solved: extend Transformer-XL's memory by compressing old memories rather than discarding them; introduced PG-19.
- Computational cost: two FIFO memories (raw and compressed, compression rate c), attention cost O(S·(S+n_m+n_cm)) per segment [U for detail].
- Memory mechanism: evicted memories are compressed (pooling/conv) into a secondary memory, trained with an auxiliary reconstruction loss [U for loss detail].
- Limitations: abstract reports LM gains only (WikiText-103 17.1 ppl, Enwik8 0.97 bpc) [V]; no evidence on exact recall of specific facts.
- Useful for PASTE: precedent for a two-tier (recent vs compressed) temporary state.
- Differently: PASTE's "compressed tier" is the external store, which must be lossless and editable.

#### Recurrent Memory Transformer, RMT (Bulatov et al., 2022; NeurIPS 2022, arXiv 2207.06881) [V]
- Problem solved: segment recurrence without changing the Transformer, by passing M memory tokens between segments.
- Computational cost: per segment O((S+2M)²·d); state = M·d vectors (10-75 tokens in the paper) [V]. Training uses BPTT through 0-4 previous segments; "deeper unrolls improve perplexity but are expensive in GPU memory" [V].
- Memory mechanism: read memory tokens prepended, write memory tokens appended; write outputs become the next segment's read memory; gradients flow through memory (unlike Transformer-XL) [V].
- Limitations: authors "observe instabilities and out-of-memory issues during RMT training for larger memory sizes with deeper BPTT unrolls" [V]; on associative retrieval RMT dips at 5 segments while Transformer-XL rises [V]; LM perplexity roughly on par with Transformer-XL (WikiText-103 25.04 vs 24.68) [V].
- Useful for PASTE: memory tokens are the minimal-change way to add cross-segment state to a pretrained encoder.
- Differently: PASTE's memory tokens should carry only within-conversation temporary state; persistent facts go to the store.

#### RMT on BERT / Scaling to 1M+ tokens (Bulatov et al., 2023; arXiv 2304.11062) [V]
- Problem solved: show that a pretrained encoder (BERT) with RMT memory can retain facts across very long inputs.
- Computational cost: linear in number of segments; 512-token segments with 10 memory tokens (499 usable) [V]; "up to ×295 fewer FLOPs" than full attention at ~2M tokens (vs OPT-135M) [V]; BERT memory footprint stays at 3.6 GB [V].
- Memory mechanism: as RMT, on BERT, curriculum from 1 to 7 segments; BPTT unroll max 7 segments [V].
- Limitations: training directly on four segments without curriculum "fails to solve the task or extrapolate" (Fig. 11) [V]; tasks are synthetic memorisation (fact + question in noise) only, authors note "no established benchmarks for NLP tasks with such lengths" [V]; evaluated to 4,096 segments (text gives 2,043,904 tokens; title says 1M, abstract 2M) [V].
- Useful for PASTE: the single most direct precedent: a pretrained bidirectional encoder of BERT size carrying memory tokens across 512-token segments, trained with a segment curriculum.
- Differently: PASTE needs record-addressed outputs (operations against store records), not QA over a hidden fact; and the memory tokens must not become the de facto persistent store.

#### Associative Recurrent Memory Transformer, ARMT (Rodkin et al., 2024; ICML 2024 NGSM workshop, arXiv 2407.04841) [V]
- Problem solved: constant time per new segment with larger associative capacity than RMT.
- Computational cost: O(1) per segment beyond the segment attention; in BABILong, ARMT used 10 memory tokens, memory dimension 64, DPFP-3 feature map [V, 2406.10149].
- Memory mechanism: RMT memory tokens plus a layer-wise associative (linear-attention / delta-rule style) memory updated from memory tokens [S: from BABILong description, abstract does not give the equation].
- Limitations: evaluated mainly on synthetic associative retrieval and BABILong; record single-fact QA is 79.9 % at 50M tokens [V], i.e. not near-perfect.
- Useful for PASTE: shows that a fast-weight memory attached to memory tokens increases capacity at GPT-2 (137M) scale [V].
- Differently: the fast-weight matrix is again latent; PASTE would at most use it for temporary state.

#### Block-Recurrent Transformer (Hutchins et al., 2022; arXiv 2203.07852, NeurIPS camera-ready noted) [V]
- Problem solved: long-sequence LM with a recurrent cell operating on blocks of tokens.
- Computational cost: linear in sequence length; "same computation time and parameter count as a conventional transformer layer" [V]; about 2× faster than a Transformer-XL baseline [V].
- Memory mechanism: a set of recurrent state vectors updated per block via self- and cross-attention with LSTM-style gates [V].
- Limitations: evaluated on perplexity (PG19, arXiv, GitHub) only [V]; no per-fact recall evidence.
- Useful for PASTE: LSTM-style gating on a vector state per block is a tested design for a learned retention gate.
- Differently: PASTE's gate decides persistent writes to an external store, a discrete decision rather than a soft state update.

#### Hierarchical Memory Transformer, HMT (He et al., 2024; NAACL 2025, arXiv 2405.06067) [V]
- Problem solved: flat memory in recurrent models "limits how well they select and filter information"; adds a memory hierarchy.
- Computational cost: 2.5-116× less inference memory than long-context LLMs; 2-57× fewer parameters at comparable quality [V].
- Memory mechanism: segment-level recurrence plus retrieval over cached memory embeddings of past segments [S].
- Limitations: abstract gives no own-parameter overhead [V].
- Useful for PASTE: segment summary embeddings + retrieval over past segment summaries is close to PASTE's RETRIEVE.
- Differently: PASTE retrieves auditable records, not segment embeddings.

#### Memorizing Transformers (Wu et al., 2022; ICLR 2022, arXiv 2203.08913) [V]
- Problem solved: memorise new data at inference time without weight updates.
- Computational cost: approximate kNN lookup into a non-differentiable (key, value) memory; gains continue up to 262K tokens of memory [V].
- Memory mechanism: one layer attends both locally and to top-k retrieved past keys/values, with a learned gate mixing the two [U for gate detail].
- Limitations: memory is a growing cache of internal states, not editable; non-differentiable, so no learned write decision.
- Useful for PASTE: precedent for exact retrieval being better than compression for test-time-defined items (functions, theorems) [V].
- Differently: PASTE needs a learned write gate and identity-aware addressing; Memorizing Transformers writes everything.

#### Infini-attention (Munkhdalai et al., 2024; arXiv 2404.07143) and the Hugging Face reproduction (Nguyen, von Werra, Wolf, 2024-08-14) [V]
- Problem solved: bounded-memory streaming over "infinitely long inputs" by adding a linear-attention compressive memory to each attention block [V].
- Computational cost: fixed d_k×d_v memory per head, combined with masked local attention; claims on 1B/8B models for 1M passkey and 500K summarisation [V].
- Memory mechanism: linear-attention memory (with delta-rule option) read with queries; a learned scalar gate per head mixes memory read and local attention [S/U for equations].
- Limitations (with evidence): the HF reproduction (200M Llama from scratch, then Llama 3 8B continual pretraining) found ~95 % of balance gates stuck near 0.5 until learning-rate/weight-decay changes, the 200M run went NaN after ~20B tokens, the 8B model failed completely when the passkey was in the first of two segments, and "performance worsens as the memory is compressed more times"; they judged it "not convincing or reliable enough" [V].
- Useful for PASTE: strong cautionary evidence that learned gates mixing memory and local attention can fail to train, and that loss can fall while retrieval is broken.
- Differently: PASTE should monitor gate distributions and evaluate retrieval directly during training, not perplexity.

#### AutoCompressors (Chevalier et al., 2023; EMNLP 2023, arXiv 2305.14788) [V]
- Problem solved: compress long contexts into summary vectors used as soft prompts.
- Computational cost: summary vectors accumulated across segments; OPT and Llama-2 fine-tuned on up to 30,720 tokens [V].
- Memory mechanism: each segment's summary tokens are appended to all prior summaries (RMT-like but accumulating) [V].
- Limitations: abstract reports no exact-recall figures [V]; summary vectors are lossy.
- Useful for PASTE: precomputed summary vectors for reranking show compressed representations can serve retrieval.
- Differently: PASTE stores text records; summary vectors could at most be a cache key.

#### Gist tokens (Mu et al., 2023; NeurIPS 2023, arXiv 2304.08467) [V]
- Problem solved: compress prompts into cacheable "gist" tokens by changing only the attention mask.
- Computational cost: no extra training cost beyond instruction tuning; up to 26× prompt compression, 40 % FLOPs reduction, 4.2 % wall-time speedup [V].
- Memory mechanism: tokens after the gist can only attend to gist tokens, forcing compression [V].
- Limitations: evaluated on LLaMA-7B and FLAN-T5-XXL; "minimal" quality loss on instructions, not on long factual state [V].
- Useful for PASTE: the masking trick is a cheap way to train memory tokens in an encoder without architectural changes.
- Differently: the gist must summarise conversation state, not a static instruction.

#### In-context Autoencoder, ICAE (Ge et al., 2023; ICLR 2024, arXiv 2307.06945) [V]
- Problem solved: compress context into memory slots via an LLM encoder with LoRA.
- Computational cost: ~1 % additional parameters; 4× compression [V].
- Memory mechanism: autoencoding + LM pretraining of memory slots, then instruction fine-tuning [V].
- Limitations: 4× compression is modest; Llama-scale only [V].
- Useful for PASTE: autoencoding pretraining is a candidate auxiliary loss to make memory tokens retain content.
- Differently: PASTE is 20-50M parameters; reconstruction targets at that scale are unproven [U].

#### Compressed Context Memory, CCM (Kim et al., 2023; ICLR 2024, arXiv 2312.03414) [S]
- Problem solved: online LM interaction (conversation, personalisation) with growing context.
- Computational cost: recursive compression of accumulated KV into a compact memory via conditional LoRA; reported full-context performance with 5× smaller context memory [S, ICLR poster/search summary].
- Memory mechanism: compression tokens appended per turn; recursion trained as one parallel forward pass [S].
- Limitations: evaluated on LLaMA-scale; memory is latent KV [S].
- Useful for PASTE: closest compression work evaluated on conversation and personalisation; parallelised training of recursive compression avoids sequential BPTT.
- Differently: PASTE writes explicit records; CCM's parallel-training trick could train PASTE's temporary state.

#### xRAG (Cheng et al., 2024; NeurIPS 2024, arXiv 2405.13792) [V]
- Problem solved: compress a retrieved document to one token by projecting its retrieval embedding into the LM.
- Computational cost: 3.53× fewer FLOPs; only the modality bridge is trained [V].
- Memory mechanism: dense-retriever embedding → projector → one soft token [V].
- Limitations: >10 % average gain over no-retrieval on six knowledge tasks, but matches uncompressed RAG only "on several datasets" [V], i.e. one vector loses detail.
- Useful for PASTE: record embeddings from the encoder could be fed back as single tokens instead of rendered text (cheaper than the text-rendered baseline).
- Differently: PASTE needs fine-grained identity decisions (same person vs similar person), which one-vector compression is likely to blur [U].

#### MemoryLLM (Wang et al., 2024; arXiv 2402.04624) and M+ (Wang et al., 2025; arXiv 2502.00592) [V]
- Problem solved: self-updatable LLM with a fixed-size latent memory pool inside the transformer.
- Computational cost: M+ reports the memory pool is 1B parameters [V].
- Memory mechanism: new text is written into per-layer memory tokens, randomly dropping old ones (exponential forgetting) [U for drop rule]; M+ adds a long-term memory with a co-trained retriever [V].
- Limitations: MemoryLLM "struggles to retain knowledge beyond about 20k tokens"; M+ extends to >160k [V].
- Useful for PASTE: shows latent pools forget quickly and need retrieval to scale.
- Differently: PASTE's persistent memory is external text; latent pools are not auditable.

#### LM2: Large Memory Models (Kang et al., 2025; arXiv 2502.06049) [V]
- Problem solved: add a memory module to a decoder without hurting general ability.
- Computational cost: separate memory bank read via cross-attention and updated through gates [V]; slot count/size not in abstract (prior notes say 2,048 slots [U]).
- Memory mechanism: input, forget and output gates on memory slots (LSTM-like) [V for "gating mechanisms"].
- Limitations: BABILong gains of 37.1 % over RMT and 86.3 % over Llama-3.2 are averages across tasks [V]; parameter count not stated in abstract [V].
- Useful for PASTE: gated slot updates + cross-attention readout is a template for reading the store via cross-attention.
- Differently: PASTE's slots are store records; gates should produce discrete operations.

#### Titans (Behrouz et al., 2024/2025; arXiv 2501.00663) [V]
- Problem solved: a neural long-term memory that learns at test time, alongside attention as short-term memory.
- Computational cost: memory is an MLP of depth L_M (1-4) updated by gradient steps per chunk; trained at 340M/400M (15B tokens) and 760M (30B tokens); 170M only in an ablation figure [V].
- Memory mechanism [V]: loss ℓ(M_{t-1}; x_t) = ||M_{t-1}(k_t) − v_t||²; surprise S_t = η_t S_{t-1} − θ_t ∇ℓ; update M_t = (1 − α_t) M_{t-1} + S_t; read y_t = M*(q_t). Variants MAC (memory as context), MAG (gate), MAL (layer).
- Limitations: BABILong and NIAH scores only in figures; no independent reproduction located in this task [U].
- Useful for PASTE: cleanest formulation of a surprise-gated write with data-dependent forgetting α_t; "surprise" is a candidate signal for the persistent-write gate.
- Differently: PASTE's gate must be supervised against explicit write labels; Titans' gate is trained only through LM loss.

#### ATLAS (Behrouz et al., 2025; arXiv 2505.23735) [V]
- Problem solved: three issues of recurrent memories: limited capacity, online updates that optimise only the last token, inflexible fixed-size memory management [V].
- Computational cost: memory optimised over a window of current and past tokens (Omega rule) [S]; "DeepTransformers" generalise attention [V].
- Memory mechanism: sliding-window objective over past tokens with polynomial feature maps and higher-order optimiser [S].
- Limitations: abstract gives only "+80 %" accuracy at 10M tokens on BABILong without stating the baseline [V].
- Useful for PASTE: argues that per-token online updates are myopic; supports segment-level (not token-level) write decisions.
- Differently: PASTE decides per segment against an explicit store.

#### BABILong (Kuratov et al., 2024; NeurIPS 2024 D&B, arXiv 2406.10149) [V]
- Problem solved: benchmark of 20 bAbI-style reasoning tasks hidden in long distractor text, up to 10M tokens.
- Key results: popular LLMs "effectively utilize only 10-20 % of the context"; RAG reaches about 60 % on single-fact QA regardless of length [V]. RMT and ARMT on GPT-2 (137M) and Mamba (130M) were fine-tuned with curricula (RMT 1→32 segments of 512 tokens, 16 memory tokens; ARMT 10 memory tokens) and trained on at most 16K tokens, yet evaluated to 11.1M (RMT) and 50M (ARMT) tokens; they "outperform GPT-4 significantly" [V]. Mamba-130M "has an edge in complex tasks such as remembering a large number of facts in QA3" but inference beyond 128K was "extremely slow" in their implementation [V].
- Useful for PASTE: the best evidence that ≤150M-parameter recurrent memory works, when supervised end to end on the task, with a segment curriculum (each stage samples 1..n segments) [V].
- Differently: BABILong facts are injected into irrelevant text; PASTE's segments are all relevant dialogue and the target is store operations, not answers.

### 2. Linear attention, fast weights and state-space models

Common frame (used below): a matrix state S_t ∈ R^{d_v×d_k} per head, read as o_t = S_t q_t. Vanilla linear attention: S_t = S_{t-1} + v_t k_tᵀ. Cost is O(d_k·d_v) per token per head, constant in L, versus O(L·d) per token for softmax attention with a KV cache. The models differ only in the transition applied to S_{t-1} (decay, gate, erase) and in the write strength.

#### Fast weights (Ba et al., 2016; arXiv 1610.06258) [V]
- Problem solved: storing "temporary memories of the recent past" without keeping copies of activity patterns [V].
- Cost: one d×d fast-weight matrix, updated per step.
- Mechanism: A(t) = λA(t−1) + η h(t)h(t)ᵀ (scalar decay λ) [U for equation].
- Limitations: scalar decay forgets everything at the same rate [U].
- Useful for PASTE: the original argument for a third timescale (activity / fast weights / slow weights) maps onto PASTE's temporary state vs persistent store vs encoder weights.
- Differently: PASTE's slowest "fast" timescale is an external store, not a matrix.

#### Linear Transformers are Secretly Fast Weight Programmers (Schlag et al., 2021; arXiv 2102.11174) [V]
- Problem solved: linear attention = 1990s fast-weight programmers; its purely additive update has "limited memory capacity" [V].
- Mechanism: delta rule, S_t = S_{t-1} + β_t (v_t − S_{t-1}k_t) k_tᵀ, so a new value replaces the old one stored under the same key [V for "delta-rule-style update ... correct existing key-to-value mappings"].
- Limitations: sequential update was slow to train until Yang et al. 2024 [V, 2406.06484].
- Useful for PASTE: the delta rule is the neural analogue of UPDATE (overwrite under the same key) versus WRITE (add new key); the error term v_t − S k_t is a natural "is this already stored?" signal.
- Differently: PASTE must make UPDATE explicit and auditable; identity is decided by key similarity, which conflates identity with surface similarity unless keys are trained for identity.

#### Transformers are RNNs (Katharopoulos et al., 2020; ICML 2020, arXiv 2006.16236) [V]
- Problem solved: O(N) attention via kernel feature maps; "up to 4000x faster" autoregressive prediction [V].
- Mechanism: S_t = S_{t-1} + φ(k_t)v_tᵀ, z_t = z_{t-1} + φ(k_t) [U for equation].
- Limitations: no forgetting; capacity bounded by feature dimension (shown by Schlag 2021 and Zoology) [V, 2102.11174].
- Useful/Differently: baseline formulation only.

#### RetNet (Sun et al., 2023; arXiv 2307.08621) [V]
- Problem solved: parallel training, O(1) inference, chunkwise recurrent mode [V].
- Mechanism: S_t = γ S_{t-1} + k_tᵀv_t with fixed per-head decay γ [U for equation].
- Limitations: data-independent decay cannot choose what to keep [U, argued by GLA/Mamba papers].
- Useful for PASTE: the chunkwise mode (parallel inside a chunk, recurrent across chunks) is the right compute pattern for segment-by-segment processing.

#### Gated Linear Attention, GLA (Yang et al., 2023; arXiv 2312.06635) [V]
- Problem solved: data-dependent gates for linear attention, with an I/O-aware kernel faster than FlashAttention-2 "even on short sequence lengths (e.g., 1K)" [V].
- Mechanism: S_t = diag(α_t) S_{t-1} + k_tᵀv_t with α_t from the input [U for equation].
- Evidence: trained on 2K, generalises to >20K without significant perplexity loss [V].
- Useful for PASTE: per-channel, input-dependent decay is the standard way to implement retention.

#### Mamba (Gu & Dao, 2023; arXiv 2312.00752) and Mamba-2 (Dao & Gu, 2024; ICML 2024, arXiv 2405.21060) [V]
- Problem solved: selective SSMs whose parameters depend on the input, so they "selectively propagate or forget information based on the current token" [V]; Mamba-2's SSD layer is 2-8× faster [V].
- Cost: state of size N per channel (Mamba-2: scalar-times-identity transition per head); ~5× higher inference throughput than Transformers [V].
- Mechanism (Mamba-2): S_t = a_t S_{t-1} + B_t x_tᵀ with scalar a_t = exp(Δ_t A) [U for equation].
- Limitations: Gated DeltaNet's S-NIAH results at 1.3B show Mamba2 at 30.4 % on S-NIAH-1 at 8K vs 99.2 % at 1K [V, 2412.06464]: decay without targeted erasure loses needles with length.
- Evidence at ≤150M: Mamba-130M fine-tuned on BABILong matches RMT on QA1 and does better on many-fact QA3 [V, 2406.10149].
- Useful for PASTE: selection = input-dependent write gate; a viable temporary-state carrier at small scale.
- Differently: Mamba's state is per-channel and has no notion of records.

#### DeltaNet, parallel training (Yang et al., 2024; arXiv 2406.06484, NeurIPS 2024 [S]) [V]
- Problem solved: parallelise the delta rule over sequence length via compact Householder-product representation [V].
- Evidence: 1.3B on 100B tokens beats Mamba and GLA on perplexity and zero-shot tasks; hybrids with sliding-window or two global attention layers beat Transformer baselines [V]. Motivation: linear models "still lag transformers on in-context retrieval" [V].
- Mechanism: S_t = S_{t-1}(I − β_t k_t k_tᵀ) + β_t v_t k_tᵀ [V via Gated DeltaNet Eq. 10 with α_t = 1].
- Useful for PASTE: shows that targeted overwrite (UPDATE) is what improves recall.

#### Gated DeltaNet (Yang, Kautz, Hatamizadeh, 2024; ICLR 2025, arXiv 2412.06464) [V]
- Problem solved: combine gating ("rapid memory erasure") with the delta rule ("targeted updates") [V].
- Mechanism [V]: S_t = S_{t-1}(α_t(I − β_t k_t k_tᵀ)) + β_t v_t k_tᵀ; α_t ∈ (0,1) data-dependent decay, β_t writing strength.
- Evidence [V, 1.3B/100B tokens]: S-NIAH-2 at 4K: DeltaNet 18.6, Mamba2 56.2, Gated DeltaNet 92.2; recall-intensive average (2K truncation) Mamba2 29.8, DeltaNet 26.2, Gated DeltaNet 30.6, all far below Transformer-level recall [V for numbers; Transformer comparison U].
- Limitations: no ≤150M results located; recall-intensive tasks remain weak.
- Useful for PASTE: the clearest decomposition of retention into (α_t: forget everything a bit) and (β_t, k_t: overwrite one association). These map to FORGET-like decay and UPDATE-like replacement.
- Differently: PASTE needs these as discrete, logged operations on records.

#### RWKV-7 "Goose" (Peng et al., 2025; arXiv 2503.14456) [S]
- Problem solved: generalised delta rule with vector-valued gating, in-context learning rates, relaxed value replacement, and separate removal and addition keys [S, abstract via search].
- Claims: can perform state tracking and recognise all regular languages [S]; models 0.19-2.9B on 1.6-5.6T tokens, Apache-2.0 [S].
- Useful for PASTE: decoupled remove-key vs add-key is the neural analogue of "FORGET record A, WRITE record B" in one step; 190M checkpoint is near PASTE's scale [S].

#### xLSTM (Beck et al., 2024; arXiv 2405.04517) [V]
- Problem solved: revive LSTMs with exponential gating; sLSTM (scalar memory, memory mixing) and mLSTM (matrix memory, covariance update, fully parallel) [V].
- Mechanism (mLSTM): C_t = f_t C_{t-1} + i_t v_t k_tᵀ with exponential input gate i_t and normaliser [U for equation].
- Limitations: abstract has no numbers [V].
- Useful for PASTE: exponential input gating lets one write dominate old state; a precedent for a sharp write gate.

#### Test-Time Training layers, TTT (Sun et al., 2024; arXiv 2407.04620) [V]
- Problem solved: hidden state is a model (linear or 2-layer MLP) trained by a self-supervised step per token [V].
- Evidence: 125M-1.3B; TTT keeps reducing perplexity with longer context like a Transformer, whereas "Mamba stops improving after 16k context" [V]; TTT-MLP has memory I/O challenges [V].
- Useful for PASTE: TTT/Titans/ATLAS show that "memory = online regression from keys to values"; PASTE's store is the discrete, inspectable version of this.

#### Longhorn (Liu et al., 2024; arXiv 2407.14207) [V]
- Problem solved: derive SSM recurrences from online-learning objectives; update resembles the closed-form solution to online associative recall [V].
- Evidence: 1.8× sample efficiency vs Mamba; extrapolates to 16× longer contexts [V].
- Useful for PASTE: the "state = online learner" view gives a principled write strength (β_t from the objective) rather than a free gate.

#### DeltaProduct (Siems et al., 2025; NeurIPS 2025, arXiv 2502.10297) [V]
- Problem solved: n_h delta steps per token → diagonal-plus-rank-n_h transitions; better state tracking and length extrapolation than DeltaNet [V].
- Useful for PASTE: more than one write per step is analogous to one segment proposing several store operations.

#### Kimi Linear / Kimi Delta Attention (Kimi Team, 2025; arXiv 2510.26692) [V]
- Problem solved: KDA "extends Gated DeltaNet with a finer-grained gating mechanism" (channel-wise rather than per-head scalar decay) [V; channel-wise detail S].
- Evidence: 3B activated / 48B total, KDA:MLA hybrid at 3:1 [S for ratio], outperforms full MLA "under an identical training recipe", up to 75 % less KV cache and up to 6× decoding throughput at 1M context [V].
- Useful for PASTE: industrial confirmation that the best recurrent layers still need some full-attention layers for retrieval.

#### Log-Linear Attention (Guo et al., 2025; arXiv 2506.04761; ICLR 2026 per conference listing [S]) [V]
- Problem solved: replace the fixed-size state with a logarithmically growing set of states (Fenwick-tree buckets) [V].
- Cost: O(T log T) training compute; O(log T) states at decoding [S].
- Evidence: log-linear Mamba-2 and Gated DeltaNet improve over linear versions [V]; a gap to Transformers remains on many tasks [S].
- Useful for PASTE: middle ground between fixed state and full history: a few multi-resolution summaries of past segments.

#### Modern Hopfield networks (Ramsauer et al., 2020; arXiv 2008.02217) [V]
- Problem solved: continuous Hopfield networks storing exponentially many patterns (in dimension), retrieval in one update, update rule equivalent to attention [V].
- Limitations: metastable states "average over a subset of patterns" [V], i.e. similar patterns blur together.
- Useful for PASTE: theory for record addressing by attention over stored record embeddings; metastable averaging is exactly the identity-vs-similarity failure PASTE must avoid (two similar records retrieved as a blend).
- Differently: PASTE needs a sharp "match / no match" decision, e.g. a calibrated threshold or a NEW-record option in the softmax.

### 3. Recall limits of fixed-size state

#### Zoology / MQAR (Arora et al., 2023; arXiv 2312.04927) [V]
- Finding: across 17 pretrained models, ~82 % of the perplexity gap between gated convolutions and attention is associative recall; a 70M attention model beats a 1.4B gated-convolution model on recall; hybrids with input-dependent sparse attention close 97.4 % of the gap [V].
- Useful for PASTE: MQAR is the right synthetic probe for "can the temporary state recall what was said N segments ago"; the 70M-vs-1.4B result says attention over explicit items beats state size at PASTE's scale.
- Differently: PASTE should keep identity lookups in attention over records, not in a recurrent state.

#### Based (Arora et al., 2024; arXiv 2402.18668) [V]
- Finding: a recall-vs-state-size trade-off; H3, Mamba, RWKV "struggle at recall"; Based (linear attention + sliding window) moves along a Pareto frontier, +6.22 recall points over Mamba at matched perplexity, 24× throughput vs FlashAttention-2 for 1,024 generated tokens at 1.3B [V]. The paper lower-bounds the recurrent state needed for associative recall (Sec. 3.2) [S].
- Useful for PASTE: sliding-window exact attention + small linear state is the cheap design for "recent turns exact, older context compressed".

#### Repeat After Me (Jelassi et al., 2024; arXiv 2402.01032) [V]
- Finding: a two-layer Transformer can copy strings of exponential length; fixed-state GSSMs cannot; pretrained Transformers beat SSMs at copying and retrieval [V].
- Useful for PASTE: copying record values verbatim (names, dates) must go through attention to text, not through state.

#### RNNs are not Transformers (Yet) (Wen et al., 2024; arXiv 2402.18510) [V]
- Finding: RNNs cannot reliably retrieve from context even with chain of thought; adding retrieval (RAG) or one Transformer layer closes the representational gap [V].
- Useful for PASTE: theoretical backing for "recurrent state + explicit retrieval over the store" as the minimal complete design.

#### 2025-2026 theory and analysis
- Test-time regression framework (Wang et al., JMLR vol. 27, 2025): linear attention's state of D_v×D_k numbers "can only store a bounded amount of information" [S, search snippet of JMLR PDF].
- Any recurrent model needs Ω(N) bits for exact associative recall, attributed to Arora et al. 2025 by a 2026 paper [U: original not retrieved].
- **Recall Scaling Laws in Mamba** (Koren et al., 2026-09-07; arXiv 2609.07681) [V]: Mamba implements recall via implicitly learned linear hash functions; a JL-style theory predicts the embedding/state dimension needed for perfect recall given vocabulary size and number of facts. Useful for sizing PASTE's temporary state at 20-50M parameters.
- **Anatomy of Associative Recall in Fixed-State Recurrences** (Boesch & Wee, 2026-09-14; arXiv 2609.16183) [V]: at a fixed state budget, a short causal convolution contributes ~+0.5 recall; rank-1 delta vs diagonal transition matters (+0.19/+0.32 at 16/32 pairs) only without convolution (+0.03 with); cells that solve 32-pair recall fall to chance when retrieving 4 pairs from a distractor haystack, attributed to "interference under sparse supervision rather than capacity"; a distance curriculum raises recall from 0.021 to 1.000; bidirectional denoiser cells show no advantage over causal training [V]. Directly relevant to PASTE: training difficulty, not capacity, may dominate at small scale, and curricula gated on measured accuracy lock in (6/6 seeds at L=512) [V].
- **HOLA: A Hippocampus for Linear Attention** (Cui, 2026-07-02; arXiv 2607.02303) [V]: delta-rule state plus a bounded exact KV cache admitting tokens with large β·||e|| (write strength × prediction residual), no learned eviction; at 340M/15B tokens Wikitext ppl 27.32 → 22.92, below a Transformer++ at 26.88; best linear NIAH recall to 32K [V]. Closest neural analogue of PASTE's design: a compressed state plus an exact store whose admission is decided by a surprise-like signal. PASTE's difference: the exact store holds text records and admission is a supervised, auditable gate.

**What fixed-size state retains well vs poorly (synthesis of the above).** Retains well: smooth, frequently reinforced, low-cardinality information (topic, style, recent dialogue act, a handful of key-value pairs within capacity); state-tracking of regular-language-like structure (RWKV-7, DeltaProduct) [V/S]. Retains poorly: many distinct key-value bindings beyond ~d_k (interference), verbatim strings (Repeat After Me), items far in the past under decay (Mamba2 S-NIAH 8K) [V], and near-duplicate keys (Hopfield metastable averaging) [V]. Gating (α_t) implements graceful forgetting of everything; the delta rule (β_t, k_t) implements targeted overwrite; neither gives exact identity.

### 4. Hybrids and the Forgetting Transformer

#### Jamba (Lieber et al., 2024; arXiv 2403.19887) [V]
- Interleaves Transformer and Mamba blocks with MoE; fits a single 80GB GPU; strong results up to 256K context; weights under a permissive licence [V]. Layer ratio not in abstract (1 attention : 7 Mamba per block is commonly cited) [U].
- Useful for PASTE: a few attention layers carry recall; most layers can be recurrent.

#### Samba (Ren et al., 2024; ICLR 2025, arXiv 2406.07522) [V]
- Mamba + sliding-window attention, 3.8B on 3.2T tokens; pretrained at 4K, perplexity improves to 1M; fine-tuned at 4K, perfect passkey recall to 256K; 3.73× throughput vs GQA Transformers at 128K prompts [V].
- Useful for PASTE: SWA handles exact local recall; the recurrent part carries gist across windows; passkey is a single item, so this does not show multi-record recall.

#### Griffin / Hawk (De et al., 2024; arXiv 2402.19427) [V]
- Gated linear recurrences (Hawk) and their hybrid with local attention (Griffin); Griffin matches Llama-2 with >6× fewer training tokens; scaled to 14B [V]. The recurrent unit (RG-LRU) uses an input-dependent recurrence gate [U, not in abstract].
- Useful for PASTE: shows local attention + gated recurrence is a strong default at all scales.

#### Forgetting Transformer, FoX (Lin et al., 2025; ICLR 2025, arXiv 2503.02130) [V]
- Mechanism: data-dependent forget gate that down-weights unnormalised attention scores: score_ij += Σ_{l=j+1..i} log f_l, with f_t = σ(w_fᵀx_t + b_f) [U for formula; mechanism V].
- Evidence: beats Transformer on long-context LM, length extrapolation and short-context tasks; on par on long-context downstream tasks; keeps the Transformer's NIAH advantage over Mamba-2, HGRN2, DeltaNet; FlashAttention-compatible, no positional embeddings needed [V].
- Useful for PASTE: the cleanest way to add learned decay while keeping exact attention: decay biases attention but never destroys stored items. For PASTE this is the right model for recency weighting over store records (stale vs fresh) without deleting them.
- Differently: FoX's gate is per-token; PASTE would put a forget bias per record (age, last-confirmed time).

### 5. 2025-2026 segment-recurrent or memory-token work on encoders

- **Diagonal Batching** (Sivtsov et al., 2025; arXiv 2506.05229) [V]: schedules RMT/ARMT computation in parallel across segments while preserving exact recurrence; on a LLaMA-1B ARMT, 3.3× faster than full-attention LLaMA-1B and 1.8× faster than sequential RMT at 131,072 tokens [V]. Removes the main inference-time cost of RMT-style segment recurrence; training still needs BPTT.
- **Encoder-specific memory-token work, 2025-2026**: targeted searches (RMT + ModernBERT, memory tokens + dialogue state tracking + BERT) found **no 2025-2026 paper applying segment recurrence or memory tokens to a bidirectional encoder** [S: absence in search results; not proof of absence]. The newest direct precedent remains RMT on BERT (2304.11062). ModernBERT supports 8,192 tokens natively [S], which weakens the need for recurrence on inputs under ~8K.
- **Anatomy of Associative Recall** (2609.16183, above) reports that bidirectional denoiser cells show "no measurable advantage over causal training" on recall [V]: weak evidence that bidirectionality does not by itself help memory formation.
- Closest neighbouring work is in DST: SOM-DST feeds the previous state as text into BERT and predicts a per-slot operation (prior bibliography, not re-verified here) [U]. This is architecturally the PASTE baseline, not PASTE.

### 6. Emphasis points

**Evidence at ≤150M parameters.** RMT/ARMT on GPT-2 137M and Mamba-130M on BABILong (task-specific fine-tuning, curricula) [V]; RMT on BERT-base (~110M [U]) for synthetic memorisation to ~2M tokens [V]; Pythia-70m in RMT parameter-efficiency experiments [V]; Zoology's 70M attention model beating a 1.4B gated convolution on recall [V]; TTT at 125M [V]; RWKV-7 at 190M [S]; HF Infini-attention reproduction at 200M failed [V]. Titans reports 170M only in an ablation figure [V]; Gated DeltaNet and DeltaNet headline results are at 1.3B [V]. No located work evaluates a recurrent memory at ≤150M on conversational data.

**Cost against full attention.** Recurrent/linear layers cost O(d_k·d_v) per token per head, independent of history; RMT reports up to ×295 fewer FLOPs at ~2M tokens [V]; Based 24× generation throughput at 1.3B [V]; Samba 3.73× at 128K [V]; Kimi Linear 6× decoding at 1M [V]. All gains are at long contexts. At ≤8K tokens on CPU with a 20-50M encoder, full attention over the segment plus rendered records is cheap; savings matter only when history must not be re-read each step.

**Training difficulty.** RMT: instabilities with large memory and deep BPTT; GPU memory grows with unroll [V]; without curriculum, training directly on 4 segments fails (BERT) [V]; BABILong uses curricula sampling 1..n segments per stage [V]. Infini-attention: gates stuck near 0.5, NaNs at 200M, retrieval from earlier segments failed at 8B [V]. Anatomy of AR: distance curriculum lifts recall 0.021 → 1.000; uniform curricula collapse at longer lengths unless gated on measured accuracy; failures are interference under sparse supervision, not capacity [V]. CCM and Diagonal Batching show recursion can be trained or run in parallel [S/V].

### Cross-cutting observations

1. Every mechanism PASTE needs for temporary cross-segment state exists and has been put on a pretrained BERT (RMT, 2304.11062). Novelty cannot rest on the recurrence itself [V].
2. Fixed-size state is consistently weak at exactly what PASTE's addressing needs: many distinct bindings, verbatim values, and near-duplicate keys (Zoology, Based, Repeat After Me, Wen et al., Hopfield metastable states) [V]. Identity decisions should therefore be made by attention over explicit record representations, with recurrent state used only for dialogue context.
3. Retention has two separable knobs in modern layers: global decay α_t (gating) and targeted overwrite β_t k_tᵀ (delta rule) [V, Gated DeltaNet]. These map onto FORGET/decay and UPDATE. FoX shows decay can bias attention without deleting items [V], which matches an auditable store better than state overwriting.
4. The strongest recurrent results are task-specific, end-to-end supervised, at long lengths, with curricula. Training failures (Infini-attention reproduction, RMT instabilities, interference walls) are common and can hide behind decreasing loss [V]. PASTE needs direct per-operation evaluation from the first epoch.
5. Cost advantages appear only at very long contexts. For short segments, the text-rendered baseline is unlikely to be compute-bound [I].
6. HOLA (2026) is the closest architectural analogue: compressed state plus an exact store gated by a residual-based admission signal [V]. PASTE's distinguishing element would be a supervised, auditable write gate over text records, a claim that requires the comparison against the rendered-records baseline.

### Sources

arXiv abstract pages (https://arxiv.org/abs/<id>) read in this task: 1901.02860, 1911.05507, 2207.06881 (+HTML), 2304.11062 (+v1, +HTML), 2407.04841, 2203.07852, 2405.06067, 2203.08913, 2404.07143, 2305.14788, 2304.08467, 2307.06945, 2405.13792, 2402.04624, 2502.00592, 2502.06049, 2501.00663 (+HTML), 2505.23735, 2406.10149 (+HTML), 1610.06258, 2102.11174, 2006.16236, 2307.08621, 2312.06635, 2312.00752, 2405.21060, 2406.06484, 2412.06464 (+HTML), 2405.04517, 2407.04620, 2407.14207, 2502.10297, 2510.26692, 2506.04761, 2008.02217, 2312.04927, 2402.18668, 2402.01032, 2402.18510, 2609.16183, 2607.02303, 2609.07681, 2403.19887, 2406.07522, 2402.19427, 2503.02130, 2506.05229.

Other primary sources: Hugging Face blog "A failed experiment: Infini-Attention, and why we should keep trying?" (https://huggingface.co/blog/infini-attention, 2024-08-14).

Secondary (search results only): CCM 2312.03414 (ICLR 2024 poster page); RWKV-7 2503.14456 (arXiv/EleutherAI listing snippets); Kimi Linear 3:1 ratio; log-linear attention cost and ICLR 2026 acceptance (iclr.cc, mlanthology); Wang et al. test-time regression (JMLR vol. 27); Arora et al. 2025 Ω(N)-bit bound (cited secondhand, original not retrieved).

# Part IV

## D. Conversational memory systems, controllers, benchmarks and dataset licences (2023-2026)

Date of search: 2026-11-01. Scope: systems that maintain an explicit memory for a conversational agent, the operations they use, how they decide identity and duplicates, measured failure modes, and the benchmarks/datasets usable to train or evaluate PASTE.

Tags: **[V]** verified in the primary source during this task (arXiv abstract/HTML, Hugging Face dataset card, GitHub LICENSE); **[S]** secondary source read during this task; **[U]** unverified. Licence strings are quoted verbatim only when seen in the card or LICENSE file.

### 1. Memory systems (LLM-orchestrated)

#### MemoryBank (Zhong et al., 2023; arXiv 2305.10250) [V]
- Problem solved: long-term memory and user-personality adaptation for a companion chatbot (SiliconFriend) [V].
- Operation vocabulary: store dialogue + summaries; retrieve; strengthen/weaken memories over time [V]. No explicit UPDATE/DELETE of contradicted facts [U].
- Identity/duplicates: none described; retrieval by dense similarity [U].
- Retention: "inspired by the Ebbinghaus Forgetting Curve"; memories are strengthened or weakened by elapsed time and significance [V]; recall resets strength [U].
- Failure modes measured: only qualitative and simulated-user evaluation [V].
- Model sizes: ChatGPT and ChatGLM (6B [U]) [V].
- Useful for PASTE: a hand-designed retention rule; a baseline for learned forgetting.
- Differently: PASTE's FORGET must be explicit and logged, not silent decay.

#### MemGPT / Letta (Packer et al., 2023; arXiv 2310.08560) [V]
- Problem solved: "virtual context management" with fast/slow memory tiers, interrupts and function calls [V].
- Operation vocabulary: LLM function calls to edit core memory (append/replace) and to search/insert into archival and recall storage [U for exact function names; tiered memory V].
- Identity/duplicates: left to the LLM's in-context judgement [U].
- Failure modes measured: evaluated on document QA beyond the window and multi-session chat [V]; Zep reports MemGPT 93.4 % vs Zep 94.8 % on DMR [V, 2501.13956].
- Model sizes: GPT-4-class models [U].
- Useful for PASTE: the "editable core memory block" is an auditable store the agent rewrites.
- Differently: PASTE replaces free-form function calls with a closed operation set predicted by a small encoder.

#### Generative Agents memory stream (Park et al., 2023; arXiv 2304.03442) [V]
- Problem solved: believable agents storing "a complete record of the agent's experiences using natural language", synthesising reflections and retrieving to plan [V].
- Operation vocabulary: append observation; reflect (write higher-level memory); retrieve. Retrieval scores recency (exponential decay), importance (LLM-rated 1-10) and relevance [U: not on abstract page].
- Identity/duplicates: none; everything is appended.
- Failure modes: ablation shows observation, planning and reflection each contribute to believability [V]; no memory-accuracy metrics.
- Useful for PASTE: importance score = a write gate; recency × importance × relevance is a transparent retrieval baseline.
- Differently: PASTE must deduplicate and update, not append-only.

#### Mem0 and Mem0g (Chhikara et al., 2025; arXiv 2504.19413) [V]
- Problem solved: scalable production memory with a two-phase extract/update pipeline [V].
- Operation vocabulary: ADD (no equivalent memory), UPDATE (complementary info; replace only if more informative), DELETE (contradicted), NOOP [V]. Mem0g: entity/relation graph; conflicting relations are "marked as invalid rather than physically removing them" [V].
- Identity/duplicates: for each candidate fact, retrieve top-s = 10 similar memories by embedding; GPT-4o-mini chooses the operation via a tool call [V]. Mem0g matches entities by embedding similarity above a threshold t (value not given) [V]. The paper both says the LLM decides directly and shows a sequential ClassifyOperation (similarity → contradiction → augmentation) in Algorithm 1 [V].
- Measured results (LoCoMo, LLM judge J): Mem0 66.88, Mem0g 68.44, full context 72.90 [V]; p95 latency 1.44 s vs 17.12 s; ~1.8K vs ~26K context tokens [V]. Stored memory per conversation: Mem0 ~7K tokens, Mem0g ~14K, Zep >600K [V].
- Failure modes (external): HaluMem-Medium update omission 74.02 % (Mem0) and 75.24 % (Mem0-Graph); on HaluMem-Long extraction recall falls to 3.23 % and update omission to 98.51 % [V, 2511.03506].
- Model sizes: GPT-4o-mini [V].
- Useful for PASTE: the operation vocabulary and "retrieve top-s then decide" pipeline are exactly the main baseline's structure. Soft invalidation (Mem0g) is the auditable way to FORGET.
- Differently: PASTE predicts the operation with a 20-50M encoder per record, rather than a GPT-class tool call.

#### A-MEM (Xu et al., 2025; arXiv 2502.12110, NeurIPS 2025 per comments) [V]
- Problem solved: Zettelkasten-style memory with dynamic indexing and linking [V].
- Operation vocabulary: create note (description, keywords, tags), link to similar notes, "memory evolution" that updates attributes of existing notes when new ones arrive [V]. No explicit DELETE [U].
- Identity/duplicates: similarity-based linking rather than merging [V]; duplicates become linked notes [I].
- Failure modes: abstract reports gains over baselines on six foundation models, no error taxonomy [V].
- Useful for PASTE: memory evolution = MERGE/UPDATE of neighbouring records; links are an auditable relation type.
- Differently: PASTE must decide merge vs link explicitly; A-MEM leaves this to the LLM.

#### Zep / Graphiti (Rasmussen et al., 2025; arXiv 2501.13956) [V]
- Problem solved: temporally-aware knowledge graph memory combining conversation and business data [V].
- Operation vocabulary: add episode; extract entities and facts (edges); deduplicate nodes and edges; invalidate edges [V].
- Identity/duplicates [V]: entities extracted from the current message plus last 4; name embedded (1024-d, BGE-m3) and matched by cosine plus full-text search over names and summaries; an LLM then decides duplicates ("duplicate nodes may have different names"). Edge candidates are restricted to the same entity pair; facts are duplicates if they "express the same information". Writes use predefined Cypher, not LLM-generated queries.
- Contradictions [V]: bi-temporal edges (t_created, t_expired, t_valid, t_invalid); an LLM compares a new edge with related edges; on temporal overlap the old edge's t_invalid is set to the new edge's t_valid. History is kept.
- Measured results [V]: DMR 94.8 % vs MemGPT 93.4 %; LongMemEval overall 55.4 → 63.8 % (gpt-4o-mini) and 60.2 → 71.2 % (gpt-4o) vs full context; **knowledge-update fell 76.9 → 74.4 % with gpt-4o-mini**; single-session-assistant fell 81.8 → 75.0 % and 94.6 → 80.4 %.
- External failure measure: HaluMem update omission 52.31 % (Medium), 62.14 % (Long) [V, 2511.03506].
- Model sizes: gpt-4o-mini for graph construction [V].
- Useful for PASTE: the most explicit identity pipeline in the literature (candidate generation → LLM duplicate decision → structured write), and bi-temporal invalidation is a clean audit model for UPDATE/FORGET.
- Differently: PASTE would learn the duplicate decision (identity vs surface similarity) with a cross-encoder over (segment, candidate record) pairs.

### 2. Trained memory controllers and writers

#### Memory-R1 (Yan et al., 2025; arXiv 2508.19828) [V]
- Problem solved: RL-trained memory management instead of heuristic/prompted operations.
- Operation vocabulary: Memory Manager chooses ADD, UPDATE, DELETE, NOOP; Answer Agent selects and reasons over retrieved entries [V].
- Identity/duplicates: the manager sees retrieved related memories and decides; no explicit identity model [V/I].
- Training [V]: outcome reward only (exact match of the frozen Answer Agent's answer); **no operation labels**; LoCoMo split 1:1:8 gives 152 training questions; memory bank built by GPT-4o-mini over a temporal window (24 or 50 turns; paper inconsistent).
- Measured results [V, LoCoMo]: LLaMA-3.1-8B Mem0 F1 30.41 / J 45.68 vs Memory-R1-GRPO 45.02 / 62.74; Qwen-2.5-7B Mem0 J 53.30 vs GRPO 61.51. Evaluated on LoCoMo, MSC, LongMemEval at 3B-14B.
- Failure modes: qualitative only: a vanilla manager "misinterpreted the second adoption as a contradiction", issuing DELETE + ADD and leaving memory "fragmented"; RL manager issued one UPDATE [V].
- Useful for PASTE: shows that UPDATE vs DELETE+ADD confusion is a real failure; outcome reward can train it at ≥3B.
- Differently: at 20-50M, PASTE should use dense per-operation supervision rather than sparse QA reward.

#### Mem-α (Wang et al., 2025; arXiv 2509.25911) [V]
- Problem solved: RL for memory construction; reward = downstream QA accuracy over the full history [V].
- Operation vocabulary: tools over core, episodic and semantic memory components [V] (insert/update/delete per component [U]).
- Evidence: trained only on ≤30K-token instances; generalises to >400K tokens (13×) [V]. Model size not on abstract page (Qwen3-4B reported elsewhere [U]).
- Useful for PASTE: typed memory partitions (core/episodic/semantic) are a natural label space for PASTE's persistent-vs-temporary distinction.

#### MemLoRA (Bini et al., 2025; arXiv 2512.04763) [V]
- Problem solved: on-device memory by distilling separate LoRA adapters for extraction, update and memory-augmented generation [V].
- Operation vocabulary: update adapter outputs ADD, UPDATE, DELETE, NONE; UPDATE includes the old memory text [V].
- Model sizes [V]: Qwen2.5-0.5B/1.5B/3B, Gemma2-2B; teachers Gemma2-27B or GPT-OSS-120B.
- Measured results [V]: Qwen2.5-0.5B on LoCoMo J 11.2 → 26.6 (+138 % relative) with a Gemma2-27B teacher; claims parity with a 60× larger model at its best size.
- Useful for PASTE: the smallest published trained memory writer (0.5B); per-operation specialisation helps.
- Differently: PASTE is ~10-25× smaller still and encoder-only; it classifies rather than generates.

#### MemReader (Kang et al., 2026; arXiv 2604.07877) [V]
- Problem solved: "passive" one-shot extraction fails on noisy dialogue, missing references and cross-turn dependencies [V].
- Operation vocabulary: MemReader-4B (GRPO, ReAct) chooses to write, search history, buffer incomplete inputs, or ignore chatter, after assessing information value, reference ambiguity and completeness [V]. MemReader-0.6B is a distilled structured extractor [V].
- Evidence: LoCoMo, LongMemEval, HaluMem; claims SOTA on knowledge updating, temporal reasoning and hallucination reduction (numbers not on abstract page) [V]. Integrated into MemOS [V].
- Useful for PASTE: **BUFFER/defer is the closest published analogue to PASTE's temporary-state vs persistent-write split**; IGNORE matches PASTE's IGNORE.
- Differently: PASTE would make the buffer a learned recurrent state and the write a gated discrete op.

#### AgeMem (Yu et al., 2026; arXiv 2601.01885, ACL 2026) [V]
- Operation vocabulary: store, retrieve, update, summarise, discard as tool actions, unifying long- and short-term memory inside the policy [V].
- Training: three-stage progressive RL with step-wise GRPO to address sparse, discontinuous rewards [V]. Backbones/benchmarks not named on abstract page [V].
- Useful for PASTE: evidence that memory-operation rewards are sparse enough to need staged training; supports a curriculum for PASTE.

#### MemoryCPT (Lei et al., 2026; arXiv 2608.04843) [V]
- Distils a modular memory-construction pipeline into a compact model (query-agnostic distillation) plus GRPO-trained LoRA summariser under a cost-aware reward; LoCoMo and LongMemEval [V]. Student size and operation set not on abstract page [V]; search snippets describe segmenter / episode generator / episode merger / semantic extractor roles [S].

#### MemoryOS (Kang et al., 2025; arXiv 2506.06326) [V]
- Operation vocabulary: three tiers (short-term, mid-term, long-term persona); short→mid by "dialogue-chain-based FIFO", mid→long by segmented pages [V]; heat-based promotion [U].
- Evidence: +49.11 % F1 and +46.18 % BLEU-1 on LoCoMo over baselines with GPT-4o-mini [V].
- Useful for PASTE: an explicit temporary-to-persistent promotion path, hand-designed.

#### MIRIX (Wang & Chen, 2025; arXiv 2507.07957) [V]
- Operation vocabulary: six memory types (Core, Episodic, Semantic, Procedural, Resource, Knowledge Vault) each managed by an agent [V].
- Evidence: LoCoMo 85.4 %; ScreenshotVQA +35 % over RAG with 99.9 % less storage [V].
- Useful for PASTE: typed routing of writes; the Knowledge Vault separates sensitive data (relevant to an auditable store) [I].

#### Learned forgetting and consolidation (2026)
- **Bemula** (Xie et al., 2026-10-13; arXiv 2610.18052) [V]: 50 multi-session dialogues, 135 forget requests (six types), 1,742 test questions; six mainstream memory systems × three backbones: "no system passes more than 1.5 % of forget requests end to end"; failures are either residual extractability or over-deletion [V]. Dataset licence not stated on abstract page [V].
- **FSFM** (Gu et al., 2026; arXiv 2604.20300) [V]: taxonomy of decay-, deletion-, safety- and reinforcement-based forgetting; reports +8.49 % access efficiency, +29.2 % SNR; whether mechanisms are learned is not stated in the abstract [V].
- AgeMem's "discard" tool is the only RL-trained forgetting action located [V].
- **No trained forgetting model at ≤1B parameters was found** [S: absence in searches].

#### HaluMem as a measurement of failure modes (Chen et al., 2025; arXiv 2511.03506) [V]
Operation-level results [V, Table 3]: on HaluMem-Medium, update omission is Mem0 74.02 %, Mem0-Graph 75.24 %, Memobase 94.25 %, Supermemory 82.47 %, Zep 52.31 %, MemOS 37.48 %; update hallucination <2 % everywhere but few items reach the update stage. On HaluMem-Long, Mem0's extraction recall is 3.23 % and its update omission 98.51 %. The authors attribute omission mainly to extraction ("if pre-update memories are never extracted, related updates cannot be processed") and conclude "the extraction and updating stages lack stable linkage" [V]. **Duplicate rates are not reported** by any system paper or HaluMem [S: not found]. Stale values appear as Zep's knowledge-update drop (76.9 → 74.4 %) [V].

### 3. Benchmarks for conversational memory

Short notes (sources in the table):
- **LongMemEval** (Wu et al., ICLR 2025, 2410.10813) [V]: 500 questions in scalable chat histories; five abilities including **knowledge updates** and abstention; commercial assistants and long-context LLMs drop ~30 %. Zep's knowledge-update score fell vs full context with gpt-4o-mini [V]; Supersede (below) uses its knowledge-update subset.
- **LoCoMo** (Maharana et al., 2024, 2402.17753) [V]: conversations averaging ~300 turns and 9K tokens over up to 35 sessions; QA, event summarisation, multimodal generation. Number of conversations not on abstract page (10 is commonly used [U]). The de facto memory-system leaderboard (Mem0 66.88 J, MIRIX 85.4 %) [V].
- **MSC** (Xu et al., 2021, 2107.07567) [V]: multi-session human chats; ParlAI lists 237k training and 25k validation examples for sessions 1-4 and a 130k-example dialogue-summary task [V]. The summary task (per-session persona extraction) is the closest public data to WRITE labels.
- **Conversation Chronicles** (Jang et al., EMNLP 2023, 2310.13420) [V]: ~1M LLM-generated multi-session dialogues with time intervals and speaker relationships.
- **DialSim** (Kim et al., 2024, 2406.13144) [V]: real-time multi-party dialogue simulator from TV shows (Friends, The Big Bang Theory, The Office per repo options [V]); names anonymised.
- **PersonaMem** (Jiang et al., COLM 2025, 2504.14225) [V]: >180 simulated user histories, up to 60 sessions, 15 tasks; frontier models ~50 % on tracking evolving profiles.
- **MemoryAgentBench** (Hu et al., 2025, 2507.05257) [V]: four competencies: accurate retrieval, test-time learning, long-range understanding, selective forgetting (HF split name "Conflict_Resolution") [V].
- **MemBench** (Tan et al., ACL 2025 Findings, 2506.21605) [V]: factual vs reflective memory, participation vs observation scenarios; effectiveness, efficiency, capacity metrics.
- **PerLTQA** (Du et al., 2024, 2402.16288) [V]: 8,593 questions over 30 characters; memory classification, retrieval, synthesis.
- **HaluMem** (Chen et al., 2025, 2511.03506) [V]: the only benchmark with **operation-level** gold for extraction and updating (~15k memory points, 3.5k questions; Medium ~1.5k turns/user, Long ~2.6k; >1M tokens).

2025-2026 benchmarks/studies on updates and conflicts:
- **Supersede** (Patel, 2026-06-25; 2606.27472) [V]: LongMemEval knowledge-update: full context ~92 % vs bounded self-maintained memory 77 % even for gpt-5.4 (McNemar p<0.005); as conversations grow 24× accuracy falls 68 % → 28 % and more memory budget gives no recovery (n=25); GRPO on Qwen2.5-3B raises held-out supersession accuracy 9.0 → 16.7 % (single run). "Memory maintenance, not comprehension" is the bottleneck [V].
- **Memora** (Uddin et al., ACL 2026 Findings; 2604.20006) [V]: weeks-to-months conversations; FAMA metric penalises use of obsolete memories; "frequent reuse of invalid memories" across 4 LLMs and 6 memory agents [V].
- **TANGLE** (Yang et al., 2026-08-14; 2608.13921) [V]: 541 instances, 40 personas, three irreducible-conflict types; in the pipeline track, "extraction often fails to preserve the conflict-bearing relations" [V].
- **TEPA** (Zhou et al., 2026-08; 2608.07429) [V]: keyed precedents revoked under the same key when contradicted, history kept for audit; under controlled drift append-only and last-write-wins score 0.210, below no memory (0.309), TEPA 0.950 [V]. Evidence that **keyed identity + revocation** beats both append and naive overwrite.
- **Bemula** (Xie et al., 2026-10-13; 2610.18052) [V]: forget-on-request; ≤1.5 % end-to-end pass rate across six systems.

### 4. Benchmarks and candidate source datasets: licences

Commercial-use column: "Yes" = licence text permits it (attribution/share-alike may apply); "No" = NC/ND or research-only; "Unclear" = no licence found. LLM-generated datasets may also carry the generator provider's terms of use, not checked here [U].

| name | year | content | size | memory-operation labels? | licence (verbatim, verified) | commercial use OK? | tag |
|---|---|---|---|---|---|---|---|
| LongMemEval | 2024 | user-assistant chat histories, QA on 5 memory abilities | 500 questions [V] | No op labels; knowledge-update question type [V] | HF card: "mit"; GitHub LICENSE: "MIT License" | Yes | [V] |
| LoCoMo | 2024 | very long multi-session conversations; QA, event summaries | ~300 turns, ~9K tokens, ≤35 sessions per conv. [V] | No | GitHub LICENSE.txt: "Attribution-NonCommercial 4.0 International" | No | [V] |
| MSC (Multi-Session Chat) | 2021 | multi-session human chit-chat + session summaries | 237k train / 25k valid examples (sessions 1-4) [V] | Partial: per-session persona summaries (WRITE-like) | No data licence found; ParlAI code LICENSE: "MIT License" | Unclear | [V] code / [U] data |
| Conversation Chronicles | 2023 | LLM-generated multi-session dialogues with time gaps and relationships | ~1M dialogues [V] | No (summaries [U]) | HF card: "cc-by-4.0" | Yes (provider terms [U]) | [V] |
| DialSim | 2024 | multi-party dialogue from TV-show scripts, real-time QA | >1,300 sessions [V] | No | No licence in GitHub repo or HF cards (jiho283/dialsim-*: none) | Unclear (copyrighted scripts [U]) | [V] |
| PersonaMem | 2025 | simulated user-LLM histories with evolving profiles | >180 histories, ≤60 sessions, 15 tasks [V] | No op labels; profile evolution annotated [U] | GitHub LICENSE: "MIT License"; HF v1 "mit", v2 "cc-by-4.0", v3 "cc-by-nc-4.0" | Yes for v1/v2; No for v3 | [V] |
| MemoryAgentBench | 2025 | incremental multi-turn memory tasks incl. selective forgetting | HF rows: 22 / 6 / 110 / 8 per split [V] | Conflict_Resolution split (fact overwrites), no op labels | HF card: "mit"; GitHub LICENSE: "MIT License" | Yes | [V] |
| MemBench | 2025 | factual/reflective memory, participation/observation | not on abstract page | No [U] | GitHub README badge "LICENSE-MIT" (import-myself/Membench; repo identity [S]) | Yes [S] | [S] |
| PerLTQA | 2024 | personal long-term memory QA (profiles, relations, events, dialogues) | 8,593 questions, 30 characters [V] | Memory-type classification labels [V] | GitHub LICENSE.txt: "Creative Commons Attribution-NonCommercial 4.0 International" | No | [V] |
| HaluMem | 2025 | operation-level memory hallucination benchmark | ~15k memory points, 3.5k questions [V] | **Yes**: gold extraction and update points [V] | HF card: "cc-by-nc-nd-4.0" | No (and no derivatives) | [V] |
| Supersede | 2026 | knowledge-update RL environment and data | n/a | Stale vs current value rewards [V] | Not stated on abstract page (paper CC BY 4.0) | Unclear | [U] |
| Memora | 2026 | weeks-to-months personal conversations | not stated | Invalidated-memory annotations (FAMA) [V] | Not verified for data (paper page CC BY 4.0) | Unclear | [U] |
| TANGLE | 2026 | irreducible memory conflicts | 541 instances, 40 personas [V] | Conflict-type labels [V] | Not stated | Unclear | [U] |
| Bemula | 2026 | forget requests in multi-session dialogues | 50 dialogues, 135 requests, 1,742 questions [V] | Forget-request labels [V] | Not stated on abstract page | Unclear | [U] |
| Synthetic-Persona-Chat | 2023 | LLM-generated persona conversations seeded from Persona-Chat | 20k conversations [V] | Persona attribute sets per user (derivable WRITE targets) [U] | HF card: "cc-by-4.0"; GitHub README: "CC-BY 4.0" | Yes (provider terms [U]) | [V] |
| SODA | 2022 | LLM-distilled social dialogues from commonsense KG | million-scale [V]; HF size 1M-10M [V] | No | HF card: "cc-by-4.0" | Yes (provider terms [U]) | [V] |
| PersonaChat / ConvAI2 | 2018 / 2019 | crowd chit-chat conditioned on persona sentences | ~10.9k dialogues [U] | Persona sentences (static) | No data licence found; ParlAI code "MIT License" | Unclear | [U] |
| DailyDialog | 2017 | human-written everyday dialogues with intent/emotion labels | 11,118 / 1,000 / 1,000 [V] | No | HF card: "cc-by-nc-sa-4.0"; card text: "Dataset provided for research purposes only." | No | [V] |
| Schema-Guided Dialogue | 2019 | multi-domain task dialogues with schemas and per-turn state | >16k dialogues, 16 domains [V] | Per-turn dialogue state (UPDATE derivable) | GitHub LICENSE.txt: "Attribution-ShareAlike 4.0 International"; HF: "cc-by-sa-4.0" | Yes (share-alike) | [V] |
| Taskmaster-1/2/3 | 2019-2020 | spoken and written task dialogues with API/slot annotations | >55,000 dialogues total [V]; TM-1 6,168/770/770 + 5,507 WOZ [V] | Slot annotations (partial) | README: "made available under the Creative Commons Attribution 4.0 License" | Yes | [V] |
| MultiWOZ | 2018 | multi-domain Wizard-of-Oz task dialogues with belief states | ~10k dialogues [V] | Per-turn belief state (UPDATE derivable) | GitHub LICENSE: "The MIT License (MIT)"; HF mirror pfb30/multi_woz_v22: "apache-2.0" | Yes | [V] |
| Topical-Chat | 2019 | knowledge-grounded open-domain chat | 10,784 conversations, 235,281 utterances [V] | No | DATALICENSE: "Community Data License Agreement – Sharing – Version 1.0" | Yes (sharing terms on data) | [V] |

**No public dataset has PASTE's full label set** (WRITE/UPDATE/MERGE/IGNORE/FORGET/RETRIEVE against an explicit store with record identity) [S: none found]. HaluMem is closest but non-commercial and no-derivatives. Commercially usable sources from which operation labels can be derived: SGD and MultiWOZ (state deltas → UPDATE/WRITE/FORGET per slot), Synthetic-Persona-Chat (persona facts → WRITE, with injected changes → UPDATE), Taskmaster, Topical-Chat and SODA (IGNORE-heavy chit-chat negatives), LongMemEval and MemoryAgentBench (evaluation).

Note: the Topical-Chat DATALICENSE file renders its dashes as mis-encoded characters ("Agreement ñ Sharing ñ Version 1.0"); the name is given with the intended dashes above.

### Cross-cutting observations

1. **Operation vocabularies have converged** on ADD/UPDATE/DELETE/NOOP (Mem0, Memory-R1, MemLoRA) [V], plus soft invalidation with history (Mem0g, Zep bi-temporal edges, TEPA revocation) [V]. PASTE's MERGE, IGNORE and RETRIEVE are not standard as operations; MemReader's write/search/buffer/ignore is the nearest match, and its "buffer" is the only published analogue of a temporary-vs-persistent split [V].
2. **Identity is decided by an LLM over top-k similar candidates** in every system (Mem0 s=10; Zep cosine + full-text + LLM dedup prompt) [V]. No system trains a dedicated identity model, and no paper reports duplicate rates [S]. This is a real gap that PASTE's addressing could fill.
3. **The dominant measured failure is omission, not hallucination**: HaluMem update omission is 52-98 % for most systems, driven by missed extraction [V]. Stale values persist: Zep's knowledge-update result fell with gpt-4o-mini; Supersede reports 92 → 77 % with bounded memory; TEPA shows append-only memory scoring below no memory under drift [V]. Forgetting on request almost never works (Bemula ≤1.5 %) [V].
4. **Trained writers stop at 0.5-0.6B** (MemLoRA Qwen2.5-0.5B; MemReader-0.6B) [V]; RL controllers are 3B+ and trained with sparse QA reward [V]. Nothing was found at 20-50M, and no encoder-based writer.
5. **Licences constrain the data plan**: LoCoMo, PerLTQA, HaluMem, DailyDialog and PersonaMem-v3 are non-commercial [V]. LongMemEval, MemoryAgentBench, PersonaMem v1/v2, SGD, MultiWOZ, Taskmaster, Topical-Chat, SODA and Synthetic-Persona-Chat permit commercial use [V], subject to share-alike or sharing terms (SGD, Topical-Chat) and to generator terms for LLM-generated sets [U]. MSC, PersonaChat/ConvAI2 and DialSim have no data licence that was found.
6. Evaluation is mostly end-to-end QA judged by an LLM. Operation-level metrics (HaluMem, FAMA, TEPA) are recent and few, which supports a PASTE evaluation that scores each operation per record.

### Sources

arXiv abstract pages read (https://arxiv.org/abs/<id>): 2305.10250, 2310.08560, 2304.03442, 2504.19413 (+HTML), 2502.12110, 2501.13956 (+HTML), 2508.19828 (+HTML), 2509.25911, 2512.04763 (+HTML), 2511.03506 (+HTML), 2506.06326, 2507.07957, 2604.07877, 2608.04843, 2601.01885, 2610.18052, 2604.20300, 2410.10813, 2402.17753, 2107.07567, 2310.13420, 2406.13144, 2504.14225, 2507.05257, 2506.21605, 2402.16288, 2606.27472, 2604.20006, 2608.13921, 2608.07429, 2312.10007, 2212.10465, 1801.07243, 1710.03957, 1909.05855, 1810.00278.

Licence sources (read during this task):
- Hugging Face dataset API/cards: xiaowu0162/longmemeval, jihyoung/ConversationChronicles, ai-hyz/MemoryAgentBench, google/Synthetic-Persona-Chat, allenai/soda, li2017dailydialog/daily_dialog (README text), google-research-datasets/schema_guided_dstc8, google-research-datasets/taskmaster1, pfb30/multi_woz_v22, IAAR-Shanghai/HaluMem, bowen-upenn/PersonaMem-v1/-v2/-v3, jiho283/dialsim-friends/-bigbang/-theoffice.
- GitHub raw files: snap-research/locomo LICENSE.txt; bowen-upenn/PersonaMem LICENSE; Elvin-Yiming-Du/PerLTQA LICENSE.txt; budzianowski/multiwoz LICENSE; google-research-datasets/dstc8-schema-guided-dialogue LICENSE.txt; xiaowu0162/LongMemEval LICENSE; HUST-AI-HYZ/MemoryAgentBench LICENSE; alexa/Topical-Chat DATALICENSE; google-research-datasets/Taskmaster TM-1-2019, TM-2-2020, TM-3-2020 READMEs; google-research-datasets/Synthetic-Persona-Chat README; import-myself/Membench README; facebookresearch/ParlAI LICENSE and projects/msc/README.md; GitHub pages alexa/Topical-Chat, jiho283/Simulator.

Secondary (search results only): MemoryCPT role names; AgeMem ACL 2026 Anthology listing; PersonaChat/ConvAI2 size.
