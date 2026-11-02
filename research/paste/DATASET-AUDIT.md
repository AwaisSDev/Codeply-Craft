# PASTE dataset audit (pilot)

Date 2026-11-02. Status: **for owner approval.** Covers the 100-episode pilot (programmatic and Claude Opus 5.5
wording of the same plans) and validation-scale drafts (1,000 train, 200 val, 300 test, 50 stress episodes;
not frozen, regenerable).

**Private storage:** pilot and comparison in the private HF dataset `Awais1290/paste-data` (verified private,
SHA256SUMS included). Drafts are regenerable from code and seed, and stay local.

## 1. Summary

| Question | Answer |
|---|---|
| Do the labels stay consistent? | **Yes.** 0 validation errors on 1,650 programmatic episodes and on all 95 valid API episodes (V1-V6) |
| Is there leakage? | **None of facts or entities.** L1 (test-only values in train/val) 0; L2 (shared names) 0; L3 (family C outside test) 0. L4: 38 identical user turns between train and test drafts, all confirmations ("yes please") or temporary plans from the shared pool |
| Are licences clean? | **Yes.** Only synthetic text, plus Topical-Chat (CDLA-Sharing-1.0) and UCI Roman Urdu (CC BY 4.0) rows already audited in DtW; MultiWOZ and WildChat excluded (§4) |
| Is there private data? | **No real personal data.** Names and facts are synthetic. A PII pattern scan (emails, phones, URLs, card numbers) over every pilot and draft segment, including 476 real-text segments, found 0 hits |
| Is every category of the brief covered? | **Yes, all 17 plus PROMOTE** (§3). Merges are thin (adjustment proposed) |
| Is API wording better than templates? | **Yes on diversity and on transfer, at a cost.** Templates teach shortcuts that do not transfer to natural wording (§5) |
| API pilot cost | **$1.87** (batch $1.83 + one $0.04 smoke test), against the approved $8 cap. 95/100 episodes valid |

## 2. Generator bugs found during development (all fixed before the pilot)

Found by the validator or by reading output. Each produced wrong labels, not just odd text.

| # | Bug | Found by | Effect if unfixed |
|---|---|---|---|
| 1 | An ontology value ("email and password") rejected by the Brain's secret guard | Planner assertion | Silent gold-store gaps |
| 2 | Mentions missing for ignored statements about other people | Realizer assertion | Crash, no labels |
| 3 | Seed records had provenance "spurious" instead of their fact id | Reading output | Closed-loop matching broken |
| 4 | Offer and confirmation could fall in the same segment | V4 (7 episodes) | PROMOTE from a non-existent item |
| 5 | Second fact about a new person in the same segment labelled NEW-ATTR | V4 (2 episodes) | The model reads the segment-start store; label impossible to predict |
| 6 | UPDATE of a fact stated earlier in the same segment | Reading output | Implausible scenario |
| 7 | Typo noise inside tagged spans | Reading output | Spans and values diverge |
| 8 | Pronoun case ("for he") | Reading output | Ungrammatical text |
| 9 | Time updates ("make that 5pm") on open-ended items | Reading output | Nonsense updates |
| 10 | Project templates that did not fit some attributes | Reading output | Wrong meaning |
| 11 | Merge could keep the duplicate profile's record | Reading output | Later duplicate writes |

## 3. Episode statistics

| | Pilot (prog.) | Pilot (API) | Test draft | Stress draft |
|---|---|---|---|---|
| Episodes / segments | 100 / 918 | 95 / 849 | 300 / 2,776 | 50 / 1,681 |
| Segments per episode, mean (max) | 9.2 (17) | — | 9.3 (17) | 33.6 (49) |
| Sessions per episode, mean (max) | 2.08 (3) | — | 2.03 (3) | 4.46 (6) |
| Records K, mean (max) | 10.3 (25) | — | 9.9 (24) | 38.6 (73) |
| Temporary items, mean (max) | 0.52 (5) | — | 0.60 (4) | 1.15 (5) |
| Gold persistent ops | 1,010 | 935 | 2,918 | 1,727 |
| Units: PERSIST / TEMP / IGNORE / FORGET | 946 / 281 / 166 / 57 | — | 2,728 / 849 / 535 / 167 | 1,635 / 508 / 341 / 82 |
| Ops: WRITE / UPDATE / MERGE_INTO / FORGET / FORGET_PROFILE / MERGE | 564 / 300 / 82 / 50 / 7 / 7 | — | 1,624 / 856 / 248 / 146 / 21 / 23 | 1,002 / 481 / 152 / 66 / 16 / 10 |
| UPDATE subtypes: change / correction / contradiction | 160 / 77 / 63 | — | 463 / 194 / 199 | 268 / 92 / 121 |
| Promotions | 76 | — | 189 | 140 |
| Languages: en / ur / mixed (segments) | 639 / 155 / 124 | 593 / 140 / 116 | 1,924 / 513 / 339 | 1,223 / 265 / 193 |
| Real-text segments | 27 | 25 | 71 | 43 |
| Episodes with same-name look-alikes | 54 | — | 161 | 24 |
| Dependency distance 1 / 2-4 / ≥5 | 127 / 46 / 0 | — | 361 / 171 / 5 | 242 / 85 / 3 |
| Tokens per segment, mean (p95, max) | 34 (55, 166) | 46 (85, 166) | 33 (55, 181) | 33 (54, 157) |
| PASTE input tokens, mean (p95) | 64 (91) | 76 (116) | 63 (89) | 121 (163) |
| M1c input tokens, estimated mean (p95) | 164 (254) | 175 (264) | 160 (244) | 512 (756) |

