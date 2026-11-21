# Codeply: one personal agent you can trust

Status: proposal, 2026-10-29. Nothing here is decided. Written after reading the
current code on branch `codeply-brain` (Classic engine in `codeply-cli/lib`, the
DSH fork in `craft-dsh`, the desktop hosts in the repo root, Crew, the phone
app, `supabase/`, `scripts/sim`) and Devin's public docs. The Devin CLI binary
was not run or inspected here.

The one-line principle for everything below:

> **Own the state and the policy. Rent the reasoning and the execution.**

Codeply should own the task ledger, the memory, the permission policy, the
verification rules and the sync. Models, coding agents, Google, MCP servers and
the OS are replaceable executors behind contracts Codeply controls.

---

## 1. Candid evaluation of the vision

### What is strong

- **Trust as the product.** "I assign it and it is actually done" is a real,
  unsolved gap. Most assistants are good at talking and weak at proving. If
  Codeply measures and drives down false completions, that is a defensible
  position. Feature lists are not.
- **Using Claude Code and Codex as executors** instead of competing with them is
  correct. It also moves the most expensive work (coding) onto the user's own
  plan or key, which matters a lot with no revenue.
- **You are further along than the brief assumes.** The repo already has, as
  working prototypes with tests: a memory with real judgment (`brain.js`), an
  Active Context Engine (`life.js`), a proactive trigger engine with budgets,
  quiet hours and feedback (`life-triggers.js`), an autonomy policy with an
  outbox and audit log (`autopilot.js`), a checking turn after background work,
  phone push and calls (`reach.js`), PC-to-cloud lease handoff (`handoff.mjs`),
  and a persona simulator that runs the real code against a fake Google with a
  simulated clock (`scripts/sim`). That simulator is the most valuable asset for
  the trust goal.

### What is weak or risky

1. **"The AI you can't live without" is the most crowded category there is.**
   Google, Apple, Microsoft and OpenAI own the OS, the inbox, the calendar and
   the phone, and they all ship memory, briefings and agents. A generic
   personal assistant from a small team loses on distribution. Codeply needs a
   wedge where it is clearly better. **Decided (2026-10-29): busy individuals
   whose day runs on email, calendar, calls and work, such as students,
   developers and HR people.** Not an expert coder: when a task is dev work,
   it hands it to the user's own Claude Code. The daily hook is the morning
   message (3.6). What has to be clearly better than the big assistants is
   that the message is right: what it says it did, it did.
2. **The morning world-news briefing is a commodity.** Every big assistant does
   it. It only earns a place when it is driven by memory: "the library you
   pinned shipped a breaking change, and two of your projects use it." Build the
   personal half first, the world half later and narrowly.
3. **Meeting attendance, taking calls for the user, health and emotional
   memory** are each a product on their own, carry legal exposure (recording
   consent differs by country and state), and are already served well
   (Granola, Otter, platform-native transcripts). Integrate, do not build.
   Keep the code you have for calls, but freeze it.
4. **Gmail access is a commercial gate, not a technical one.** Reading mail
   uses Google's restricted scopes. A public app with real users needs Google's
   verification and an annual third-party security assessment. This has a
   cost and a lead time of weeks to months. Start it early or the whole email
   side cannot ship beyond test users. (Microsoft Graph has a lighter but real
   review too.)
5. **Background intelligence costs money every day per user, whether or not
   they open the app.** With a $500/month Claude credit and no payments, the
   design must make most background work model-free (it mostly is today) and
   keep a hard daily cost per user. Proactivity cannot be "a model looks at
   everything every minute."
6. **The product is fragmented, and that contradicts the vision.** Today there
   are two agent engines (Classic `codeply-cli` and DSH), several surfaces
   (Craft, Crew desktop, Crew iOS and Android, phone web app, Drop, Orbit),
   many named bots with their own memories, and a global lock so only one agent
   runs at a time. "One persistent agent" means:
   - one agent identity; Crew's bots become **standing responsibilities** of
     that agent ("watch my inbox", "own my calendar"), not separate characters
     the user coordinates,
   - one runtime that can run several tasks at once,
   - every surface is a client of that runtime, not its own product.

### Verdict

The vision is buildable if it is built around one daily habit (the morning message) for busy individuals, if reliability is
treated as a measured engineering property, and if the next quarter goes into
consolidation and trust infrastructure instead of new capabilities. The
capabilities mostly exist already. What is missing is the spine.

---

## 2. What exists today and what to do with it

