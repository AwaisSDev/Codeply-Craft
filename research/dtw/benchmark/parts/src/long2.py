# ---------- 021 first home purchase (C, en)
X(21, "long", "en", "C", [C(
    "User: ok so big news, our offer on the 2-bed flat in Didsbury got accepted!! first-time buyers, me and Callum",
    "Assistant: Congratulations! That's a big milestone. How can I help?",
    "User: stamp duty. it's 285k with first-time buyer relief, what do we owe",
    "Assistant: Under the current first-time buyer relief, there's no stamp duty on the first £300,000, so at £285,000 you'd owe nothing.",
    "User: amazing. survey is booked for Wednesday at 9",
    "Assistant: Good. A Level 2 survey is usually enough for a newer flat.",
    "User: it's a 1930s conversion so maybe level 3? my sister Priya is our solicitor which is either brilliant or a disaster lol",
    "Assistant: For a 1930s conversion, a Level 3 is worth it. And a solicitor in the family can speed things up!",
    "User: I work fully remote for a Leeds company so the commute doesn't matter, Callum cycles to Salford",
    "Assistant: Didsbury to Salford is a decent ride, roughly 40 minutes.",
    "User: if rates drop next year we might remortgage, but that's a future-us problem",
    "Assistant: Fair. Most fixed deals have early repayment charges, so check yours before deciding.",
    mins=4)],
  obs=[
    O("fact", "home purchase", "offer accepted on a 2-bed flat in Didsbury", "The user's offer on a 2-bed flat in Didsbury was accepted; they are first-time buyers.", "stated", 0.8, "user", "our offer on the 2-bed flat in Didsbury got accepted"),
    O("fact", "callum", "buying the flat with the user", "Callum is buying the Didsbury flat with the user.", "implied", 0.6, "person", "me and Callum"),
    O("fact", "priya", "the user's sister, a solicitor", "Priya, the user's sister, is a solicitor and is handling their purchase.", "stated", 0.65, "person", "my sister Priya is our solicitor"),
    O("fact", "work", "fully remote for a Leeds company", "The user works fully remote for a company in Leeds.", "stated", 0.7, "user", "I work fully remote for a Leeds company"),
    O("fact", "callum", "cycles to work in Salford", "Callum cycles to Salford.", "stated", 0.45, "person", "Callum cycles to Salford"),
    O("idea", "remortgage", "might remortgage if rates drop", "The user might remortgage next year if rates drop.", "hypothetical", 0.15, "user", "if rates drop next year we might remortgage"),
  ],
  plans=[P("Survey of the Didsbury flat", "2026-11-18T09:00", "survey is booked", "Wednesday at 9", where="Didsbury")])

# ---------- 022 chemistry teacher, known (D, en)
X(22, "long", "en", "D", [C(
    "User: rough week. I've lost my voice completely so I'm doing everything in writing this week, help me write instructions for tomorrow's lab",
    "Assistant: Oh no, rest that voice. What's the lab?",
    "User: titration with NaOH and vinegar, 11th graders",
    "Assistant: Here's a step-by-step handout: 1. Rinse the burette with NaOH solution. 2. Fill to the zero mark...",
    "User: good. make the safety section sound more formal, like the district template",
    "Assistant: Safety Requirements: Students must wear splash goggles at all times while in the laboratory...",
    "User: thanks. fyi I'm still the chem teacher at Lincoln High obviously but now I teach AP Chem too",
    "Assistant: Nice, that's a big addition.",
    "User: and I moved grading to Saturday mornings, Sundays are for my kids now",
    "Assistant: That sounds healthier.",
    "User: a student told me I'm 'lowkey the GOAT of moles' lol",
    "Assistant: High praise from a teenager!",
    "User: parent night is Thursday at 6:30, can you draft a 3 minute intro I can hand out since I can't talk",
    "Assistant: Of course. 'Welcome to Chemistry and AP Chemistry! I'm sorry I can't greet you in person tonight...'",
    mins=3)],
  known=[
    K(1, "fact", "occupation", "high school chemistry teacher", "The user is a high school chemistry teacher."),
    K(2, "routine", "grading", "Sunday evenings", "The user grades on Sunday evenings."),
    K(3, "preference", "tone", "casual", "The user prefers a casual tone."),
  ],
  obs=[
    O("context", "voice", "lost voice, communicating in writing", "The user has lost their voice and is doing everything in writing.", "temporary", 0.5, "user", "I've lost my voice completely", until="2026-12-06T23:59", time_text="this week"),
    O("fact", "occupation", "high school chemistry teacher", "The user is a high school chemistry teacher (Lincoln High).", "stated", 0.85, "user", "I'm still the chem teacher at Lincoln High", merge={"target": "m1", "relation": "same"}),
    O("fact", "teaching load", "also teaches AP Chemistry", "The user now also teaches AP Chemistry.", "stated", 0.65, "user", "now I teach AP Chem too"),
    O("routine", "grading", "Saturday mornings", "The user grades on Saturday mornings now.", "stated", 0.6, "user", "I moved grading to Saturday mornings", merge={"target": "m2", "relation": "different"}),
    O("fact", "children", "has kids", "The user has children and keeps Sundays for them.", "implied", 0.5, "user", "Sundays are for my kids now"),
    O("fact", "goat of moles", "student's compliment", "A student called the user 'lowkey the GOAT of moles'.", "quoting", 0.1, "user", "lowkey the GOAT of moles"),
  ],
  plans=[P("Parent night", "2026-12-03T18:30", "parent night", "Thursday at 6:30", where="Lincoln High")])

