# Integrating the memory model into Brain (instructions, rollout, rollback)

Nothing here is applied to production. The code changes are on branch
`codeply-memory-model-integration` (five commits on top of
`codeply-memory-model`, including the Brain value-match fix and the 5:1
tiers, both by owner decision), to be merged into main only with the
owner's approval (`results/BRAIN-DEDUP.md`, `TIERS.md`). Before any release, the legal and privacy
questions in `LEGAL-AND-PRIVACY-QUESTIONS.md` must be answered; the private
opt-in path is in `PRIVATE-OPT-IN.md`.

## 1. What changes in production code

| File | Change | Effect when merged but not configured |
|---|---|---|
| `codeply-cli/lib/local-runtime.js` | catalog entry `lfm3-1.7b-memory-v1-q4` (full prompt, thinking off, `--swa-full`, ctx 8,192, `sha256` of the release candidate, `tiers` = frozen 5:1, `optIn: true`); `selectModel`: an opt-in model is never the fallback | none until the model is installed **and** selected |
| `context-desktop.js` | the catalog's `style` wins over the "`codeply-*` reads the compact prompt" rule; `tiers` from the catalog | none for existing models (no `style`, no `tiers`) |
| `codeply-cli/lib/context-model.js` | local backend option `confidence`: requests token log-probabilities, returns a confidence per observation | off unless asked |
| `codeply-cli/lib/context-schema.js` | the guard carries confidences, by position, next to the answer (a confidence written in the answer is ignored) | none |
| `codeply-cli/lib/context-tiers.js` | new: confidences and the automatic / pending / discard decision | none |
| `codeply-cli/lib/context-engine.js` | applies tiers when the settings have them | `tiers: null` by default |
| `codeply-cli/lib/brain.js` | an observation marked `pending` is stored `tentative` with a 30-day expiry; promotion (seen again, stated) or the user's confirm clears it | none (no one sends `pending` yet) |
| `scripts/context/fetch-model.mjs` | an unpublished model installs from a file; a catalog model whose file does not match the catalog SHA-256 is refused | none |

Tests (all pass on the branch): `node scripts/memory-model-test.mjs` (33
checks), `node scripts/brain-test.mjs`, `node scripts/context-test.mjs`,
`node release/memory-model/rollback-test.mjs`,
`node release/memory-model/optin-report-test.mjs`,
`node release/memory-model/integration/malformed.mjs` (18), and
`node release/memory-model/verify-frozen.mjs` (frozen results and checksum).

## 2. Release steps (after owner approval and the WildChat decisions)

1. The artifact: `codeply-memory-lfm3-s1-Q4_K_M.gguf`, SHA-256
   `7360aaed…ac14f9` (`results/FROZEN-MANIFEST.json`; check a copy with
   `verify-frozen.mjs --gguf <file>`). Ship `notices/NOTICE.md` and
   `notices/LFM-OPEN-LICENSE-v1.0.txt` with it in every channel.
2. Host it where clients can download it (a Hugging Face repo under the
   owner's account; public hosting waits for `WILDCHAT-OPEN-ISSUES.md`), then
   set `repo` and `sha256` in the catalog entry.
3. Set `tiers` in the catalog entry to the frozen values from
   `results/TIERS-FROZEN.json` (or leave `null` to ship without tiers).
4. Merge the integration branch; run the three test scripts and the
   integration suite against the downloaded file:
   `node release/memory-model/integration/run-integration.mjs --model lfm3-1.7b-memory-v1-q4`
   (gate: secrets and injection 100 %, the other categories at their
   thresholds; jokes and quotes reported).
5. Ship as **opt-in** first, in phases (`PRIVATE-OPT-IN.md`: internal, named
   testers, public opt-in): the user selects the model in local intelligence
   settings; the current default (`lfm3-1.7b-qad-q4`) stays the default.
   Testers share the counts-only `optin-report.mjs` output.
6. Make it the default after a clean opt-in period (no rise in memories
   the users delete or correct, no latency complaints).

## 3. Runtime requirements

* Disk ~1.1 GB, CPU only, 4 threads in all measurements; llama.cpp
  `aa588a3` (the Codeply runtime) or newer with LFM3 support.
* Background only: the context engine runs batches at a 25 % duty cycle;
  per-batch latency p50 ~5-6 s, p95 ~20 s on 4 threads.
* The full prompt style (the catalog sets it). The compact prompt must not
  be used with this model.

## 4. Rollback

Three levels, from cheapest to most thorough:

1. **Switch back the model** (instant, no data loss): select
   `lfm3-1.7b-qad-q4` again in settings (`settings.model`), or remove the
   catalog entry in a patch release. New batches use the old model at once.
2. **Turn the tiers off** without changing the model: `settings.tiers =
   false` (desktop) makes `localTiers()` return null; everything the guard
   keeps is stored as before.
3. **Undo what the model wrote** into a user's brain:
   `node release/memory-model/rollback-memories.mjs --events <context events db>
   --brain <brain db> --model lfm3-1.7b-memory-v1-q4` (dry run), then
   `--apply`. It forgets memories the model added (unless the user confirmed
   or edited them, or they were seen again), undoes its replacements to the
   previous value, and leaves everything else. Limit: only batches still in
   the event store (it purges old rows). Tested in `rollback-test.mjs`.

Pending memories need no rollback: they expire after 30 days unless
confirmed.

## 5. Monitoring after release

Per batch the event store already records the model, the brain action per
observation and (with tiers) the tier counts. Watch: share of memories later
deleted or corrected by the user; pending-to-confirmed rate; share
discarded; latency p95; backend errors (malformed output is already handled,
`integration/malformed.mjs`).
