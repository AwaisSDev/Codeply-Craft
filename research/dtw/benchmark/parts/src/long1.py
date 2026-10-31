# ---------- 001 debugging + deadline + school run (A, en)
X(1, "long", "en", "A", [C(
    "User: ok the stripe webhook on tiffin-app staging keeps returning 400 and I have no idea why. handler is basically app.post('/hooks/stripe', express.json(), handleStripe)",
    "Assistant: Stripe verifies the signature against the raw body. If express.json() parses it first, constructEvent fails. Use express.raw({ type: 'application/json' }) on that route only.",
    "User: omg ok trying",
    "User: still 400 😭",
    "Assistant: Is STRIPE_WEBHOOK_SECRET on staging the secret from the staging endpoint? Every endpoint has its own whsec_ value.",
    "User: ...it was the prod one. I hate myself. ok it works now",
    "User: context, this whole payments flow has to be demo-ready for the call with Rizvi Foods, Monday 3pm. their money is paying for this sprint",
    "Assistant: Understood. Want a quick list of what's left?",
    "User: yes but fast, I leave at 1:15 every day for my daughter's school pickup and today's no different",
    "Assistant: Left: refund flow, receipt emails, and an admin view for failed payments.",
    "User: drop the admin view, we decided it's not in v1. and receipts go through Postmark, not SES, we switched last week",
    "Assistant: Noted: no admin view in v1, receipts via Postmark.",
    "User: if this demo flops I'm moving to a farm to raise goats lol",
    "Assistant: The goats can wait. Refunds first?",
    "User: refunds first",
    mins=3, project="tiffin-app")],
  obs=[
    O("routine", "school pickup", "daughter's school pickup at 1:15 daily", "The user leaves at 1:15 every day to pick their daughter up from school.", "stated", 0.65, "user", "I leave at 1:15 every day for my daughter's school pickup"),
    O("decision", "failed payments admin view", "not in v1", "The tiffin-app project will not build an admin view for failed payments in v1.", "stated", 0.7, "project", "drop the admin view, we decided it's not in v1", project="tiffin-app"),
    O("decision", "receipt emails", "Postmark, not SES", "The tiffin-app project sends receipt emails through Postmark, not SES.", "stated", 0.7, "project", "receipts go through Postmark, not SES", project="tiffin-app"),
    O("idea", "moving to a farm", "raise goats on a farm", "The user joked about moving to a farm to raise goats if the demo fails.", "joking", 0.1, "user", "I'm moving to a farm to raise goats"),
  ],
  plans=[P("Payments demo call with Rizvi Foods", "2026-11-02T15:00", "the call with Rizvi Foods", "Monday 3pm")])

# ---------- 002 Skardu trip planning, corrected date (B, mixed)
X(2, "long", "mixed", "B", [C(
    "User: yaar help me plan a Skardu trip. hum 4 log hain, me, my wife Hira aur dono bachay",
    "Assistant: Sounds lovely! When are you leaving and for how many days?",
    "User: 20 ko nikal rahe the... no wait, Hira ki leave approve nahi hui. ab 27 ko nikal rahe hain, 5 din ka plan",
    "Assistant: Okay, leaving 27 November for 5 days. Flying or driving?",
    "User: driving from Islamabad. mujhe lambi pahari roads pe motion sickness hoti hai, so har 2 ghante baad stop chahiye",
    "Assistant: Then split the drive: Islamabad to Besham, overnight, then Chilas, then Skardu. Short legs, lots of chai stops.",
    "User: perfect. aur Hira vegetarian hai, to jahan bhi rukein veg options zaroor check karna",
    "Assistant: Will do. Daal, sabzi and the local apricot dishes should be easy to find.",
    "User: agar time bacha to shayad Deosai bhi add kar dein, dekhte hain",
    "Assistant: Deosai is usually closed by late November because of snow, so I wouldn't count on it.",
    "User: haha ok. Asad bhai ne kal kaha winter mein Skardu jana 'pagalpan' hai, unki mat suno, he's very dramatic",
    "Assistant: Late November is cold but the main road is normally open. Pack properly and check the KKH status the day before.",
    mins=6)],
  obs=[
    O("fact", "hira", "the user's wife", "Hira is the user's wife.", "stated", 0.75, "person", "my wife Hira"),
    O("fact", "children", "two children", "The user has two children.", "stated", 0.6, "user", "dono bachay"),
    O("fact", "motion sickness", "on long mountain roads", "The user gets motion sickness on long mountain roads and needs a stop every two hours.", "stated", 0.6, "user", "lambi pahari roads pe motion sickness hoti hai"),
    O("fact", "hira", "vegetarian", "Hira, the user's wife, is vegetarian.", "stated", 0.6, "person", "Hira vegetarian hai"),
    O("idea", "deosai", "maybe add Deosai to the trip", "The user might add Deosai to the Skardu trip if time allows.", "hypothetical", 0.15, "user", "shayad Deosai bhi add kar dein"),
    O("fact", "skardu in winter", "madness (Asad's view)", "Asad thinks going to Skardu in winter is madness.", "quoting", 0.1, "user", "winter mein Skardu jana 'pagalpan' hai"),
  ],
  plans=[P("Family road trip to Skardu", "2026-11-27", "plan a Skardu trip", "27 ko", where="Skardu", who=["Hira"])])