# ---------- 023 heard mom + gift chat (E, en)
X(23, "long", "en", "E", [
    H("Mom: beta, don't forget Nani's 80th birthday dinner is next Friday, we've booked Al Fanar for 8. And bring your cousins from Ajman, they don't have a car.", mins=30),
    C("User: ugh I totally forgot about Nani's dinner. add it pls",
      "Assistant: Added: Nani's 80th birthday dinner, Friday 27 Nov, 8pm, Al Fanar.",
      "User: what do you even gift an 80 year old who has everything",
      "Assistant: Something personal: a family photo book, or an old picture restored and framed.",
      "User: she loves gardening and old Noor Jehan songs, maybe something with that",
      "Assistant: A vintage-style radio preloaded with Noor Jehan classics, plus a set of good pruning shears.",
      "User: love that. but I'm broke till payday on the 28th, so under 200 dirhams",
      "Assistant: Very doable: a retro Bluetooth radio is around 120 AED.",
      "User: my cousin says Nani secretly just wants cash lol",
      "Assistant: A card with a small envelope inside could cover both!",
      mins=5)],
  obs=[
    O("todo", "cousins pickup", "bring cousins from Ajman to Nani's dinner", "The user should bring their cousins from Ajman to Nani's birthday dinner.", "implied", 0.45, "user", "bring your cousins from Ajman", event=0),
    O("fact", "nani", "loves gardening and Noor Jehan songs", "The user's Nani (grandmother) loves gardening and old Noor Jehan songs.", "stated", 0.55, "person", "she loves gardening and old Noor Jehan songs", event=1),
    O("context", "budget", "tight budget until payday", "The user is short on money until payday on the 28th.", "temporary", 0.45, "user", "I'm broke", event=1, until="2026-11-28T00:00", time_text="till payday on the 28th"),
    O("fact", "nani's gift", "wants cash (cousin's view)", "The user's cousin says Nani secretly wants cash.", "quoting", 0.1, "person", "Nani secretly just wants cash", event=1),
  ],
  plans=[P("Nani's 80th birthday dinner", "2026-11-27T20:00", "Nani's 80th birthday dinner", "next Friday", where="Al Fanar", who=["Nani"], event=0)])

# ---------- 024 grocery shop owner, Roman Urdu (F, ur)
X(24, "long", "ur", "F", [C(
    "User: assalam o alaikum. meri kiryana ki dukaan hai Samanabad mein, hisaab kitaab mein madad chahiye",
    "Assistant: Walaikum assalam! Zaroor. Kis cheez ka hisaab?",
    "User: pehle ek baat, mujhe hamesha asaan alfaaz mein samjhaya karo, English ke mushkil lafz nahi",
    "Assistant: Bilkul, asaan alfaaz mein samjhaunga.",
    "User: dukaan subah 8 baje kholta hoon, raat 10 tak, Juma ko aadha din band",
    "Assistant: Theek. Udhaar ka hisaab kaise rakhte hain?",
    "User: udhaar bohat hai logon pe, sab register mein likha hai, magar gadbad ho jati hai",
    "Assistant: Udhaar ka alag safha banayein: naam, raqam, tareekh, aur wapsi ki tareekh. Har hafte total karein.",
    "User: supplier Rehman bhai keh rahe the agle hafte cheeni 10 rupay mehngi ho jayegi, pata nahi sach hai ya nahi",
    "Assistant: Agar jagah hai to thori zyada cheeni abhi le lein, lekin bohat zyada nahi.",
    "User: kal 11 baje bank jana hai loan ki file le kar, kaun se kaghaz chahiye honge",
    "Assistant: CNIC ki copy, dukaan ka kiraya nama ya milkiyat ke kaghaz, 6 maheene ka bank statement, aur do guarantor.",
    mins=4)],
  obs=[
    O("fact", "business", "grocery shop in Samanabad", "The user owns a grocery (kiryana) shop in Samanabad.", "stated", 0.85, "user", "meri kiryana ki dukaan hai Samanabad mein"),
    O("style", "explanations", "simple words, no difficult English", "The user wants explanations in simple words without difficult English terms.", "stated", 0.8, "user", "mujhe hamesha asaan alfaaz mein samjhaya karo"),
    O("routine", "shop hours", "8am to 10pm, half day Friday", "The user opens the shop from 8am to 10pm, with a half day on Fridays.", "stated", 0.6, "user", "dukaan subah 8 baje kholta hoon, raat 10 tak, Juma ko aadha din band"),
    O("fact", "rehman", "the user's supplier", "Rehman bhai is the user's supplier.", "stated", 0.45, "person", "supplier Rehman bhai"),
    O("fact", "sugar price", "rising by Rs 10 next week (Rehman's claim)", "Rehman says sugar will cost Rs 10 more next week.", "quoting", 0.15, "user", "agle hafte cheeni 10 rupay mehngi ho jayegi"),
  ],
  plans=[P("Bank visit with loan file", "2026-11-10T11:00", "bank jana hai loan ki file le kar", "kal 11 baje")])

# ---------- 025 new job notion, known repeats (A, en)
X(25, "long", "en", "A", [C(
    "User: help me set up my notion for the new job. quick context: I left Tabeer Labs, I'm at Kestrel Analytics since last Monday",
    "Assistant: Congrats on the new role! What do you want in the workspace?",
    "User: tasks, meeting notes, a reading list. and set the meeting template so nothing gets booked before 11, you know the drill, meetings after 11am only",
    "Assistant: Got it. I've added a note to the template: 'Default meeting window: after 11am'.",
    "User: mornings are for deep work, that hasn't changed",
    "Assistant: Noted.",
    "User: first 1:1 with my new lead Sameer is Monday at 11:30",
    "Assistant: Added a meeting-notes page for Monday 11:30 with Sameer.",
    "User: also I'm toying with asking for a 4-day week after probation. probably won't. but maybe",
    "Assistant: Worth keeping in mind once you've built some trust.",
    "User: how do I make a linked database view filtered by status = doing",
    "Assistant: Type /linked, choose your Tasks database, then Filter → Status → is → Doing.",
    mins=3)],
  known=[
    K(1, "routine", "deep work", "mornings", "The user does deep work in the mornings."),
    K(2, "preference", "meeting time", "after 11am", "The user only takes meetings after 11am."),
    K(3, "fact", "employer", "Tabeer Labs", "The user works at Tabeer Labs."),
    K(4, "fact", "home city", "Islamabad", "The user lives in Islamabad."),
  ],
  obs=[
    O("fact", "employer", "Kestrel Analytics", "The user now works at Kestrel Analytics (left Tabeer Labs).", "stated", 0.85, "user", "I'm at Kestrel Analytics since last Monday", merge={"target": "m3", "relation": "different"}),
    O("preference", "meeting time", "after 11am", "The user only takes meetings after 11am.", "stated", 0.8, "user", "meetings after 11am only", merge={"target": "m2", "relation": "same"}),
    O("routine", "deep work", "mornings", "The user does deep work in the mornings.", "stated", 0.6, "user", "mornings are for deep work", merge={"target": "m1", "relation": "same"}),
    O("fact", "sameer", "the user's new lead", "Sameer is the user's new lead at Kestrel Analytics.", "stated", 0.6, "person", "my new lead Sameer"),
    O("idea", "4-day week", "might ask for a 4-day week", "The user is toying with asking for a 4-day week after probation.", "hypothetical", 0.2, "user", "toying with asking for a 4-day week after probation"),
  ],
  plans=[P("First 1:1 with Sameer", "2026-11-02T11:30", "first 1:1 with my new lead Sameer", "Monday at 11:30", who=["Sameer"])])