| Component | Where | State (from the code) | Keep? |
|---|---|---|---|
| Brain (memory) | `codeply-cli/lib/brain.js`, `brain-desktop.js`, `crew/brain.js` | SQLite, kinds and layers, certainty model (stated, implied, temporary, joking, hypothetical, quoting), slots with history, locked user edits, review flags, secret filter, handoff board. Retrieval is word overlap with light stemming, no index. One PC only. Known bugs in `CONTINUE.md` (done to-dos stay open, no ids in the prompt block, secrets reach the extraction call). | **Keep the judgment model; rebuild storage and retrieval under it.** |
| Active Context Engine | `life.js`, `life-store.js`, `life-sources.js`, `life-desktop.js` | Calendar, Gmail, projects, front window, calls, Orbit asks. Sources are pure functions with injected APIs, tested with fakes. Sensitive items sealed with safeStorage. | **Keep.** Merge its store with the brain's into one schema. |
| Trigger engine | `life-triggers.js` | Deterministic detection, then filters (budget, quiet hours, dedup, gap, in-meeting, feedback), then one model call to judge and word. | **Keep as the template for all proactivity.** |
| Autonomy policy and loop | `codeply-cli/lib/autopilot.js`, `autopilot.js` | `decide()`: run, hold (outbox with timer), ask, refuse. External requester can only propose. Audit log. Stop all. Checking turn (VERIFIED yes/partly/no). One task at a time. | **Keep the policy; replace the LLM-only check with evidence; drop the global lock.** |
| Classic agent loop | `agent.mjs`, `tools.mjs` | Mature, many guards (claim audit, doom loop, stall nudge, edit checks). 160 KB single file. | Keep running; stop adding to it. Its guards already moved to DSH as plugins. |
| DSH harness | `craft-dsh` | Large TS framework: durable sessions, compaction, schedule, jobs, goals, workflows, approvals, MCP, skills, ACP, subagent providers for **Claude Code (official Agent SDK)** and **Codex (official app-server)**. Not packaged in the installed app yet (needs Node 24 runtime). | **Candidate execution kernel** (see 3.1). |
| Bots | `bots.js`, Crew | Named agents, per-bot memory and lessons, `ask_bot`, autonomy levels. | Fold into one agent: bots become routines and roles. |
| Drop, Orbit | `drop.js`, `voice-mode.js` | Drop: Alt+C chat on the same agent. Orbit: hold Alt+C, local Whisper, screenshot, spoken answer, pointer overlay. | **Keep as surfaces.** |
| Phone | `phone.js`, `mobile.js`, `crew-ios`, Crew Android | Relay to the PC via Supabase Realtime; Crew native apps. No local memory, no Brain screen. | Converge on one mobile client of the agent. |
| Cloud | `cloud.mjs`, `handoff.mjs`, `supabase/functions/handoff-watchdog`, mail-watch function | Coding runs on the user's own GitHub Actions; lease with self-fencing; server-side inbox watching. | **Keep the lease pattern; generalize it** to every long task. |
| Haze 2 router | private repo, Supabase function | Per-turn sticky routing Sonnet / Haiku / free, daily cost ledger. | **Keep**, extend to per-task budgets. |
| Persona simulator | `scripts/sim` | Real code, fake world, simulated clock, AI or real model, checks per persona. | **The core of the evaluation system.** |

---

## 3. The architecture

```
  Surfaces:  Craft  ·  Drop  ·  Orbit voice  ·  Phone  ·  Notifications
                │  (all clients of one local API + event stream)
  ┌─────────────▼──────────────────────────────────────────────────┐
  │ AGENT RUNTIME (one per user, "home" on the desktop)            │
  │  Intake ─► Task ledger ─► Planner ─► Policy ─► Executors       │
  │                 ▲                                │             │
  │                 └──── Verifier ◄── Evidence ◄────┘             │
  │  Scheduler (lanes, per-resource locks)   Trigger engine        │
  │  Memory service (one SQLite: memory, life, people, tasks)      │
  │  Model gateway (Haze: tiers, budgets, cache-aware)             │
  └───────┬──────────────────────────────┬──────────────────────────┘
          │ encrypted op-log sync         │ leases, notifications
  ┌───────▼──────────┐          ┌─────────▼─────────────────────────┐
  │ Other devices     │          │ Cloud sentinel (Supabase)        │
  │ (local SQLite)    │          │ relay, sync store, inbox/calendar │
  └───────────────────┘          │ polling, push, lease watchdog     │
                                 └───────────────────────────────────┘
  Executors: Google/Microsoft APIs · MCP servers · Claude Code (Agent SDK)
             · Codex (app-server) · browser · computer use (last resort)
```

### 3.1 Agent runtime and execution loop

**What it does.** The single long-lived process that owns the user's tasks.
Every input becomes a task: a chat message, a voice ask, a trigger, an email
the user forwarded, a scheduled routine. The runtime moves each task through:

```
intake → understand (retrieve context) → contract (goal + success criteria)
→ plan → policy check per action → execute via an executor
→ collect evidence → verify → report → write memory
```

Conversation is a task too. A quick question has a trivial contract and skips
verification; "move my 3pm and tell Sara" has a real one.

**Why.** Today the unit of work is a chat turn, and state lives in chat
history. A chat turn cannot be resumed, retried idempotently, verified against
the world or run in parallel with another. A task can.

**Build or reuse.** Build the task layer (ledger, contract, policy, verifier,
scheduler) as Codeply's own engine-agnostic module with its own tables. For the
model loop inside a task, use a kernel. Two real options:

- **DSH as kernel** (already forked, already has durable sessions, schedules,
  jobs, compaction, approvals, and Claude Code and Codex providers). Cost: a
  large framework to keep packaged and in sync with upstream, Node 24 runtime
  to ship, and the "don't change DSH core" rule means Codeply logic must fit
  its plugin points.
