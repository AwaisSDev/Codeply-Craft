import json

OUT = "/home/user/Codeply-Craft/research/dtw/benchmark/parts/pl.jsonl"
EX = []


def chat(text, m=2, project=None):
    e = {"source": "chat", "trust": "user", "minutes_ago": m, "text": text}
    if project:
        e["project"] = project
    return e


def email(frm, subject_body, m=30):
    return {"source": "email", "trust": "external", "minutes_ago": m,
            "text": f"Email the user received (from {frm}): {subject_body}"}


def K(i, kind, slot, value, text, **kw):
    d = {"id": f"m{i}", "kind": kind, "slot": slot, "value": value, "text": text}
    d.update(kw)
    return d


def P(what, when, evidence, time_text, where="", who=None, event=0, **kw):
    d = {"what": what, "when": when, "where": where, "who": who or [], "evidence": evidence, "time_text": time_text}
    if event:
        d["event"] = event
    d.update(kw)
    return d


def O(kind, slot, value, text, certainty, importance, evidence, about="user", event=0, **kw):
    d = {"kind": kind, "slot": slot, "value": value, "text": text, "certainty": certainty,
         "importance": importance, "about": about, "evidence": evidence}
    if event:
        d["event"] = event
    d.update(kw)
    return d


def CTX(slot, value, text, until, evidence, time_text, importance=0.5, event=0, **kw):
    return O("context", slot, value, text, "temporary", importance, evidence, event=event,
             until=until, time_text=time_text, **kw)


def ex(task, lang, anchor, events, observations=(), plans=(), known=()):
    EX.append({"task": task, "lang": lang, "anchor": anchor, "events": list(events), "known": list(known),
               "observations": list(observations), "plans": list(plans), "expect": {}})


# ---------------------------------------------------------------- PLAN: anchor A (Thu 2026-10-29 09:10 PKT)
ex("plan", "en", "A",
   [chat("User: dinner w/ Hamza and Rida tomorrow at 8pm, Bundu Khan on MM Alam. remind me to leave by 7:30\nAssistant: Done, I'll remind you at 7:30.", 3)],
   plans=[P("Dinner with Hamza and Rida", "2026-10-30T20:00", "dinner w/ Hamza and Rida", "tomorrow at 8pm",
            where="Bundu Khan, MM Alam", who=["Hamza", "Rida"])],
   known=[K(1, "fact", "home city", "Lahore", "The user lives in Lahore.")])

ex("plan", "en", "A",
   [chat("User: fyi every monday i have a 9am standup with the platform team, it runs like 20 min so dont book stuff right on top of it\nAssistant: Got it, I'll keep Monday 9:00-9:30 clear.", 4)],
   observations=[O("routine", "monday standup", "9am standup every Monday", "The user has a 9am standup with the platform team every Monday.",
                   "stated", 0.6, "every monday i have a 9am standup")])

ex("plan", "mixed", "A",
   [chat("User: kal shaam 5 baje Dr. Nadia ke clinic jana hai, ammi ka checkup hai. reminder laga do pls\nAssistant: Theek hai, kal 4:15 pe yaad dila doon ga.", 5)],
   plans=[P("Ammi's checkup with Dr. Nadia", "2026-10-30T17:00", "Dr. Nadia ke clinic jana hai", "kal shaam 5 baje",
            where="Dr. Nadia's clinic", who=["Ammi", "Dr. Nadia"])])

ex("plan", "en", "A",
   [email("Usman Tariq <usman@brightlane.pk>",
          "Interview at Brightlane. Hi, thanks for applying to Brightlane for the Backend Engineer role. We'd like to invite you for a technical interview on Monday, 2 November at 11:00 AM at our Gulberg office (3rd floor, Plot 41). Please bring your CNIC and arrive 10 minutes early. Regards, Usman", 40)],
   observations=[O("fact", "job search", "applied to Brightlane, backend role", "The user applied for a Backend Engineer role at Brightlane.",
                   "implied", 0.6, "thanks for applying to Brightlane")],
   plans=[P("Technical interview at Brightlane", "2026-11-02T11:00", "technical interview", "Monday, 2 November at 11:00 AM",
            where="Brightlane office, Gulberg", who=["Usman Tariq"])])

ex("plan", "en", "A",
   [chat("User: ok weekend: saturday morning 10 the plumber comes for the geyser, and sunday 1:30 lunch at my in-laws in DHA\nAssistant: Both added.", 6)],
   plans=[P("Plumber visit for the geyser", "2026-10-31T10:00", "the plumber comes for the geyser", "saturday morning 10"),
          P("Lunch at the in-laws'", "2026-11-01T13:30", "lunch at my in-laws in DHA", "sunday 1:30", where="in-laws' house, DHA")])