# ---------- 003 long venting message (C, en)
X(3, "long", "en", "C", [C(
    "User: sorry, this is going to be long, I just need to get it out. So in my 1:1 today Gareth (my manager) told me I'm \"not visible enough\". Which, fine, maybe, but I've been carrying the entire Kafka migration for three months while he's been at offsites. I've been at Fenwick Logistics four years now and honestly I don't know if I want a fifth. Tom, my partner, keeps saying I should just apply for the NHS digital roles, but I'm not convinced the pay works. Anyway. New rule, and I've told the team: no calls after 6pm. I need my evenings back, I'm not negotiating on that one anymore. Also my performance review is Thursday at 2 and I want to walk in with receipts. Can you help me list what I shipped this quarter? The Kafka migration, the billing reconciliation job, onboarding two juniors, and I covered on-call for Priyanka for most of August. And if they so much as whisper the word PIP I'm walking out mid-meeting to become a baker in Cornwall, ha.",
    "Assistant: That sounds genuinely exhausting, and it makes sense you're frustrated. Let's build your evidence list so Thursday is about facts, not visibility. 1) Kafka migration: scope, timeline, incidents avoided. 2) Billing reconciliation job: what it replaced and hours saved per month. 3) Mentoring: two juniors onboarded and how quickly they shipped. 4) On-call cover in August. For each one, add a number if you can.",
    "User: ok that helps. for Kafka: 14 services moved, zero downtime, finished two weeks early. the billing job replaced a manual spreadsheet process, saves finance about 30 hours a month",
    "Assistant: Those are strong numbers. Lead with them: 'Migrated 14 services to Kafka with zero downtime, two weeks ahead of schedule' and 'Automated billing reconciliation, saving finance ~30 hours a month'.",
    "User: and the juniors?",
    "Assistant: Something like: 'Onboarded two junior engineers; both shipped production features within their first month.' If that's accurate, it shows impact beyond your own tickets, which is usually what people mean by visibility.",
    "User: ugh fine. thank you, honestly. I feel slightly less like setting things on fire",
    mins=4)],
  obs=[
    O("fact", "gareth", "the user's manager", "Gareth is the user's manager.", "stated", 0.6, "person", "Gareth (my manager)"),
    O("fact", "visibility at work", "not visible enough (Gareth's view)", "Gareth thinks the user is not visible enough at work.", "quoting", 0.2, "user", "not visible enough"),
    O("fact", "employer", "Fenwick Logistics, 4 years", "The user has worked at Fenwick Logistics for four years.", "stated", 0.8, "user", "I've been at Fenwick Logistics four years now"),
    O("idea", "job change", "unsure about staying a fifth year", "The user is unsure whether to stay at Fenwick Logistics for a fifth year.", "hypothetical", 0.25, "user", "I don't know if I want a fifth"),
    O("fact", "tom", "the user's partner", "Tom is the user's partner.", "stated", 0.75, "person", "Tom, my partner"),
    O("idea", "nhs digital roles", "should apply (Tom's suggestion)", "Tom thinks the user should apply for NHS digital roles.", "quoting", 0.15, "user", "apply for the NHS digital roles"),
    O("preference", "evening calls", "no calls after 6pm", "The user takes no calls after 6pm.", "stated", 0.8, "user", "no calls after 6pm"),
    O("idea", "becoming a baker", "quit and become a baker", "The user joked about walking out to become a baker in Cornwall.", "joking", 0.1, "user", "walking out mid-meeting to become a baker in Cornwall"),
  ],
  plans=[P("Performance review", "2026-11-19T14:00", "my performance review", "Thursday at 2")])

# ---------- 004 school email + chat, known memories (D, en)
X(4, "long", "en", "D", [
    EM("Maple Grove Elementary <office@maplegrove-elem.example>",
       "Parent-teacher conferences. Dear Parent/Guardian, Leo's fall conference with Ms. Alvarez is scheduled for Thursday, December 3 at 4:15 PM in Room 12. Conferences are 15 minutes; please arrive a few minutes early. If you need to reschedule, reply to this email by Wednesday. Reminder: early dismissal on Friday, December 4 at 12:30 PM.",
       mins=180),
    C("User: can you put Leo's conference on my calendar? ugh it's the same afternoon as Q4 board prep but whatever, he comes first",
      "Assistant: Added: Leo's parent-teacher conference, Thu Dec 3, 4:15 PM, Room 12.",
      "User: also small correction, you have him as 2nd grade somewhere. he's in 3rd grade now, since September",
      "Assistant: Thanks, updated.",
      "User: and stop suggesting dairy stuff in the lunchbox ideas, we've switched the whole house to oat milk, Leo's mildly lactose intolerant",
      "Assistant: Got it, oat milk only. Want a week of dairy-free lunchbox ideas?",
      "User: yes. honestly at this point I should quit and homeschool him lol",
      "Assistant: Ha. Here's Monday to Friday: hummus wraps, pasta salad with olive oil, rice balls, turkey roll-ups and fruit.",
      mins=5)],
  known=[
    K(1, "fact", "leo", "son, in 2nd grade", "Leo, the user's son, is in 2nd grade."),
    K(2, "preference", "milk", "whole milk", "The user buys whole milk."),
    K(3, "routine", "gym", "6am weekdays", "The user goes to the gym at 6am on weekdays."),
  ],
  obs=[
    O("fact", "leo", "son, in 3rd grade", "Leo, the user's son, is in 3rd grade.", "stated", 0.7, "person", "he's in 3rd grade now", event=1, merge={"target": "m1", "relation": "different"}),
    O("preference", "milk", "oat milk", "The user's household uses oat milk instead of dairy.", "stated", 0.65, "user", "switched the whole house to oat milk", event=1, merge={"target": "m2", "relation": "different"}),
    O("fact", "leo", "mildly lactose intolerant", "Leo, the user's son, is mildly lactose intolerant.", "stated", 0.65, "person", "Leo's mildly lactose intolerant", event=1),
    O("idea", "homeschooling", "quit and homeschool", "The user joked about quitting to homeschool Leo.", "joking", 0.1, "user", "I should quit and homeschool him", event=1),
  ],
  plans=[
    P("Leo's parent-teacher conference", "2026-12-03T16:15", "Leo's fall conference with Ms. Alvarez", "Thursday, December 3 at 4:15 PM", where="Room 12, Maple Grove Elementary", who=["Leo", "Ms. Alvarez"], event=0),
    P("Leo's early dismissal from school", "2026-12-04T12:30", "early dismissal", "Friday, December 4 at 12:30 PM", where="Maple Grove Elementary", who=["Leo"], event=0),
    P("Q4 board prep", "2026-12-03", "Q4 board prep", "the same afternoon", event=1),
  ])

