# Codeply 4.0: UI reference study

Studied 13 Nov 2026 for the Codeply 4.0 app (Rune UI, Node engine). Sources: four X posts, one Instagram reel and seven images the user shared. These are references for feel and quality. **Codeply's design must be its own**: no copied layouts, art, mascots or icons.

---

## 1. What each reference teaches

### A. Capy desktop app (two X posts: @lordspline, Capy's cofounder, and @amritwt, "Capy's UI/UX is just perfect")

- **Sidebar**: New thread, Threads, Issues, Pull requests, Automations, Explore, More. Agents live under **"Captains"**: folders of agents, each with its own small pixel-art avatar, a lock icon when private, an unread count and a last-active time ("2d", "1w"). "Drag Captains here" is an empty drop zone. Threads sit under the agents, with Pinned at the top.
- **Main area**: no chat chrome until you start. One floating composer sits in the middle of the canvas:
  - context chips sit above it: repo, cloud machine (with a live status), "Ask Capy to set up", branch;
  - the box itself reads "Ask anything, / for commands, @ for context";
  - the bottom row has +, a mode toggle, a model chip ("Claude Opus 5.5") and an effort chip ("Low"), plus a square blue send button.
- **Background**: a **dithered, pixel-grid artwork** (halftone dots). It is dark purple fading to teal in the marketing shot, and a near-black dot grid that fades from the top-left in the real app. The texture gives depth without noise.
- **Titlebar**: browser-like tabs ("New thread", +) next to the traffic lights.
- **Marketing trick**: the 10 post images are slices of one wide picture, so swiping the post pans across the app. This is worth copying for Codeply's launch posts.

### B. Devin desktop concept (@jkelleyrtp, "should we make Devin look sick AF?")

- **Home is a bento dashboard** over the same kind of **dithered art**: a pixelated planet horizon in orange and blue.
- **Frosted glass cards** float over the art:
  - the composer ("Ask Devin to build features, fix bugs, or work on your code", with Agent mode, model, mic, voice and send);
  - a GitHub-style **activity heatmap** (380 PRs merged, 259,269 lines);
  - recent sessions, pull requests with times, usage (ACUs, "Resets Dec 1");
  - "This month" stats with deltas in color (36 sessions, 7 PRs merged).
- **Sidebar**: Sessions, New session, Recent (with relative times and a globe icon for shared), Done.
- **Lesson**: the home screen should say *what your agent did for you*. That fits Codeply's ledger and morning message exactly.

### C. Factory-style desktop (user image 3)

- Near-black UI, an **orange dithered gradient** filling the bottom-right corner, and one centered mark with "What should we work on?".
- The composer has an **autonomy level** chip ("High Autonomy", shown as three bars), the model ("Opus 5.5 Fast Mode High"), mic and send. Under it sit Local and folder pickers.
- **Sidebar**: New Session, Inbox with a count, Automations, Code Review, Search, More. Then **Workstreams (Beta)** as long-running projects with ages, and history grouped Today / Last 3 days / Last 7 days / Last 30 days.
- **Lesson**: autonomy as a visible, simple control; long-running work as named workstreams.

### D. Agents app with blob avatars (user image 1)

- Desktop and phone share one design. Each agent is a **soft 3D blob character** in its own color and shape: Chief of Staff (purple sphere), EA (blue drop), Inbox Manager (green cloud), and also Sales Outbound, Talent Scout, Growth Marketer, Customer Support, Expense Manager and Invoice Collector.
- Each sidebar row is avatar, name, time and a **one-line status of what it did** ("Responded in 3 threads, 4 replies ready").
- **The chat shows the agent's work**: an attached PDF card, a linked Slack channel. The right panel shows a **live view of the agent's screen** and its **Routines** (Morning briefing, every day at 8 AM; Inbox cleanup on weekdays; a paused weekly update).
- **The phone home** is a row of big agent avatars, then the agent list with statuses.
- **Lesson**: this is the closest to Wisp and its specialists. Wisp's blue pentagon and its specialists' shapes already fit this world. Routines map to the morning briefing and schedules.