ex("plan", "en", "A",
   [chat("User: Can you set up the sprint review with the Kestrel team for next Tuesday 3pm? And please, no Teams links. I only use Google Meet for external calls.\nAssistant: Sure, Google Meet link it is.", 2)],
   observations=[O("preference", "video call tool", "Google Meet, not Teams", "The user only uses Google Meet (not Teams) for external calls.",
                   "stated", 0.75, "I only use Google Meet for external calls")],
   plans=[P("Sprint review with the Kestrel team", "2026-11-03T15:00", "sprint review with the Kestrel team", "next Tuesday 3pm")])

ex("plan", "en", "A",
   [chat("User: the 6pm call with Faraz today got cancelled, he's down with something. so evening's free\nAssistant: Removed it from your day.", 8)],
   known=[K(1, "preference", "reply length", "short", "The user prefers short replies.")])

ex("plan", "ur", "A",
   [chat("User: parson subah 9 baje Islamabad ke liye nikalna hai, Daewoo se. ticket le li hai\nAssistant: Acha, safar mubarak!", 7)],
   plans=[P("Trip to Islamabad by Daewoo", "2026-10-31T09:00", "Islamabad ke liye nikalna hai", "parson subah 9 baje", where="Islamabad")])

# ---------------------------------------------------------------- PLAN: anchor B (Fri 2026-11-06 18:45 PKT)
ex("plan", "en", "B",
   [chat("User: physio appt moved from monday to wednesday 11:15, same clinic (Shifa on Jail Rd)\nAssistant: Updated.", 3)],
   plans=[P("Physio appointment", "2026-11-11T11:15", "physio appt", "wednesday 11:15", where="Shifa clinic, Jail Road")])

ex("plan", "en", "B",
   [chat("User: booked a table at Cafe Aylanto for tomorrow night 9pm, me + Sana for our anniversary 🥂 dont let me forget flowers\nAssistant: Congrats! I'll remind you about flowers tomorrow afternoon.", 5)],
   observations=[O("fact", "sana", "the user's partner", "Sana is the user's partner (they share an anniversary).",
                   "implied", 0.75, "me + Sana for our anniversary", about="person")],
   plans=[P("Anniversary dinner with Sana", "2026-11-07T21:00", "booked a table at Cafe Aylanto", "tomorrow night 9pm",
            where="Cafe Aylanto", who=["Sana"])])

ex("plan", "en", "B",
   [chat("User: we should totally do a trip to Hunza next month or something, if work ever calms down. no idea when tho\nAssistant: Sounds lovely. Want me to look at options later?\nUser: maybe, not now", 4)],
   observations=[O("idea", "hunza trip", "maybe a trip to Hunza", "The user would like to take a trip to Hunza someday (nothing decided).",
                   "hypothetical", 0.2, "we should totally do a trip to Hunza")])

ex("plan", "mixed", "B",
   [chat("User: Sunday 2 baje cricket match hai Gymkhana ground pe, Bilal ki team vs hamari 🏏 kit dhoni hai\nAssistant: Haha, best of luck!", 6)],
   plans=[P("Cricket match against Bilal's team", "2026-11-08T14:00", "cricket match", "Sunday 2 baje",
            where="Gymkhana ground", who=["Bilal"])])

ex("plan", "en", "B",
   [email("Dr. Hira Qureshi <hira.q@northfield.edu.pk>",
          "Thesis submission reminder. Dear all, a gentle reminder that the final thesis draft is due on the 14th by 5pm via the portal. Late submissions will not be accepted without a medical certificate. Best, Dr. Qureshi", 25)],
   observations=[O("fact", "studies", "writing a thesis at Northfield", "The user is a student writing a thesis at Northfield.",
                   "implied", 0.55, "final thesis draft")],
   plans=[P("Final thesis draft due", "2026-11-14T17:00", "final thesis draft is due", "the 14th by 5pm", where="portal")])

ex("plan", "en", "B",
   [chat("User: call w/ the landlord is off, he'll text instead. but the electrician is still coming monday 17:30\nAssistant: Okay, kept the electrician.", 2)],
   plans=[P("Electrician visit", "2026-11-09T17:30", "the electrician is still coming", "monday 17:30")])

