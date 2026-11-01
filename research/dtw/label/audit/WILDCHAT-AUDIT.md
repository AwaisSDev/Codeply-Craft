# WildChat provenance, licensing, privacy and contamination audit (2026-11-01)

Owner priority (2026-11-01): WildChat is already in the training split and
natural-300, so its provenance, licence and privacy are audited before any
result built on it is relied on. Not legal advice: this records what the
data and the terms say; the owner (and counsel) decide.

Scripts in this folder reproduce every count (`python -I`, shard downloaded
from Hugging Face at the pinned revision; the shard is not committed):
`wildchat_audit.py` → `wildchat-audit.json`, `user_overlap_ids.py` →
`user-overlap-ids.json`, `moderation_check.py` → `moderation-check.json`.
Outputs hold counts and our own example ids only: no hashed IP, header,
location or conversation text.

## Summary

| Area | Finding | Status |
|---|---|---|
| Provenance | All 4,416 WildChat-derived examples (train 3,315, val 378, test-real 425, natural-300 298; 693 of them Claude rewrites) trace to `allenai/WildChat-1M` revision `7d6490e4…`, shard `train-00000-of-00014.parquet` (SHA-256 verified against Hugging Face), and a conversation present in it | **Clean** |
| Licence | ODC-BY 1.0 (since 2024-06-26, retroactive); no extra terms on the card. Covers the database, not the individual contents (user text) | **Owner/counsel to confirm** derived-data and model-release obligations |
| Quasi-identifiers | None of hashed IP, country, state, timestamp, user-agent or accept-language reaches our files | **Clean** |
| Residual PII | Regex matches in what the models read: e.g. phone-like 91, URL 163, email 10, card-like 20 examples in train (patterns, not confirmed PII; many will be numbers or placeholders) | **Needs manual review** |
| Harmful content | 0 conversations with any OpenAI-moderation flag, 0 sexual flags, 0 Detoxify toxicity > 0.5; 17 with a weak minors-category score (0.1-0.5, no flag) | **17 ids for owner review** |
| Within-data contamination: conversations | 0 conversations in more than one file; every rewrite is in its source's split | **Clean** |
| Within-data contamination: users | The split is by conversation, not user: 64 % of test-real's WildChat examples, 62 % of natural-300's and 63 % of val's come from users who also appear in train (one user contributes 84 examples) | **Real; tested: does not explain the Ettin lead (below)** |
| Pre-training contamination | Ettin: documented data (Table 2, data folders) contains no WildChat. LFM3: training data not disclosed | **Ettin unlikely; LFM3 unknown** |

## Licence (primary sources)

* Card at the pinned revision (identical to `main`, last commit
  2024-10-17): `license: odc-by`; "WildChat is now made available under the
  ODC-BY License… retroactively applied to any previous downloads under the
  ImpACT license." LICENSE.md holds the ODC-By 1.0 text. Before 2024-06-26
  it was AI2 ImpACT (low risk), gated, with an intended-use form.
* No added terms on the card (no gating, no use restrictions, no OpenAI
  clause); citation is requested ("Please consider citing our paper").
* ODC-BY 1.0: commercial use allowed (§3.1). Publicly conveying a derived
  database (our relabelled data) must be under ODC-BY with notices kept
  (§4.2). Publicly using a "Produced Work" needs an attribution notice
  (§4.3); whether a trained model is a Produced Work is not stated.
  **The licence covers the database only**: contents "may be covered by
  other rights, including copyright, … data protection, privacy" (§2.4).
  So the users' own words carry rights ODC-BY does not grant.
* Consent: the collection Space showed a consent screen and a confirm
  dialog ("I agree that my data may be published or shared"); its text
  mentioned "commercial applications".
* `NOTICE.md` in `research/dtw/label/` already attributes WildChat-1M
  under ODC-BY with the revision.

## Privacy

* The publisher de-identified with Presidio + spaCy + custom rules (names,
  phones, emails, cards, URLs; 10 languages) and hashed IPs; it removed
  conversations flagged by later PII research on 2024-10-17 (the pinned
  revision is that day's commit). Independent work found "PII detection
  alone is insufficient" for WildChat (Mireshghallah et al. 2024).
* Codeply's own redaction runs on every example before labelling, and the
  examples were sent to the Anthropic API for labelling.
* What remains in our files is user text only. The residual-pattern counts
  above need a person to review the matched examples (this audit does not
  print them). Labels also contain a few matches (train: 6 phone-like, 1 URL).
* WildChat-1M has no documented removal-request process (the newer
  WildChat-4.8M card has one, via its author). If a user asked for removal,
  we could find their examples through `original_id`.
* An open Hugging Face discussion (#4, 2025-08) reports CSAM in WildChat-1M
  prompts and replies. Our 4,416 conversations: 0 flagged by OpenAI
  moderation in any category, 0 sexual flags; 17 have a minors-category
  score between 0.1 and 0.5 without a flag (ids in `moderation-check.json`,
  14 train, 1 val, 1 test-real, 1 natural-300). Moderation models miss
  things; the conservative option is to exclude those 17 from any future
  training data. This audit did not change the frozen data (owner rule).

## Contamination

**Users across splits.** The frozen split (`sha1('split-v1:'+family)`)
keeps conversations apart but not users. Re-analysis of the existing
test-real results on the 279 examples whose users are not in train (155
WildChat + 124 other sources; 150 gold memories):

| test-real subset | LFM3 production | Ettin-150M (3 seeds) | Ettin-400M s1 |
|---|---|---|---|
| user in train (n = 270) | 0.333 | 0.345 | 0.417 |
| WildChat, user not in train (n = 155) | 0.300 | 0.338 | 0.448 |
| user-disjoint (n = 279) | 0.258 | 0.333 | 0.442 |

Paired bootstrap on the user-disjoint subset: Ettin-400M − LFM3
**+0.102 to +0.272** (95 %), Ettin-150M − LFM3 +0.001 to +0.155. Ettin is
no better on users it has seen than on new ones, so user overlap does not
explain its lead on test-real (one seed for 400M). Future splits should
group by user (hashed IP) as well as conversation; the frozen split is not
regenerated (owner rule), and the user-disjoint subset is reported
alongside test-real from now on.

**Pre-training.** Ettin's documented mixture (paper Table 2; Hugging Face
data folders) has no WildChat; its only instruction source, "Tulu Flan",
predates WildChat (Flan cutoff Feb 2023, collection began April 2023);
the shards themselves were not inspected. LFM3's card names no datasets;
LFM2's SFT mix includes 10.1 % open-source "real-world chats" from
undisclosed sources, which could include WildChat. So if anything, LFM3 is
the model that may have seen these conversations.

## Owner / counsel decisions needed

1. Licence: accept ODC-BY obligations for publishing derived data (same
   licence, notices) and attribution if a model trained on it is publicly
   used; decide on the users' rights in their own text (§2.4).
2. Privacy: review the residual-pattern matches; decide whether to drop or
   re-redact them before any further training.
3. Safety: review or exclude the 17 weak minors-score conversations.
4. Splits: group future splits by user.
5. Removal: decide how a removal request would be handled (`original_id`
   makes it possible).