# ---------- 026 two chats, party moved (B, en)
X(26, "long", "en", "B", [
    C("User: flutter build keeps failing on iOS, 'Module riverpod not found' after I added it",
      "Assistant: Run flutter clean, then cd ios && pod install --repo-update. Make sure the iOS deployment target in the Podfile is at least 12.0.",
      "User: ok building. side note I need to wrap this by 4 on Sunday, my son Ibrahim's 6th birthday party is at 5 at Jungle Gym",
      "Assistant: Happy early birthday to Ibrahim! Let's get the build green.",
      "User: it built. and yes we're dropping Provider for Riverpod across souq-app, decided this morning",
      "Assistant: Good choice for testability. Want a migration checklist?",
      mins=240, project="souq-app"),
    C("User: update: party moved to Saturday, same time, Jungle Gym double-booked Sunday 🙄",
      "Assistant: Noted, Saturday at 5.",
      "User: also pls stop adding comments on every line, I like code with minimal comments, it should read on its own",
      "Assistant: Understood, minimal comments from now on.",
      "User: and if Apple rejects us again I might just go web-only, I swear",
      "Assistant: Let's see what the reviewer says first; the last rejection was just a missing privacy string.",
      mins=20),
  ],
  obs=[
    O("fact", "ibrahim", "the user's son, turning 6", "Ibrahim, the user's son, is turning 6.", "stated", 0.65, "person", "my son Ibrahim's 6th birthday party", event=0),
    O("decision", "state management", "Riverpod (replacing Provider)", "The souq-app project is replacing Provider with Riverpod.", "stated", 0.8, "project", "we're dropping Provider for Riverpod across souq-app", project="souq-app", event=0),
    O("style", "code comments", "minimal comments", "The user likes code with minimal comments that reads on its own.", "stated", 0.7, "user", "I like code with minimal comments", event=1),
    O("decision", "web-only", "might go web-only", "The user might go web-only if Apple rejects the app again.", "hypothetical", 0.2, "project", "I might just go web-only", project="souq-app", event=1),
  ],
  plans=[P("Ibrahim's 6th birthday party", "2026-11-07T17:00", "party moved to Saturday", "Saturday, same time", where="Jungle Gym", who=["Ibrahim"], event=1)])

# ---------- 027 masjid teaching, cousin nikkah (C, mixed)
X(27, "long", "mixed", "C", [C(
    "User: salam, quick one, I'm at the masjid till 12 teaching the kids so reply short",
    "Assistant: Walaikum assalam, sure.",
    "User: har Saturday 10 se 12 bachon ko Quran parhata hoon yahan Small Heath mein, 3 saal ho gaye",
    "Assistant: MashaAllah, that's lovely.",
    "User: cousin Bilal ka nikkah hai 22 ko Bradford mein, unhone RSVP manga hai. write a reply, make it really formal, his in-laws are reading it",
    "Assistant: Assalamu alaikum. We are honoured to accept your kind invitation to the Nikkah of Bilal on the 22nd of November, and we look forward to celebrating with both families.",
    "User: perfect. Amir keh raha tha Bradford walon se biryani nahi banti lol, Brummie propaganda",
    "Assistant: A debate as old as time.",
    "User: also tax season se pehle yaad rakhna, I'm a chartered accountant (ACCA), self-assessment clients January mein pagal kar dete hain",
    "Assistant: Noted! January is going to be busy.",
    mins=3)],
  obs=[
    O("context", "at the masjid", "teaching kids at the masjid", "The user is teaching at the masjid and wants short replies.", "temporary", 0.45, "user", "I'm at the masjid", until="12:00", time_text="till 12"),
    O("routine", "quran teaching", "Saturdays 10 to 12 in Small Heath", "The user teaches children Quran every Saturday from 10 to 12 in Small Heath.", "stated", 0.7, "user", "har Saturday 10 se 12 bachon ko Quran parhata hoon"),
    O("fact", "bilal", "the user's cousin", "Bilal is the user's cousin.", "stated", 0.45, "person", "cousin Bilal"),
    O("fact", "bradford biryani", "Bradford can't make biryani (Amir's view)", "Amir says people from Bradford can't make biryani.", "quoting", 0.1, "user", "Bradford walon se biryani nahi banti"),
    O("fact", "occupation", "chartered accountant (ACCA)", "The user is an ACCA chartered accountant.", "stated", 0.85, "user", "I'm a chartered accountant (ACCA)"),
  ],
  plans=[P("Cousin Bilal's nikkah", "2026-11-22", "cousin Bilal ka nikkah", "22 ko", where="Bradford", who=["Bilal"])])