ex("plan", "en", "B",
   [chat("User: what time is maghrib these days?\nAssistant: Around 5:15 pm in Lahore at this time of year.\nUser: ok so the mehndi is Thursday, starts at 8, we leave around 7. Mama's side is hosting it at Lalazar Banquet\nAssistant: Got it, noted for Thursday.", 9)],
   plans=[P("Mehndi hosted by Mama's side", "2026-11-12T20:00", "the mehndi", "Thursday, starts at 8", where="Lalazar Banquet")])

ex("plan", "ur", "B",
   [chat("User: kal raat 9 baje Ahmed bhai ki taraf khana hai, ammi bhi saath jayengi\nAssistant: Theek hai, note kar liya.", 3)],
   plans=[P("Dinner at Ahmed bhai's", "2026-11-07T21:00", "Ahmed bhai ki taraf khana hai", "kal raat 9 baje",
            where="Ahmed bhai's house", who=["Ahmed", "Ammi"])])

# ---------------------------------------------------------------- PLAN: anchor C (Sat 2026-11-14 11:30 London)
ex("plan", "en", "C",
   [chat("User: parents evening at Ellie's school on the 19th, half six. need to ask her teacher about her reading\nAssistant: Added for Thursday 6:30pm.", 4)],
   observations=[O("todo", "ellie's reading", "ask teacher about Ellie's reading", "The user needs to ask Ellie's teacher about her reading.",
                   "stated", 0.5, "need to ask her teacher about her reading")],
   plans=[P("Parents' evening at Ellie's school", "2026-11-19T18:30", "parents evening at Ellie's school", "the 19th, half six",
            where="Ellie's school", who=["Ellie"])])

ex("plan", "en", "C",
   [chat("User: I swim at the leisure centre every Tuesday and Thursday 7am before work, so don't put anything before 9 on those days\nAssistant: Understood.", 3)],
   observations=[O("routine", "swimming", "Tue and Thu 7am at the leisure centre", "The user swims at the leisure centre every Tuesday and Thursday at 7am before work.",
                   "stated", 0.65, "I swim at the leisure centre every Tuesday and Thursday 7am"),
                 O("preference", "meeting time", "nothing before 9am on Tue/Thu", "The user wants nothing scheduled before 9am on Tuesdays and Thursdays.",
                   "stated", 0.7, "don't put anything before 9 on those days")])

ex("plan", "en", "C",
   [chat("User: Train to Manchester on Monday, the 08:47 from Euston. need a coffee before that tbh\nAssistant: Noted, it's in your calendar.", 5)],
   plans=[P("Train to Manchester", "2026-11-16T08:47", "Train to Manchester", "Monday, the 08:47", where="Euston")])

ex("plan", "en", "C",
   [chat("User: Tom asked if I'm up for five-a-side on Wednesday at 8, not sure yet tbh, depends on work\nAssistant: Want me to remind you to reply to him?\nUser: nah I'll sort it", 6)],
   observations=[O("idea", "five-a-side", "might play five-a-side Wednesday", "The user might play five-a-side with Tom on Wednesday, but has not decided.",
                   "hypothetical", 0.2, "Tom asked if I'm up for five-a-side")])

ex("plan", "en", "C",
   [chat("User: can you add: Sunday roast at Gran's, 1pm tomorrow. Mum and Jake will be there\nAssistant: Added.", 2)],
   plans=[P("Sunday roast at Gran's", "2026-11-15T13:00", "Sunday roast at Gran's", "1pm tomorrow",
            where="Gran's house", who=["Gran", "Mum", "Jake"])])

ex("plan", "en", "C",
   [email("Priya Raman <priya@harbourdental.co.uk>",
          "Appointment confirmation. Hello, your hygienist appointment is booked for Thursday 26 November at 14:40 at Harbour Dental, 12 Quay St. If you need to reschedule please call us at least 24 hours ahead. Kind regards, Harbour Dental", 50)],
   plans=[P("Hygienist appointment", "2026-11-26T14:40", "hygienist appointment", "Thursday 26 November at 14:40",
            where="Harbour Dental, 12 Quay St")])

ex("plan", "mixed", "C",
   [chat("User: Friday 2 baje Imran ke saath lunch hai Whitechapel mein, Jummah ke baad seedha wahan jaunga\nAssistant: Done, added.", 4)],
   plans=[P("Lunch with Imran", "2026-11-20T14:00", "Imran ke saath lunch", "Friday 2 baje", where="Whitechapel", who=["Imran"])])

