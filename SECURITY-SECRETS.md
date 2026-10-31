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
* **`bots.js`, `life.js`**: the same rule for bot memory and plans on the
  legacy (non-engine) path.
* **`scripts/context/sweep-secrets.mjs` (new)**: one-off cleanup of an
  existing install (brain.db, context.db, vectors.db). Dry run by default.
* **Tests and eval**: `scripts/secret-test.mjs` + `scripts/fixtures/secret-bench.json`
  (`npm run test:secrets`), `ml/eval/run.mjs` (`--set-file`, removed values to
  the guard as in production, `secretsLeakedAny`, `secretsInBrain`),
  `ml/eval/secrets-fp.mjs`. The fixture and test are excluded from the app build.

## Test results

RESULTS-PLACEHOLDER

## Residual risks

RISKS-PLACEHOLDER

## Deployment checklist (owner approval needed)

CHECKLIST-PLACEHOLDER