# ---------- 028 renovation venting (D, en)
X(28, "long", "en", "D", [C(
    "User: I need to vent for a sec. the kitchen reno is now 3 weeks behind and our contractor Dave has ghosted me for 4 days",
    "Assistant: That's really frustrating, especially with the kitchen out of action.",
    "User: we've been living on takeout, with 3-year-old twins, do you know how hard that is",
    "Assistant: That sounds exhausting. Do you have a microwave or hot plate set up somewhere?",
    "User: microwave in the dining room. at this point the microwave is my closest friend lol",
    "Assistant: Ha. Did Dave give any reason?",
    "User: finally texted this morning. says he'll come Thursday at 8am with the cabinet guy",
    "Assistant: Good. I'd confirm in writing and ask for an updated completion date.",
    "User: should I just fire him and find someone else?",
    "Assistant: Switching mid-job usually costs more time. I'd hold him to a written schedule first, with a clear deadline.",
    "User: yeah ok. lesson learned, next time I'm only hiring someone with a written timeline and a penalty clause, no exceptions",
    "Assistant: That's a sensible rule. Here's a short message you could send Dave: 'Hi Dave, confirming Thursday 8am...'",
    mins=5)],
  obs=[
    O("fact", "home renovation", "kitchen renovation, 3 weeks behind", "The user's kitchen renovation is in progress and three weeks behind.", "stated", 0.5, "user", "the kitchen reno is now 3 weeks behind"),
    O("fact", "dave", "the user's kitchen contractor", "Dave is the user's kitchen contractor.", "stated", 0.5, "person", "our contractor Dave"),
    O("fact", "children", "3-year-old twins", "The user has 3-year-old twins.", "stated", 0.8, "user", "3-year-old twins"),
    O("fact", "microwave", "closest friend", "The user joked that the microwave is their closest friend.", "joking", 0.1, "user", "the microwave is my closest friend"),
    O("idea", "firing contractor", "maybe fire Dave", "The user wondered about firing Dave and hiring someone else.", "hypothetical", 0.2, "user", "should I just fire him and find someone else?"),
    O("preference", "hiring contractors", "written timeline and penalty clause", "The user will only hire contractors with a written timeline and a penalty clause.", "stated", 0.65, "user", "only hiring someone with a written timeline and a penalty clause"),
  ],
  plans=[P("Dave and the cabinet installer come over", "2026-12-03T08:00", "he'll come", "Thursday at 8am", who=["Dave"])])

# ---------- 029 Arabic classes, corrected level (E, en)
X(29, "long", "en", "E", [C(
    "User: marhaba! started Arabic classes at Al Qalam Institute, Tuesday and Thursday evenings after work",
    "Assistant: Marhaba! That's great. What level are you at?",
    "User: A2. wait no, they moved me up to B1 last week, still not used to it",
    "Assistant: Congratulations on moving up!",
    "User: whenever you write Arabic for me, always add the transliteration underneath, I can't read fast yet",
    "Assistant: Of course. كيف حالك؟\nkayfa ḥāluk?",
    "User: perfect. my teacher Ustadha Mariam says my pronunciation is 'surprisingly ok for a Brit' haha",
    "Assistant: That's a real compliment from a teacher!",
    "User: what's the difference between إلى and لِ, they both mean 'to'?",
    "Assistant: إلى (ilā) marks direction toward a place: ذهبت إلى المكتب (dhahabtu ilā al-maktab). لِ (li-) marks purpose or possession: هذا الكتاب لِأحمد (hādhā al-kitāb li-Aḥmad).",
    "User: got it. maybe I'll do the summer intensive in Amman if work lets me, we'll see",
    "Assistant: That would be a big boost to your fluency.",
    mins=4)],
  obs=[
    O("routine", "arabic classes", "Al Qalam Institute, Tue and Thu evenings", "The user takes Arabic classes at Al Qalam Institute on Tuesday and Thursday evenings.", "stated", 0.65, "user", "started Arabic classes at Al Qalam Institute, Tuesday and Thursday evenings after work"),
    O("fact", "arabic level", "B1", "The user's Arabic level is B1.", "stated", 0.55, "user", "they moved me up to B1 last week"),
    O("style", "arabic text", "always add transliteration", "The user wants transliteration under any Arabic text.", "stated", 0.75, "user", "always add the transliteration underneath"),
    O("fact", "mariam", "the user's Arabic teacher", "Ustadha Mariam is the user's Arabic teacher.", "stated", 0.45, "person", "my teacher Ustadha Mariam"),
    O("fact", "pronunciation", "surprisingly ok (teacher's view)", "The user's teacher says their pronunciation is surprisingly ok.", "quoting", 0.1, "user", "surprisingly ok for a Brit"),
    O("idea", "summer intensive", "maybe summer intensive in Amman", "The user might do a summer Arabic intensive in Amman.", "hypothetical", 0.2, "user", "maybe I'll do the summer intensive in Amman"),
  ])

# ---------- 030 hiring, candidate email, known (F, mixed)
X(30, "long", "mixed", "F", [
    EM("Usman Ali <usman.ali.dev@example.com>",
       "Interview confirmation. Dear Sir, thank you for the invitation. I confirm the technical interview on Thursday 12 November at 3 PM over Google Meet. I have 4 years of experience with Django and PostgreSQL. Regards, Usman",
       mins=90),
    C("User: Usman ne confirm kar diya. strong Django banda lagta hai",
      "Assistant: Great. Want me to prepare interview questions?",
      "User: haan. backend Django hi rahega, koi FastAPI ki baat nahi, so Django-heavy questions",
      "Assistant: Sure: ORM query optimisation, select_related vs prefetch_related, migrations on large tables...",
      "User: aur Postgres deep knowledge must hai, that's non-negotiable for this role",
      "Assistant: Added: indexing strategies, EXPLAIN ANALYZE, locking.",
      "User: btw team ab 6 log hai, last month 2 aur join kiye, so onboarding ka question bhi daalo",
      "Assistant: Added a question on how they'd ramp up in an existing codebase.",
      "User: Faisal kehta hai remote devs kaam hi nahi karte, bakwas. hum hybrid hi rahenge",
      "Assistant: Noted.",
      mins=10, project="dukaan-pos"),
  ],
  known=[
    K(1, "decision", "backend framework", "Django", "The dukaan-pos project uses Django for the backend.", project="dukaan-pos"),
    K(2, "fact", "team size", "4 developers", "The dukaan-pos team has 4 developers.", project="dukaan-pos"),
    K(3, "preference", "reply language", "English", "The user wants replies in English."),
  ],
  obs=[
    O("decision", "backend framework", "Django", "The dukaan-pos backend stays on Django.", "stated", 0.8, "project", "backend Django hi rahega", project="dukaan-pos", event=1, merge={"target": "m1", "relation": "same"}),
    O("requirement", "postgres expertise", "deep Postgres knowledge required", "The dukaan-pos backend hire must have deep Postgres knowledge.", "stated", 0.7, "project", "Postgres deep knowledge must hai", project="dukaan-pos", event=1),
    O("fact", "team size", "6 people", "The dukaan-pos team now has 6 people (2 joined last month).", "stated", 0.6, "project", "team ab 6 log hai", project="dukaan-pos", event=1, merge={"target": "m2", "relation": "different"}),
    O("fact", "remote developers", "remote devs don't work (Faisal's view)", "Faisal says remote developers don't get work done.", "quoting", 0.1, "user", "remote devs kaam hi nahi karte", event=1),
    O("decision", "work model", "hybrid", "The dukaan-pos team stays hybrid.", "stated", 0.7, "project", "hum hybrid hi rahenge", project="dukaan-pos", event=1),
  ],
  plans=[P("Technical interview with Usman Ali", "2026-11-12T15:00", "the technical interview", "Thursday 12 November at 3 PM", where="Google Meet", who=["Usman Ali"], event=0)])