ex("plan", "en", "C",
   [chat("User: Change of plan: the dentist on Tuesday is cancelled (they rang this morning), but I've now got the boiler service Wednesday 8-12 and drinks with Leah Friday 7pm at The Crown.\nAssistant: Removed the dentist, added both.", 3)],
   plans=[P("Boiler service", "2026-11-18T08:00", "the boiler service", "Wednesday 8-12"),
          P("Drinks with Leah", "2026-11-20T19:00", "drinks with Leah", "Friday 7pm", where="The Crown", who=["Leah"])])

# ---------------------------------------------------------------- PLAN: anchor D (Tue 2026-12-01 07:55 New York)
ex("plan", "en", "D",
   [chat("User: standup moved to 10:30 today bc of the all-hands\nAssistant: Updated.", 2)],
   plans=[P("Standup", "2026-12-01T10:30", "standup", "10:30 today")])

ex("plan", "en", "D",
   [chat("User: Flight to Austin Thursday 6:05am out of LGA, AA 1123. ugh that's a 4am alarm\nAssistant: Oof. Want a reminder Wednesday night to pack?\nUser: yes", 5)],
   plans=[P("Flight to Austin", "2026-12-03T06:05", "Flight to Austin", "Thursday 6:05am", where="LGA")])

ex("plan", "en", "D",
   [chat("User: My trainer moved our session to next Tuesday at 5:30 pm, same zoom link\nAssistant: Got it, moved.", 3)],
   plans=[P("Training session", "2026-12-08T17:30", "trainer moved our session", "next Tuesday at 5:30 pm", where="Zoom")])

ex("plan", "en", "D",
   [email("Dana Whitfield <dana@corvidlabs.io>",
          "Re: Q1 roadmap. Works for me, let's lock the roadmap review for Friday Dec 4, 2:00 PM ET in the 5th floor conference room. I'll send the invite. Bring the churn numbers if you have them. Dana", 35)],
   observations=[O("todo", "churn numbers", "bring churn numbers to roadmap review", "The user should bring the churn numbers to the roadmap review.",
                   "implied", 0.45, "Bring the churn numbers")],
   plans=[P("Roadmap review with Dana", "2026-12-04T14:00", "the roadmap review", "Friday Dec 4, 2:00 PM ET",
            where="5th floor conference room", who=["Dana Whitfield"])])

ex("plan", "en", "D",
   [chat("User: every first Monday of the month we do a board call at 4, it's a drag but whatever\nAssistant: Noted.", 4)],
   observations=[O("routine", "board call", "first Monday of the month at 4pm", "The user has a board call at 4pm on the first Monday of every month.",
                   "stated", 0.6, "every first Monday of the month we do a board call at 4")])

ex("plan", "en", "D",
   [chat("User: pick up the cake from Levain at noon on Saturday. Maya's 7th birthday party is at 3 at our place, 12 kids, pray for me\nAssistant: Ha, good luck! Both are in your calendar.", 6)],
   observations=[O("fact", "maya", "turning 7", "Maya is turning 7; her birthday party is at the user's home.",
                   "implied", 0.6, "Maya's 7th birthday", about="person")],
   plans=[P("Pick up the cake from Levain", "2026-12-05T12:00", "pick up the cake from Levain", "noon on Saturday", where="Levain"),
          P("Maya's 7th birthday party", "2026-12-05T15:00", "Maya's 7th birthday party", "at 3", where="the user's home", who=["Maya"])])

ex("plan", "en", "D",
   [chat("User: Kevin wants to do lunch thursday or friday\nAssistant: Which day works better for you?\nUser: friday, 12:30 at Joe's Pizza on Carmine\nAssistant: Booked in.", 5)],
   plans=[P("Lunch with Kevin", "2026-12-04T12:30", "Kevin wants to do lunch", "friday, 12:30", where="Joe's Pizza, Carmine St", who=["Kevin"])])

ex("plan", "en", "D",
   [chat("User: Grant report due to the foundation by 11:59pm on the 15th. ugh.\nAssistant: Want me to block time to write it?", 7)],
   plans=[P("Grant report due to the foundation", "2026-12-15T23:59", "Grant report due to the foundation", "by 11:59pm on the 15th")])

# ---------------------------------------------------------------- PLAN: anchor E (Fri 2026-11-20 22:05 Dubai)
ex("plan", "en", "E",
   [chat("User: brunch tomorrow at 1 at Arabian Tea House w/ the girls (Noor, Dalia, Reem) 💅\nAssistant: Added!", 3)],
   plans=[P("Brunch with Noor, Dalia and Reem", "2026-11-21T13:00", "brunch", "tomorrow at 1",
            where="Arabian Tea House", who=["Noor", "Dalia", "Reem"])])