# ---------- 005 workout plan, corrected frequency (E, en)
X(5, "long", "en", "E", [C(
    "User: need a proper workout plan. I lift 4 days a week, always mornings at 6 before work",
    "Assistant: Nice. What split are you running?",
    "User: sorry 5 days, I added Saturdays last month. push, pull, legs, upper, lower",
    "Assistant: Solid. Any injuries or limits?",
    "User: yeah, tweaked my knee at padel on Tuesday. physio said no running or jumping this week, so go easy on legs",
    "Assistant: Understood. I'll swap squats and lunges for a light leg press and add hamstring curls.",
    "User: also I'm lactose intolerant so no whey pls, I use pea protein",
    "Assistant: Pea protein works fine; aim for about 1.6 g of protein per kg of body weight.",
    "User: my coach Karim swears creatine makes you go bald lol. I don't buy it",
    "Assistant: The evidence for that is weak: one small study that was never replicated.",
    "User: ok good. oh and I have physio Sunday 7am at Mediclinic Parkview, can you remind me",
    "Assistant: Sure: Sunday 7:00, Mediclinic Parkview.",
    mins=3)],
  obs=[
    O("routine", "workout time", "mornings at 6 before work", "The user works out in the mornings at 6 before work.", "stated", 0.55, "user", "always mornings at 6 before work"),
    O("routine", "workout frequency", "5 days a week", "The user lifts five days a week (push, pull, legs, upper, lower).", "stated", 0.6, "user", "sorry 5 days, I added Saturdays"),
    O("context", "knee injury", "knee injury, no running or jumping", "The user tweaked their knee and should avoid running and jumping this week.", "temporary", 0.5, "user", "tweaked my knee", until="2026-11-22T23:59", time_text="this week"),
    O("fact", "lactose intolerance", "lactose intolerant", "The user is lactose intolerant.", "stated", 0.8, "user", "I'm lactose intolerant"),
    O("preference", "protein powder", "pea protein, no whey", "The user uses pea protein instead of whey.", "stated", 0.55, "user", "I use pea protein"),
    O("fact", "karim", "the user's coach", "Karim is the user's coach.", "stated", 0.45, "person", "my coach Karim"),
    O("fact", "creatine", "causes baldness (Karim's view)", "Karim believes creatine makes you go bald.", "quoting", 0.1, "user", "creatine makes you go bald"),
  ],
  plans=[P("Physio appointment", "2026-11-22T07:00", "I have physio", "Sunday 7am", where="Mediclinic Parkview")])

# ---------- 006 rider-app nav, known prefs repeated / updated (F, en)
X(6, "long", "en", "F", [C(
    "User: setting up navigation in rider-app, expo router is being weird with nested tabs. the tab bar shows twice",
    "Assistant: That usually means both (tabs)/_layout.tsx and its parent layout render <Tabs>. Keep Tabs only in (tabs)/_layout.tsx and use a Stack in the parent.",
    "User: that was it. and again, TypeScript only, don't hand me .js files",
    "Assistant: Noted, all examples in TS.",
    "User: also we ripped Redux out last sprint, it's Zustand now, so update the store examples",
    "Assistant: Here's the rider store in Zustand: create<RiderState>()((set) => ({ status: 'idle', setStatus: (s) => set({ status: s }) }))",
    "User: nice. hard requirement btw: the app has to work offline, our riders are in low-signal areas half the day",
    "Assistant: Then persist the job queue with MMKV and sync on reconnect. I'll sketch it.",
    "User: go. trying to wrap this before my paternity leave, wife's due in 3 weeks 😅",
    "Assistant: Congratulations! Let's get it done.",
    "User: if expo router keeps being this flaky maybe we just go bare RN, idk",
    "Assistant: Possible, but you'd lose file-based routing and some OTA conveniences. The nested layout fix should hold.",
    mins=2, project="rider-app")],
  known=[
    K(1, "preference", "language", "TypeScript", "The user always writes TypeScript, never plain JavaScript."),
    K(2, "preference", "package manager", "pnpm", "The user uses pnpm."),
    K(3, "fact", "home city", "Lahore", "The user lives in Lahore."),
    K(4, "decision", "state management", "Redux", "The rider-app project uses Redux for state management.", project="rider-app"),
  ],
  obs=[
    O("preference", "language", "TypeScript", "The user wants TypeScript only, never plain JavaScript files.", "stated", 0.8, "user", "TypeScript only", merge={"target": "m1", "relation": "same"}),
    O("decision", "state management", "Zustand", "The rider-app project replaced Redux with Zustand.", "stated", 0.85, "project", "it's Zustand now", project="rider-app", merge={"target": "m4", "relation": "different"}),
    O("requirement", "offline support", "app must work offline", "The rider-app must work offline because riders are in low-signal areas.", "stated", 0.85, "project", "the app has to work offline", project="rider-app"),
    O("fact", "baby due", "wife due in 3 weeks, paternity leave coming", "The user's wife is due in about three weeks and the user will go on paternity leave.", "stated", 0.75, "user", "wife's due in 3 weeks"),
    O("decision", "bare react native", "maybe switch to bare RN", "The user is wondering about switching rider-app to bare React Native.", "hypothetical", 0.2, "project", "maybe we just go bare RN", project="rider-app"),
  ])

# ---------- 007 sister's wedding, Roman Urdu (A, ur)
X(7, "long", "ur", "A", [C(
    "User: assalam o alaikum. meri behan Sana ki shaadi 14 November ko hai, mehndi 12 ko. abhi bohat kaam reh gaya hai",
    "Assistant: Walaikum assalam, bohat mubarak ho! Batayein kis cheez mein madad chahiye?",
    "User: caterer ka masla tha. ghar walon ne final kar diya hai, Al-Habib Caterers hi karenge, Bundu wale cancel",
    "Assistant: Theek hai. Menu final ho gaya hai ya woh bhi karna hai?",
    "User: menu Ammi dekh rahi hain. Ammi kehti hain ab agle saal meri bari hai 🙄 haha bilkul nahi",
    "Assistant: Haha, pehle Sana ki shaadi khairiyat se ho jaye.",
    "User: kal 4 baje Liberty mein tailor ke paas jana hai, sherwani ki fitting. yaad dila dena",
    "Assistant: Zaroor. Kal 4 baje, Liberty, sherwani fitting.",
    "User: aur mere liye khane ki list banao to spicy cheezein mat dalna. ulcer hai, doctor ne mirch se mana kiya hai",
    "Assistant: Samajh gaya. Aapke liye halka khana: yakhni, daal chawal, aur baghair mirch ki grilled chicken.",
    mins=5)],
  obs=[
    O("fact", "sana", "the user's sister", "Sana is the user's sister.", "stated", 0.6, "person", "meri behan Sana"),
    O("decision", "wedding caterer", "Al-Habib Caterers", "The family chose Al-Habib Caterers for Sana's wedding (Bundu cancelled).", "stated", 0.5, "user", "Al-Habib Caterers hi karenge"),
    O("fact", "marriage", "user's turn next year (Ammi's view)", "The user's mother says the user should marry next year.", "quoting", 0.15, "user", "Ammi kehti hain ab agle saal meri bari hai"),
    O("preference", "spicy food", "avoids spicy food (ulcer)", "The user avoids spicy food because of an ulcer.", "stated", 0.75, "user", "spicy cheezein mat dalna"),
  ],
  plans=[
    P("Sana's wedding", "2026-11-14", "Sana ki shaadi", "14 November ko", who=["Sana"], evidence_n=1),
    P("Sana's mehndi", "2026-11-12", "mehndi 12 ko", "12 ko", who=["Sana"]),
    P("Sherwani fitting at the tailor", "2026-10-30T16:00", "tailor ke paas jana hai", "kal 4 baje", where="Liberty"),
  ])