# ---------- 031 meal plan, diet update, allergy repeat (A, en)
X(31, "long", "en", "A", [C(
    "User: need a new meal plan. I quit keto, way too hard with site visits, now just counting calories, about 1900 a day",
    "Assistant: Got it. Any foods to avoid?",
    "User: peanuts, I'm allergic, like I told you before. otherwise anything",
    "Assistant: Noted, no peanuts. Here's a 1900 kcal day: oats with banana, chicken wrap, daal and roti, yogurt.",
    "User: I'll do breakfast at 6 every day since I leave for site at 7",
    "Assistant: Then a filling breakfast matters; I'll keep it around 500 kcal.",
    "User: my trainer swears cold showers 'reset your metabolism' lol",
    "Assistant: There's no good evidence for that, but they won't hurt.",
    "User: also I've got a blood test Saturday 8am, fasting, so nothing after 10pm Friday right?",
    "Assistant: Yes, about 10 hours of fasting is enough. Water is fine.",
    "User: cool. swap the yogurt for something else, I just don't like it",
    "Assistant: Swapped for a boiled egg and an apple.",
    mins=3)],
  known=[
    K(1, "preference", "diet", "keto", "The user follows a keto diet."),
    K(2, "fact", "allergy", "peanuts", "The user is allergic to peanuts."),
    K(3, "fact", "occupation", "civil engineer", "The user is a civil engineer."),
  ],
  obs=[
    O("preference", "diet", "calorie counting, about 1900 a day", "The user quit keto and now counts calories, about 1900 a day.", "stated", 0.7, "user", "now just counting calories, about 1900 a day", merge={"target": "m1", "relation": "different"}),
    O("fact", "allergy", "peanuts", "The user is allergic to peanuts.", "stated", 0.9, "user", "peanuts, I'm allergic", merge={"target": "m2", "relation": "same"}),
    O("routine", "breakfast", "6am daily, leaves for site at 7", "The user has breakfast at 6 every day and leaves for site at 7.", "stated", 0.55, "user", "I'll do breakfast at 6 every day since I leave for site at 7"),
    O("fact", "cold showers", "reset your metabolism (trainer's view)", "The user's trainer claims cold showers reset your metabolism.", "quoting", 0.1, "user", "cold showers 'reset your metabolism'"),
    O("preference", "yogurt", "dislikes yogurt", "The user doesn't like yogurt.", "stated", 0.55, "user", "I just don't like it"),
  ],
  plans=[P("Fasting blood test", "2026-10-31T08:00", "blood test", "Saturday 8am")])

# ---------- 032 chess (B, en)
X(32, "long", "en", "B", [C(
    "User: random chess question. in the Caro-Kann advance, why is ...c5 so common for black",
    "Assistant: It strikes at White's d4 pawn, the base of the chain. After e5 the d4-e5 chain is strong, so Black hits it from the side.",
    "User: makes sense. I'm about 1600 on Lichess rapid, trying to break 1800 by March",
    "Assistant: Very achievable with consistent tactics practice.",
    "User: I do puzzles every night before bed, 20 minutes",
    "Assistant: Great habit. Add one long game a week and review it properly.",
    "User: there's an online arena tomorrow at 9pm, should I play the Caro or switch to the Sicilian",
    "Assistant: Stick with the Caro-Kann; arenas reward familiarity.",
    "User: if I ever hit 2000 I'm shaving my head lol",
    "Assistant: Something to look forward to!",
    "User: ok and what's the main idea behind Bf5 in the classical line",
    "Assistant: Black develops the light-squared bishop outside the pawn chain before playing ...e6, so it doesn't get locked in.",
    mins=2)],
  obs=[
    O("fact", "chess rating", "about 1600 rapid, aiming for 1800 by March", "The user is about 1600 in Lichess rapid and aims to reach 1800 by March.", "stated", 0.55, "user", "I'm about 1600 on Lichess rapid, trying to break 1800 by March"),
    O("routine", "chess puzzles", "20 minutes every night before bed", "The user does chess puzzles for 20 minutes every night before bed.", "stated", 0.55, "user", "I do puzzles every night before bed, 20 minutes"),
    O("idea", "shaving head", "shave head at 2000", "The user joked about shaving their head if they reach 2000.", "joking", 0.1, "user", "if I ever hit 2000 I'm shaving my head"),
  ],
  plans=[P("Online chess arena", "2026-11-07T21:00", "online arena", "tomorrow at 9pm")])

