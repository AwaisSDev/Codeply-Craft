# PASTE sequential dataset: design

Date 2026-11-02. Branch `research/paste-architecture`. Status: **generator built and validated; 100-episode
pilots generated (programmatic and API); full dataset not generated, pending owner approval.**

Code: `research/paste/data/`. Generated data lives **outside git, in private storage** (owner decision 4);
the repository holds only code, documents and hashes.

## 1. What the data must test

Each episode is one user's conversation, possibly over several sessions, processed one segment at a time.
For every segment the dataset gives everything both PASTE and M1c need, plus the gold answers:

* the Brain's persistent records before the segment;
* the temporary items before the segment;
* the segment text;
* gold units, mentions, targets, relations, persistent operations, temporary operations, expiries,
  retrievals and merges.

Labels come from a **symbolic plan**, never from a language model. A realizer only chooses the wording.

## 2. Sources and licences

| Source | Used for | Licence | Status |
|---|---|---|---|
| Synthetic plans (this generator) | All labels; all synthetic text | Own work | Used |
| Programmatic templates (`data/realize_prog.py`) | Wording, families A/B/C | Own work | Used |
| Claude API wording (`data/realize_api.py`) | Wording of the same plans (pilot) | Output generated on the owner's key; Anthropic's commercial terms apply to outputs | Pilot only, owner decision 2 |
| Topical-Chat rows with nothing to keep, from the frozen DtW split files (read only) | "Irrelevant" real-text segments, no units | CDLA-Sharing-1.0 (`research/dtw/label/NOTICE.md`) | Used; DtW train → PASTE train, val → val, test → test/stress |
| UCI Roman Urdu rows with nothing to keep, same files | Real Roman Urdu distractor segments | CC BY 4.0 | Used, same mapping |
| MultiWOZ rows | — | MIT | **Excluded:** its "I'm planning a trip to Cambridge" rows are labelled nothing-to-keep in DtW but would be temporary plans under PASTE's labels, which contradicts the synthetic labels |
| WildChat and anything derived from it | — | Unresolved | **Excluded** (owner decision 1) |
| LoCoMo, PerLTQA, HaluMem, DailyDialog, PersonaMem v3 | — | Non-commercial or no-derivatives (`LITERATURE-REVIEW.md` §3) | Excluded |
| MSC, PersonaChat/ConvAI2, DialSim | — | No data licence found | Excluded |

## 3. World model

* **Ontology:** `data/ontology.py`, 100 attribute classes, which replace the prototype's placeholders.
  * Each class has a Brain kind (preference, fact, routine, style, decision, idea, requirement, todo), the
    entity types it applies to (user, person, project), and a pool of values.
  * 552 values in total. The last 20 % of every pool (103 values) appears **only in test and stress**.
