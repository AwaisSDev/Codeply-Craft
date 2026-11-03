# WildChat: licensing and privacy issues that are not resolved (task 5)

No legal clearance is assumed. This lists exactly what is open, what was
checked, and what was done that needs no legal judgement. Facts and sources:
`research/dtw/label/audit/WILDCHAT-AUDIT.md`.

The fine-tuned memory model was trained on the frozen realistic train split:
3,315 of its 4,096 examples are excerpts of WildChat-1M (revision
`7d6490e4`, shard `train-00000-of-00014`), the rest MultiWOZ 2.2, Topical-Chat,
UCI Roman Urdu and Claude-written rewrites of WildChat excerpts.

## Open: needs the owner and counsel

| # | Question | Why it is open | What would close it |
|---|---|---|---|
| L1 | May a model trained on WildChat be shipped commercially? | ODC-BY 1.0 allows commercial use of the database (§3.1) and does not restrict "Produced Works"; but it covers the database only, not the users' own text (§2.4), which may carry copyright or data-protection rights | Counsel's view on training on user-written text under ODC-BY + the collection consent ("may be published or shared", "commercial applications") |
| L2 | Attribution duty when the model is "publicly used" | ODC-BY §4.3: publicly using a Produced Work requires a notice; whether a trained model is a Produced Work is not stated | Decide to add the notice anyway (cheap; draft in `MODEL-CARD.md`) or counsel says not needed |
| L3 | ChatGPT-generated assistant turns | WildChat assistant turns are GPT-3.5/4 output; the WildChat-1M card states no OpenAI terms, Ai2's Tulu 3 card says such outputs "are subject to separate terms". Our model reads them as context (input), it is not trained to produce them | Counsel's view on training data that contains another provider's model outputs as inputs |
| L4 | Publishing the derived data | The repository is public; `research/dtw/data/real/` republishes the excerpts. ODC-BY §4.2 and CDLA-Sharing require the same licence and notices (now added: `research/dtw/data/real/NOTICE.md`). Whether to keep the data public at all is a separate choice | Owner: keep public with notices, or move the data to a private location |
| P1 | Personal data in the training inputs | WildChat was de-identified by its publisher (Presidio + rules), and the publisher later removed conversations flagged by PII research; still, the train inputs contain ~10 real-looking e-mail addresses and 4 international phone numbers (0 Pakistani mobile numbers), and the 2,454 de-identified-but-real conversations are personal data under GDPR-style law | Owner/counsel: lawful basis for processing (EU users are in WildChat); whether to scrub the residual contact data before any retraining (technical, cheap) |
| P2 | Removal requests | WildChat-1M has no removal process (WildChat-4.8M does). We can find any user's examples through `source.original_id` | Owner: write the process (who receives requests, how fast, retrain policy) |
| P3 | Data sent to the Anthropic API for labelling | All examples were labelled with Claude via the API | Confirm that this is covered by the API terms in use (commercial terms; no training on API data by default) |
| S1 | Child-safety signals | 0 of our 4,416 WildChat conversations is flagged by OpenAI moderation in any category; 17 have a weak minors-category score (0.1-0.5), ids in `research/dtw/label/audit/moderation-check.json` (14 in train). An open public report says WildChat-1M contains CSAM elsewhere | Owner: review or exclude the 17 (recommended: exclude from any v2 training) |

## Checked and not an issue for the model's behaviour

* **The model cannot write training data into a user's memory.** The
  production guard drops every observation whose value is not grounded in
  the current conversation (verified by the integration suite:
  hallucinated values are never stored). Memorised training text cannot
  reach a user's brain through this path.
* **Labels contain no contact data.** The 11 label matches of the PII
  patterns are dates (4 birth dates), numeric ranges and one company
  website: the model learns to keep users' own birth dates when they state
  them (expected for a memory product), not phone numbers or e-mails.
* **No quasi-identifiers** (hashed IP, location, timestamps, headers) are
  in our files.
* **User overlap between splits** does not inflate the results
  (user-disjoint re-analysis in `research/dtw/LORA-RESULTS.md`).

## Recommendation

Shipping can be prepared technically, but the release should wait for L1,
L3 and P1 (and an owner decision on L4 and S1). If counsel says no, the
fallback is a model trained without WildChat (MultiWOZ, Topical-Chat,
Roman Urdu, synthetic): expected to be weaker, and it would need the full
protocol again.
