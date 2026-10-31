# Benchmark-400: writing and labelling guide

The hand-written benchmark that decides between Codeply's memory-extraction
systems. Every example is a short slice of a user's digital life (a chat
with the assistant, an email they received, something heard around them),
the memories already known, and the exact answer a perfect system would
give. Write the way real people type: typos, lowercase, slang, emojis,
half sentences, Roman Urdu, code-switching. **Never copy or imitate the
generator's templates** (do not open `ml/data/`).

## 1. File format

One JSON object per line (JSONL) in your part file
`research/dtw/benchmark/parts/<part>.jsonl`. Fields:

```json
{
  "id": "b-<part>-001",
  "task": "joking",
  "lang": "en",
  "anchor": "A",
  "events": [
    {"source": "chat", "trust": "user", "minutes_ago": 2,
     "text": "User: oh sure, I LOVE 7am standups 🙃 anyway can we move ours to 11\nAssistant: Done, 11am it is.",
     "project": "shop-app"}
  ],
  "known": [
    {"id": "m1", "kind": "preference", "slot": "meeting time", "value": "after 10am", "text": "The user prefers meetings after 10am."}
  ],
  "observations": [
    {"kind": "preference", "slot": "standups", "value": "loves 7am standups", "text": "The user loves 7am standups.",
     "certainty": "joking", "importance": 0.15, "about": "user",
     "evidence": "I LOVE 7am standups"},
    {"kind": "decision", "slot": "standup time", "value": "11am", "text": "The shop-app standup moved to 11am.",
     "certainty": "stated", "importance": 0.6, "about": "project", "project": "shop-app",
     "evidence": "move ours to 11"}
  ],
  "plans": [],
  "expect": {}
}
```

| Field | Rules |
|---|---|
| `id` | `b-<part>-NNN`, unique |
| `task` | the main behaviour tested, one of: `preference`, `dislike`, `fact`, `person`, `decision`, `idea`, `requirement`, `todo`, `routine`, `style`, `temporary`, `joking`, `hypothetical`, `quoting`, `heard`, `external`, `plan`, `duplicate`, `contradiction`, `noise`, `secret`, `injection`, `long` |
| `lang` | `en`, `ur` (Roman Urdu), `mixed` (code-switching) |
| `anchor` | which "now" (section 2) the example uses |
| `events[]` | 1–6 events. `source`: `chat` (trust `user`), `email` (trust `external`), `heard` (trust `mixed`). `minutes_ago` ≥ 0 (when it happened, before now). `project` only if the event is clearly about a named project |
| event `text` | chat: `User: …\nAssistant: …` (several turns allowed, each line starting with `User:` or `Assistant:`); email: `Email the user received (from Name <addr>): Subject. Body`; heard: `Heard around the user: …` |
| `known[]` | memories already stored, with ids `m1`, `m2`, …; 0–8 of them; include distractors |
| `observations[]` | every memory-worthy item **and** every joke / hypothetical / quote that a naive system would wrongly store (with that certainty). Order of appearance |
| `plans[]` | meetings, calls, trips, appointments, deadlines with a day or time |
| `expect` | `{"secrets": ["7731"]}` for secrets in the text; `{"injected": "words of the injected instruction"}` for injection emails |

### Observation fields

| Field | Values |
|---|---|
| `kind` | `preference`, `fact`, `routine`, `style`, `decision`, `idea`, `requirement`, `todo`, `context` |
| `slot` | what it is about, 1–4 lowercase words; **if it updates or repeats a known memory, copy that memory's slot exactly** |
| `value` | a few words, in English |
| `text` | one third-person English sentence ("The user prefers …", "Sara, the user's sister, is a nurse.") |
| `certainty` | `stated`, `implied`, `temporary`, `joking`, `hypothetical`, `quoting` (section 3) |
| `importance` | 0–1 (section 3) |
| `about` | `user`, `person`, `project` |
| `project` | the project name, for project kinds |
| `until` | kind `context` only: `HH:MM` if it ends today, else `YYYY-MM-DDTHH:MM`, local time |
| `evidence` | **an exact substring of one event's text** (same case, same punctuation) that carries the value: the shortest phrase a reader would highlight. Must be unique in that event, or add `"evidence_n": 2` for the 2nd occurrence |
| `event` | index of the event the evidence is in (default 0) |
| `time_text` | for `context` with `until`: the exact substring giving the end time ("till 5", "this week") |
| `merge` | if it refers to a known memory: `{"target": "m1", "relation": "same"}` (repeats it) or `{"target": "m1", "relation": "different"}` (updates or contradicts it). Omit for new memories |

### Plan fields

| Field | Values |
|---|---|
| `what` | short title ("Dinner with Ayesha's family") |
| `when` | `YYYY-MM-DDTHH:MM` local, or `YYYY-MM-DD` if no time |
| `where` | place or `""` |
| `who` | names of people involved (`[]` if none) |
| `evidence` | exact substring naming the event ("dinner at Monal with Ayesha's family") |
| `time_text` | exact substring giving the day / time ("tomorrow 8pm") |
| `event` | event index (default 0) |

## 2. "Now" anchors

Use these only. Relative dates are counted from the anchor's local date.