# ---------- 033 book club email + chat (C, en)
X(33, "long", "en", "C", [
    EM("Hackney Book Circle <hello@hackneybookcircle.example>",
       "November meet-up. Hi readers! This month's pick is 'The Glass Orchard' by Mira Okafor. We meet Tuesday 17 November, 7pm, upstairs at The Crooked Fox. Bring a snack to share if you can. Next month we'll vote on December's book.",
       mins=600),
    C("User: I'm halfway through The Glass Orchard and the meetup is Tuesday, can you give me a spoiler-free summary of themes so I don't sound clueless",
      "Assistant: I don't have reliable details about that book, so I can't summarise it accurately. If you paste the blurb or your notes, I can help you shape discussion points.",
      "User: fair. it's about three sisters running a failing orchard after their dad dies",
      "Assistant: Then themes to raise: grief and inheritance, sibling duty versus personal ambition, and land as identity.",
      "User: nice. I'm not an audiobook person at all btw, I zone out after ten minutes, so don't suggest that to speed up",
      "Assistant: Noted, print or ebook only.",
      "User: my friend Jess called it 'the most overrated book of the decade' which is a bit harsh imo",
      "Assistant: That could be a good discussion starter!",
      "User: I mostly read non-fiction anyway, this is the club's pick not mine",
      mins=12),
  ],
  obs=[
    O("preference", "audiobooks", "dislikes audiobooks", "The user doesn't like audiobooks; they zone out after ten minutes.", "stated", 0.6, "user", "I'm not an audiobook person at all", event=1),
    O("fact", "the glass orchard", "most overrated book of the decade (Jess's view)", "Jess thinks The Glass Orchard is the most overrated book of the decade.", "quoting", 0.1, "user", "the most overrated book of the decade", event=1),
    O("preference", "reading", "mostly non-fiction", "The user mostly reads non-fiction.", "stated", 0.6, "user", "I mostly read non-fiction", event=1),
    O("fact", "book club", "member of Hackney Book Circle", "The user is in the Hackney Book Circle book club.", "implied", 0.5, "user", "the club's pick", event=1),
  ],
  plans=[P("Hackney Book Circle meet-up", "2026-11-17T19:00", "We meet", "Tuesday 17 November, 7pm", where="The Crooked Fox", event=0)])

# ---------- 034 son's college apps, nurse, known (D, mixed)
X(34, "long", "mixed", "D", [C(
    "User: assalam o alaikum. beta Ahmed ki college applications ka scene hai, thora guide karo",
    "Assistant: Walaikum assalam! Of course. Where is he applying?",
    "User: Penn mein early decision diya tha, result 15 December ko aayega. baaki regular decision Jan tak",
    "Assistant: Okay. For regular decision, aim for a balanced list: two reaches, three targets, two safeties.",
    "User: woh CS karna chahta tha... nahi, ab kehta hai economics, last week change kiya",
    "Assistant: Economics is strong at Penn, Temple and Pitt. Want schools known for econ?",
    "User: haan. aur deadlines mujhe hi track karni hain, main nurse hoon, night shifts, Tuesday Wednesday Thursday, din mein sota hoon un dinon",
    "Assistant: Understood, I'll keep reminders for your off days.",
    "User: Ahmed ke dost kehte hain Ivy League sab scam hai lol, bachon ki baatein",
    "Assistant: Haha, every teen has a theory.",
    "User: FAFSA kab tak submit karna hai?",
    "Assistant: The federal deadline is in June, but many states and colleges want it much earlier, so aim for this month.",
    mins=4)],
  known=[
    K(1, "fact", "ahmed", "son, in 12th grade", "Ahmed, the user's son, is in 12th grade."),
    K(2, "fact", "occupation", "nurse", "The user is a nurse."),
    K(3, "fact", "home city", "Philadelphia", "The user lives in Philadelphia."),
  ],
  obs=[
    O("fact", "ahmed", "wants to study economics", "Ahmed, the user's son, now wants to study economics (not CS).", "stated", 0.6, "person", "ab kehta hai economics"),
    O("fact", "occupation", "nurse", "The user is a nurse.", "stated", 0.85, "user", "main nurse hoon", merge={"target": "m2", "relation": "same"}),
    O("routine", "night shifts", "Tuesday, Wednesday, Thursday nights", "The user works night shifts on Tuesday, Wednesday and Thursday and sleeps during the day.", "stated", 0.7, "user", "night shifts, Tuesday Wednesday Thursday"),
    O("fact", "ivy league", "a scam (Ahmed's friends' view)", "Ahmed's friends say the Ivy League is a scam.", "quoting", 0.1, "user", "Ivy League sab scam hai"),
  ],
  plans=[P("Ahmed's Penn early decision result", "2026-12-15", "Penn mein early decision", "15 December ko", who=["Ahmed"])])

# ---------- 035 SQL perf, style, decision, travel (E, en)
X(35, "long", "en", "E", [C(
    "User: this query takes 40s on the reporting db. select account_id, sum(amount) from txns where created_at > now() - interval '90 days' group by 1",
    "Assistant: Check EXPLAIN first. You likely need an index on created_at, or a BRIN index if the table is append-only.",
    "User: it's append-only, 300M rows",
    "Assistant: Then BRIN is cheap and effective: create index concurrently txns_created_brin on txns using brin (created_at);",
    "User: ok. and from now on write SQL keywords in uppercase, your lowercase stuff drives me nuts",
    "Assistant: Understood. SELECT account_id, SUM(amount) FROM txns WHERE created_at > NOW() - INTERVAL '90 days' GROUP BY 1;",
    "User: better. long term we've decided to move all finsight reporting to ClickHouse anyway, Postgres stays for transactions only",
    "Assistant: Sensible split. I can help plan the CDC pipeline.",
    "User: next week. I fly to Riyadh tomorrow for a client workshop, back Tuesday, so I'll be patchy till then",
    "Assistant: Safe travels.",
    "User: our DBA's answer to everything is 'just add an index', like it's holy water",
    "Assistant: In this case he'd be right, to be fair.",
    mins=2, project="finsight")],
  obs=[
    O("style", "sql formatting", "uppercase SQL keywords", "The user wants SQL keywords written in uppercase.", "stated", 0.65, "user", "write SQL keywords in uppercase"),
    O("decision", "reporting database", "ClickHouse; Postgres for transactions only", "finsight is moving all reporting to ClickHouse; Postgres stays for transactions only.", "stated", 0.85, "project", "move all finsight reporting to ClickHouse", project="finsight"),
    O("context", "availability", "travelling, patchy availability", "The user is travelling to Riyadh for a client workshop and will be hard to reach.", "temporary", 0.5, "user", "I'll be patchy till then", until="2026-11-24T23:59", time_text="back Tuesday"),
    O("fact", "indexes", "just add an index (DBA's view)", "The user's DBA says to just add an index to everything.", "quoting", 0.1, "user", "just add an index"),
  ],
  plans=[P("Trip to Riyadh for a client workshop", "2026-11-21", "I fly to Riyadh", "tomorrow", where="Riyadh")])

