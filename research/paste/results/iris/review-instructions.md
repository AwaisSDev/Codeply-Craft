# Blind meaning review of rendered IrisBench events

Each line of your packet file is one rendered event: a synthetic chat, email or document written by a language model
from a fact sheet. `required` lists the items the text had to express (`[speaker] instruction`); these items are the
gold memory labels of the event. `transcript` is what the model wrote.

The question for every packet: **could a memory system reading this transcript be scored unfairly against the gold?**

For each packet write one JSON line:

    {"rid": "r017", "items_ok": [true, false], "contrary": ["..."], "extra": ["..."], "note": "..."}

* `items_ok` — one boolean per required item, in order: true if the transcript expresses it faithfully (right speaker,
  right value, right framing: a joke stays a joke, a hypothetical stays hypothetical, a correction is clearly a
  correction, a time/date is the same). Paraphrase is fine.
* `contrary` — short quotes of statements that contradict a required item or each other (for example a different date,
  value or person than the item says, or the user agreeing to something the item says they declined).
* `extra` — short quotes of statements that assert a **lasting, memory-worthy fact beyond the required items** about the
  user, a named person or a project: a preference, habit/routine, personal fact (job, family, health, location,
  possessions), relationship, project decision, commitment, or a plan with a time. Count it whether the user, another
  person, or the assistant asserts it about the user.
  Do NOT count: restating/paraphrasing a required item; greetings, small talk, questions, thanks, feelings about the
  moment; the assistant's generic advice, suggestions or recipes (unless the user then adopts them as their own
  preference/plan); vague filler with no specific content ("I've been busy lately").
  When unsure whether a statement is memory-worthy, ask: would a careful personal-memory system store it as a fact about
  this person? If yes, it is extra.
* `note` — optional, one short sentence.

Judge only from the packet. Do not open any other file in the review directory (in particular never open `key.json`),
and do not try to guess which model wrote a packet. Be consistent: apply the same standard to every packet.