ex("plan", "en", "E",
   [chat("User: ok so sunday 8am visa medical at the Al Nahda center, then emirates ID biometrics tuesday 10:20. both need the passport copy\nAssistant: Added both, with a note about the passport copy.", 4)],
   plans=[P("Visa medical test", "2026-11-22T08:00", "visa medical at the Al Nahda center", "sunday 8am", where="Al Nahda center"),
          P("Emirates ID biometrics", "2026-11-24T10:20", "emirates ID biometrics", "tuesday 10:20")])

ex("plan", "mixed", "E",
   [chat("User: parson raat 8 baje Arsalan ka walima hai Sharjah mein, outfit abhi tak nahi liya 😭\nAssistant: Kal mall chale jao!", 5)],
   plans=[P("Arsalan's walima", "2026-11-22T20:00", "Arsalan ka walima", "parson raat 8 baje", where="Sharjah", who=["Arsalan"])])

ex("plan", "en", "E",
   [chat("User: the client demo tomorrow is pushed, Faisal says Monday same time\nAssistant: Same time being 11am?\nUser: yep", 6)],
   plans=[P("Client demo", "2026-11-23T11:00", "the client demo", "Monday same time", who=["Faisal"])])

ex("plan", "en", "E",
   [chat("User: I do Friday family lunch at my aunt's every week, but this Sunday at 6 I'm taking Mum to Global Village, she's been asking for ages\nAssistant: That'll be fun.", 4)],
   observations=[O("routine", "family lunch", "Friday family lunch at aunt's", "The user has family lunch at their aunt's every Friday.",
                   "stated", 0.6, "Friday family lunch at my aunt's every week")],
   plans=[P("Global Village with Mum", "2026-11-22T18:00", "taking Mum to Global Village", "this Sunday at 6",
            where="Global Village", who=["Mum"])])

ex("plan", "en", "E",
   [chat("User: thinking of maybe flying to Muscat for the National Day long weekend? nothing booked, prices are insane rn\nAssistant: Want me to watch fares?\nUser: eh not yet", 3)],
   observations=[O("idea", "muscat trip", "maybe fly to Muscat for long weekend", "The user is considering a trip to Muscat over the National Day long weekend (nothing booked).",
                   "hypothetical", 0.2, "thinking of maybe flying to Muscat")])

ex("plan", "en", "E",
   [chat("User: VAT return has to be filed by the 28th. and pls stop suggesting excel templates, I use Google Sheets for all my accounting\nAssistant: Noted, Google Sheets from now on.", 2)],
   known=[K(1, "preference", "spreadsheet tool", "Excel", "The user uses Excel for spreadsheets.")],
   observations=[O("preference", "spreadsheet tool", "Google Sheets", "The user uses Google Sheets for all their accounting, not Excel.",
                   "stated", 0.75, "I use Google Sheets for all my accounting", merge={"target": "m1", "relation": "different"})],
   plans=[P("VAT return filing deadline", "2026-11-28", "VAT return has to be filed", "by the 28th")])

# ---------------------------------------------------------------- PLAN: anchor F (Mon 2026-11-09 13:20 PKT)
ex("plan", "ur", "F",
   [chat("User: kal Asr ke baad Faisal Mosque pe Usman se milna hai\nAssistant: Theek hai, yaad dila doon ga.", 3)],
   plans=[P("Meet Usman at Faisal Mosque", "2026-11-10", "Usman se milna hai", "kal Asr ke baad", where="Faisal Mosque", who=["Usman"])])

ex("plan", "en", "F",
   [chat("User: Class test for Data Structures is on Thursday 9am, room B-204. also lab viva Saturday 11. kill me\nAssistant: You've got this. Want a revision plan?", 5)],
   plans=[P("Data Structures class test", "2026-11-12T09:00", "Class test for Data Structures", "Thursday 9am", where="room B-204"),
          P("Lab viva", "2026-11-14T11:00", "lab viva", "Saturday 11")])

ex("plan", "en", "F",
   [email("Sadia Anwar <sadia@kitebird.co>",
          "Kickoff call. Hi! Just confirming our kickoff call tomorrow at 3:30 pm PKT on Zoom, with me and Hamid from our side. Agenda attached. Looking forward, Sadia", 20)],
   plans=[P("Kickoff call with Kitebird", "2026-11-10T15:30", "our kickoff call", "tomorrow at 3:30 pm PKT",
            where="Zoom", who=["Sadia Anwar", "Hamid"])])

