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
- Gmail and Calendar gaps the simulation found, now wired end to end:
  `gmail_send`/`gmail_draft` take `cc`; `gmail_read` reads a whole email by
  the `[id]` that `gmail_search` shows; `calendar_add` takes `attendees` (they
  get an invite); `calendar_update` moves, renames or cancels an event by the
  `[id]` that `calendar_list` shows. In `oauth-connectors.js`, `tools.mjs`,
  `agent.mjs` (PARAMS, aliases, recovery, examples, MUTATING_ACTIONS,
  BATCHABLE_TOOLS), `native-tools.mjs`, `bots.js` (calendar approval
  category, status labels), `bots-desktop.js` (cc on the approval card) and
  the sim's fake Google. Sending an email clears that person from
  `gmail.waiting` (`life.js noteSent`).
- Fixes from the simulation: the health check-in goes to the bot that handles
  health before a general life bot (`life-triggers.js` chooseBot, trigger
  `topic`); a plan already on the calendar is not saved again and the
  "leaving" nudge goes out once per event (`life.js sameEvent`); a closing
  promise like "I'll check in next week" no longer trips the stall nudge
  (`agent.mjs` LATER_PROMISE); bots whose domains do not include `code` get
  a one-line skills note instead of the coding skill catalog and per-message
  matches (`agent.mjs` wantsCodeSkills); an event ending on another day shows
  that day; the shopkeeper persona answers its outbox.
- Tests: `npm run test:brain` and `node scripts/engine-test.mjs` all pass.
  `scripts/life-test.mjs` has 1 failure that is date-dependent ("learnFromTurn
  asks for plans and stores them" uses a plan on 2026-10-17, which is now in
  the past) and was there before this work.

Simulation results so far (real Claude agents as the model): farmer 12/12,
hiring week 12/12, senior 17/18, manager 11/13, artist 10/12, hr 8/9. The
student and shopkeeper runs have not finished yet: see below.

## Next

1. Rerun the simulations for `student` and `shopkeeper` (and ideally all).
   With no model key, start the persona in the background
   (`node scripts/sim/run.mjs student --bridge <dir> --out <dir>`) and have
   an AI agent act as the model through `model-bridge.mjs`, without letting it
   read `scripts/sim/personas.mjs` (it must not see the checks). Reports land
   in `<out>/report.md`. A run cannot resume: if it stops, start it again.
2. Fix what the reports show, rerun the tests, commit and push to
   `codeply-brain`. Do not open a PR unless the user asks.