# ---------- 036 hackathon organiser, corrected cap (F, en)
X(36, "long", "en", "F", [
    EM("Kamran Shah <kamran@sabzcloud.example>",
       "HackFest sponsorship. Hi, happy to confirm Sabz Cloud will sponsor HackFest Lahore with PKR 500,000 and cloud credits for all teams. Two of our engineers will join the judging panel on Saturday 14 November. Please share the logo specs by Wednesday. Best, Kamran",
       mins=200, project="hackfest"),
    C("User: sponsor locked!! ok help me update the HackFest plan",
      "Assistant: Congrats! What's changed?",
      "User: venue is final, Ravi Tech Park auditorium. registrations capped at 250",
      "Assistant: Updated: venue Ravi Tech Park, cap 250.",
      "User: wait, no, we upgraded to the bigger hall last night, cap is 300 now",
      "Assistant: Updated: cap 300.",
      "User: Sara, my co-organiser, keeps joking we should make it 72 hours so nobody sleeps lol",
      "Assistant: The 24-hour format is plenty, I'd say.",
      "User: agreed. and one rule I'm firm on: every team must have at least one woman, we announced it already",
      "Assistant: Added to the rules and the registration form.",
      "User: can you draft the logo spec email to Kamran too",
      "Assistant: Sure: 'Hi Kamran, please send your logo as SVG and transparent PNG, at least 1000px wide...'",
      mins=15, project="hackfest"),
  ],
  obs=[
    O("fact", "sponsor", "Sabz Cloud, PKR 500,000 plus credits", "Sabz Cloud is sponsoring HackFest with PKR 500,000 and cloud credits.", "implied", 0.6, "project", "Sabz Cloud will sponsor HackFest Lahore with PKR 500,000", project="hackfest", event=0),
    O("decision", "venue", "Ravi Tech Park auditorium", "HackFest's venue is the Ravi Tech Park auditorium.", "stated", 0.75, "project", "venue is final, Ravi Tech Park auditorium", project="hackfest", event=1),
    O("decision", "registration cap", "300", "HackFest registrations are capped at 300.", "stated", 0.7, "project", "cap is 300 now", project="hackfest", event=1),
    O("fact", "sara", "the user's co-organiser", "Sara is the user's HackFest co-organiser.", "stated", 0.5, "person", "Sara, my co-organiser", event=1),
    O("idea", "72-hour hackathon", "make it 72 hours (Sara's joke)", "Sara jokes HackFest should run 72 hours so nobody sleeps.", "quoting", 0.1, "project", "make it 72 hours so nobody sleeps", project="hackfest", event=1),
    O("requirement", "team composition", "at least one woman per team", "Every HackFest team must include at least one woman.", "stated", 0.75, "project", "every team must have at least one woman", project="hackfest", event=1),
  ],
  plans=[
    P("HackFest judging with Sabz Cloud engineers", "2026-11-14", "join the judging panel", "Saturday 14 November", where="Ravi Tech Park", event=0),
    P("Send logo specs to Kamran", "2026-11-11", "share the logo specs", "by Wednesday", who=["Kamran Shah"], event=0),
  ])

# ---------- 037 home bakery, baking days update, known (A, en)
X(37, "long", "en", "A", [C(
    "User: help me price a big order. 200 cupcakes for a mehndi on Saturday, delivery by 6pm. my usual is 180 per cupcake",
    "Assistant: For 200, a 10% bulk discount is common: 162 each, 32,400 total. Add delivery separately.",
    "User: ok 32,400 + 1500 delivery. also baking days are now Wednesday and Saturday, school timings changed for the kids so Tuesday doesn't work anymore",
    "Assistant: Noted. For Saturday's order, will you bake Friday night or early Saturday?",
    "User: friday night, ugh. and I've decided, orders only through Instagram DMs from now on, no more WhatsApp orders, too messy",
    "Assistant: Makes sense. Want a pinned post explaining the change?",
    "User: yes pls. Faraz says I should open a franchise lol he thinks I'm a whole company now",
    "Assistant: Ha, one mehndi at a time! Here's the post: 'Hi lovely people! From now on we take orders only via Instagram DM...'",
    "User: make it a bit more fun, emojis allowed for this one",
    "Assistant: 'Hi lovely people! 🧁 From now on, orders are only via Instagram DM 💌 See you in the inbox!'",
    mins=3)],
  known=[
    K(1, "fact", "business", "home bakery", "The user runs a home bakery."),
    K(2, "routine", "baking days", "Tuesdays and Fridays", "The user bakes on Tuesdays and Fridays."),
    K(3, "preference", "currency", "PKR", "The user works in PKR."),
    K(4, "fact", "faraz", "the user's husband", "Faraz is the user's husband."),
  ],
  obs=[
    O("fact", "cupcake price", "PKR 180 per cupcake", "The user's usual price is 180 per cupcake.", "stated", 0.5, "user", "my usual is 180 per cupcake"),
    O("routine", "baking days", "Wednesdays and Saturdays", "The user now bakes on Wednesdays and Saturdays.", "stated", 0.65, "user", "baking days are now Wednesday and Saturday", merge={"target": "m2", "relation": "different"}),
    O("fact", "children", "has school-age kids", "The user has school-age children.", "implied", 0.45, "user", "school timings changed for the kids"),
    O("decision", "order channel", "Instagram DMs only, no WhatsApp", "The user takes bakery orders only through Instagram DMs, no longer on WhatsApp.", "stated", 0.75, "user", "orders only through Instagram DMs from now on"),
    O("idea", "franchise", "open a franchise (Faraz's view)", "Faraz says the user should open a franchise.", "quoting", 0.1, "user", "Faraz says I should open a franchise"),
  ],
  plans=[P("Deliver 200 cupcakes for a mehndi", "2026-10-31T18:00", "200 cupcakes for a mehndi", "Saturday, delivery by 6pm")])

