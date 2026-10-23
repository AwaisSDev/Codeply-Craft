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
hiring week 12/12, senior 17/18, manager 11/13, artist 10/12, hr 8/9,
student 10/12, shopkeeper 10/12 (12/12 against the fixed checks below).

What the student and shopkeeper runs found, and what was done:
- Shopkeeper: a "back in two hours" note stayed in "Right now" because the
  model guessed ttlHours 4. `remember` now takes `until` (local time) and the
  prompt shows expiry in the user's time, not UTC. Rerun: passes.
- Shopkeeper checks were too literal: "15:00" matched "5 am", and "22:00" /
  "23:00" did not count as 10 / 11 pm. Fixed in personas.mjs.
- Student: the health check-in now goes to Pulse (fixed). It went out a day
  late because the judge model chose not to send it on Thursday ("futsal
  tonight will make up for it"): model judgement, not changed.
- Student: Craft in folder `study-buddy` did not see decisions saved under
  "HackLahore study buddy". `brain.js knownKey` now matches a folder or name
  whose words run whole inside a known project's key (and the other way).
  Not rerun yet.
- A lead bot's "Hand money matters to Hisaab" made it look like the money
  bot (`botDomains` now drops sentences that give work away).
- `life_context` on a topic whose sources were all off (heard, activity)
  returned every source, sensitive ones included. Now refused.
- The bot prompt says which life sources it cannot read, so it does not
  promise to list calls it may not see.
- A plan with only a date is stored as all day, not at a made-up 12:00.
- An email answered through `gmail_send` before the sync read it no longer
  shows as waiting (`noteSent` sets lastTo; the sync checks it).

Seen by the model agents, not fixed yet:
- The "claims a file changed" guard fired twice on an email turn (student
  req 44-45) and the throwaway reply became the recorded answer.
- list_dir reused a cached result after a `run` changed the folder.
- A done to-do ("buy Ayesha a gift") stays open; the brain block shows no ids,
  so the model cannot forget it. Reflection adds duplicate open threads.
- "Right now" doubles names ("with Usman with Usman").
- A bot's own "WHAT YOU HAVE LEARNED" facts are not updated when the brain
  slot changes (shop hours 22:00 stayed next to 23:00).
- The memory extraction call still receives a secret the user typed (ATM PIN),
  though nothing stores it.
- gmail_send has no thread or In-Reply-To, so replies thread by subject only.

## Next

1. Rerun `student` to confirm the project match, and ideally all personas.
   With no model key, start the persona in the background
   (`node scripts/sim/run.mjs student --bridge <dir> --out <dir>`) and have
   an AI agent act as the model through `model-bridge.mjs`, without letting it
   read `scripts/sim/personas.mjs` (it must not see the checks). Reports land
   in `<out>/report.md`. A run cannot resume: if it stops, start it again.
2. Fix what the reports show, rerun the tests, commit and push to
   `codeply-brain`. Do not open a PR unless the user asks.
