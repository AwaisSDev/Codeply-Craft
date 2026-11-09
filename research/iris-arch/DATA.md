# Iris data (v1)

Code: `irisarch/build.py` (lives → `iris.v1` examples), `irisarch/checks.py` (dataset gates). Tests:
`tests/test_build.py`. Generated data never goes into git (`data/` is ignored); it lives in the owner's private
store (`Awais1290/paste-data`, an `iris/` prefix) once the owner's token is available to the session.

## 1. Where the labels come from

**The world, not a model.** The life simulator (`research/paste/iris/sim/life.py`) runs weeks of one user's life and
records, for every event, the exact gold: which memory it creates or changes (op + target), the value, certainty,
sensitivity, plans and their status transitions, conflicts, and agent tasks with the minimal context they need and
what must not be shared. A model only *words* the events (renderer + deterministic verifier: every gold anchor
verbatim, nothing forbidden). So every training label is checkable and the teacher can never invent a fact.

The frontier model is used for what the simulator cannot do well, always with verification:

| Use | Check |
|---|---|
| Rendering fact sheets into realistic conversations (or a local open model on Kaggle, as decided 2026-11-04) | anchors verbatim, forbidden values absent, meaning gate, blind sample review |
| Hard slices the simulator cannot express (below) written as fact sheet + conversation pairs | the same verifier; gold written as fact sheets first, conversation second |
| Adversarial evaluation cases (prompt injection inside events, look-alike names, sarcasm) | two independent reviews; disagreements dropped, not resolved by the writer |

Never sent to any teacher: private user data, secrets, real names from team data.

## 2. Example types

| Type | Built from | Teaches |
|---|---|---|
| observe (single event) | every event, store replayed to just before it | extract, decide op, link to memory ids, do nothing |
| observe (noisy history) | same, with near-duplicates and wrong memories mixed in (`--noise`) | dedupe (`link same_as`), leave unrelated wrong memories alone |
| observe (own history, round 2) | same events, store built from **Iris's own earlier outputs** | work from the state it really produces (TRAINING.md §3) |
| retrieve | agent tasks with needed / forbidden / distractor memories | relevance, staleness, conflicts, `share` for frontier agents |
| resolve | memories with challengers (from conflicts and corrections in the lives) | update vs correct vs conflict |

Current builder state: observe + noisy history + retrieve implemented; own-history and resolve are A2 work.

## 3. Coverage targets (per 1,000 observe examples)

| Slice | Target share | Source |
|---|---|---|
| nothing worth keeping (`items: []`) | 50-70 % (production base rate ≈ 85 % of turns) | sim purposes + LongMemEval statistics |
| add | 15 % | sim |
| reinforce / refine | 6 % | sim |
| update / expire (changed deadline, moved launch, cancelled plan) | 6 % | sim |
| correct / conflict | 3 % | sim + hard slice |
| jokes, hypotheticals, quotes, someone else's suggestion (`ignore`) | 5 % | sim + hard slice (the memory model had 15 jokes and 11 quotes; it stores ⅓ of them) |
| implicit commitments ("I'll send it Friday") | 3 % | hard slice |
| temporary vs permanent ("in Karachi this week") | 3 % | sim (`context` kind) + hard slice |
| look-alike names, nicknames, two Saras | 3 % | sim pools + hard slice |
| Urdu and Roman Urdu, code-switching | ≥ 15 % of all events | renderer language setting + hard slice (memory model fails urdu-02/03) |
| secrets and sensitive categories | 2 % | sim (fake values only) |
| prompt injection inside events | 1 % | hard slice; gold = ignore |
| long histories (≥ 30 candidate memories, multi-week) | 20 % | sim with 42-day lives |

## 4. Gates (`irisarch/checks.py`, all must pass before a set is used)

| Gate | Rule |
|---|---|
| gold | every gold output passes `validate` + `verify_evidence` against its own request (100 %) |
| duplicates | no two examples with the same request |
| leakage | no person / organisation / project name and no labelled event text shared across splits |
| renders | no `plain` (fact-sheet) renders in training or evaluation sets |
| render quality | ≤ 5 % renders with contrary or extra facts on a blind sample of 100 (pre-registered; E59-E60 show this is not met yet: 4.3 % then 9 %) |
| balance | slice shares within ± 30 % of §3 |

Thresholds are pre-registered here and are not relaxed to get more data.

**Value pools (checked 2026-11-09).** Names are split 60 / 20 / 20 (`pools.py split_pool`). Attribute values are
split differently by design (`pools.split_values`, `ontology.values`): train and val share values, and the last 20 %
of every value pool appears only in test and stress. So an exact labelled sentence can repeat across train and val
when renders are identical: `checks.py` flags it (it fires on `plain` renders; with real renders it should not, and a
flagged real render is re-rendered). Generalisation is measured on the test examples whose values are test-only
(EVAL.md).

## 5. Reproducing

```
cd research/paste && python -m iris.sim.life --split train --n 200 --out ../iris-arch/data/lives-train.jsonl --seed 10000 --days 28
cd ../iris-arch && PYTHONPATH=.:../paste python -m irisarch.build data/lives-train.jsonl --out data/train.jsonl --noise 0.3
PYTHONPATH=.:../paste python -m irisarch.checks data/train.jsonl data/val.jsonl
```

Renders come from `research/paste/iris/render/` (Kaggle CPU / T4 with a local open model) before `build`.
