# Training-data sources: licences (checked 2026-10-31)

Candidate public datasets for the realistic training set (Claude relabels them
in the benchmark schema). Licences were read from primary sources (LICENSE
files, dataset cards, UCI / LDC catalog pages); third-party Hugging Face
mirrors are not treated as authoritative. Not legal advice: the owner decides
the "unclear" rows. Keep a NOTICE file with attribution for every source used.

## Use (commercial use allowed by the stated licence)

| Dataset | Licence | Where | Size | Use for | Caveats |
|---|---|---|---|---|---|
| **WildChat-1M** | ODC-BY (relicensed 2024-06-26) | HF `allenai/WildChat-1M` | 838k conversations | Real users talking to an assistant: self-disclosure, preferences, plans, hypotheticals, jokes; multilingual | Presidio de-identified, PII may remain; toxic content; assistant turns are ChatGPT output (we only read them, never train to generate them; owner to confirm OpenAI terms) |
| **Topical-Chat** | CDLA-Sharing 1.0 (trained models are unrestricted "Results") | github.com/alexa/Topical-Chat | 10.8k conversations | Real human-human chit-chat, opinions | Republishing the data keeps CDLA-Sharing |
| **MultiWOZ 2.2** | MIT | HF `pfb30/multi_woz_v22` | 10.4k dialogues | Plans, bookings with day/time/people, updates | Crowdworker Wizard-of-Oz, tourism domain |
| **LongMemEval** | MIT | HF `xiaowu0162/longmemeval-cleaned` | 500 histories | Preferences, knowledge updates, temporal | Filler sessions from ShareGPT / UltraChat (provenance unclear); small |
| **ConvAI2** | CC BY 4.0 (ParlAI task README) | ParlAI `-t convai2` | ~3.5k | Persona facts | Built on PersonaChat (see unclear) |
| **SODA** | CC BY 4.0 | HF `allenai/soda` | 1.19M | Social dialogue, plans, events | GPT-3.5 generated |
| **Conversation Chronicles** | CC BY 4.0 | HF `jihyoung/ConversationChronicles` | ~1M multi-session | Time gaps, updates, temporary context | LLM generated |
| **Synthetic-Persona-Chat** | CC BY 4.0 | HF `google/Synthetic-Persona-Chat` | 20k | Persona facts in dialogue | LLM generated |
| **Roman Urdu (UCI 458)** | CC BY 4.0 | archive.ics.uci.edu/dataset/458 | 20k | Real Roman Urdu text | Comments / reviews, few personal facts |
| **RUSAD (UCI 854)** | CC BY 4.0 | archive.ics.uci.edu/dataset/854 | 11k | Roman Urdu text | Not confirmed to be RUSA-19 |
| **RUHSOLD** | MIT | HF `community-datasets/roman_urdu_hate_speech` | 10k | Roman Urdu social text | Offensive by design, low fit |
| SNIPS | CC0 | HF `sonos-nlu-benchmark/snips_built_in_intents` | small | — | Commands, low value |

## Avoid (non-commercial or paid)

LoCoMo (CC BY-NC 4.0), DailyDialog (CC BY-NC-SA 4.0), EmpatheticDialogues
(CC BY-NC 4.0), FactBank (LDC, paid, commercial terms unknown).

## Unclear: owner should decide

| Dataset | Why | Fit |
|---|---|---|
| PersonaChat, Multi-Session Chat, Dialogue NLI | No data licence stated (ParlAI code is MIT) | High (persona facts, merges, contradictions) |
| CommitmentBank | No licence; text from BNC, Switchboard, WSJ (LDC) | High for certainty, but tiny (1.2k) |
| SARC | Reddit content, no data licence | Jokes, noisy self-labels |
| iSarcasmEval | MIT repo, but tweet text | Best joke labels, small |
| Smat26 Roman-Urdu-Dataset | GPL-3.0 applied to data | Roman Urdu |
| Roman-Urdu-Parl | Original licence not verified | Transliteration |

## Gaps

* **Mixed Urdu-English chat:** no well-licensed conversational set. Plan:
  WildChat filtered by language, and Claude rewriting permissive English
  dialogues into Roman Urdu / mixed.
* **Quoting someone else, hypotheticals:** no permissive dedicated set; they
  occur naturally in WildChat and Topical-Chat, and Claude labels them.
* Relabelled data is derived data: fine with attribution under CC BY, ODC-BY,
  CDLA-Sharing; anything NC stays non-commercial.