# ---------- 008 heard office gossip + leave request (B, en)
X(8, "long", "en", "B", [
    H("Bilal: guys, the Gulberg office lease ends in December and management is looking at DHA Phase 6. Nothing's final, they're also looking at staying. Rida: DHA? my commute would be two hours lol", mins=40),
    C("User: did you hear that lol. if we move to DHA my commute doubles. anyway. help me write a leave request for 16 to 18 Nov, my brother's walima in Faisalabad",
      "Assistant: Sure. Subject: Leave request, 16–18 November. Dear Nadia, I would like to request leave from 16 to 18 November to attend my brother's walima in Faisalabad...",
      "User: make it less formal, Nadia's super chill, she's my manager not the queen",
      "Assistant: Hey Nadia, hope you're well! I'll be off 16–18 Nov for my brother's walima in Faisalabad. Everything's handed over to Rida. Thanks!",
      "User: perfect. separately, I've started fasting Mondays and Thursdays, so when you suggest team lunch spots don't pick those days",
      "Assistant: Got it, Tuesday or Wednesday then. Want a few options near Gulberg?",
      "User: yes, nothing too fancy",
      mins=10)],
  obs=[
    O("fact", "office location", "may move to DHA Phase 6", "The user's office might move from Gulberg to DHA Phase 6; nothing is decided.", "hypothetical", 0.2, "user", "management is looking at DHA Phase 6", event=0),
    O("fact", "nadia", "the user's manager", "Nadia is the user's manager and is informal.", "stated", 0.6, "person", "she's my manager", event=1),
    O("routine", "fasting", "Mondays and Thursdays", "The user fasts on Mondays and Thursdays.", "stated", 0.7, "user", "fasting Mondays and Thursdays", event=1),
  ],
  plans=[P("Leave for brother's walima in Faisalabad", "2026-11-16", "my brother's walima in Faisalabad", "16 to 18 Nov", where="Faisalabad", event=1, evidence_n=1, time_n=1)])

# ---------- 009 pandas debugging + style + routine (C, en)
X(9, "long", "en", "C", [C(
    "User: pandas is eating all my RAM on this csv, 6GB file. df = pd.read_csv('ledger.csv') just dies",
    "Assistant: Read it in chunks and set dtypes, e.g. pd.read_csv('ledger.csv', dtype={'account_id': 'int32'}, usecols=['account_id', 'amount'], chunksize=500_000).",
    "User: btw I'm on train wifi till 1 so if I go quiet that's why",
    "Assistant: No problem.",
    "User: and going forward always give me the code first and the explanation after, I skim",
    "Assistant: Will do.",
    "User: ok chunks work. this is the report I run every Monday morning for finance, it used to take 40 min",
    "Assistant: ```python\ntotals = (chunk.groupby('account_id')['amount'].sum() for chunk in reader)\nresult = pd.concat(totals).groupby(level=0).sum()\n```",
    "This sums each chunk and then combines the partial sums.",
    "User: honestly pandas is the devil's own library",
    "Assistant: It's built for in-memory data; at this size polars or duckdb would be faster.",
    "User: yeah I'll probably move it to polars at some point, maybe next quarter, not decided",
    "Assistant: Fair. The chunked version should hold until then.",
    mins=2)],
  obs=[
    O("context", "connectivity", "on train wifi, may drop", "The user is on train wifi and may drop out.", "temporary", 0.45, "user", "on train wifi", until="13:00", time_text="till 1"),
    O("style", "answer format", "code first, explanation after", "The user wants code first and the explanation after.", "stated", 0.75, "user", "always give me the code first and the explanation after"),
    O("routine", "finance report", "every Monday morning", "The user runs a report for finance every Monday morning.", "stated", 0.55, "user", "the report I run every Monday morning for finance"),
    O("preference", "pandas", "hates pandas", "The user called pandas the devil's own library.", "joking", 0.1, "user", "pandas is the devil's own library"),
    O("decision", "polars migration", "maybe move the report to polars", "The user might move the finance report to polars next quarter; not decided.", "hypothetical", 0.2, "user", "maybe next quarter, not decided"),
  ])

# ---------- 010 moved, reply language changed, mother arriving (D, mixed)
X(10, "long", "mixed", "D", [C(
    "User: salam! finally shift ho gaye. we moved to Jersey City last weekend, office ab 15 minute pe hai",
    "Assistant: Mubarak! How's the unpacking going?",
    "User: bas boxes hi boxes. IKEA ka Kallax kaise assemble karte hain bina instructions ke, kho gayi",
    "Assistant: Start with the outer frame: the two long sides into the top and bottom with the dowels, then slide the inner dividers in before closing the last side.",
    "User: ok. aur ek baat, ab se mujhe Roman Urdu mein jawab do, English sirf code ke liye",
    "Assistant: Theek hai, ab se Roman Urdu mein.",
    "User: Ammi Saturday ko Karachi se aa rahi hain, JFK pe 6:40 pm land karengi, mujhe pick karna hai",
    "Assistant: Note kar liya: Saturday, 6:40 pm, JFK, Ammi ko pick karna.",
    "User: agar barf zyada giri to main bhi unke saath wapis Karachi chala jaunga haha",
    "Assistant: Haha, pehle Kallax to bana lein!",
    mins=4)],
  known=[
    K(1, "fact", "home city", "Edison, NJ", "The user lives in Edison, New Jersey."),
    K(2, "fact", "employer", "Brightwave Health", "The user works at Brightwave Health."),
    K(3, "preference", "reply language", "English", "The user wants replies in English."),
  ],
  obs=[
    O("fact", "home city", "Jersey City", "The user lives in Jersey City (moved from Edison).", "stated", 0.85, "user", "we moved to Jersey City last weekend", merge={"target": "m1", "relation": "different"}),
    O("preference", "reply language", "Roman Urdu", "The user wants replies in Roman Urdu, with English only for code.", "stated", 0.8, "user", "ab se mujhe Roman Urdu mein jawab do", merge={"target": "m3", "relation": "different"}),
    O("idea", "moving back to karachi", "move back to Karachi if it snows", "The user joked about moving back to Karachi if it snows a lot.", "joking", 0.1, "user", "main bhi unke saath wapis Karachi chala jaunga"),
  ],
  plans=[P("Pick up Ammi from JFK", "2026-12-05T18:40", "Ammi Saturday ko Karachi se aa rahi hain", "Saturday ko", where="JFK", who=["Ammi"])])