ex("plan", "mixed", "F",
   [chat("User: yaar Wednesday wali meeting with Zain cancel ho gayi, ab next week dekhenge kabhi\nAssistant: Theek hai, hata di.", 4)])

ex("plan", "en", "F",
   [chat("User: can you help me plan the week\nAssistant: Sure, what's on it?\nUser: tue 7pm badminton w/ Kashif at Punjab Club. thu is my sister's mehndi so nothing else that day. fri 9:30 car service at Toyota Township.\nAssistant: Got it, all three are in.", 6)],
   plans=[P("Badminton with Kashif", "2026-11-10T19:00", "badminton w/ Kashif", "tue 7pm", where="Punjab Club", who=["Kashif"]),
          P("Sister's mehndi", "2026-11-12", "my sister's mehndi", "thu"),
          P("Car service", "2026-11-13T09:30", "car service at Toyota Township", "fri 9:30", where="Toyota Township")])

ex("plan", "en", "F",
   [chat("User: this weekend we're driving up to Murree with the cousins, leaving early sat. any good dhabas on the way?\nAssistant: A few! Want a list?", 3)],
   plans=[P("Trip to Murree with the cousins", "2026-11-14", "driving up to Murree with the cousins", "this weekend", where="Murree")])

# ================================================================ TEMPORARY
# A (Thu 2026-10-29 09:10 PKT)
ex("temporary", "en", "A",
   [chat("User: in back-to-back interviews till 5, reply later\nAssistant: Good luck!", 2)],
   observations=[CTX("availability", "in back-to-back interviews", "The user is in back-to-back interviews.", "17:00",
                     "in back-to-back interviews", "till 5")])

ex("temporary", "en", "A",
   [chat("User: I'm in Karachi till Sunday night for my cousin's nikkah. I live in Islamabad btw, so after that go back to Isb suggestions\nAssistant: Got it.", 4)],
   known=[K(1, "fact", "home city", "Islamabad", "The user lives in Islamabad."),
          K(2, "preference", "food", "spicy", "The user likes spicy food.")],
   observations=[CTX("location", "in Karachi", "The user is in Karachi for a cousin's nikkah.", "2026-11-01T23:59",
                     "I'm in Karachi", "till Sunday night"),
                 O("fact", "home city", "Islamabad", "The user lives in Islamabad.", "stated", 0.85, "I live in Islamabad",
                   merge={"target": "m1", "relation": "same"})])

ex("temporary", "mixed", "A",
   [chat("User: aaj roza hai, lunch wali koi baat na karna 😅\nAssistant: Haha theek hai!", 1)],
   observations=[CTX("fasting", "fasting", "The user is fasting today.", "23:59", "roza hai", "aaj")])

ex("temporary", "en", "A",
   [chat("User: phone at 4% and the charger's at the office. I'll be offline tonight\nAssistant: No worries.", 2)],
   observations=[CTX("availability", "offline", "The user's phone is dying and they will be offline.", "23:59", "I'll be offline", "tonight", importance=0.45)])

# B (Fri 2026-11-06 18:45 PKT)
ex("temporary", "en", "B",
   [chat("User: WFH through Wednesday, the office AC is being replaced\nAssistant: Okay.", 3)],
   observations=[CTX("work location", "working from home", "The user is working from home while the office AC is replaced.", "2026-11-11T23:59",
                     "WFH", "through Wednesday")])

ex("temporary", "en", "B",
   [chat("User: at my sister's place tonight, no laptop. ping me tomorrow\nAssistant: Will do.", 5)],
   observations=[CTX("location", "at sister's place", "The user is at their sister's place without a laptop.", "23:59",
                     "at my sister's place", "tonight", importance=0.45)])

ex("temporary", "ur", "B",
   [chat("User: Is hafte Multan mein hoon, abbu ki tabiyat theek nahi. jawab der se doon ga\nAssistant: Allah sehat de. Koi baat nahi.", 6)],
   observations=[CTX("location", "in Multan", "The user is in Multan because their father is unwell.", "2026-11-08T23:59",
                     "Multan mein hoon", "Is hafte")])

