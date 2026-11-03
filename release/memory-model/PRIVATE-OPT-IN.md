# Private, restricted opt-in: can the model be evaluated without public distribution?

Status 2026-11-03. Short answer: **yes, technically**. The model can be
installed and used by named people only, with nothing published and no
change to what other users get. **This does not resolve any licensing or
privacy question.** Giving the file to anyone outside Codeply is still
distribution (see `LEGAL-AND-PRIVACY-QUESTIONS.md`, D5 and "Suggested
minimum per release path"). Nothing below has been done; it needs the
owner's approval.

## What already keeps it private (integration branch, not merged)

| Safeguard | Where | Tested |
|---|---|---|
| The app cannot download it: the catalog entry has no repository (`repo: ''`); `fetch-model.mjs` installs it only from a file the tester already has (`--from`) | `local-runtime.js`, `fetch-model.mjs` | `memory-model-test.mjs` |
| The file must be the frozen release candidate: install refuses any file whose SHA-256 is not `7360aaed…ac14f9` | `fetch-model.mjs` | `memory-model-test.mjs` (wrong file refused, not linked); the real file installs |
| Opt-in only: an installed copy is never used unless the user selects it (`optIn: true`; never the fallback model) | `local-runtime.js` `selectModel`, `context-desktop.js` | `memory-model-test.mjs` (3 checks) |
| Everything runs locally: the model reads the user's own conversations on their machine and writes to their local Brain; no network call | runtime design | `integration/` suite |
| Instant rollback: select the previous model, or turn tiers off, or undo what the model wrote | `DEPLOYMENT.md` §4, `rollback-memories.mjs` | `rollback-test.mjs` |

## Distribution channel for the file (private options)

| Option | Who can get it | Cost | Notes |
|---|---|---|---|
| **A. Private Kaggle dataset, named collaborators** (recommended first) | Kaggle accounts the owner adds | Free; already holds the file (`awaissididique/codeply-memory-model-gguf`, `s1.tar`) | No new upload; access is revocable; download log on Kaggle |
| B. Private Hugging Face model repo, named members | HF accounts the owner adds | Free | Needs a new upload; would let the catalog `repo` point at it later, but the app would then need an HF token to download, which it does not support (it would stay `--from`) |
| C. Direct transfer inside the team | Team members | Free | No access control after transfer |

Every channel ships `notices/NOTICE.md` and `notices/LFM-OPEN-LICENSE-v1.0.txt`
with the file (LFM Open License §4: licence copy and "modified" notice).

## Phases

1. **Internal (Codeply staff only).** The file never leaves the team. Suggested
   to clear first: B1 (LFM revenue threshold), C3 (Anthropic terms for the
   labels), D1 (lawful basis).
2. **Named external testers** (5-20 people who opt in in writing, told the
   model is experimental and how to roll back). Suggested to clear first: also
   A1, A2, B2, C1, C2, D2.
3. **Public opt-in**, then default: everything in the legal file.

## Tester procedure (phase 1 or 2)

```
# 1. get s1.tar from the private dataset; check the file
node release/memory-model/verify-frozen.mjs --gguf codeply-memory-lfm3-s1-Q4_K_M.gguf
# 2. a build of branch codeply-memory-model-integration (not merged into main)
node scripts/context/fetch-model.mjs lfm3-1.7b-memory-v1-q4 --from codeply-memory-lfm3-s1-Q4_K_M.gguf
# 3. acceptance on the tester's machine (secrets and injection must be 100 %)
node release/memory-model/integration/run-integration.mjs --model lfm3-1.7b-memory-v1-q4
# 4. select it: local intelligence settings -> model = lfm3-1.7b-memory-v1-q4
# 5. after 2-4 weeks: counts-only report (no memory text) to share
node release/memory-model/optin-report.mjs --events <context events db> --brain <brain db> --model lfm3-1.7b-memory-v1-q4
```

`optin-report.mjs` (tested, `optin-report-test.mjs`) prints numbers only:
batches, failures, latency, brain actions, pending/discarded counts, and
how many of the model's memories the user later forgot, corrected or
confirmed. A tester can send it without sending their memories.

## What the phase must show before a wider release

| Signal | Source | Bar (proposed) |
|---|---|---|
| Memories the user forgot or corrected | `optin-report.mjs` | Not higher than the current default model over the same weeks |
| Secrets or injected instructions stored | tester reports, integration suite | Zero |
| Backend failures | `optin-report.mjs` | < 1 % of batches |
| Latency p95 | `optin-report.mjs` | ≤ 30 s per batch on the tester's CPU (background work) |
| Pending memories confirmed vs expired (if the 5:1 tiers are used) | `optin-report.mjs` | Recorded; decides whether the pending tier is worth its prompts |

## Open technical gaps for this path

* The tiers come from the catalog; trying the 5:1 configuration needs the
  catalog value changed on the integration branch (one line, `TIERS.md`).
  There is no per-user setting for it, on purpose.
* The installed model id `lfm3-1.7b-memory-v1-q4` and the evaluation id
  `codeply-memory-lfm3-s1-q4` name the same file; reports should use the
  installed id.