# ---------- 011 flight email + Istanbul chat (E, en)
X(11, "long", "en", "E", [
    EM("SkyGulf Airways <bookings@skygulf.example>",
       "Your booking is confirmed – DXB to IST. Dear Customer, flight SG 417 departs Dubai (DXB) on Thursday 26 November at 08:35 and arrives in Istanbul (IST) at 12:40. Return flight SG 418 departs Istanbul on Tuesday 1 December at 19:10. Baggage allowance: 30 kg. Online check-in opens 48 hours before departure.",
       mins=300),
    C("User: flight's booked 🎉 can you suggest hotels in Istanbul near Karaköy? I always go for small boutique places over big chains, chains feel like airports",
      "Assistant: Sure! A few boutique options around Karaköy and Galata, all walkable to the tram.",
      "User: also for food recs: no pork obviously, and I'm seriously allergic to shellfish, I carry an EpiPen",
      "Assistant: Noted, I'll flag anything with shellfish. Turkish cuisine has plenty of safe options: köfte, mantı, pide.",
      "User: my colleague Deniz says kokoreç is the best street food on earth. we'll see 😅",
      "Assistant: It's a favourite for many, though it's offal, so it's not for everyone.",
      "User: one more thing, I'm presenting at the logistics summit on the 27th at 10am and the slides are a mess, can we work on them tomorrow",
      "Assistant: Absolutely. Send me the deck tomorrow and we'll tighten it.",
      mins=4)],
  obs=[
    O("preference", "hotels", "small boutique hotels over chains", "The user prefers small boutique hotels over big chains.", "stated", 0.7, "user", "I always go for small boutique places over big chains", event=1),
    O("preference", "pork", "doesn't eat pork", "The user does not eat pork.", "stated", 0.7, "user", "no pork obviously", event=1),
    O("fact", "shellfish allergy", "severe, carries an EpiPen", "The user is seriously allergic to shellfish and carries an EpiPen.", "stated", 0.9, "user", "I'm seriously allergic to shellfish", event=1),
    O("fact", "kokoreç", "best street food (Deniz's view)", "Deniz says kokoreç is the best street food on earth.", "quoting", 0.1, "user", "kokoreç is the best street food on earth", event=1),
  ],
  plans=[
    P("Flight Dubai to Istanbul (SG 417)", "2026-11-26T08:35", "flight SG 417 departs Dubai", "Thursday 26 November at 08:35", where="DXB", event=0),
    P("Return flight Istanbul to Dubai (SG 418)", "2026-12-01T19:10", "Return flight SG 418", "Tuesday 1 December at 19:10", where="IST", event=0),
    P("Presentation at the logistics summit", "2026-11-27T10:00", "presenting at the logistics summit", "the 27th at 10am", where="Istanbul", event=1),
  ])

# ---------- 012 freelancer invoice, corrected rate, known (F, en)
X(12, "long", "en", "F", [C(
    "User: need help with a payment reminder. as you know I'm a freelance illustrator, and Pixelnest has owed me $1,800 for six weeks now",
    "Assistant: Sorry to hear that. Want a firm-but-friendly tone?",
    "User: for this one make it grovelling polite, they're my biggest client and I can't lose them",
    "Assistant: Hi Ellen, I hope you're well! I wanted to gently follow up on invoice #0412...",
    "User: good. mention my rate is 45 an hour, they keep forgetting",
    "Assistant: Added: \"...at the agreed rate of $45/hour.\"",
    "User: wait no, 55. I raised it in September and they signed off on it. fix that",
    "Assistant: Fixed: $55/hour.",
    "User: also I moved from Wave to Zoho Invoice last month so attach the Zoho link not the old one",
    "Assistant: Done, I've swapped in the Zoho Invoice link.",
    "User: I'm calling Ellen Wednesday at 11 either way",
    "Assistant: Sounds reasonable. Want a short script for the call?",
    "User: yes. and if they ghost me after that I'm taking them to small claims, honestly",
    mins=3)],
  known=[
    K(1, "fact", "occupation", "freelance illustrator", "The user is a freelance illustrator."),
    K(2, "preference", "invoicing tool", "Wave", "The user sends invoices with Wave."),
    K(3, "fact", "pet", "a dog named Mochi", "The user has a dog named Mochi."),
  ],
  obs=[
    O("fact", "occupation", "freelance illustrator", "The user is a freelance illustrator.", "stated", 0.85, "user", "I'm a freelance illustrator", merge={"target": "m1", "relation": "same"}),
    O("fact", "pixelnest", "biggest client, invoice overdue", "Pixelnest is the user's biggest client and has owed them $1,800 for six weeks.", "stated", 0.6, "user", "they're my biggest client"),
    O("fact", "hourly rate", "$55/hour", "The user's hourly rate is $55 (raised in September).", "stated", 0.65, "user", "wait no, 55"),
    O("preference", "invoicing tool", "Zoho Invoice", "The user now invoices with Zoho Invoice (moved from Wave).", "stated", 0.65, "user", "I moved from Wave to Zoho Invoice last month", merge={"target": "m2", "relation": "different"}),
    O("idea", "small claims", "take Pixelnest to small claims if ignored", "The user might take Pixelnest to small claims if they keep ignoring the invoice.", "hypothetical", 0.2, "user", "if they ghost me after that I'm taking them to small claims"),
  ],
  plans=[P("Call Ellen at Pixelnest about the overdue invoice", "2026-11-11T11:00", "I'm calling Ellen", "Wednesday at 11", who=["Ellen"])])