### E. Perplexity onboarding (user image 2)

- A **full-bleed painterly illustration** (a desk in a cactus desert at night) on the top two thirds, fading into black.
- Logo and wordmark sit centered, with three stacked pill buttons (Apple, Google, email) and quiet links at the bottom.
- **Lesson**: onboarding earns trust with one beautiful image and very few choices.

### F. Juno health app (user images 4 to 7)

- **Light, airy cards** on near-white. A strong title and two round icon buttons (one black + button) head each screen.
- A **week strip of rings** shows each day's progress.
- **One hero card per tab**: an energy battery with a glow, a meds gauge "2/3", a symptom bar chart.
- The **mascot chip floats above the tab bar** with an action ("Log with Juno", "Plan with Juno", "Talk to Juno"). It changes per tab.
- **Gamified tasks**: XP rewards, streak flame, trophy count.
- The **home** has a sky gradient, a sleepy mascot on a cloud and "Happy Monday, Liam. I'm here if you need me."
- The **paywall** is calm: a Free vs Premium table on a blue-to-cloud gradient, with "Continue for free" as the main button.
- **The icon pack** is the standout: 3D clay icons (heart, chat bubble with eyes, sun and cloud, pill, trophy, leaf, brain, calendar, flame, pencil, thermometer, lotus, question mark, moon, shower, bread, water drop, lungs, briefcase, phone, plant, spiral, muscle, battery). Every icon has the same soft studio lighting from the top-left, gentle highlights, no outlines, saturated but warm colors, and slightly chubby proportions.
- The founders' line: great design needs human taste, finesse, expertise and creativity.

### G. "How I get Claude Code to make app UIs that look and move like this" (@BreejeAnadkat; the motion reference)

