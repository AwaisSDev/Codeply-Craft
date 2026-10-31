# Secrets and the brain

Status: **fix on branch `claude/wonderful-feynman-y2ldw2`, not merged, not
released, not deployed.** Production stays as it is until the owner approves
the checklist at the end.

## What was wrong

On the hand-written Benchmark-520 (`research/dtw/benchmark/bench.jsonl` on
`codeply-li-dtw-experiment`), the production local pipeline (LFM3-1.7B QAD
Q4_0, prompt v2) put **5 of 13 secrets** into memorable observations that
reach `brain.observe()`. 4 of them would really have been stored, because the
brain's own check (`SECRET_RE`, keywords only) caught only the one whose text
said "API key":

| Example | Secret | What the model wrote |
|---|---|---|
| b-cv-062 | `owm-Kt9F3cQe7Xb24dRw46ZpLm` (unknown key format) | slot "openweather key" |
| b-cv-064 | locker code `2207` | "locker code location = 2207 at Al Qusais gym" |
| b-cv-067 | backup codes `7731-0042`, `5519-8820` | stored as the value |
| b-cv-068 | door code `58#14` | "the cleaner comes Thursday at 10, door code is 58#14" |

The DtW span-copying encoders leaked 6–7 of 13 each (b-cv-063's card expiry
among them). The cause: redaction (`context-redact.js`) and the guard
(`checkExtraction`) only knew fixed token formats (sk-…, ghp_…, AKIA…, Luhn
card numbers, "password is …"). A key in a format nobody listed, a keypad
code, or a short number next to the word "code" passed every layer. The
earlier claim that no secret ever reached memory was measured on generated
data only.

## Where the fix lives

`main` does not contain the local-intelligence pipeline (`context-*.js`,
`ml/eval`): it is on `codeply-local-intelligence`, which is `main` plus 36
commits. The fix is therefore based on `codeply-local-intelligence`
(and so on `main`), on the branch this session was assigned. The experiment
branch `codeply-li-dtw-experiment` and `main` were not changed. `brain.js`,
`bots.js` and `life.js` exist on `main` too; their part of the fix applies
there as well.

## Paths audited

Every way text reaches something stored, and every way it is read back.
"Before" is `codeply-local-intelligence` as it was.

### Into storage