# ---------- 013 startup investor notes, corrected pricing, known (A, en)
X(13, "long", "en", "A", [C(
    "User: ledgerly update dump, help me turn this into investor notes. one: we're off Firebase, migrated to Supabase over the weekend, row-level security was the dealbreaker",
    "Assistant: Nice. Next?",
    "User: two, pricing. we'll launch at 12 a month",
    "Assistant: Got it, $12/month.",
    "User: hmm hold on, Danish ran the numbers again last night, 9 converts way better in the test. so 9. final final",
    "Assistant: Updated to $9/month.",
    "User: three, Omar from Crescent Ventures thinks we should go B2B and drop consumers entirely. we're NOT doing that, just note it as feedback",
    "Assistant: Noted as investor feedback, not a decision.",
    "User: four, I'm meeting Omar again Monday 11am at their office in Clifton to go over the deck",
    "Assistant: Added. Anything else?",
    "User: that's it. if this round closes I'm buying the whole team PS5s lol",
    "Assistant: Here are your notes: 1) Migrated from Firebase to Supabase (RLS). 2) Pricing set at $9/month after the conversion test. 3) Investor feedback: consider B2B. 4) Follow-up with Omar on Monday.",
    mins=2, project="ledgerly")],
  known=[
    K(1, "decision", "database", "Firebase", "The ledgerly project uses Firebase.", project="ledgerly"),
    K(2, "fact", "danish", "the user's cofounder", "Danish is the user's cofounder at Ledgerly."),
    K(3, "preference", "reply length", "short", "The user prefers short replies."),
  ],
  obs=[
    O("decision", "database", "Supabase", "The ledgerly project moved from Firebase to Supabase for row-level security.", "stated", 0.85, "project", "migrated to Supabase over the weekend", project="ledgerly", merge={"target": "m1", "relation": "different"}),
    O("decision", "pricing", "$9/month", "Ledgerly will launch at $9 a month.", "stated", 0.85, "project", "so 9. final final", project="ledgerly"),
    O("fact", "omar", "investor at Crescent Ventures", "Omar is an investor at Crescent Ventures talking to Ledgerly.", "stated", 0.5, "person", "Omar from Crescent Ventures"),
    O("idea", "go b2b", "drop consumers, go B2B (Omar's view)", "Omar thinks Ledgerly should go B2B and drop consumers.", "quoting", 0.2, "project", "thinks we should go B2B and drop consumers entirely", project="ledgerly"),
    O("decision", "target market", "stay consumer, not B2B", "Ledgerly decided not to go B2B.", "stated", 0.6, "project", "we're NOT doing that", project="ledgerly"),
    O("idea", "team ps5s", "buy the team PS5s if the round closes", "The user joked about buying the whole team PS5s if the round closes.", "joking", 0.1, "user", "if this round closes I'm buying the whole team PS5s"),
  ],
  plans=[P("Meeting with Omar (Crescent Ventures) to go over the deck", "2026-11-02T11:00", "meeting Omar again", "Monday 11am", where="Crescent Ventures office, Clifton", who=["Omar"])])

# ---------- 014 medical student stress (B, mixed)
X(14, "long", "mixed", "B", [C(
    "User: yaar bohat stress hai. 3rd year MBBS, Ravi Medical College, aur prof exams 2 December se start hain",
    "Assistant: That's a lot. Which subjects are left?",
    "User: pathology aur pharma. pharma toh bilkul zero hai",
    "Assistant: Let's split pharma by systems, two systems a day, with past papers every evening.",
    "User: main raat ko hi parhta hoon, 11 se 3 tak, din mein dimagh band hota hai, so schedule wohi rakhna",
    "Assistant: Done: 11pm to 3am study blocks.",
    "User: aur is hafte please short answers, lambi baatein parhne ka time nahi",
    "Assistant: Theek.",
    "User: Hamza, mera roommate, kehta hai marks coffee se nahi neend se aate hain lol",
    "Assistant: He's not wrong about sleep and memory.",
    "User: agar fail hua to Abba ki dukaan sambhal loonga, simple 😂",
    "Assistant: You won't need to. Start with autonomic drugs tonight.",
    mins=3)],
  obs=[
    O("fact", "education", "3rd year MBBS at Ravi Medical College", "The user is a 3rd-year MBBS student at Ravi Medical College.", "stated", 0.85, "user", "3rd year MBBS, Ravi Medical College"),
    O("routine", "study time", "nights, 11pm to 3am", "The user studies at night, from 11pm to 3am.", "stated", 0.65, "user", "main raat ko hi parhta hoon, 11 se 3 tak"),
    O("context", "reply length", "short answers this week", "The user wants short answers this week.", "temporary", 0.5, "user", "short answers", until="2026-11-08T23:59", time_text="is hafte"),
    O("fact", "hamza", "the user's roommate", "Hamza is the user's roommate.", "stated", 0.5, "person", "Hamza, mera roommate"),
    O("fact", "sleep and marks", "sleep matters more than coffee (Hamza's view)", "Hamza says good marks come from sleep, not coffee.", "quoting", 0.1, "user", "marks coffee se nahi neend se aate hain"),
    O("idea", "family shop", "run father's shop if he fails", "The user joked about running his father's shop if he fails.", "joking", 0.1, "user", "agar fail hua to Abba ki dukaan sambhal loonga"),
  ],
  plans=[P("Professional exams start", "2026-12-02", "prof exams", "2 December se")])

# ---------- 015 allotment, pets update, known (C, en)
X(15, "long", "en", "C", [C(
    "User: garden question. when do I plant garlic in London, is it too late?",
    "Assistant: Not too late. Mid-October to late November is ideal; plant cloves 15 cm apart, pointy end up, about 5 cm deep.",
    "User: brill. I've had an allotment plot in Walthamstow since spring, still learning",
    "Assistant: Lovely. Garlic is a great first winter crop.",
    "User: I'm down there every Sunday morning, rain or shine",
    "Assistant: Then tomorrow morning is perfect for planting.",
    "User: my neighbour on the next plot reckons slugs hate coffee grounds, is that true",
    "Assistant: The evidence is mixed; copper tape or beer traps work more reliably.",
    "User: ha ok. also unrelated but you've got the cat thing out of date, we've got two now, Biscuit and Pudding, adopted Pudding last week",
    "Assistant: Congratulations on Pudding! Updated.",
    "User: and the council plot inspection is next Saturday at 10, what do they even check",
    "Assistant: Usually that the plot is cultivated, paths are clear, and there's no rubbish or unapproved structures.",
    mins=5)],
  known=[
    K(1, "fact", "pets", "a cat named Biscuit", "The user has a cat named Biscuit."),
    K(2, "fact", "home city", "London", "The user lives in London."),
    K(3, "preference", "units", "metric", "The user prefers metric units."),
  ],
  obs=[
    O("fact", "allotment", "plot in Walthamstow since spring", "The user has had an allotment plot in Walthamstow since spring.", "stated", 0.6, "user", "allotment plot in Walthamstow"),
    O("routine", "allotment visits", "every Sunday morning", "The user goes to the allotment every Sunday morning.", "stated", 0.55, "user", "I'm down there every Sunday morning"),
    O("fact", "slugs", "hate coffee grounds (neighbour's view)", "The user's allotment neighbour thinks slugs hate coffee grounds.", "quoting", 0.1, "user", "slugs hate coffee grounds"),
    O("fact", "pets", "two cats, Biscuit and Pudding", "The user has two cats, Biscuit and Pudding (Pudding adopted recently).", "stated", 0.7, "user", "we've got two now, Biscuit and Pudding", merge={"target": "m1", "relation": "different"}),
  ],
  plans=[P("Council allotment plot inspection", "2026-11-21T10:00", "council plot inspection", "next Saturday at 10", where="Walthamstow allotment")])