# ---------- 038 Murree trip with friends, corrected day (B, mixed)
X(38, "long", "mixed", "B", [C(
    "User: yaar weekend pe Murree ka plan hai dosto ke saath, Saad, Umer aur main",
    "Assistant: Nice! When are you leaving?",
    "User: Saturday subah nikal rahe the. nahi wait, Saad ki Saturday duty lag gayi, ab Sunday subah 7 baje nikalenge",
    "Assistant: Okay, Sunday 7am departure.",
    "User: Saad drive karega, Allah hum sab pe reham kare 😂",
    "Assistant: Haha, maybe someone can take over on the climbs.",
    "User: main nahi, raat ko main gaari nahi chalata, aankhon ka masla hai, night blindness types",
    "Assistant: Then you're the navigator. Want a stay suggestion?",
    "User: haan but hotel nahi, mujhe cottages ya Airbnb type jagah pasand hai, hotels boring lagte hain",
    "Assistant: There are cottages around Bhurban and Kuldana; a 3-bedroom is usually 15–25k a night in November.",
    "User: theek, aur Murree ka mausam kaisa hoga next week?",
    "Assistant: Cold, around 4–12°C, with a chance of rain; snow is unlikely before December.",
    mins=5)],
  obs=[
    O("fact", "saad's driving", "dangerous driver (teasing)", "The user teased that Saad's driving needs God's mercy.", "joking", 0.1, "person", "Allah hum sab pe reham kare"),
    O("fact", "night driving", "doesn't drive at night (eyesight)", "The user doesn't drive at night because of an eyesight problem.", "stated", 0.65, "user", "raat ko main gaari nahi chalata"),
    O("preference", "accommodation", "cottages or Airbnb over hotels", "The user prefers cottages or Airbnb-style places over hotels.", "stated", 0.65, "user", "mujhe cottages ya Airbnb type jagah pasand hai"),
  ],
  plans=[P("Murree trip with friends", "2026-11-08T07:00", "Murree ka plan", "Sunday subah 7 baje", where="Murree", who=["Saad", "Umer"])])

# ---------- 039 meal plan, assistant assumes vegan, known (C, en)
X(39, "long", "en", "C", [C(
    "User: can you make me a meal plan for next week, weeknights only",
    "Assistant: Sure! Since you're vegan, here's a plan: Mon: chickpea curry, Tue: tofu stir-fry, Wed: lentil shepherd's pie...",
    "User: ah no, I'm not vegan anymore, I'm pescatarian now, been eating fish since the summer",
    "Assistant: Thanks for the update! Revised: Mon: salmon traybake, Tue: tofu stir-fry, Wed: prawn linguine...",
    "User: better. it's for two btw, me and Lena, and she can't stand mushrooms",
    "Assistant: Doubled the quantities and took out the mushroom risotto.",
    "User: I meal prep on Sunday afternoons so stuff that keeps 3-4 days",
    "Assistant: Swapped the linguine for a fish pie that reheats well.",
    "User: if I had a bigger kitchen I'd get an air fryer, honestly",
    "Assistant: A compact 4L one fits most counters if you change your mind.",
    "User: you assume a lot about my counters 😂 ok send the shopping list",
    "Assistant: Shopping list: salmon fillets x4, raw prawns 300g, firm tofu x2, potatoes 1kg, frozen peas...",
    mins=3)],
  known=[
    K(1, "preference", "diet", "vegan", "The user is vegan."),
    K(2, "fact", "home city", "Bristol", "The user lives in Bristol."),
    K(3, "fact", "lena", "the user's flatmate", "Lena is the user's flatmate."),
  ],
  obs=[
    O("preference", "diet", "pescatarian", "The user is pescatarian now (no longer vegan).", "stated", 0.85, "user", "I'm pescatarian now", merge={"target": "m1", "relation": "different"}),
    O("fact", "lena", "can't stand mushrooms", "Lena, the user's flatmate, dislikes mushrooms.", "stated", 0.5, "person", "she can't stand mushrooms"),
    O("routine", "meal prep", "Sunday afternoons", "The user meal preps on Sunday afternoons.", "stated", 0.6, "user", "I meal prep on Sunday afternoons"),
    O("idea", "air fryer", "would get an air fryer with a bigger kitchen", "The user would get an air fryer if they had a bigger kitchen.", "hypothetical", 0.15, "user", "if I had a bigger kitchen I'd get an air fryer"),
  ])

# ---------- 040 heard + IT email + chat, role update (D, en)
X(40, "long", "en", "D", [
    H("Priya: all-hands moved to Thursday 2pm, apparently the CEO is flying in for it. Marcus: ooh. Priya: I bet it's layoffs, it's always layoffs.", mins=90),
    EM("Corvid IT <it-helpdesk@corvid.example>",
       "Action required: password rotation. All staff must rotate their SSO password and re-enroll MFA by Friday, December 4. Accounts not updated by then will be locked. – Corvid IT",
       mins=60),
    C("User: ok so all-hands is Thursday at 2 now. add it",
      "Assistant: Added: All-hands, Thursday Dec 3, 2:00 PM.",
      "User: also I need to sort the SSO thing before Friday",
      "Assistant: I'll remind you Thursday morning.",
      "User: and since Monday I'm officially the platform team lead, so update whatever you have on me, I'm not just 'senior engineer' anymore",
      "Assistant: Congratulations! Updated.",
      "User: I'm out Friday afternoon, driving test at 1pm, wish me luck",
      "Assistant: Good luck! You'll do great.",
      "User: Priya thinks the CEO visit means layoffs but she says that every quarter so 🤷",
      "Assistant: Hopefully it's just an update.",
      mins=5),
  ],
  known=[
    K(1, "fact", "role", "senior engineer", "The user is a senior engineer."),
    K(2, "fact", "employer", "Corvid Systems", "The user works at Corvid Systems."),
    K(3, "preference", "meeting time", "afternoons", "The user prefers meetings in the afternoon."),
  ],
  obs=[
    O("fact", "role", "platform team lead", "The user is now the platform team lead.", "stated", 0.85, "user", "I'm officially the platform team lead", event=2, merge={"target": "m1", "relation": "different"}),
    O("fact", "layoffs", "CEO visit means layoffs (Priya's view)", "Priya thinks the CEO visit means layoffs.", "quoting", 0.1, "user", "Priya thinks the CEO visit means layoffs", event=2),
  ],
  plans=[
    P("Company all-hands", "2026-12-03T14:00", "all-hands", "Thursday at 2", event=2),
    P("Rotate SSO password and re-enroll MFA", "2026-12-04", "rotate their SSO password and re-enroll MFA", "by Friday, December 4", event=1),
    P("Driving test", "2026-12-04T13:00", "driving test", "Friday afternoon", event=2),
  ])