ex("temporary", "en", "B",
   [chat("User: on night shifts this week so I'm asleep till 2pm most days. I'm a nurse at City Care btw, if that wasn't obvious lol\nAssistant: Makes sense! I'll keep that in mind.", 4)],
   observations=[CTX("work shift", "on night shifts", "The user is on night shifts and sleeps until about 2pm.", "2026-11-08T23:59",
                     "on night shifts", "this week"),
                 O("fact", "job", "nurse at City Care", "The user is a nurse at City Care.", "stated", 0.85, "I'm a nurse at City Care")])

# C (Sat 2026-11-14 11:30 London)
ex("temporary", "en", "C",
   [chat("User: Stuck at Gatwick, flight delayed till 3pm. ugh\nAssistant: Sorry! Want me to find a lounge?", 2)],
   observations=[CTX("travel", "stuck at Gatwick, flight delayed", "The user is stuck at Gatwick with a delayed flight.", "15:00",
                     "Stuck at Gatwick", "till 3pm")])

ex("temporary", "en", "C",
   [chat("User: Mum's staying with us until Tuesday night so I'm mostly offline in the evenings\nAssistant: Enjoy the visit!", 3)],
   observations=[CTX("availability", "offline evenings, mum visiting", "The user's mum is staying with them, so they are mostly offline in the evenings.",
                     "2026-11-17T23:59", "mostly offline in the evenings", "until Tuesday night")])

ex("temporary", "en", "C",
   [chat("User: on call this weekend for the payments service, so if I vanish mid-chat that's why\nAssistant: Understood.", 2)],
   observations=[CTX("on call", "on call for payments service", "The user is on call for the payments service.", "2026-11-15T23:59",
                     "on call", "this weekend")])

ex("temporary", "en", "C",
   [chat("User: absolutely knackered today, skipping the gym, early night for me\nAssistant: Rest up.", 1)],
   observations=[CTX("energy", "very tired", "The user is exhausted and skipping the gym.", "23:59", "absolutely knackered", "today", importance=0.4)])

ex("temporary", "en", "C",
   [chat("User: hungover rn and useless, keep it short pls\nAssistant: Water and toast. Short answers it is.", 2)],
   observations=[CTX("health", "hungover", "The user is hungover.", "23:59", "hungover", "rn", importance=0.4)])

# D (Tue 2026-12-01 07:55 New York)
ex("temporary", "en", "D",
   [chat("User: snowed in today, schools closed, kids home 🙃\nAssistant: Stay warm!", 3)],
   observations=[CTX("snowed in", "snowed in with kids home", "The user is snowed in with the kids home from school.", "23:59", "snowed in", "today")])

ex("temporary", "en", "D",
   [chat("User: in Chicago for the conference thru Thursday, so central time for me\nAssistant: Got it, I'll use Central time.", 4)],
   observations=[CTX("location", "in Chicago", "The user is in Chicago for a conference.", "2026-12-03T23:59",
                     "in Chicago for the conference", "thru Thursday")])

ex("temporary", "en", "D",
   [chat("User: on a liquid diet through Friday after the wisdom teeth thing. normally I'm vegetarian anyway so keep the recipe ideas veggie\nAssistant: Soups and smoothies it is, all vegetarian.", 5)],
   observations=[CTX("liquid diet", "liquid diet after wisdom teeth", "The user is on a liquid diet after wisdom teeth surgery.", "2026-12-04T23:59",
                     "on a liquid diet", "through Friday"),
                 O("preference", "diet", "vegetarian", "The user is vegetarian.", "stated", 0.85, "normally I'm vegetarian")])

ex("temporary", "en", "D",
   [chat("User: Kid's sick, I'm out of office today. only ping me for urgent stuff\nAssistant: Hope they feel better soon.", 2)],
   observations=[CTX("availability", "out of office, kid sick", "The user is out of office because their kid is sick.", "23:59",
                     "I'm out of office", "today")])

# E (Fri 2026-11-20 22:05 Dubai)
ex("temporary", "en", "E",
   [chat("User: In Manila this week for the vendor audit, so assume Manila time for anything I schedule\nAssistant: Will do.", 3)],
   observations=[CTX("location", "in Manila", "The user is in Manila for a vendor audit.", "2026-11-22T23:59",
                     "In Manila", "this week")])

ex("temporary", "en", "E",
   [chat("User: brain fried. it's 10pm and I'm still at the office, going home in an hour\nAssistant: Hang in there.", 0)],
   observations=[CTX("location", "still at the office", "The user is still at the office late.", "23:05",
                     "I'm still at the office", "in an hour", importance=0.4)])