| Path | Before | Now |
|---|---|---|
| Event text → model input (local **and cloud**) | fixed formats redacted | `redact()` uses the new detector (formats, shapes, cue words) |
| Event text → event queue (`context.db`, 7 days) | **raw text stored** (sealed only if sensitive) | redacted before it is stored; the removed values are kept in memory only, for the guard |
| Legacy learning (`learnFromExchange` without the engine, bots' `learnFromTurn`) → chat model | **raw text sent** | redacted first; removed values checked against what comes back |
| Model observation (slot, value, text, project, until) → guard | no secret check at all | dropped whole if any field holds a secret (fail closed); drop log keeps kind and reason only |
| Model plans → guard → `life.notePlans` | no secret check | a plan holding a secret value is dropped (naming one, "rotate the SSO password", is kept) |
| Value copied back by a model (from known memories, invented, or a buggy route) | not checked | refused if it matches a removed value or a value the events mark as secret, or if it is code-like, not in the events, and the batch had a secret removed |
| `brain.observe()` (every writer: engine, legacy `learnFromExchange`, bots' `noteObservations`, `remember` tool, `<codeply:remember>` tags, bot lessons, the Brain page's "add") | keyword `SECRET_RE` on the cleaned observation | the detector, on the raw input and the cleaned one |
| History (old value kept on replace) and the change log | the old text copied as is | an old value that looks secret is not carried into history or the log |
| Challenger | from the observation | covered by `observe()` (refused before it is built) |
| Sources | product / bot ids only | no text; nothing to do |
| `correct()` / `resolve('switch'/'undo')` (the user, or a challenger, by hand) | keyword check on text only | the detector on slot, value and text |
| `forget()` | logged the forgotten text in the change log | logs a placeholder for a secret-looking memory |
| Handoff facts | keyword check | the detector |
| Bot memory (`bots.mergeMemory`; in every prompt of that bot) | `password:`-style only | the detector (the brain's rule) |
| Bot lessons, tool tips, playbooks | `password:`-style | the detector, values only (a tip may say "refresh the token") |
| Engine outcome on the event (`actions[].text`) | text of what was kept | only what passed the guard; `redacted` lists kinds, never values |
| Deleted rows on disk (SQLite free pages, WAL) | kept until overwritten | `secure_delete` on the brain; the sweep vacuums and truncates the WAL |

### Out of storage

| Path | Before | Now |
|---|---|---|
| `contextBlock()` (every prompt; cloud models too) | all memories | skips any memory whose slot, value, text, history or challenger looks secret |
| `recall` tool | all memories | same |
| Engine `knownFor()` (memories shown to the extraction model) | all memories | same |
| Embedding retriever (`context-retrieval.js`, vectors.db) | embedded all memories | same (it reads through `list()`) |
| Brain page in Crew (`brain-desktop.js` → `list()`, `changes()`) | everything | secret-looking memories hidden; change-log lines that hold one shown as "(hidden: looked sensitive)" |
| Exports, phone, server, cloud sync, telemetry | none read the brain (checked: `server.mjs`, `cloud.mjs`, `telemetry.js`, `mobile.js`, `phone.js`) | — |

`list({ includeSecrets: true })` exists for the sweep and the tests only.

## What changed

* **`codeply-cli/lib/secret-scan.js` (new)**: one detector used everywhere.
  Any one signal is enough:
  * *pattern*: known formats (private keys, sk-/pk-/rk-, ghp_/github_pat_,
    AKIA/ASIA, AIza, xox?-, Stripe, glpat-, npm_, JWTs, `user:pass@` in URLs,
    bearer tokens, "password/pin/otp/cvv is …", IBANs, Luhn card numbers,
    long random strings)
  * *topic*: the brain's old keyword list, unchanged (so nothing refused
    before is kept now), plus "PIN", "OTP", "door/gate/locker/backup… code",
    "<service> key", "credentials", "account number"…, which count only when
    the text also holds a code-like value ("sign-in is phone OTP only" is a
    real decision)
  * *strong shape*: a random-looking token (`Kt9F3cQe7Xb24dRw46ZpLm`),
    prefix + random tail (`owm-…`), digits with `#`/`*` (`58#14`, `*1234#`),
    equal digit groups (`7731-0042`, `4402 1187`, not years, times or round
    numbers), letters + digits + symbols (`Sameer@786`)
  * *cue*: a number or mixed token up to 6 words after a cue word in the same
    sentence ("locker code 2207", "pin: …", "login, it's … / TigerNoodle99"),
    or up to 3 words before it with no punctuation between (Roman Urdu:
    "482913 ye OTP aya hai", "mera pin 4432 hai"); after "is/:/hai", even a
    plain word ("password is sunflower")
  * *source*: a value the redactor removed, or the events mark as secret
  * *mark*: the redactor's `[secret removed]` copied into an answer
* **`context-redact.js`**: `redact()` uses the detector and also returns the
  removed `values` (in memory only, never stored or logged).
* **`context-schema.js` `checkExtraction`**: secret check first, on the raw and
  the cleaned observation, and on plans; the code-like-value-not-in-events
  rule for batches that had a redaction.
* **`context-events.js`**: text redacted before it is stored; removed values
  kept in a memory-only map (`secretsFor(id)`), gone after processing or a
  restart; kinds (not values) in `meta.redacted`.
* **`context-engine.js`, `context-model.js`**: pass the removed values to the
  guard; never show the model a secret-looking known memory.
* **`brain.js`**: `observe()` and `correct()` use the detector;
  `list()` (all reads) skips secret-looking memories; history and the change
  log never copy an old secret; `forget()` logs a placeholder; `changes()`
  masks; `secure_delete`; `sweepSecrets({ apply })`; `memoryLooksSecret()`,
  `getSafe()`.
* **`bots.js`, `life.js`, `brain.learnFromExchange`**: the legacy (non-engine)
  learning paths redact the exchange before the model reads it, and pass the
  removed values and the redacted text to `observe()` (`secret-scan.guardWhy`).
  Bot memory and plans get the same rule.
* **`scripts/context/sweep-secrets.mjs` (new)**: one-off cleanup of an
  existing install (brain.db, context.db, vectors.db). Dry run by default.
* **Tests and eval**: `scripts/secret-test.mjs` + `scripts/fixtures/secret-bench.json`
  (`npm run test:secrets`), `ml/eval/run.mjs` (`--set-file`, removed values to
  the guard as in production, `secretsLeakedAny`, `secretsInBrain`),
  `ml/eval/secrets-fp.mjs`. The fixture and test are excluded from the app build.

## Test results

### Unit and end-to-end tests

`npm run test:secrets` (`scripts/secret-test.mjs`): **678 checks, all pass.**

* **Detection (63 kinds of secret).** API keys in known and unknown formats
  (sk-, ghp_, AKIA, owm-, a generic prefix + random tail, a random key with no
  prefix, a 12-character key), bearer tokens, a private key and a password in a
  URL. PINs, OTPs (both word orders), door, locker, gate and keypad codes
  (`2207`, `58#14`, `*1234#`), and codes typed in pieces (`2 2 0 7`,
  `58 # 14`, `4.4.7.1`, Urdu number words). Backup and recovery codes, card
  numbers, expiry dates and CVVs. Passwords in prose and as plain words, SSNs,
  CNICs, routing, account and passport numbers, seed phrases and security
  answers. Credentials in env lines, `mysql -p`, a Wi-Fi QR string and link
  query strings. Roman Urdu phrasings.
  For each one, the test checks three things:
  * the secret is gone from the redacted input;
  * the guard drops an observation holding it, with no help from the source and
    with the source;
  * `brain.observe` refuses it.

  It also checks that nothing reached the brain's file.
* **Negative controls (38, all kept by redaction, the guard and the brain, and
  readable back).** Prices and price ranges, times, working hours, dates, ages,
  room and flat numbers, years and year ranges, versions, model names, scores,
  phone numbers, issue numbers, weights, percentages, "code review", "key
  decision", and "OTP" or "API keys" as a feature with no value. Also:
  * token counts, "max tokens", "code is about 300 lines", an OTP expiry in
    seconds, "response code 502";
  * `user@ip`, a meal combo, "pin image …", a commit hash, a UUID, "hashed
    with argon2id";
  * a gym time and a cleaner visit in the same sentence as a code.
* **Benchmark-520 end to end, all 11 secret examples.** Each example runs
  through the event queue, redaction, the guard, `observe()` (twice, to
  exercise challengers), `contextBlock` and `recall`, and then the brain's
  file bytes and the queue's file bytes are checked. The answers used are:
  * the answers 4 real backends gave: LFM3 and 3 DtW encoders, 24 leaks
    between them before the fix;
  * adversarial answers that put each secret, in every variant (upper case,
    no separators, spaced), into the slot, value, text, project, `until`, and
    a plan's what, where and who;
  * the gold answers. Every gold memory and plan is still kept.
* **Brain paths.** Replacing or challenging a memory with a secret,
  `correct()` with a secret in the value, the `remember` tool, bot lessons
  and handoff facts.
* **Bot memory and Life plans** (legacy path).
* **Legacy `learnFromExchange` and bot `learnFromTurn`** with a model that
  writes a code back with no cue word: the model never sees the code, and
  nothing stores it.
* **A brain written before the fix.**
  * `list`, `contextBlock`, `recall`, the engine's known memories and
    `changes` never show the seeded secrets, and `forget()` logs a
    placeholder.
  * `sweepSecrets()`: the dry run reports ids and reasons only; `apply`
    deletes or cleans, and no secret is left in the file or its WAL.
* **The sweep script** on a brain, an event queue and a vectors store from the
  old code. The dry run changes nothing and prints no secret. `--apply`
  removes every secret from all three files, keeps the rest, and deletes the
  orphan vectors.
* **The engine with a backend that cheats** (it writes the original secrets
  back). The model sees none of them; only the safe memory is kept; nothing
  is in either file; a sensitive event is redacted before it is held.

Existing suites:
* `test:context` and `test:brain` pass.
* `engine-test` fails 1 check and `life-test` fails 2, all three
  identically on `codeply-local-intelligence` without this change:
  * a Windows-only `findstr` check (engine-test);
  * "learnFromTurn asks for plans and stores them" (life-test);
  * "quiet hours keep everything but leaving" (life-test).

### Harness on Benchmark-520

`node ml/eval/run.mjs ... --set bench --set-file research/dtw/benchmark/bench.jsonl`.
Summaries are in `ml/results/secrets/`.

How each row was produced:
* *before* is the old guard; *after* is this branch.
* *rules* ran live.
* The other "recorded" rows re-score the answers each backend gave in the
  experiment (`--rescore`), which measures exactly the guard's effect.
* *LFM3 live* is a fresh run of LFM3-1.7B QAD Q4_0 (prompt v2, 4 CPU threads,
  7,111 s) with this branch's redaction and guard. It shows the effect of the
  new redaction on the model's input as well.

Leak columns:
* **Leaked** is the original metric: gold secrets in memorable observations.
* **Any** counts gold secrets anywhere in the guard output.
* **Brain** counts gold secrets anywhere in a real brain afterwards.

| Run | F1 | P | R | Noise ok | Plans P / R | Mem. actions | Leaked | Any | Brain |
|---|---|---|---|---|---|---|---|---|---|
| rules before | 0.091 | 0.600 | 0.049 | 0.939 | 0 / 0 | 0.354 | 0/13 | 0 | 0 |
| rules after | 0.091 | 0.600 | 0.049 | 0.939 | 0 / 0 | 0.354 | 0/13 | 0 | 0 |
| LFM3 recorded before | 0.575 | 0.545 | 0.608 | 0.837 | 0.608 / 0.194 | 0.528 | 5/13 | 5 | 4 |
| LFM3 recorded after | 0.578 | 0.551 | 0.608 | 0.837 | 0.608 / 0.194 | 0.528 | 0/13 | 0 | 0 |
| DtW s1 before | 0.306 | 0.193 | 0.728 | 0.102 | 0.218 / 0.106 | 0.475 | 6/13 | 6 | 5 |
| DtW s1 after | 0.307 | 0.195 | 0.724 | 0.122 | 0.218 / 0.106 | 0.475 | 0/13 | 0 | 0 |
| DtW s1 Q4 before | 0.300 | 0.189 | 0.735 | 0.143 | 0.215 / 0.125 | 0.44 | 7/13 | 7 | 6 |
| DtW s1 Q4 after | 0.302 | 0.190 | 0.733 | 0.163 | 0.215 / 0.125 | 0.44 | 0/13 | 0 | 0 |
| DtW s1r before | 0.328 | 0.213 | 0.710 | 0.143 | 0.185 / 0.175 | 0.472 | 6/13 | 6 | 5 |
| DtW s1r after | 0.330 | 0.215 | 0.708 | 0.163 | 0.185 / 0.175 | 0.472 | 0/13 | 0 | 0 |
| LFM3 live run, fixed (redaction+guard), scored at run time | 0.577 | 0.550 | 0.606 | 0.837 | 0.615 / 0.2 | 0.528 | 0/13 | 0 | 0 |
| LFM3 live run, rescored with the final guard | 0.577 | 0.550 | 0.606 | 0.837 | 0.615 / 0.2 | 0.528 | 0/13 | 0 | 0 |

**Secrets: 0 of 13 for every backend** (before: LFM3 5, DtW 6–7). F1 is
unchanged or slightly higher: the dropped observations were not in the gold
answers. Noise rejection, plans and memory actions are unchanged. The DtW
runs lose 1–2 true positives each, and none of them is a new false positive:
* "car token tax", which the brain's old keyword rule already refused;
* b-cv-063, where the encoder copied the `[secret removed]` marker into its
  text.

### False positives (`ml/eval/secrets-fp.mjs`, `ml/results/secrets/false-positives.txt`)

Gold memories and plans (things that must be kept) put through the new
redaction and guard, with no model:

| Set | Gold memories refused | Gold plans refused | Non-secret inputs changed by redaction | Gold secrets removed from input |
|---|---|---|---|---|
| Benchmark-520 (hand-written) | 1 / 551 (0.18 %) | 0 / 160 | 1 / 534 | 13 / 13 |
| gold.jsonl | 0 / 33 | 0 / 3 | 0 / 39 | 2 / 2 |
| test (generated) | 0 / 637 | 0 / 64 | 0 / 848 | 25 / 25 |
| val (generated) | 0 / 671 | 0 / 66 | 0 / 835 | 39 / 39 |
| train (generated) | 0 / 6,559 | 0 / 614 | 0 / 8,367 | 279 / 279 |

The one refused gold memory ("pay the car's token tax", b-ur-014) was
already refused by the brain before this change, because of its old keyword
rule, which is kept unchanged on purpose. The one changed input is a public
promo code in a newsletter ("20% off with code COSY20").

### Independent red-team pass

A separate agent, given only the code, tried to get secrets past every layer
and to find over-blocking. Everything it found is fixed and in the tests:
* lock combinations shaped like dates or scores; SSNs and CNICs;
* "pw", "pass" and `DB_PASS`;
* "the code to the gate is …", "lock/unlock/opens with/khulta";
* codes in pieces or in Urdu number words; seed phrases and security answers;
* env lines, `mysql -p`, Wi-Fi QR strings and link tokens;
* 12-character random keys; routing, account and passport numbers;
* the legacy paths that sent raw text to the model.

It also found 9 kinds of false positive, which are fixed (see the negative
controls above).

Memory reads stay fast: one scan of 1,000 memories takes 59 ms cold, a prompt
block takes 6.7 ms warm, and redacting a 6,000-character event takes 1.6 ms.


## Residual risks

1. **This is still detection, not proof.** A secret that is a plain word, said
   with no cue ("the router uses bluemangoes"), cannot be told from an
   ordinary word. When the source is known (the engine, legacy learning, bots),
   a value the redactor removed is still caught if the model writes it back.
   But the `remember` tool, which an agent calls directly, has only the
   observation itself to judge.
2. **Paraphrased or partial secrets** ("the code starts with 58 and ends with
   14", a secret spelled out letter by letter) are not detected.
3. **Removed values are kept in memory only.** After a restart, a queued
   event's removed values are gone, and the guard falls back to the rule
   "code-like value not in the redacted events".
4. **Over-refusal that was already there is kept on purpose.** The brain's old
   keyword list refuses "car token tax", "secret santa", "NADRA token number"
   and coding decisions that say "access token". Changing that is a product
   decision, not a safety fix.
5. **Over-redaction of the input is small but not zero.** Public promo codes
   are removed, and so are Indian "pin code" postal codes.
6. **Out of scope, and not changed:**
   * chat transcripts (`session-db.js`) and the chat model itself still see
     what the user types;
   * handoff *intent* and *decision* text, which is a task for another bot;
     only the facts are filtered;
   * sealed (sensitive) event text, which the sweep cannot read without the
     host key and which is cleared by the normal 7-day purge.
7. **Existing installs.** Reads hide secret-looking memories at once, but
   they stay on disk until the sweep runs. `secure_delete` only covers
   deletions from now on.
8. **The evidence is small.** It is 13 benchmark secrets, 63 test kinds and
   one red-team pass. Real traffic may hold formats nobody thought of: monitor
   the "looks like a secret" drop counts (engine outcomes) after release.
9. **Fake secrets on the experiment branch.** The per-example result files
   there hold the backends' raw outputs, including the fake benchmark secrets.
   They are not real credentials.


## Deployment checklist (owner approval needed)

Nothing below has been done. Each step needs the owner's explicit OK.

- [ ] Review the diff against `codeply-local-intelligence`:
  * `codeply-cli/lib/`: secret-scan, context-redact, context-schema,
    context-events, context-engine, context-model, brain, bots, life;
  * `scripts/`: secret-test.mjs, fixtures/, context/sweep-secrets.mjs;
  * `ml/eval/`: run.mjs, secrets-fp.mjs;
  * `package.json`.
- [ ] Run `npm run test:secrets`, `npm run test:context` and
  `npm run test:brain` on a clean checkout. The 3 failures in engine-test
  and life-test exist without this change.
- [ ] Decide the merge path. This branch is based on
  `codeply-local-intelligence`. The `brain.js`, `bots.js` and `life.js`
  parts also protect `main`'s current (cloud) learning path. If `main` ships
  before the local-intelligence work, cherry-pick or port those parts and
  `secret-scan.js`.
- [ ] Decide how existing brains are cleaned. Options:
  * (a) run `node scripts/context/sweep-secrets.mjs` by hand;
  * (b) run `sweepSecrets({ apply: true })` once on first start after the
    update, behind a meta flag (not built).

  Either way, try the dry run on a copy of a real `~/.codeply` first, and
  back up before `--apply`.
- [ ] Decide whether the Crew Brain page should say how many memories are
  hidden as secrets (it hides them now, silently).
- [ ] Release as part of a versioned build with a changelog line ("Codeply no
  longer keeps codes, keys or passwords it hears, and hides any it kept").
- [ ] After release, watch the share of guard drops marked "looks like a
  secret" and any reports of missing memories; widen the negative controls
  with real cases.

