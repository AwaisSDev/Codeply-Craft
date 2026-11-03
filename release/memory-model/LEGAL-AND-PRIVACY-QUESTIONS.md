# Memory model v1: legal and privacy questions before any release

Status 2026-11-03. **No legal clearance is assumed anywhere in this
repository.** This turns the 8 open items of `WILDCHAT-OPEN-ISSUES.md` (L1-L4,
P1-P3, S1) into specific questions, adds two items the review found (B1, the
base model's licence; P3 widened to the labelling terms), and separates
what needs counsel from what we can settle ourselves.

Legend. **Counsel**: needs legal advice; we cannot answer it by engineering.
**Owner**: a business decision for the owner, no legal interpretation
needed. **Technical**: we can resolve or measure it ourselves; status given.

Facts the questions rest on:

* Training data: 4,096 examples; 3,315 are excerpts of WildChat-1M
  (`allenai/WildChat-1M`, revision `7d6490e4`, licence ODC-BY 1.0,
  retroactive since 2024-06-26), the rest MultiWOZ 2.2, Topical-Chat
  (CDLA-Sharing 1.0), UCI Roman Urdu (CC BY 4.0) and Claude-written
  rewrites. Sources: `research/dtw/label/audit/WILDCHAT-AUDIT.md`.
* Every training **label** (the JSON the model learns to write) was
  produced by Claude through the Anthropic API. The loss is on the label
  only; the conversation text is masked input (`ml/finetune/train_lora.py`).
* The base model is LiquidAI LFM3-1.7B under the **LFM Open License v1.0**
  (fetched at the pinned revision `ac2586a3`, LICENSE SHA-256
  `4d28ca14…0068c`). The current production default (`lfm3-1.7b-qad-q4`)
  is the same base family, so B1 already applies to production today.
* The model runs on the user's machine; it reads the user's own
  conversations and writes to the user's local Brain. Nothing is sent to
  Codeply servers by this feature.

## A. Dataset licensing

| # | Question | Kind | Notes |
|---|---|---|---|
| A1 (L1) | Under ODC-BY 1.0, are the fine-tuned weights a **"Produced Work"** (§4.3: public use needs an attribution notice only) or a **"Derivative Database"** (§4.2: public conveyance must itself be under ODC-BY)? | Counsel | Decides whether distributing the weights carries ODC-BY obligations beyond a notice |
| A2 (L2) | If a Produced Work: is the attribution in `MODEL-CARD.md` ("contains information from WildChat-1M, made available under ODC-BY 1.0") a sufficient §4.3 notice, and where must it appear (model card, app's licences screen, download page)? | Counsel (wording) / Technical (placement) | Notice drafted; placement is cheap once counsel says where |
| A3 (L4) | The public repository republishes our relabelled WildChat excerpts (`research/dtw/data/real/`, with `NOTICE.md`). Does that meet ODC-BY §4.2 (same licence, notices kept), and does Topical-Chat's CDLA-Sharing share-alike reach the relabelled files or the model? | Counsel | If in doubt, the owner can move the data out of the public repo (A4) |
| A4 (L4) | Keep the derived data public, or move it to a private location? | Owner: **decided 2026-11-03, keep it out of the public repo** | Done for the current tips of all six branches (private Kaggle copy, `PRIVATE-DATA.md`); git **history** still holds it while the repo is public: owner to make the repo private and/or approve a history purge |

## B. Base model licence (found in this review; applies to production already)

| # | Question | Kind | Notes |
|---|---|---|---|
| B1 | LFM Open License v1.0 §5: commercial use is licensed only while the user's legal entity has **annual revenue under US $10M** ("Threshold"). Is Codeply under it, and what is the plan when it is not (a commercial licence from Liquid AI, or another base)? | Owner + Counsel | Same exposure as the current production model |
| B2 | §4 redistribution: give recipients a copy of the licence; mark modified files as changed; keep notices. Does shipping the merged, quantized weights through a download count as distributing a Derivative Work? | Counsel (interpretation) / Technical (compliance) | Compliance is cheap: ship `LICENSE` and a "modified by Codeply (LoRA fine-tune, merged, quantized)" notice next to the file (`notices/NOTICE.md` drafted) |

## C. Rights in the users' own text and in model outputs

| # | Question | Kind | Notes |
|---|---|---|---|
| C1 (L1) | ODC-BY covers the database, not its contents (§2.4). Do WildChat users hold copyright or other rights in their prompts, and does the collection consent ("I agree that my data may be published or shared", with mention of "commercial applications") license **downstream** users like Codeply to train a commercial model on them? | Counsel | Core open question; the publisher's consent was given to the publisher |
| C2 (L3) | The assistant turns are GPT-3.5/4 outputs. Do OpenAI's terms bind downstream users who never accepted them, given that our model reads those turns only as masked input and is never trained to produce them? | Counsel | Training detail is a fact (loss on our labels only) counsel can rely on |
| C3 (P3) | Every label was written by Claude via the API. Do the **Anthropic terms** under which the API key was used permit (a) sending third-party WildChat text for processing and (b) using Claude's outputs to train a model we ship commercially? Commercial terms restrict using outputs to build competing models; is a small task-specific memory extractor within that restriction? | Counsel | Check the exact terms in force for the account (consumer vs commercial); not assumed either way |

## D. Privacy

| # | Question | Kind | Notes |
|---|---|---|---|
| D1 (P1) | What is our lawful basis (GDPR Art. 6 and equivalents, incl. Pakistan's) for processing de-identified but real conversations of EU and other users for training? Does a legitimate-interests assessment need to be written? | Counsel | WildChat includes EU users; the publisher de-identified (Presidio) and removed flagged conversations, but independent work found residual PII |
| D2 (P1) | Are the trained weights themselves personal data (can training text be extracted from them)? | Counsel, informed by **Technical** evidence | Technical: the production guard drops any value not present in the current conversation, so memorised text cannot reach a user's Brain (verified). A memorisation probe on the residual contact data is possible (planned, T4) |
| D3 (P1) | Residual contact data in training inputs (~10 real-looking e-mails, 4 phone numbers): scrub before any retraining? | **Technical** (for v2) | Cheap; v1 weights cannot be changed without retraining |
| D4 (P2) | Removal requests: who receives them, how fast, and does a request oblige us to retrain (machine unlearning is not practical at this scale)? | Owner + Counsel | Technical side solved: examples are traceable by `source.original_id` |
| D5 | Does an opt-in **private** evaluation (section F of `PRIVATE-OPT-IN.md`) change any answer above? | Counsel | We do not assume it does; it only limits how many people receive the file |

## E. Safety signals

| # | Question | Kind | Notes |
|---|---|---|---|
| E1 (S1) | 17 conversations have a weak minors-category moderation score (0.1-0.5, no flag; 14 in train). Review or exclude? | Owner: **decided 2026-11-03, excluded from v2 until a person reviews them** | `ml/data/v2/EXCLUDE.json` (17 example ids, 13 source conversations; derivatives excluded too: 18 v1 examples match) + `check-exclusions.mjs`. v1 was trained on them; whether that matters for v1 is an owner/counsel call |

## What we can resolve ourselves (status)

| # | Item | Status |
|---|---|---|
| T1 | Attribution text for WildChat, MultiWOZ, Topical-Chat, Roman Urdu, LFM3 | Done: `MODEL-CARD.md`, `research/dtw/data/real/NOTICE.md` |
| T2 | LFM licence copy + "modified" notice to ship with the file | Done: `notices/NOTICE.md` (LICENSE fetched at the pinned revision, checksum recorded) |
| T3 | Memorised training text cannot be written into a user's Brain | Verified (guard grounding; integration suite) |
| T4 | Memorisation probe on the 14 residual contact strings | Not run; cheap (CPU, minutes); evidence for D2 only, not a clearance |
| T5 | v2 data hygiene: scrub residual contact data, drop the 17 E1 ids, split by user | Ready to apply for v2; v1 unchanged (frozen) |
| T6 | Removal lookup by `original_id` | Possible today |
| T7 | Fallback if counsel says no: a model trained without WildChat (MultiWOZ, Topical-Chat, Roman Urdu, synthetic) | Feasible on free Kaggle GPU; expected weaker; needs the full evaluation protocol |

## Suggested minimum per release path (our engineering view, not legal advice)

| Path | Must be answered first |
|---|---|
| Internal evaluation by Codeply staff only (file never leaves the team) | B1; C3; D1 (processing for training already happened) |
| Private opt-in for named external testers | All of the above + A1, A2, B2, C1, C2, D2 |
| Public opt-in or default | Everything above + A3/A4, D4, E1 |
