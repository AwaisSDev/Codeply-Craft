# Continue: Codeply shared brain, life simulation fixes

You are picking up work on branch `codeply-brain` of `awaissdev/codeply-craft-next`.
Read `ENGINE-NOTES.md` (section "The shared brain and agent handoffs") first.

## What exists (all committed)

- `codeply-cli/lib/brain.js`: the shared brain (personal memory, project
  context, live context that expires, team lessons, change log) and the
  handoff board between bots. Every `runAgent` turn gets the brain block in
  its turn context. Tools: `remember`, `recall`, `hand_off`.
- `brain-desktop.js`: desktop host (handoffs become autopilot tasks, meeting
  emails go from the email bot to the calendar bot, Crew's Brain page IPC).
- `crew/brain.js` + `crew/crew.css`: the Brain page in Crew.
- Autonomy Level 1 `none` ("Just suggest, never act") in `bots.js`,
  `autopilot.js`, `crew/crew-main.js`, `bots-desktop.js`.
- Health as a Life source (`life.js` noteHealth / healthSummary / about=health,
  `life-triggers.js` "activity" check-in, `POST /api/life/health` in
  `autopilot.js` bridge).
- `scripts/sim/`: life simulation. Runs a persona's days through the REAL code
  (Crew main process with a fake Electron, agent loop, brain, autopilot,
  life-desktop engine, mail watcher) with a pretend Google world and a
  simulated clock. Every model call goes to a file bridge that an AI agent
  answers (`--bridge <dir>` + `scripts/sim/model-bridge.mjs next|reply`), or
  to a real OpenAI-compatible endpoint (`SIM_BASE_URL`, `SIM_API_KEY`,
  `SIM_MODEL`). Personas in `scripts/sim/personas.mjs`: shopkeeper, farmer,
  manager, hr, artist, hiring, student, senior.
- Tests: `npm run test:brain` (all pass). `scripts/life-test.mjs` has 2 and
  `scripts/engine-test.mjs` has 1 failure that were there before this work
  (date-dependent tests and a Windows-only `findstr`); do not count them.

Simulation results so far (real Claude agents as the model): farmer 12/12,
hiring week 12/12, senior 17/18, manager 11/13, artist 10/12, hr 8/9. The
failures were bugs that are now fixed (long turns lost the brain when the
middle got summarized; standing rules filed as "requirement" were left out of
the prompt; "candidates" did not match "candidate"). The student and
shopkeeper runs were cut off and must be rerun.

## In progress (half done in the last commit, finish it)

Gmail and Calendar tool gaps the simulation found:

1. Done in `oauth-connectors.js`: `rawEmail` and `gmailSend`/`gmailCreateDraft`
   take `cc`; new `gmailGetMessage`, `calendarPatchEvent`,
   `calendarDeleteEvent`; `calendarInsertEvent` sends invites when there are
   attendees.
2. Done in `tools.mjs`: `gmail_send`/`gmail_draft` take `cc`; new `gmail_read`
   (whole email by id) and `calendar_update` (move, rename or cancel by id);
   `gmail_search` and `calendar_list` show `[id]`s; `calendar_add` takes
   `attendees`. `gmail_send` calls `lifeLib.noteSent(...)`, which does NOT
   exist yet (wrapped in try).
3. NOT done yet:
   - `codeply-cli/lib/agent.mjs`: add to `PARAMS` (`gmail_send` + `cc`,
     `gmail_draft` + `cc`, `gmail_read: ['id']`, `calendar_add` + `attendees`,
     `calendar_update: ['id','title','start','end','minutes','location','description','cancel']`),
     `NAME_ALIASES`, the `FORMAT_CORRECTION` name list, `MUTATING_ACTIONS`
     (+ `calendar_update`), `BATCHABLE_TOOLS` (+ `gmail_read`), and text
     examples in `TOOL_REFERENCE` near the gmail/calendar ones.
   - `codeply-cli/lib/native-tools.mjs` `TOOL_DOCS`: docs for the new params
     and tools.
   - `codeply-cli/lib/bots.js` `APPROVALS.calendar.tools` += `calendar_update`.
   - `codeply-cli/lib/life.js`: add `noteSent(addresses)` that removes entries
     from `store.getState('gmail.waiting')` whose `from` matches any address,
     and export it. Also fix `itemLine`: for an event ending on another day,
     print `when(x.end, ...)` instead of only `clock(x.end)` (the hackathon
     showed as "Fri 18:00 to 18:00").
   - `scripts/sim/harness.mjs` `installGoogle`: fake `gmailGetMessage`
     (from `world.inbox`), `calendarPatchEvent`, `calendarDeleteEvent`
     (update `world.calendar` and the life store mirror), keep `cc` on
     `world.sent`.
   - Tests in `scripts/brain-test.mjs` or `scripts/engine-test.mjs` for cc,
     gmail_read, attendees and calendar_update (fake the oauth functions).

## Still to fix (found by the simulation, not started)

- `life-triggers.js` `chooseBot`: the "activity" (health) check-in went to the
  personal-life bot. Prefer a bot whose `handles` include `health` or whose
  specialty matches health/fitness, then fall back.
- Duplicate events: `life.js notePlans` saves a plan for something already
  on the calendar (two "leave now" nudges for one cricket match). Skip a plan
  when a calendar item within about 3 hours shares the main title words; also
  dedupe in the `leaving` trigger.
- `agent.mjs` stall check is too eager: a final reply like "I'll check in next
  week" is treated as an announced action with no action block. Find the
  stall/announcement regex and do not fire on a reply that is clearly a
  closing to the user (no tool needed).
- Companion bots get the coding agent's skill index ("likely relevant"
  blender, billing, remotion skills). When a bot prompt is set and the bot is
  not a code bot, skip or narrow the skill suggestions in
  `buildSystemSections` / `buildSystemPrompt`.
- Harness note: personas without an `outbox` answer make tasks wait the real
  30 minute ask timeout. Give the shopkeeper an `outbox: () => 'now'`.

## Then

1. `npm run test:brain`, `node scripts/life-test.mjs`, `node scripts/engine-test.mjs`
   (expect only the 3 old failures), `node --check` on edited host files.
2. Rerun the simulations for `student` and `shopkeeper` (and ideally all).
   With no model key, start the persona in the background
   (`node scripts/sim/run.mjs student --bridge <dir> --out <dir>`) and have
   an AI agent act as the model through `model-bridge.mjs`, without letting it
   read `scripts/sim/personas.mjs` (it must not see the checks). Reports land
   in `<out>/report.md`.
3. Commit and push to `codeply-brain` with a clear message. Do not open a PR
   unless the user asks.
