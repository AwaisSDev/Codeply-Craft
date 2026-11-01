# Codeply Craft

The Codeply AI coding agent as a desktop app, with Codeply Away, a phone app you can
use from anywhere. The agent engine lives in `codeply-cli/` and is bundled
into the app.

## Run

```
npm install
npm start
```

## What it does

- **Wisp, the agent you talk to.** Every Craft chat is led by Wisp (the same
  character as codeply.app/wisp: a pentagon with eyes that follow your cursor,
  morphs, and shows how it feels). Wisp does small things itself. For real work
  it brings in a specialist with `bring_in` (Frontend, Backend, Database,
  DevOps, Security, Testing, Docs), and when nobody fits it creates a new
  specialist with `create_specialist`. Those stay on the team for next time
  (`~/.codeply/wisp/specialists.json`) and Wisp can refine them. You only ever
  talk to Wisp: a specialist works behind it (its steps fold into Wisp's work
  line, with one quiet "Brought in ..." row), and Wisp gets its report plus
  what it really did (files, commands and exit codes from the tool results)
  to check before it answers in its own voice. Ask Wisp who worked on
  something and it can tell you (the chat history records it). Specialists run one
  at a time and cannot bring in others. Wisp's reply starts with a
  `[mood: x]` tag that sets its eyes and colour (it stays a pentagon; only the
  home screen's Wisp morphs, like the website's demo) and is never shown. Account menu, "Wisp
  and its team" turns it off (chats go back to plain Craft and the DSH
  harness) and lists the team. Crew bots' chats and Design are not Wisp's.
  Code: `codeply-cli/lib/wisp.js` (team, prompts, moods), `wisp-desktop.js`
  (runs specialists), `wisp.js` / `wisp-ui.js` / `wisp.css` (the character
  and where it shows). Tests: `npm run test:wisp`.
- **One agent, many roles** (with Wisp off). A single agent does all the work, one step at a
  time. For each task it takes on the role that fits (Frontend, Backend,
  Database, DevOps, Security, Testing, Docs) and holds its work to that role's
  guide (`codeply-cli/agents/*.md`). Nothing runs in parallel.
- **Tasks.** A request with several asks is split into a checklist and worked
  through one task at a time, then a verification pass checks every task
  against the real project and reports task by task.
- **Verified, not claimed.** Every turn is audited against what the tools
  actually did. The agent is sent back if it claims a file change, a test run
  or a deploy that never happened, if it tries to finish without checking
  changed code, or if it glosses over a failed command. Each turn ends with a
  "What actually happened" card built from tool results, not from the model's
  prose.
- **`/goal <objective>`.** Keeps working until the goal is met: work, then an
  independent check that ends in `GOAL_STATUS: ACHIEVED` or `NOT_ACHIEVED`,
  then keep going on what's missing. Bounded to 8 rounds, stoppable, and it
  stops honestly when it's stuck.
- **Models.** "Auto" is Gemma 4 31B on Ollama Cloud, run with Codeply's keys (needs sign-in). Users can add
  their own model (name, OpenAI-compatible base URL, model ID, API key) or
  connect Ollama for local models. Model entries and API keys are stored only
  in `~/.codeply/config.json` on that computer and are only ever sent to the
  base URL the user entered.
- **Supabase and Vercel, full access.** Once connected in Connect Apps, the
  agent can use the whole Supabase Management API (`supabase_api`), run SQL on
  a project (`supabase_sql`), and use the whole Vercel REST API
  (`vercel_api`). Reads run immediately. Anything that changes something asks
  first.
- **Approvals.** Every write, command, and outside action shows an approval
  card. Bypass mode skips them for that run.
- **Modes.** Build, Plan, Ask. Plan and Ask are read-only, enforced in the
  engine.

## Codeply Away (use Craft from your phone, anywhere)

The phone signs in with the same Codeply account. There's no QR code and no
pairing code, and it works on any network as long as the PC is on and signed
in.

How it works: the PC and the phone both connect out to a Supabase Realtime
channel. The channel name includes a random secret stored in the account's own
user metadata, the PC announces itself with presence (so the phone knows
whether it's online), and the PC checks the phone's sign-in token on every
request before doing anything. Every action still runs on the PC behind the
same approvals.

Hosting the phone app:

```
npm run mobile:prepare
```

That writes `mobile-app/`, a static site with no server. Deploy that folder
to Vercel and point `mobile.codeply.app` at it. The desktop app links there
(override with `CRAFT_MOBILE_URL`). The same folder is what Capacitor wraps
for Android (`npm run android:build`).

On the same Wi-Fi, a phone can also open `http://<pc-address>:45671`, which
the PC serves directly.

## Updates

Installed apps check GitHub Releases at startup and every 4 hours.

- A normal update (for example 1.1.0 to 1.1.1 or 1.2.0) downloads in the
  background and installs the next time the app quits. A small "update ready"
  pill offers an immediate restart.
- A required update blocks the app until it's installed. An update is required
  when the major version goes up (1.x to 2.0), or when the GitHub release notes
  contain `[required]`.
- macOS can't auto-install into an unsigned app, so on Mac the same pill or
  screen offers a button that downloads the new .dmg.

To test from source: `CRAFT_TEST_UPDATES=1 CRAFT_TEST_UPDATES_VERSION=1.0.0 npm start`
checks the live release as if the app were 1.0.0.

## Release builds

Connect Apps needs OAuth app credentials. From source they come from `.env`
(see `.env.example`). For an installed build, `npm run dist` (or the release
workflow) runs `scripts/embed-secrets.js`, which bakes them into
`build-secrets.json`. That file is gitignored. The release workflow reads them
from repository secrets named `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET`,
`VERCEL_SLUG`, `SUPABASE_CLIENT_ID`, `SUPABASE_CLIENT_SECRET`,
`OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET` (plus optional Gmail
and Slack ones).

## Tests

```
npm run test:engine
```

This drives the real agent loop against a scripted fake model server. It
covers the claim audit, the verification gate, read-only enforcement, and the
custom model and Ollama backends.

## Files

- `main.js`: Electron main process. Hosts the engine, sessions, approvals,
  models, tasks, `/goal`, the phone relay and the local bridge.
- `preload.js`: the `window.craft` bridge.
- `index.html`, `styles.css`, `app.js`: the desktop renderer.
- `mobile.html`, `mobile.css`, `mobile.js`: the phone app.
- `codeply-cli/lib/agent.mjs`: the agent loop, prompt, claim audit and
  verification gate.
- `codeply-cli/lib/tools.mjs`: tools.
- `codeply-cli/lib/ai.js`: model backends (hosted, custom OpenAI-compatible,
  native Ollama).
- `codeply-cli/lib/config.js`: provider config, user models, integrations.