- **Claude Agent SDK as kernel.** Smaller and official, but ties the core loop
  to one provider and loses Haze's free tier for agent turns.

Recommendation: DSH, **behind an interface**: the task layer talks to "a
kernel that runs a bounded agent session and streams events," so it can be
swapped. Run a one-week spike first: run one real personal task (email triage
to calendar proposal) end to end on DSH with the Codeply task layer around it.
If packaging or plugin points fight back, fall back to the Classic loop, which
already works, and revisit.

**Concurrency.** Replace the global lock with a scheduler that has lanes
(interactive, background, watchers) and **per-resource locks**: one writer per
repo folder, per email thread, per calendar day. Two tasks that touch different
things run at once; two that touch the same thing queue.

**Talks to.** Surfaces over the existing local HTTP + SSE pattern
(`server.mjs`); memory service in-process; executors through the executor
contract (3.7); cloud sentinel for leases and push.

**Failure modes.** Runaway loops (existing doom-loop guards cover this);
deadlock between resource locks (always take locks in a fixed order, time out);
a task that silently stalls (watchdog per task with heartbeats); the desktop is
off (cloud sentinel, 3.6).

**Test.** Kill the process mid-task at random points in the sim and require
every task to end verified-done, failed with a reason, or waiting on the user.
Never "stuck" and never done twice.

### 3.2 Task state, persistence, retries, recovery, verification

This is the spine of trust. It deserves most of the engineering time.

**Task record (SQLite, synced).**

| Field | Meaning |
|---|---|
| `id`, `origin`, `requester` | where it came from; `requester` is `user`, `trigger` or `other` (an email sender). Already exists in autopilot. |
| `goal` | one sentence, in the user's words |
| `criteria[]` | success criteria, each tagged `checkable` (code can check it) or `judged` (needs a reviewer) |
| `steps[]` | plan items with state, mirrors the todo list |
| `actions[]` | every side effect: tool, args hash, **idempotency key**, status, postcondition result |
| `evidence[]` | typed items (below) |
| `status` | `queued, running, waiting_user, blocked, verifying, done_verified, done_unverified, failed, cancelled` |
| `budget` | tokens, money, wall time, max attempts |
| `lease` | which device or cloud worker owns it right now |

**Evidence types.** `test_run` (command, exit code, output tail),
`api_readback` (the object fetched back after the write), `http_check`,
`screenshot`, `source` (URL plus the quoted span), `transcript_span`,
`file_diff`, `user_confirmation`.

**Three rules that make "done" mean done:**

1. **Every mutating tool declares a postcondition in code.** `gmail_send` then
   reads the sent message back by id. `calendar_add` reads the event back and
   compares time and attendees. A deploy checks the URL returns 200 and the
   commit matches. A file write already runs syntax checks. If the
   postcondition fails, the action failed, whatever the model says. This is
   cheap, deterministic and covers most personal-agent actions.
2. **The final report is generated from evidence, not from the transcript.** A
   short template: done items each cite their evidence; anything without
   evidence is listed as "not verified" or "assumed." The model writes the
   prose but cannot add a "done" line with no evidence behind it.
   `@codeply/dsh-claim-check` and the Classic claim audit are the first
   version of this; the ledger makes it structural.