* **Entities per episode:** the user, 2-5 people (name and role), and 0-2 projects.
* **Name pools** are split 60 / 20 / 20 into train / val / test (stress uses test's pool), so test entities
  are never seen in training.
* **Look-alikes:**
  * same first name, different person: about 50 % of episodes have two people sharing a first name;
  * same attribute and value, different person: the seeded store usually holds a record that duplicates a
    user record under someone else.
* **Merge scenario:** in about 30 % of episodes, one person is stored under two profiles with a duplicated
  record. A later segment reveals they are the same person and adds a new fact about them; that fact is the
  write-gate licence D1 requires.
* **Seeded store:** the Brain holds 3-10 records before the episode starts (15-40 for stress), so addressing
  existing memory is tested from the first segment.

## 4. Episode structure

| | Main splits | Stress |
|---|---|---|
| Sessions | 1-3 | 3-6 |
| Segments per session | 3-6 | 5-10 |
| Gap within a session | 1-12 minutes | same |
| Gap between sessions | 6 hours to 5 days | same |
| Store cap K | 32 | 128 (store-size scaling, H4) |

Each segment:

* 1-3 user events;
* then an assistant turn: an acknowledgement, an answer to a retrieval question, or (12 %) an offer to
  remember something, which creates a PENDING item;
* language: English, Roman Urdu or code-mixed, with a per-episode bias (pilot: 70 % English, 17 % Roman
  Urdu, 13 % mixed).

## 5. Events and gold labels (all 17 categories of the brief, plus PROMOTE)

| Category (brief §6) | Events | Gold |
|---|---|---|
| 1 New information | write, write_implied, project_write | PERSIST → NEW-ATTR(e), or NEW-ENT with a mention; WRITE |
| 2 Repeated information | repeat (paraphrase) | PERSIST → record, SAME; MERGE_INTO (reinforce) |
| 3 Preference changes | change on a preference record (explicit marker) | PERSIST → record, UPDATE |
| 4 Contradictions | contradict: a flat statement of another value, no change marker | PERSIST → record, CONTRADICTION; the Brain challenges and replaces on the 2nd |
| 5 Entity identity matching | alias and pronoun references; same-name look-alikes force full mentions | Mention style recorded; dependency distance for pronouns |
| 6 Similar facts, different entities | lookalike: the same attribute and value for another person | PERSIST → that person (NEW-ATTR / NEW-ENT), **not** the look-alike record |
| 7 Temporary plans | temp_plan (20 plans, 4 test-only) | TEMP → NEW, type PLAN / TASK / CONTEXT, TTL SESSION / UNTIL / OPEN |
| 8 Expired temporary context | temp_done (learned expiry), UNTIL passing, session end, 14-day cap | `expire` labels; deterministic expiries recorded |
| 9 Long-running projects | project_write / project_change across sessions | Records on project entities |
| 10 Memory retrieval | retrieve: a question about a stored fact | `retrieve` labels on records |
| 11 Memory merging | merge_reveal | MERGE(pair) licensed by a PERSIST unit on the pair's profile |
| 12 Memory deletion | forget (one record), forget_profile | FORGET → record / profile |
| 13 Irrelevant conversations | chitchat; real-text distractors (Topical-Chat, UCI) | No units |
| 14 Jokes and hypotheticals | joke, quote, frame_open (FRAME item), frame_cont, frame_close | IGNORE (joking / quoting / hypothetical); a FRAME temporary item carries the hypothetical |
| 15 Corrections | correct (persistent); temp_update (plans) | CORRECTION; T-UPDATE |
| 16 Uncertain information | uncertain ("might", "maybe"); implied statements | IGNORE (hypothetical); PERSIST with certainty implied → tentative |
| 17 Multilingual / Roman Urdu | Any event in Roman Urdu or mixed wording | Same labels |
| PROMOTE (temporary → persistent) | offer (assistant), then confirm or decline | PERSIST with source = PENDING item (PROMOTE), or learned expiry |

Each unit also records its **dependency distance**: how many segments back the context it needs lies (pronoun
antecedent, the plan it updates, the frame it continues, the offer it answers).

## 6. Realizers

* **Programmatic** (`realize_prog.py`):
  * template lists per event and attribute, assigned to **families A/B/C**; train and val use A and B, test
    and stress use all three;
  * typo and lower-case noise is applied only outside labelled spans;
  * pronoun case (subject, object, possessive) is handled.
* **API** (`realize_api.py`):
  * Claude writes the turns from a plain-English description of each beat;
  * every unit must appear as an exact tagged string (free tags only for confirmations and forget phrases);
  * any output whose tags differ from the plan is **rejected**, and counted as a failure, not repaired.

Both realizers produce identical labels for the same plan, so they can be compared directly
(`data/compare.py`).

## 7. Validation (`data/validate.py`; must pass with 0 errors before anything is frozen)

| ID | Check |
|---|---|
| V1 | Spans exact and in bounds; exact units equal their values; no overlapping unit spans |
| V2 | Replaying the gold operations through `paste.brain_sim` reproduces every next store |
| V3 | Replaying the gold temporary operations plus the adapter's deterministic rules reproduces every next temporary state |
| V4 | Targets exist; NEW-ENT entities have no record; PROMOTE sources are PENDING items |
| V5 | Route vs certainty consistent (IGNORE ⇔ joking/hypothetical/quoting; PERSIST ⇔ stated/implied); TEMP units carry type and TTL |
| V6 | Merges are licensed by a PERSIST unit on one of the pair's profiles (D1) |
| L1-L4 | No test-only values in train/val; disjoint names; family C only in test; identical user turns across splits counted |

Generator bugs found and fixed by these checks, or by reading output, during development (`DATASET-AUDIT.md` §2):

* an ontology value rejected by the Brain's secret guard;
* offers and confirmations landing in the same segment;
* NEW-ATTR targets for profiles created later in the same segment (the model reads the segment-start store);
* updates of facts stated in the same segment;
* typos inside mentions;
* pronoun case;
* time updates on open-ended items;
* misfitting project templates;
* the merge keeping the wrong profile's record.

## 8. Proposed full dataset (for approval)

| Split | Episodes | Generator | Use |
|---|---|---|---|
| train | 6,000 | Decided by the pilot comparison (`DATASET-AUDIT.md` §5) | Training |
| val | 600 | Same mix as train | Model selection, calibration, D2 choice |
| test (frozen) | 600 | Both programmatic and API wording of the same 600 plans | Central test; generator-shift analysis |
| stress (frozen) | 200 long episodes | Programmatic + API | Long conversations, large stores, noise |

* **Freezing:** test and stress are generated with their own seeds, hashed into `results/FROZEN.json`
  **before any model is trained**, and stored privately. They are loaded only by `evaluate.py --final`.
* **Power:** the 300-episode test draft has 2,918 gold persistent operations, so 600 episodes give about
  5,800, above the pre-registered 3,000 minimum (spec §10.5).

### Adjustments proposed before full generation

1. **Merge frequency:** 30 % → 60 % of episodes. The test draft has 23 merges; separate merge P/R (D1)
   needs more than 100.
2. **Long-range dependency is rare by design:** test draft distances are 361 at distance 1, 171 at 2-4,
   5 at 5 or more. Natural references (pronouns, "make that 5pm") are short-range. I recommend **not**
   inventing artificial long-range references. H1 is then tested at distances 1-4 only, and the report says
   so.
3. **Generator mix:** decided from the pilot comparison and its cost, `DATASET-AUDIT.md` §5.

## 9. Known limitations

* Synthetic conversations, not Codeply traffic. Real text appears only as "irrelevant" segments (~3 % of
  segments).
* Third-person events stay in English templates even in Roman Urdu segments (programmatic realizer only).
* Segments are short (pilot: mean 34 tokens, p95 55), as chat turns are. The cost difference between PASTE
  and M1c is small in absolute terms on main splits; it is large on stress (`DATASET-AUDIT.md` §3).
* UNTIL times are resolved in UTC by a simple rule-based resolver (spec clarification C7).
* The relation taxonomy separates update and contradiction by the presence of a change marker; the Brain's
  own rule distinguishes them by certainty. PASTE's labels follow the plan.