ex("temporary", "ur", "E",
   [chat("User: Sunday tak Abu Dhabi mein hoon, phir wapas Dubai\nAssistant: Theek hai.", 4)],
   observations=[CTX("location", "in Abu Dhabi", "The user is in Abu Dhabi.", "2026-11-22T23:59", "Abu Dhabi mein hoon", "Sunday tak")])

ex("temporary", "en", "E",
   [chat("User: fasting tomorrow (making up a missed one) so no lunch plans pls\nAssistant: Noted.", 2)],
   observations=[CTX("fasting", "fasting", "The user is fasting tomorrow.", "2026-11-21T23:59", "fasting", "tomorrow")])

ex("temporary", "en", "E",
   [chat("User: Hey, quick one: I'm on parental leave until Dec 4, so don't schedule anything work-related. Also I'm the eng lead on Falcon, so when I'm back that's the priority.\nAssistant: Congratulations! Noted on both.", 5)],
   observations=[CTX("leave", "on parental leave", "The user is on parental leave.", "2026-12-04T23:59",
                     "on parental leave", "until Dec 4", importance=0.55),
                 O("fact", "role", "eng lead on Falcon", "The user is the engineering lead on Falcon.", "stated", 0.85,
                   "I'm the eng lead on Falcon")])

ex("temporary", "en", "E",
   [chat("User: at a desert camp till 9am tomorrow, signal is terrible so expect slow replies\nAssistant: Enjoy the stars!", 3)],
   observations=[CTX("location", "at a desert camp", "The user is at a desert camp with poor signal.", "2026-11-21T09:00",
                     "at a desert camp", "till 9am tomorrow")])

# F (Mon 2026-11-09 13:20 PKT)
ex("temporary", "en", "F",
   [chat("User: at the dentist till 3, numb face incoming\nAssistant: Good luck!", 1)],
   observations=[CTX("location", "at the dentist", "The user is at the dentist.", "15:00", "at the dentist", "till 3")])

ex("temporary", "mixed", "F",
   [chat("User: aaj WFH kar raha hoon, office mein bijli ka masla hai\nAssistant: Theek hai.", 3)],
   observations=[CTX("work location", "working from home", "The user is working from home due to a power issue at the office.", "23:59",
                     "WFH kar raha hoon", "aaj")])

ex("temporary", "en", "F",
   [chat("User: Iqbal Day holiday today so I'm off, but I'll check slack every now and then\nAssistant: Enjoy the day off!", 4)],
   observations=[CTX("day off", "off for Iqbal Day", "The user is off for the Iqbal Day holiday.", "23:59", "I'm off", "today", importance=0.45)])

ex("temporary", "ur", "F",
   [chat("User: Parson tak gaon mein hoon, internet bohat kamzor hai\nAssistant: Koi baat nahi.", 5)],
   observations=[CTX("location", "in the village", "The user is in their village with weak internet.", "2026-11-11T23:59",
                     "gaon mein hoon", "Parson tak")])

ex("temporary", "en", "F",
   [chat("User: back in Lahore till thursday night for my cousin's wedding (I live in Riyadh these days)\nAssistant: Have fun at the wedding!", 3)],
   known=[K(1, "preference", "reply language", "English", "The user prefers replies in English.")],
   observations=[CTX("location", "in Lahore", "The user is in Lahore for a cousin's wedding.", "2026-11-12T23:59",
                     "back in Lahore", "till thursday night"),
                 O("fact", "home city", "Riyadh", "The user lives in Riyadh.", "stated", 0.85, "I live in Riyadh these days")])

ex("temporary", "en", "F",
   [chat("User: recovering from dengue, doc says bed rest till Saturday so I'll be slow on everything\nAssistant: Get well soon, take it easy.", 4)],
   observations=[CTX("health", "recovering from dengue, bed rest", "The user is recovering from dengue and on bed rest.", "2026-11-14T23:59",
                     "recovering from dengue", "till Saturday", importance=0.55)])

ex("temporary", "en", "F",
   [chat("User: in a meeting for the next hour, talk after\nAssistant: Sure.", 0)],
   observations=[CTX("availability", "in a meeting", "The user is in a meeting.", "14:20", "in a meeting", "for the next hour", importance=0.4)])

assert len(EX) == 75, len(EX)
with open(OUT, "w", encoding="utf-8") as f:
    for i, e in enumerate(EX, 1):
        e = {"id": f"b-pl-{i:03d}", **e}
        f.write(json.dumps(e, ensure_ascii=False) + "\n")
print("wrote", len(EX))