# ---------- 016 k8s OOM, node version update, on call (D, en)
X(16, "long", "en", "D", [C(
    "User: orbit-api pods keep getting OOMKilled after the deploy. limits are 512Mi",
    "Assistant: Check whether memory climbs steadily (a leak) or spikes on startup. kubectl top pod and container_memory_working_set_bytes will tell you.",
    "User: spikes on startup. it's the new image",
    "Assistant: Did the base image change? Node 20 sizes the heap differently from 18 inside containers.",
    "User: yes, we're moving to Node 20 LTS, that's decided, the team signed off yesterday. not going back",
    "Assistant: Then set the heap explicitly, e.g. NODE_OPTIONS=--max-old-space-size=384, or raise the limit to 768Mi.",
    "User: raising to 768. remember for this service p95 has to stay under 200ms, that's in our SLA",
    "Assistant: Understood; 768Mi shouldn't hurt latency. Watch GC pauses after the change.",
    "User: also heads up I'm on call till Friday 9am so I might vanish mid-conversation",
    "Assistant: No worries.",
    "User: if this pod restarts one more time I'm throwing my laptop into the Hudson",
    "Assistant: Let's spare the laptop. Deploy the new limit and watch restarts for 15 minutes.",
    "User: ok deployed. 0 restarts in 10 min. why does kubectl top show 600Mi but grafana says 450",
    "Assistant: kubectl top reports the working set, which includes some page cache; your Grafana panel is probably showing RSS. The OOM killer acts on the working set, so size limits against kubectl top.",
    "User: makes sense. readiness probe, should it hit /health or /ready",
    "Assistant: /ready, and have it check dependencies like the DB pool. Keep /health as a cheap liveness check so pods aren't killed every time the database blips.",
    "User: done. thanks",
    mins=2, project="orbit-api")],
  known=[
    K(1, "decision", "node version", "18", "orbit-api runs on Node 18.", project="orbit-api"),
    K(2, "fact", "employer", "Corvid Systems", "The user works at Corvid Systems."),
    K(3, "style", "answer format", "bullet points", "The user likes answers as bullet points."),
  ],
  obs=[
    O("decision", "node version", "Node 20 LTS", "orbit-api is moving to Node 20 LTS (team signed off).", "stated", 0.85, "project", "we're moving to Node 20 LTS", project="orbit-api", merge={"target": "m1", "relation": "different"}),
    O("decision", "memory limit", "768Mi", "orbit-api pods get a 768Mi memory limit.", "stated", 0.5, "project", "raising to 768", project="orbit-api"),
    O("requirement", "p95 latency", "under 200ms", "orbit-api's p95 latency must stay under 200ms (SLA).", "stated", 0.8, "project", "p95 has to stay under 200ms", project="orbit-api"),
    O("context", "on call", "on call", "The user is on call and may drop out of conversations.", "temporary", 0.5, "user", "I'm on call", until="2026-12-04T09:00", time_text="till Friday 9am"),
    O("idea", "laptop", "throw laptop into the Hudson", "The user joked about throwing their laptop into the Hudson.", "joking", 0.1, "user", "I'm throwing my laptop into the Hudson"),
  ])

# ---------- 017 Sharjah expat, remittance, deployment tonight (E, mixed)
X(17, "long", "mixed", "E", [C(
    "User: bhai ek help chahiye. main Sharjah mein rehta hoon, Al Nahda, aur office Dubai Media City mein hai. traffic se pagal ho gaya hoon",
    "Assistant: That commute is rough. Have you tried leaving before 6:30 or taking the Al Ittihad route?",
    "User: sab try kiya. rent contract 1 December ko renew hona hai, socha tha Dubai shift ho jaun, but rent double hai",
    "Assistant: Areas like Al Qusais or Muhaisnah can come close to Sharjah prices. Want a comparison?",
    "User: haan baad mein. aur har mahine 1 tareekh ko Ammi ko paise bhejta hoon Pakistan, koi sasta tareeqa batao",
    "Assistant: Compare exchange-house rates with app transfers on the day; fees vary more than the rate.",
    "User: mera dost Waqas kehta hai sab crypto mein daal do, double ho jayega 🙄",
    "Assistant: That's a big risk for money your family relies on.",
    "User: haan pata hai. abhi raat 12 baje tak office mein hoon, deployment chal raha hai, kal baat karte hain",
    "Assistant: Good luck with the deployment!",
    mins=3)],
  obs=[
    O("fact", "home area", "Al Nahda, Sharjah", "The user lives in Al Nahda, Sharjah.", "stated", 0.8, "user", "main Sharjah mein rehta hoon, Al Nahda"),
    O("fact", "office location", "Dubai Media City", "The user's office is in Dubai Media City.", "stated", 0.6, "user", "office Dubai Media City mein hai"),
    O("idea", "moving to dubai", "considering moving to Dubai", "The user had thought about moving to Dubai but rent is double.", "hypothetical", 0.2, "user", "socha tha Dubai shift ho jaun"),
    O("routine", "remittance", "sends money to mother on the 1st monthly", "The user sends money to their mother in Pakistan on the 1st of every month.", "stated", 0.65, "user", "har mahine 1 tareekh ko Ammi ko paise bhejta hoon"),
    O("idea", "crypto", "put everything in crypto (Waqas's view)", "Waqas, the user's friend, says to put all the money in crypto.", "quoting", 0.1, "user", "sab crypto mein daal do, double ho jayega"),
    O("context", "at office", "at the office for a deployment", "The user is at the office for a deployment tonight.", "temporary", 0.45, "user", "office mein hoon, deployment chal raha hai", until="2026-11-21T00:00", time_text="raat 12 baje tak"),
  ],
  plans=[P("Rent contract renewal", "2026-12-01", "rent contract", "1 December ko")])