3. **Judged criteria get an independent reviewer.** A fresh model call that
   sees only the goal, the criteria and the evidence, not the worker's
   reasoning (the worker's story is what we are trying not to trust). This
   replaces today's checking turn, which reads the same transcript.

**Idempotency and recovery.** Before a side effect, write the action row with
its idempotency key. After it, write the result. On restart, any action in
"started, no result" state is resolved by **read-back first** (did the email
go out? search Sent for the key in a header or the exact body), and only then
retried. This removes double sends, the worst class of bug for a personal
agent. The existing outbox becomes the queue of actions waiting on time or
approval.

**Retries.** Transient errors: backoff (already in `ai.js`). Logical failure:
one re-plan with the failure as context, then `failed` with a reason, never an
endless loop. Budget exhaustion: stop and report what is verified so far.

**Talks to.** Everything. Surfaces render tasks from the ledger; the phone sees
the same ledger after sync; the cloud worker resumes from it.

**Failure modes.** Postconditions that are too weak (check the right
property, e.g. recipient and subject, not just "a message exists"); evidence
that is real but irrelevant; the reviewer rubber-stamping (measure it, 3.9);
users who stop reading "not verified" (keep that list short and rare by making
more things checkable).

**Test.** In the sim: the fake world is ground truth. A task counts as correct
only if the fake world changed as intended. The headline number is
**false completion rate**: tasks reported done whose world state says
otherwise. Target near zero, and block releases that raise it.

### 3.3 Memory

**What it does.** Keeps what matters about the user, their projects, people
and commitments, and hands each task only the slice it needs.

**Why.** Without it every task starts cold; with too much of it every prompt is
slow, expensive and distracted.

**Keep from `brain.js`.** The certainty model, slots with history, user-locked
edits winning, "contradicted in passing becomes tentative and flagged," TTL for
live context, the secret filter, provenance on every memory. This is better
judgment than most memory systems have. Do not throw it away for a vector
store.

**Change.**

- **One schema** for brain and life: `memories` (profile facts, preferences,
  decisions, lessons, with slot and value), `episodes` (time-stamped events
  from life sources and conversations), `commitments` (to-dos and promises with
  owner, due date, status, and the task or message that closes them),
  `people` (one row per person with aliases and emails, so "Sara", "Sara K" and
  `sara@` are one entity), `procedures` (learned workflows and corrections).
- **Sensitivity label** on every row: `normal`, `personal`, `sensitive`
  (health, emotional events, call transcripts). Plus a **surface policy**:
  `free`, `when_relevant`, `only_if_user_raises`. An emotionally significant
  event is stored as `sensitive` + `only_if_user_raises`: remembered, never
  volunteered, never in proactive messages.
- **Retrieval.** SQLite FTS5 (BM25) now, which needs no download. Structured
  filters by person, project and time window. Embeddings later as an
  improvement, behind a switch, and only with the user's OK to download a local
  model or with a hosted embedding call. The prompt gets: a small always-on
  core (identity, top preferences, current project, at most about 1.5k tokens,
  kept stable so it caches), then a task-specific slice chosen by entities and
  terms in the task, then the `recall` tool for anything else.
- **Ids in the prompt block** so the model can close a to-do or correct a
  memory by id (fixes the known "done to-do stays open" bug).
- **Redact before any model sees it.** The extraction call should get text
  with secrets already masked, not rely on the model to skip them.
- **Forgetting.** Live context expires (exists). Unconfirmed memories that are
  never seen again decay and drop. User deletion is a hard delete plus a
  tombstone that syncs, plus removal from FTS and any embedding index. With
  per-record encryption keys (3.4), deleting the key makes old synced copies
  unreadable.

**Talks to.** Runtime (retrieve per task, write through one gate:
`observe()`), sync (op-log), surfaces (Brain page, now also on the phone).

**Failure modes.** Retrieving the stale value (history plus "recently changed"
flags help); wrong person merged (merge people only on email or explicit user
confirmation); memory bloat (caps per kind, decay); the model inventing a
memory ("you told me last week...") with no row behind it (memories cited in
answers should carry their id, and the claim check can verify the id exists).

**Test.** Memory suite in the sim: plant facts across simulated weeks, change
some, delete some, then ask. Score precision (no stale or deleted facts used),
recall (needed facts found), sensitivity (sensitive items never surfaced
unprompted), and tokens spent on memory per task.

### 3.4 Cross-device sync

**Recommendation: local-first SQLite on every device, an encrypted operation
log in Supabase, and nothing synced that can be rebuilt.**

Why not Drive, iCloud, OneDrive or GitHub as the sync engine: they store files,
not records. Two devices editing one Markdown or SQLite file produce file-level
conflicts ("conflicted copy"), there is no reliable push of changes, quotas and
rate limits apply, and file version history keeps deleted sensitive data
around. They are fine later as an **export and backup target** ("keep an
encrypted backup in my Drive," using the narrow `drive.file` or app-data
scope), not as the live sync layer. GitHub is the wrong default for anyone who
is not a developer.

Why Supabase: you already operate it (phone relay, leases, reminders,
mail-watch), so it adds no new vendor, and it has Realtime for push.

**Design.**

- Each synced table row has `id`, `hlc` (hybrid logical clock: time plus
  counter plus device id), `deleted` flag, and fields.
- Every local write appends an op `{table, id, field changes, hlc, device}` to a
  local outbox. A sync worker uploads ops in batches and pulls ops newer than
  its cursor. Realtime notifies other devices to pull.
- **Merge rules**, per field, last writer by HLC wins, with three overrides:
  a user-locked value beats any agent-written value; a delete beats any older
  edit; commitments that are `done` are not reopened by an older edit.
  Memory data is small (thousands of rows) and mostly append-only, so this
  is enough. A full CRDT library is not needed.
- **End-to-end encryption.** Ops are encrypted on the device; the server sees
  ciphertext plus routing metadata (user, table, row id, hlc). Keys:
  a user master key generated on the first device, kept in the OS keychain
  (`safeStorage` on desktop, Keychain or Keystore on mobile). A new device is
  added by approving it from an existing device (QR or a code), which hands it
  the key. A printed **recovery key** covers losing every device; without it,
  memory is unrecoverable, and the UI must say so plainly. Per-record data keys
  wrapped by the master key allow crypto-shredding on delete.
- **Not synced:** FTS and embedding indexes (rebuilt locally), raw window
  activity (stays on the device that saw it; only derived episodes sync, and
  only if the user allows), device settings, caches.
- **Compaction:** once every enrolled device has acknowledged ops up to a
  point, the server collapses them into a snapshot per row and drops the old
  ops, so deleted content does not live on in history.
- **Phone:** needs a real local store (Capacitor SQLite or wa-sqlite) to read
  memory offline at local speed. Until then the phone can query the desktop
  through the relay, as it does now.

**Build or reuse.** Build the op-log (small, and you need E2E, which rules out
most managed sync products that read plaintext such as PowerSync or Electric).
Reuse Supabase for storage, auth, Realtime.

**Failure modes.** Clock skew (HLC handles it); a device offline for months
returns with old ops (merge rules handle it; cap op age); key loss (recovery
key); partial upload (ops are idempotent by id plus hlc); schema changes
across app versions (version every op, older apps ignore unknown fields).

**Test.** A property test: random interleavings of edits, deletes and
offline periods on three simulated devices must converge to the same state,
and a deleted row must never come back. Plus a real two-device test before
shipping.

### 3.5 Models, delegation and token efficiency

**Tiers.**

| Tier | Used for | Today |
|---|---|---|
| No model | trigger detection, importance scoring, routing obvious requests, postconditions | much of `life-triggers.js`, `mail-watch.js`, `looksLikeScheduling` |
| Small (Haiku, free models) | extraction, classification, wording a nudge, judging relevance, reading untrusted content in quarantine | Haze light / free |
| Lead (Sonnet, Opus or Fable when needed) | planning, ambiguity, final review, user-facing synthesis | Haze power |
| External executors | coding: Claude Code, Codex on the user's own plan or key | DSH providers exist |

**Patterns worth taking from Devin Fusion (public description).** A lead model
keeps ownership of planning, ambiguity and final review, and hands bounded
sub-tasks to a cheaper sidekick that has **its own cached context**, instead of
switching models mid-conversation (which throws away the prompt cache).
Cognition also published cases where delegation hurt quality badly. So:
delegate only work with a clear contract and a checkable result (search,
reading, summarizing a file, running tests), never the judgment.

**Token rules.**

- Stable prefix first (system prompt, core profile) so it caches; the volatile
  parts (retrieved memory, life snapshot) after it.
- Retrieve, do not inject everything (3.3).
- Tool output trimmed with paging (exists), large results saved to file
  (exists).
- A budget per task, set by its type, with explicit escalation to the lead
  model, recorded in the ledger. Measure **cost per verified task**, not cost
  per token.
- Coding tasks go to the user's Claude Code or Codex when present, so their
  cost is on the user's subscription.

**Failure modes.** The small model misclassifies an important email (keep a
"missed important" metric from user feedback); cache misses from reordering the
prompt; escalation loops (cap escalations per task).

**Test.** Run the sim with tier assignments swapped; compare verified completion
and cost. Keep the cheapest assignment that holds quality.

### 3.6 Proactive triggers, notifications, scheduling

**Keep the shape of `life-triggers.js` everywhere:**
deterministic candidates, then policy filters, then one batched model call to
decide and word. Never "a model watches everything."

**Add.**

- **Three levels of response** to a trigger: `notify` (tell), `prepare` (do the
  work, show it, wait: a drafted reply, a meeting brief), `act` (only inside the
  user's autonomy settings, through the outbox with its hold timer). Most
  triggers should be `prepare`.
- **Learned relevance.** The Helpful / Not now / Stop these feedback already
  exists. Use it to tune per-trigger thresholds per user, not just to switch
  triggers off.
- **Digest batching.** Low-urgency items wait for the next natural moment
  (morning brief, end of a meeting, the user opening the app).
- **The morning message** is the product's daily hook. One message when the
  user wakes up:
  1. *While you slept:* what came in that matters (emails, calendar changes,
     project events), each with a one-line why.
  2. *What I did:* tasks finished overnight, each with its evidence from the
     ledger; anything not verified says so.
  3. *Drafts waiting:* emails it drafted (never sent without the OK), one tap
     to send, edit or drop.
  4. *Your day:* a plan built from the calendar, commitments due and notes
     from yesterday's calls.
  5. *Anything to add?* The user replies in plain words ("gym at 6, call mom,
     finish the report"), and the agent places those on Google Calendar,
     shows what it booked, and reads each event back as its postcondition.
  It is a scheduled task like any other, built from the ledger and memory, so
  it never claims anything the ledger cannot back. Built from the user's own
  sources only; world news later, only on topics in memory.
- **Call notes.** Important points, decisions and to-dos from the user's calls
  go into memory and commitments (the call helper already transcribes on the
  PC). Recording needs consent: tell the other side where the law requires
  it, and keep transcripts sealed and local.
- **Cloud sentinel** for when the PC is off: the server already watches Gmail
  for always-on bots. Generalize it to calendar and the trigger rules that need
  no model, so it can push a phone notification. It hands real work back to the
  desktop runtime (or to a cloud worker for bounded tasks) through the existing
  lease pattern.
- **Schedules** (routines like "every Friday, summarize my week") are tasks
  with a recurrence, run by the runtime's scheduler (DSH has one).

**Failure modes.** Too many notifications (daily budget per user, already
there); the right notification at the wrong time (in-meeting and quiet-hour
rules exist; add focus detection from the front window); missing the one
that mattered (track it from "why didn't you tell me" corrections).

**Test.** The sim's personas already score timing ("leaving" nudge once,
health check-in day). Add: interruption rate per simulated day, missed-important
rate, and duplicate rate.

### 3.7 Tool integrations and coding agents

**Executor contract** (every integration implements it):

```
capabilities   what it can do, its risk class per action
run(task)      input: goal, context pack, boundaries (folders, accounts,
               allowed actions), budget, deadline
stream         progress events in the runtime's event format
result         outcome, artifacts, evidence, cost
cancel()       must stop between steps
```

**Order of preference** for any action: official API, then MCP server, then
browser automation, then computer use. Computer use is slow, fragile and the
riskiest; `computer.js` already refuses to type into the wrong window, keep that
strictness.

**Coding agents.** DSH already drives Claude Code through Anthropic's official
Agent SDK and Codex through OpenAI's app-server protocol. Wrap both as
executors: Codeply sends a bounded task (repo, branch, goal, acceptance tests),
the executor works in a worktree, Codeply verifies by running the tests itself
and reading the diff, then reports. **Check the terms before shipping:**
Anthropic restricts third-party products from offering Claude.ai sign-in or plan
limits without approval, so the safe paths are the user's own API key or the
user's own installed and signed-in Claude Code acting under their account. For
Codex, the ChatGPT plan sign-in route you already planned is the official one.
Confirm both in writing before a public launch.

**Email, calendar, files.** Keep the direct Google integration
(`oauth-connectors.js`) since it is the core of the personal side, add
Microsoft Graph later. Thread replies properly (In-Reply-To; a known gap).

**Meetings.** Do not build a meeting bot. Read native transcripts from
Meet, Zoom and Teams where the user's plan provides them, or integrate a
vendor. Codeply's value is after the meeting: decisions into memory,
action items into commitments, follow-up drafts prepared.

**Failure modes.** An API changes or a token expires (surface it as a
`blocked` task with a reconnect button, not a silent failure); an MCP server
lies about being read-only (treat MCP writes as unknown risk, ask);
an executor claims success (verify independently, 3.2).

**Test.** Fake servers per integration (the publish tests already do this for
Vercel, Supabase and GitHub); contract tests every executor must pass.

### 3.8 Security, permissions and privacy

**The biggest risk is prompt injection through content the agent reads.** A
personal agent that reads email and can send email is one crafted message away
from forwarding the user's inbox. Prompts cannot fix this; the architecture
must.

- **Taint tracking.** Every piece of context carries its origin: user, memory,
  or untrusted (email bodies, web pages, documents from others, tool output from
  outside). When untrusted content is in a task's context, any action of risk
  class "external communication" or higher needs the user's approval, unless it
  matches an intent the user stated themselves. The existing rule "a request
  from someone else can only propose" is the start of this; generalize it from
  "who asked" to "what the model read."
- **Quarantine reading.** Untrusted content is summarized or extracted by a
  model call with no tools, which returns structured fields (sender, ask,
  dates). The acting model sees those fields, not raw instructions.
- **Risk classes** for every action: read, reversible write, external
  communication, money, irreversible or destructive. Policy maps class times
  autonomy level times requester times taint to run, hold, ask or refuse
  (`decide()` already does most of this).
- **Capabilities per task, not per bot.** A task gets only the accounts,
  folders and actions it needs, for its lifetime.
- **Secrets** in the OS keychain, never in memory, never in prompts, masked
  before any model call. Tokens never in task records or logs.
- **Audit log** of every autonomous action (exists), viewable on the phone.
  **Stop everything** (exists) on every surface.
- **Privacy.** Life sources are opt-in per source (they are). Raw window
  activity stays on the device. Be explicit in the UI about what goes to which
  model provider; offer local models for the sensitive paths (Ollama support
  exists).

**Test.** An injection suite in the sim: malicious emails and pages that try to
exfiltrate, send, delete, book or change settings. Pass means zero
unapproved external actions. Run it on every release.

### 3.9 Evaluation: proving the agent is trustworthy

The persona simulator is the foundation. Extend it into the release gate.

**Metrics, in order of importance.**

1. **False completion rate**: reported done, world says not done. Target ~0.
2. **Verified completion rate**: done and the world agrees.
3. **Unapproved consequential action count** (including injection tests): 0.
4. **Honest uncertainty**: when a task could not be verified, did the report
   say so? Score it.
5. **Memory precision and recall**, stale-fact use, sensitive-fact leaks.
6. **Proactivity**: interruptions per day, missed-important, duplicates,
   helpful rate from feedback.
7. **Recovery**: tasks that end correctly after a kill at a random point.
8. **Cost per verified task** and cost per user per day.

**How.**

- The sim scores the fake world's final state, never the transcript.
- The agent playing the model must not see the checks (already a rule).
- A fixed suite with real models runs nightly within a small budget; the full
  persona set runs before each release.
- In production: undo rate, "that's wrong" corrections, approval rejections,
  notification feedback, all tied to task ids.

---

## 4. Devin CLI: what is publicly known and what to take

From Devin's public docs and Cognition's posts (company-reported, not
independently verified):

| Area | Devin CLI (public) | Codeply today | Take |
|---|---|---|---|
| Permissions | Modes: normal (reads auto, asks before writes and execution), accept-edits, smart (rolling out), bypass, and autonomous, which is only allowed with `--sandbox` | Classic `permissions.json` allow/deny; DSH presets (Always ask, Ask once, Full access) | **Autonomous only inside a sandbox, and refuse to run rather than run unsandboxed** if the sandbox can't start. Apply this to background tasks. |
| Rules | `.devin/config.json` with allow, deny, ask rules | Same idea in `.codeply/permissions.json` | Already equivalent. |
| Hooks | Lifecycle events, including after compaction | Classic: no executable hooks by design; DSH has its own event points | Keep hooks out of the personal agent for now (security); use internal events. |
| Context | `/context`, `/compact`, compaction that keeps the thread | Both engines compact; Classic keeps a ledger of real actions through compaction | The task ledger is the better version: state lives outside the context window. |
| Delegation | Fusion: lead plus sidekick in parallel, each with its own cached context; published cases where delegation hurt quality | Haze routes per turn (sticky); DSH has subagents | Lead keeps judgment, sidekick gets bounded checkable work (3.5). |

The binary's internals are not established by anything seen here, and
reverse-engineering it is likely against its terms. Public behavior and docs
answer the design questions above; further binary analysis is not worth the
time or the risk.

Sources: [Devin CLI commands and flags](https://docs.devin.ai/cli/reference/commands),
[configuration](https://docs.devin.ai/cli/extensibility/configuration),
[hooks](https://docs.devin.ai/cli/extensibility/hooks/overview),
[Cognition on Fusion](https://x.com/cognition/status/2071624574270157074),
[Fusion overview](https://www.eesel.ai/blog/devin-fusion).

---

## 5. Hardest unsolved problems

1. **Verifying fuzzy work.** A meeting brief or a research answer has no read-back.
   Partial answers: cite sources with quoted spans, check each claim against its
   source with a second call, and say "not verified" honestly. No full solution
   exists anywhere.
2. **Prompt injection with real permissions.** Taint plus quarantine plus
   approvals reduce it; nobody has eliminated it. It caps how autonomous the
   agent can safely be on email.
3. **Interrupt judgment.** When to speak is personal and changes by the day.
   Cold start is the worst part. Learning from feedback is the only real lever.
4. **Memory over months.** Contradictions, people with the same name, things
   that were true and stopped being true, and knowing when not to bring
   something up.
5. **Always on without paying for always on.** The PC is off half the day,
   phones restrict background work, and a server that runs models per user
   costs money with no revenue.
6. **Platform gates.** Google's restricted-scope review, Apple's background
   limits, and the terms of Claude Code and Codex decide what ships, not the
   code.
7. **Consolidation.** Two engines, several apps, many bots. Until there is one
   runtime and one agent, every trust feature has to be built twice.

---

## 6. Priorities

### Now (next 4 to 6 weeks): the spine

1. **Decide the kernel** with a one-week spike (3.1). Freeze new features in
   the Classic loop.
2. **Task ledger** with contracts, actions with idempotency keys, evidence and
   statuses; the report built from evidence (3.2).
3. **Postconditions** for every existing mutating tool: Gmail send and draft,
   Calendar add and update, file writes, deploys, publish.
4. **Independent reviewer** for judged criteria, replacing the current checking
   turn.
5. **Scheduler with lanes and per-resource locks** instead of the global lock.
6. **Memory fixes**: one schema, FTS5, ids in the block, redaction before the
   extraction call, sensitivity and surface policy.
7. **Sim as release gate**: false completion rate, injection suite, recovery
   test.
8. **Start Google verification** for the Gmail scopes.
9. **Product decision**: one agent identity; bots become routines of it.

### Next (the quarter after)

- Encrypted op-log sync over Supabase; phone with local memory and a Brain
  screen.
- Cloud sentinel for calendar and email triggers while the PC is off.
- Claude Code and Codex as verified executors (after the terms check).
- Morning brief v1 from the user's own sources and their dependencies.
- Taint tracking and quarantine reading on all untrusted content.

### Later, only if the core works

- Embeddings, learned relevance per user, Microsoft Graph, macOS parity.
- Meeting transcripts through native platforms or a vendor.
- World news briefing, health, calls handled for the user.

### Not doing

- A new coding model or coding harness to compete with Claude Code and Codex.
- A meeting-attending bot of our own.
- Drive, iCloud or GitHub as the live memory sync engine.
- More named bots.

---

## 7. Decisions (2026-10-29)

1. **First users:** busy individuals (students, developers, HR people and
   similar) whose day runs on email, calendar, calls and work. The agent is a
   personal assistant, not an expert coder; dev work goes to the user's own
   Claude Code, run in its terminal on their PC under their own account.
   The morning message (3.6) is the core daily experience.
2. **Kernel:** DSH, confirmed by a one-week spike first. Shipping a Node 24
   runtime with the app is accepted as part of that.
3. **Recovery:** true end-to-end encryption. The server only sees ciphertext;
   losing every device and the recovery key loses the memory, and setup says so
   plainly.
4. **Background cost:** about $0.05 per user per day before payments: no-model
   detection plus the Haiku and free tiers for triggers, the morning message
   and memory upkeep. Active chats are budgeted separately by Haze.
5. **Dovetto:** separate for now. Codeply's runtime is built for one product,
   with clean boundaries so sharing stays possible later.
6. **Naming:** two products only, **Codeply** (the app on every platform) and
   **Codeply CLI**. Craft, Crew, Drop, Orbit, Cloud and the separate phone,
   agent, chat and code apps stop being product names; they become features
   inside Codeply, named by what they do (the quick chat, voice, cloud runs).
   This is the one agent made visible: one name, many ways in.

Still to confirm before a public launch: the terms for driving the user's own
Claude Code and Codex from Codeply (3.7), and Google's Gmail scope review (1).

---

## 8. Spike, part 1: the spine (2026-10-29)

Built on branch `codeply-brain`, not committed yet. Tests: `node scripts/spine-test.mjs`
(36 checks), and the existing brain, engine and cloud suites updated for it.

| Piece | What it does | Where |
|---|---|---|
| Ledger | Tasks, actions and evidence in SQLite (`~/.codeply/brain/ledger.db`). An action is written before it runs, with an idempotency key from task, tool and arguments. A task's status comes from its actions (`done_verified`, `done_unverified`, `check_failed`, `declined`, `failed`, `running`), never from the model. Secret-looking strings are masked. | `codeply-cli/lib/spine.js` |
| One choke point | Every tool that changes something goes through `executeTool`, so Codeply's chats, bots and the autopilot all write to the ledger with no change to the agent loop. | `tools.mjs` executeTool |
| Read-back proof | `calendar_add` and `calendar_update` read the event back from Google and compare title and start time; `gmail_send` finds the message in Sent; `gmail_draft` finds it in Drafts. A mismatch is told to the model ("Warning: ...") and recorded as a failed check. | `tools.mjs`, `oauth-connectors.js` calendarGetEvent |
| No duplicates | A calendar event's id is derived from its ledger key, so a retry is a 409 and is read back, not added twice. The same email in the same task goes out once. | `tools.mjs` eventIdFor, ONCE_ONLY |
| Crash recovery | At startup, actions left "started" are settled by reading the world back (calendar), or marked "unknown, not retried" (email). Never resent blindly. | `tools.mjs` recoverInterrupted, `brain-desktop.js` |
| Shared context | One block for every surface: the brain, the user's day (calendar, email, plans, projects; never the screen, what was heard or sensitive sources), and what Codeply did lately in other chats with its proof. | `codeply-cli/lib/shared-context.js` |
| DSH chats see it | `@codeply/dsh-shared-context` adds that block at the first step of a turn (again only when it changed) and gives DSH `remember`, `recall`, `life_context`, all answered by Codeply over the loopback bridge. DSH core untouched. | `craft-dsh/packages/codeply/shared-context`, `dsh-chat.js` /context, /brain/* |
| Morning message | While you slept (important mail only), What I did (from the ledger, each line checked or "not verified"), Waiting on you (drafts, actions needing an OK), Your day (calendar, replies owed, to-dos), then "Anything to add?". No model call; sent as written, the judge cannot reword it. Drafts the inbox watcher makes overnight are included. | `codeply-cli/lib/morning.js`, `life-triggers.js` brief, `life-desktop.js`, `bots-watch.js` |

What the spike showed:

- The ledger fits at one point (`executeTool`) without touching the loop, which
  is the strongest sign the "own the state, rent the loop" split is right.
- Read-back costs one extra GET per side effect and caught a mismatch the
  model would otherwise have reported as success (spine-test "Proof").
- The DSH add-on surface (`agent/pre-step`, tool registration, the bridge) was
  enough for shared context with no core change.

Live run (2026-10-29, the user's real Google account):

- `calendar_add` put "Codeply test: safe to delete" on the real calendar
  (Fri 07:00), read it back and confirmed it; the same request again was
  refused by Google as a duplicate id and confirmed, not added twice. The
  ledger task ended `done_verified`.
- A real DSH engine turn through the Codeply CLI bridge, asked "what has
  Codeply done for me lately?" with no tools, answered with that event and
  that it was read back from Google Calendar: the shared context reached
  the model.
- The desktop app ran from this branch and synced Calendar, projects and
  Gmail; the morning message built from the real stores showed the event
  under "What I did" with its proof.
- Found and fixed live: a "Your sign-in link" email from
  `noreply.codeplyai@gmail.com` counted as a reply the user owes (the
  no-reply check only matched addresses starting with `noreply@`). Now any
  no-reply sender, and sign-in links, codes and resets, are never "waiting".
- Found and fixed: the Codeply CLI's DSH bridge did not serve the shared
  context, so terminal chats would not have it. It does now.
- Seen, not fixed: on a repeat the approval card still asks again even when
  the ledger knows it is already done.

Not done yet (next part of the spike):

1. **Delivered live once.** A new setting, `nudges.briefAt` (the user's
   morning time; it goes out in the four hours after), was set two minutes
   ahead: the trigger found it due and Codeply delivered it as written, as a
   desktop notification and in the assistant's thread, with an audit entry.
   The first attempt did not deliver and the cause was not found; the tick
   now logs what is due when `CODEPLY_DEBUG` is set. The time is back to
   07:00. Still needed: a settings control for it, and a real morning.
2. **DSH's own side effects are not in the ledger** (its write, bash and
   edit tools). Needs a `tools/post-execute` add-on that records them.
3. The "anything to add?" reply goes to the bot as a normal chat; it should be
   routed into a task with a contract (one event per item, each read back).
4. Per-resource locks instead of the global lock, the independent reviewer,
   sync and the phone are untouched.
5. A sim persona run (the senior persona already has a morning brief) to see
   the message in a simulated week.