**Segments per category** (a segment can count in several):

| Category | Pilot prog. | Pilot API | Test draft |
|---|---|---|---|
| new information | 460 | 424 | 1,359 |
| repeated | 81 | 74 | 242 |
| preference change | 64 | 59 | 184 |
| contradiction | 62 | 60 | 196 |
| identity | 195 | 178 | 640 |
| look-alike | 74 | 66 | 205 |
| temporary plan | 122 | 113 | 391 |
| expired context | 80 | 72 | 266 |
| project | 62 | 55 | 206 |
| retrieval | 83 | 77 | 232 |
| **merge** | **7** | **7** | **23** |
| deletion | 56 | 52 | 166 |
| irrelevant | 87 | 76 | 272 |
| joke / hypothetical | 129 | 121 | 450 |
| correction | 79 | 75 | 209 |
| uncertain | 59 | 55 | 187 |
| multilingual | 279 | 256 | 852 |
| promote | 202 | 185 | 538 |

## 4. Licence and privacy audit

| Item | Finding |
|---|---|
| WildChat | Not read by the generator. The DtW split files are read only for Topical-Chat and UCI rows (`build.py:CLEAN`) |
| Topical-Chat | CDLA-Sharing-1.0: obligations apply when the data is shared; the PASTE dataset is private and not redistributed |
| UCI Roman Urdu | CC BY 4.0: attribution in `DATASET-DESIGN.md` §2 and the private repo README |
| MultiWOZ | Excluded for a label conflict, not a licence problem (DATASET-DESIGN §2) |
| Frozen DtW files | Read only; never modified; checked by `git status` (no changes outside `research/paste/`) |
| API outputs | Generated under the owner's key; Anthropic's commercial terms; stored privately |
| Synthetic names | From fixed pools of common Pakistani first names; no real persons are described |
| PII scan | 0 hits (emails, phone numbers, URLs, 16-digit numbers) over all pilot and draft text |
| Sensitive categories | The ontology includes allergy and blood group (health-adjacent, synthetic values). No religion beyond prayer routine, no sexuality, no finances beyond bank name and project budgets |

## 5. Programmatic vs API wording (owner decision 2)

Same 95 plans, two wordings (`data/compare.py`; results in `pilot-2026-11-02/compare.json`).

| Measure | Programmatic | API (Opus 5.5) |
|---|---|---|
| Vocabulary (user turns with units) | 591 | **1,462** |
| distinct-1 / -2 / -3 | 0.069 / 0.222 / 0.405 | **0.116 / 0.429 / 0.663** |
| Words per user turn | 10.9 | 15.1 |
| gzip ratio (higher = less repetitive) | 0.224 | 0.303 |
| Skeleton reuse (turns repeating once spans are masked) | 14.3 % | 7.9 % |
| Mention-style violations | 0 / 749 | 4 / 749: all Roman Urdu pronouns ("usay", "unko") the checker did not list, so 0 genuine |
| Segments with ontology values outside labelled spans | 0 % | 1.7 % (14). About half are false hits (inside quotes, substrings); the rest are mild unlabelled hints in small talk ("chai pee ke maza aa gaya") |
| Realisation failures | 0 | 5 / 100 (tags duplicated, missing or malformed), rejected, not repaired |

**Shortcut probe.** A bag-of-words naive Bayes on the ±6 words around each unit, trained on 1,000 programmatic
training episodes:

| Probe | Programmatic test | API test (same plans) | Majority baseline |
|---|---|---|---|
| Route (PERSIST / TEMP / IGNORE / FORGET) | 0.967 | **0.603** | 0.651 |
| Relation (SAME / UPDATE / CORRECTION / CONTRADICTION) | 0.908 | **0.440** | — |

**Reading.**

* On template text, words around a unit nearly give the label away. On natural wording of the same plans,
  the same cues fall **below the majority baseline**.
* A model trained on templates alone is likely to learn these shortcuts. This is the DtW lesson (template
  F1 1.000, natural-300 0.015) reproduced at the pilot stage.
* It argues for natural wording in training, and above all in test.
* It does not prove API data is better for training the neural models. That is H6, tested on validation.

**Manual review** of 4 random beats per risky type (change, contradiction, correction, frame continuation,
implied, joke, merge, quote, look-alike, temporary done/update, uncertain): every reviewed realisation
matched its label's meaning. A suspected identity error (two "Sara"s) turned out to be a world with only one
Sara: correct.

## 6. Proposed decisions

1. **Generator mix and budget** (pilot cost per episode: $0.0183 at batch price):

| Option | Train | Val / test / stress | Cost (incl. 5 % retries) |
|---|---|---|---|
| A. All API | 6,000 API | API (test also programmatic) | ≈ $152 |
| **B. Mixed (recommended)** | 3,000 API + 3,000 programmatic | API (test and stress also programmatic) | ≈ $95 |
| C. API for evaluation only | 6,000 programmatic | API | ≈ $37 |

   B keeps the cheap programmatic variety while giving the models natural wording. Test in both wordings
   supports the generator-shift analysis (EVALUATION-PROTOCOL §7). C risks training on shortcuts (§5).
   A spends more for a train-mix question H6 can answer on validation.
   **I will not spend beyond the pilot until you choose.**

2. **Merge frequency** 30 % → 60 % of episodes, to get more than 100 test merges for separate merge P/R (D1).

3. **No artificial long-range references.** H1 is tested at distances 1-4 (DATASET-DESIGN §8.2).

4. **Freeze test and stress** (generation, hashing, private upload) as the first step after approval, before
   any training code runs on data.