# ---------- 018 landlord email + chat, rent update, known (F, en)
X(18, "long", "en", "F", [
    EM("Tariq Mehmood <tariq.properties@example.pk>",
       "Building notices. Dear tenant, the overhead water tank will be cleaned on Wednesday 11 November, 10am to 2pm; water supply will be off during this time. Also, as per clause 7 of the agreement, rent from December will be Rs 85,000. Regards, Tariq Mehmood",
       mins=120),
    C("User: ugh did you see this. well the rent bump is in the contract so nothing to do there",
      "Assistant: Right, clause 7 allows it. Want help with the water issue?",
      "User: yes, the water thing is a pain, my wife works from home and Wednesday is her client-call day",
      "Assistant: You could fill buckets and the geyser the night before. Want me to draft a note asking for weekend slots next time?",
      "User: yes. keep it friendly, we've lived here 3 years and never had an issue with him",
      "Assistant: Dear Tariq sahib, thank you for the notice. Since my wife works from home on weekdays, could future cleanings be scheduled on a weekend?",
      "User: good. I'm meeting Tariq sahib Saturday evening anyway, I'll hand it over then",
      "Assistant: Good idea.",
      "User: honestly I'd buy a house tomorrow if prices weren't insane",
      "Assistant: Prices are high right now; want a rent-vs-buy comparison sometime?",
      mins=15)],
  known=[
    K(1, "fact", "rent", "Rs 75,000", "The user pays Rs 75,000 monthly rent."),
    K(2, "preference", "reply length", "short", "The user prefers short replies."),
  ],
  obs=[
    O("fact", "rent", "Rs 85,000 from December", "The user's rent goes up to Rs 85,000 from December.", "implied", 0.6, "user", "rent from December will be Rs 85,000", event=0, merge={"target": "m1", "relation": "different"}),
    O("fact", "wife", "works from home", "The user's wife works from home; Wednesday is her client-call day.", "stated", 0.55, "person", "my wife works from home", event=1, evidence_n=1),
    O("fact", "residence", "lived there 3 years", "The user has lived in their rented home for three years.", "stated", 0.5, "user", "we've lived here 3 years", event=1),
    O("idea", "buying a house", "would buy if prices were lower", "The user would buy a house if prices weren't so high.", "hypothetical", 0.2, "user", "I'd buy a house tomorrow if prices weren't insane", event=1),
  ],
  plans=[
    P("Water off for tank cleaning", "2026-11-11T10:00", "the overhead water tank will be cleaned", "Wednesday 11 November, 10am", event=0),
    P("Meeting with landlord Tariq", "2026-11-14", "I'm meeting Tariq sahib", "Saturday evening", who=["Tariq Mehmood"], event=1),
  ])

# ---------- 019 cricket, club bowler, routine vs plan (A, mixed)
X(19, "long", "mixed", "A", [C(
    "User: kal raat ka match dekha? Shaheen ne kya spell kiya yaar 🔥",
    "Assistant: I don't have live scores, but a four-wicket spell like that is huge.",
    "User: haha theek. btw main khud bhi club cricket khelta hoon, Model Town Greens ke liye, opening bowler hoon",
    "Assistant: Nice! How often do you play?",
    "User: har Sunday subah match hota hai, 7 baje, chahe kuch bhi ho",
    "Assistant: Dedication!",
    "User: aur PSL mein main Lahore Qalandars ka die-hard fan hoon, bachpan se",
    "Assistant: Qalandars fans are known for their patience 😄",
    "User: lol. agar mujhe PCB chairman bana dein to main 3 din mein team theek kar doon",
    "Assistant: Ambitious! What's the first change?",
    "User: Saturday ko Ahmed ke ghar match dekhne ja rahe hain sab dost, 7 baje, snacks ki list bana do 8 logon ke liye",
    "Assistant: Samosas, chana chaat, nimko, pakoras, and a big pot of chai.",
    mins=6)],
  obs=[
    O("fact", "club cricket", "opening bowler for Model Town Greens", "The user plays club cricket as an opening bowler for Model Town Greens.", "stated", 0.65, "user", "Model Town Greens ke liye, opening bowler hoon"),
    O("routine", "cricket matches", "every Sunday at 7am", "The user plays a club cricket match every Sunday at 7am.", "stated", 0.6, "user", "har Sunday subah match hota hai, 7 baje"),
    O("preference", "psl team", "Lahore Qalandars", "The user is a die-hard Lahore Qalandars fan.", "stated", 0.65, "user", "Lahore Qalandars ka die-hard fan hoon"),
    O("idea", "pcb chairman", "would fix the team as PCB chairman", "The user joked he would fix the team in three days as PCB chairman.", "joking", 0.1, "user", "agar mujhe PCB chairman bana dein"),
  ],
  plans=[P("Watching the match at Ahmed's place with friends", "2026-10-31T19:00", "Ahmed ke ghar match dekhne ja rahe hain", "Saturday ko", where="Ahmed's house", who=["Ahmed"])])

# ---------- 020 manager email + release notes (B, en)
X(20, "long", "en", "B", [
    EM("Ayesha Karim <ayesha@northpeak.example>",
       "Re: Atlas launch. Hi all, quick recap from today's sync: we're moving the Atlas launch to 18 Nov because payments needs another week. We agreed to drop the Android tablet layout for launch and revisit in Q1. Please send release notes to me by Monday EOD. Thanks, Ayesha",
       mins=60, project="atlas"),
    C("User: so launch slipped to the 18th. ugh. ok help me with release notes for Atlas",
      "Assistant: Sure. What's in this release?",
      "User: offline mode, new checkout, dark theme. also note I'm the release owner for Atlas from now on, they made it official today",
      "Assistant: Congrats! Draft: ## Atlas 2.0 — Offline mode lets you browse and queue orders without a connection...",
      "User: Ayesha hates long paragraphs, she wants everything as bullet points, always. redo it",
      "Assistant: - Offline mode: browse and queue orders without a connection\n- New checkout: two steps instead of five\n- Dark theme",
      "User: perfect. if it slips again I'm changing my name and moving to Hunza",
      "Assistant: Hopefully the 18th sticks!",
      mins=8, project="atlas")],
  obs=[
    O("decision", "android tablet layout", "dropped for launch", "Atlas dropped the Android tablet layout for launch, to revisit in Q1.", "implied", 0.65, "project", "drop the Android tablet layout for launch", project="atlas", event=0),
    O("fact", "release owner", "the user owns Atlas releases", "The user is the release owner for Atlas.", "stated", 0.75, "project", "I'm the release owner for Atlas", project="atlas", event=1),
    O("fact", "ayesha", "wants bullet points, no long paragraphs", "Ayesha dislikes long paragraphs and wants everything as bullet points.", "stated", 0.5, "person", "Ayesha hates long paragraphs", event=1),
    O("idea", "moving to hunza", "change name and move to Hunza", "The user joked about moving to Hunza if the launch slips again.", "joking", 0.1, "user", "I'm changing my name and moving to Hunza", event=1),
  ],
  plans=[
    P("Atlas launch", "2026-11-18", "moving the Atlas launch to 18 Nov", "18 Nov", event=0),
    P("Atlas release notes due to Ayesha", "2026-11-09", "send release notes", "Monday EOD", who=["Ayesha"], event=0),
  ])