**How they work** (from the thread's images):
1. Give Claude Code **reference screenshots plus a screen recording** of the motion you like, and describe the feeling ("unique smooth animation", "dark theme with liquid glass").
2. Then iterate with **exact, small fixes**: name the screen, give hex colors (good #E0A150, best #38CD76), and fix corner radius, text and gauge structure one by one.
3. Spec **component states** explicitly. Their swipe-to-add button has three: idle (grey knob), touched (white knob with a green glow behind it), and dragging (a green trail fills behind the knob and the label turns mint as it is revealed).

**The demo video, frame by frame** (5.1 s, 1200x1080, stepped at 1/30 s and at 1/60 s around the check-off):
- **Onboarding (left phone), 0 to 0.8 s:**
  - the logo fades and scales in at the center (0 to 0.1 s);
  - the headline rises in one line at a time with fade and blur ("Meet Baller," then "where live prediction" then "meets social layer.", about 70 ms apart);
  - 3D objects (burger, ball, cup, popcorn, sneaker, goal net) **pop in around the edges, staggered**, with a slight overshoot; a sneaker slides in from the right;
  - the ball rises from the bottom and keeps **bobbing**, and every object floats a little all the time;
  - the sign-in buttons slide up and fade in, Google first and Apple about 60 ms later (0.53 to 0.77 s).
- **Dashboard (right phone), 0 to 0.4 s:** a white sheet dissolves into the dashboard, rows **cascade in top to bottom** (about 35 ms apart), and the streak number **counts up** (0 Days, 1 Day, 3 Days).
- **Checking off a task**, about 500 ms in total:
  - 2.683 s: the counter flips "0/5" to "1/5" at once, and the dashed circle becomes a **green blob that swells** (about 50 ms);
  - 2.73 to 2.85 s: the blob **bursts into confetti** (green and blue squares and dots);
  - 2.82 s: the filled blue check **pops in** while the row tints mint;
  - by about 3.2 s the particles have drifted outward and faded.
- **Camera**: the presentation zooms into the right phone and back out (2.0 to 2.75 s, then 4.4 to 5.0 s). That is promo camera work, not app motion.

### H. "20 Design Terms You Should Know" reel (@charles.unemployed; 25.7 s, sampled every 0.5 s plus the final list)

The 20 terms, to be used as a checklist for Codeply:

| # | Term | # | Term |
|---|---|---|---|
| 1 | Kerning | 11 | OKLCH (color space) |
| 2 | Optical centre | 12 | Widow |
| 3 | Tabular numbers | 13 | Safe area |
| 4 | Layout shift | 14 | Stagger |
| 5 | Tracking | 15 | Line length (about 65 characters reads best) |
| 6 | Optimistic update | 16 | Affordance |
| 7 | x-height | 17 | Combobox |
| 8 | Touch target | 18 | Interruptible animation |
| 9 | Leading | 19 | Progressive disclosure |
| 10 | Origin-aware animation | 20 | Shared element transition |

Plus the five from the caption: orphan, tinted neutral, skeleton screen, ease-out (for anything entering) and empty state.

---

## 2. What this means for Codeply 4.0

1. **One world, two moods.**
   - The desktop is dark and calm, with **dithered art in Codeply blue** (from the Capy, Devin and Factory references).
   - The phone and onboarding are light and warm, with soft 3D characters and clay icons (from Juno and the agents app).
   - Wisp and its team are the bridge: the same characters on both.
2. **The home screen shows what Wisp did** (from Devin, and the agents app's status lines). Cards: morning briefing, what got done with proof, drafts waiting, today, agents working now.
3. **Agents are characters.** Each Claude Code agent and each specialist gets a shape, a color and a status line, Wisp's pentagon leads, and a live screen view and routines sit beside the chat.
4. **The composer holds context.** Chips above it show the project, where it runs (Local or Cloud) and the branch; chips inside it show the model (Haze 2 or the user's own), effort and autonomy.
5. **Motion rules:**
   - **ease-out** for anything entering;
   - **stagger** lists by 30 to 40 ms;
   - text comes in **line by line** with fade and blur;
   - numbers **count up** using **tabular numbers** so they don't jitter;
   - completing a task gets the **blob, burst, check** moment (about 500 ms);
   - idle characters **float** slightly;
   - every animation can be **interrupted** and starts from where the click was;
   - opening a card into a page is a **shared element transition**;
   - loading uses **skeletons**, and nothing shifts the layout.
6. **Respect the craft list** in section 1H on every screen.
7. **Existing Codeply rules still hold:** no monospace in the UI, no little status dots in pills or labels, no em dashes in copy.

## 3. The custom icon pack ("Codeply Clay")

The goal is a fully custom set with Juno's level of quality, but drawn for Codeply's world, not copied.

- **Style spec** (written once, used for every icon):
  - soft 3D clay, one key light from the top-left with a soft fill, gentle specular highlights, a faint contact shadow;
  - no outlines, rounded chubby forms, the same camera angle (front, a slight tilt);
  - Codeply's palette: Wisp blue as the lead, plus warm accents;
  - 1024 px masters, exported at 16 to 128 px with simplified small-size versions.
- **First set** (from Codeply's own features):
  - inbox and mail, calendar, briefing (sunrise), task check, draft (pencil), meeting (camera), voice (mic), memory (brain or a lit lamp), routine (clock loop);
  - agents (Wisp pentagon), cloud run, browser, code, deploy (rocket), approval (hand), privacy (shield), settings (gear);
  - search, streak (flame), trophy, phone, plugin (puzzle).
- **How to make them:** generate the masters with an image model from the one style spec, keeping the same prompt skeleton, seed habits and lighting words for every icon. Then hand-pick, touch up for consistency and redraw the small sizes. Each icon is checked side by side against the full set before it is accepted.
- **Where they show:** the phone and onboarding everywhere, and on the desktop only in empty states, the home cards and the agent avatars. Small desktop UI icons stay as clean line icons for clarity.

## 4. Open questions for the user's UI plan

- The desktop art: one fixed Codeply piece, or a set the user can pick from (the existing Appearance wallpapers)?
- Should the phone stay light and the desktop stay dark, or should both follow the system?
- Should the clay icons also replace the desktop sidebar icons, or stay in hero and empty states only?