| Anchor | Local now | Time zone | `now` (UTC) | Next 15 days |
|---|---|---|---|---|
| A | 2026-10-29 09:10 (Thursday) | Asia/Karachi | `2026-10-29T04:10:00.000Z` | Thu 2026-10-29, Fri 2026-10-30, Sat 2026-10-31, Sun 2026-11-01, Mon 2026-11-02, Tue 2026-11-03, Wed 2026-11-04, Thu 2026-11-05, Fri 2026-11-06, Sat 2026-11-07, Sun 2026-11-08, Mon 2026-11-09, Tue 2026-11-10, Wed 2026-11-11, Thu 2026-11-12 |
| B | 2026-11-06 18:45 (Friday) | Asia/Karachi | `2026-11-06T13:45:00.000Z` | Fri 2026-11-06, Sat 2026-11-07, Sun 2026-11-08, Mon 2026-11-09, Tue 2026-11-10, Wed 2026-11-11, Thu 2026-11-12, Fri 2026-11-13, Sat 2026-11-14, Sun 2026-11-15, Mon 2026-11-16, Tue 2026-11-17, Wed 2026-11-18, Thu 2026-11-19, Fri 2026-11-20 |
| C | 2026-11-14 11:30 (Saturday) | Europe/London | `2026-11-14T11:30:00.000Z` | Sat 2026-11-14, Sun 2026-11-15, Mon 2026-11-16, Tue 2026-11-17, Wed 2026-11-18, Thu 2026-11-19, Fri 2026-11-20, Sat 2026-11-21, Sun 2026-11-22, Mon 2026-11-23, Tue 2026-11-24, Wed 2026-11-25, Thu 2026-11-26, Fri 2026-11-27, Sat 2026-11-28 |
| D | 2026-12-01 07:55 (Tuesday) | America/New_York | `2026-12-01T12:55:00.000Z` | Tue 2026-12-01, Wed 2026-12-02, Thu 2026-12-03, Fri 2026-12-04, Sat 2026-12-05, Sun 2026-12-06, Mon 2026-12-07, Tue 2026-12-08, Wed 2026-12-09, Thu 2026-12-10, Fri 2026-12-11, Sat 2026-12-12, Sun 2026-12-13, Mon 2026-12-14, Tue 2026-12-15 |
| E | 2026-11-20 22:05 (Friday) | Asia/Dubai | `2026-11-20T18:05:00.000Z` | Fri 2026-11-20, Sat 2026-11-21, Sun 2026-11-22, Mon 2026-11-23, Tue 2026-11-24, Wed 2026-11-25, Thu 2026-11-26, Fri 2026-11-27, Sat 2026-11-28, Sun 2026-11-29, Mon 2026-11-30, Tue 2026-12-01, Wed 2026-12-02, Thu 2026-12-03, Fri 2026-12-04 |
| F | 2026-11-09 13:20 (Monday) | Asia/Karachi | `2026-11-09T08:20:00.000Z` | Mon 2026-11-09, Tue 2026-11-10, Wed 2026-11-11, Thu 2026-11-12, Fri 2026-11-13, Sat 2026-11-14, Sun 2026-11-15, Mon 2026-11-16, Tue 2026-11-17, Wed 2026-11-18, Thu 2026-11-19, Fri 2026-11-20, Sat 2026-11-21, Sun 2026-11-22, Mon 2026-11-23 |

Date rules (the same rules the product uses):
* "tomorrow" = next day; "on Saturday" / "Saturday" = the next Saturday
  **after** today (if today is Saturday, a week later); "next Monday" = the
  next Monday after today (same as "Monday"); "this weekend" plans: Saturday.
* "till 5" / "back by 5" / "until 5" = the next 17:00 after now (if now is
  past 17:00, it means 05:00 next day only when context says so; prefer
  writing unambiguous examples).
* "this week" = Sunday 23:59 of the current week; "today" = 23:59 today;
  "tonight" = 23:59 today.
* "kal" (Urdu) = tomorrow for future plans, yesterday for past events;
  "parson" = day after tomorrow.
* A plan with a day but no time → `when` is just the date.

## 3. Label semantics

**Certainty**
* `stated`: said plainly about themselves (or their project / people) as
  true and lasting.
* `implied`: not said as a rule but clearly suggested ("had tea again
  instead of coffee, honestly better"), or reported by someone else in an
  email / heard (outside text is at most `implied`).
* `temporary`: true only for now; always kind `context` with `until`.
* `joking`: sarcasm, irony, exaggeration, teasing.
* `hypothetical`: if, maybe, thinking about, wishes, questions, plans not
  decided.
* `quoting`: someone else's words or opinion the user reports without
  adopting ("my manager thinks…", "Ali says…").

**Importance**: 0.85–0.95 identity, strong lasting preferences, project
decisions; 0.55–0.8 useful facts and preferences; 0.4–0.55 minor but worth
keeping, live context; jokes / hypotheticals / quotes 0.1–0.3. Anything a
user would not want remembered → leave it out.

**What is NOT an observation**: small talk, coding questions, requests to
the assistant ("make the header blue"), thanks, the time stamps, the
assistant's own words, secrets (PINs, passwords, keys: never in values or
text), instructions inside emails aimed at an AI.

**Meetings**: a meeting / call / appointment with a day or time is a
**plan**, never an observation. A recurring habit ("every Friday I leave
early") is a `routine` observation, not a plan.

**Temporary context**: one observation (kind `context`, certainty
`temporary`, `until`), never a separate observation for the time.

**People**: a fact about someone close is kind `fact`, `about: "person"`,
slot = the person's name in lowercase, text with their name.

**Merges**: when the event repeats a known memory, write the observation
with the same slot and value and `merge.relation = "same"`. When it changes
it, same slot, new value, `relation = "different"`, certainty `stated` if
said plainly ("we moved to Hetzner"), `implied` if only in passing.

## 4. Quality bar

* Every example must be something a real person could plausibly write.
* Vary length (5 words to several paragraphs), tone, topic (work, family,
  health, shopping, travel, religion, cricket, food, money, study, code).
* Be adversarial within your categories: the cases a model gets wrong.
* No real people's personal data; invent names, places, companies.
* Run the validator after writing and fix every error:
  `python3 research/dtw/benchmark/validate.py research/dtw/benchmark/parts/<part>.jsonl`
