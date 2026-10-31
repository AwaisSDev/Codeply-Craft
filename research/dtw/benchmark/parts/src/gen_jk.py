import json

OUT = "/home/user/Codeply-Craft/research/dtw/benchmark/parts/jk.jsonl"


def O(kind, slot, value, text, cert, imp, about, evidence, **kw):
    o = {"kind": kind, "slot": slot, "value": value, "text": text, "certainty": cert,
         "importance": imp, "about": about}
    o.update({k: v for k, v in kw.items() if k in ("project", "until", "merge")})
    o["evidence"] = evidence
    for k in ("event", "evidence_n", "time_text"):
        if k in kw:
            o[k] = kw[k]
    return o


def P(what, when, evidence, time_text, where="", who=None, event=0):
    p = {"what": what, "when": when, "where": where, "who": who or [], "evidence": evidence, "time_text": time_text}
    if event:
        p["event"] = event
    return p


def K(i, kind, slot, value, text, project=None):
    k = {"id": i, "kind": kind, "slot": slot, "value": value, "text": text}
    if project:
        k["project"] = project
    return k


def chat(text, mins=2, project=None):
    e = {"source": "chat", "trust": "user", "minutes_ago": mins, "text": text}
    if project:
        e["project"] = project
    return e


def email(text, mins=30):
    return {"source": "email", "trust": "external", "minutes_ago": mins, "text": text}


def heard(text, mins=10):
    return {"source": "heard", "trust": "mixed", "minutes_ago": mins, "text": text}


def same(t):
    return {"target": t, "relation": "same"}


def diff(t):
    return {"target": t, "relation": "different"}


EX = []


def ex(task, lang, anchor, events, obs, plans=None, known=None, expect=None):
    EX.append({"task": task, "lang": lang, "anchor": anchor, "events": events, "known": known or [],
               "observations": obs, "plans": plans or [], "expect": expect or {}})


J, H = "joking", "hypothetical"

# ---------------------------------------------------------------- joking (40)

# 1 sarcasm + real project decision that updates a known memory
ex(J, "en", "A",
   [chat("User: oh great, a prod outage on a thursday morning, exactly how I wanted to start my day 🙂 anyway fyi we moved paydesk's billing service from AWS to Hetzner last night, can you update the runbook section on restarts\nAssistant: Sure, send me the current runbook and I'll rewrite the restart steps for Hetzner.", 4, "paydesk")],
   [O("preference", "outages", "enjoys prod outages", "The user enjoys production outages on Thursday mornings.", "joking", 0.1, "user", "exactly how I wanted to start my day"),
    O("decision", "hosting", "Hetzner", "Paydesk's billing service moved from AWS to Hetzner.", "stated", 0.85, "project", "moved paydesk's billing service from AWS to Hetzner", project="paydesk", merge=diff("m1"))],
   known=[K("m1", "decision", "hosting", "AWS", "Paydesk's billing service runs on AWS.", "paydesk"),
          K("m2", "preference", "reply length", "short", "The user prefers short replies.")])

# 2 classic goat farmer + real resignation
ex(J, "en", "B",
   [chat("User: I'm quitting tech and becoming a goat farmer lol\nAssistant: The goats are lucky. Rough week?\nUser: rough YEAR. but genuinely, I handed in my notice at Finlo today. last day is the 30th, then 2 months off before anything new", 15)],
   [O("fact", "career", "goat farmer", "The user is quitting tech to become a goat farmer.", "joking", 0.15, "user", "becoming a goat farmer"),
    O("fact", "employer", "resigned from Finlo", "The user has resigned from Finlo.", "stated", 0.85, "user", "I handed in my notice at Finlo"),
    O("decision", "career break", "2 months off", "The user plans to take 2 months off after leaving Finlo.", "stated", 0.6, "user", "2 months off before anything new")],
   [P("Last day at Finlo", "2026-11-30", "last day", "the 30th")])

# 3 dry sarcasm, no markers, + real fact
ex(J, "en", "C",
   [chat("User: Brilliant. My landlord replied to my email in only 19 days. A new personal best. Truly a man of the people.\nAssistant: That's frustrating. Want me to draft a firmer follow-up?\nUser: Yes please, address it to Harlow Lettings. I've rented from them since 2022 and never missed a payment.", 40)],
   [O("fact", "landlord", "a man of the people", "The user's landlord is a man of the people.", "joking", 0.1, "user", "Truly a man of the people."),
    O("fact", "landlord", "Harlow Lettings, since 2022", "The user has rented from Harlow Lettings since 2022.", "stated", 0.6, "user", "I've rented from them since 2022")])

# 4 sincere enthusiasm that reads like sarcasm
ex(J, "en", "D",
   [chat("User: ok hear me out. I love 6am runs. not sarcastic, not ironic. everyone assumes I'm joking when I say it but the empty streets at 6 are the best part of my day\nAssistant: That's a great habit. Want me to keep early mornings free for it?\nUser: yes pls, nothing before 7:30", 3)],
   [O("routine", "morning run", "6am runs", "The user runs at 6am and genuinely loves it.", "stated", 0.7, "user", "I love 6am runs"),
    O("preference", "meeting time", "nothing before 7:30am", "The user wants nothing scheduled before 7:30am.", "stated", 0.7, "user", "nothing before 7:30")])

# 5 teasing the husband + real fact about him
ex(J, "en", "E",
   [chat("User: my husband Omar 'cooked' tonight, by which I mean he microwaved yesterday's biryani and called it fusion cuisine. michelin star incoming 😂 in his defence he just got back from a 14 hour shift, he's an Emirates pilot so the kitchen was never really his department\nAssistant: Reheating counts as cooking after a 14-hour shift!", 20)],
   [O("fact", "omar", "michelin-level chef", "Omar, the user's husband, is a Michelin-level chef.", "joking", 0.1, "person", "michelin star incoming"),
    O("fact", "omar", "husband, Emirates pilot", "Omar, the user's husband, is an Emirates pilot.", "stated", 0.85, "person", "he's an Emirates pilot")])

# 6 Roman Urdu joke + real meeting
ex(J, "mixed", "F",
   [chat("User: yaar mera laptop toh basically heater hai, chai garam kar leta hoon is pe 😂 btw client wali meeting kal 3 baje shift kar do please, unhon ne khud bola hai\nAssistant: Done, client meeting moved to tomorrow 3 PM.", 1)],
   [O("fact", "laptop", "used to heat chai", "The user heats chai on their laptop.", "joking", 0.1, "user", "chai garam kar leta hoon is pe")],
   [P("Client meeting", "2026-11-10T15:00", "client wali meeting", "kal 3 baje")])

# 7 sarcastic decision on the SAME slot as a known rule; real line repeats it
ex(J, "en", "A",
   [chat("User: Sure, let's push the carthop payment refactor Friday at 5pm, what could possibly go wrong.\nAssistant: Do you want me to schedule the Friday 5pm deploy?\nUser: god no. we never deploy on fridays. Tuesday mornings only, same as always", 10, "carthop")],
   [O("decision", "deploy window", "Friday 5pm", "Carthop's payment refactor will be deployed Friday at 5pm.", "joking", 0.15, "project", "push the carthop payment refactor Friday at 5pm", project="carthop"),
    O("requirement", "deploy window", "Tuesday mornings", "Carthop deploys only happen on Tuesday mornings.", "stated", 0.8, "project", "Tuesday mornings only", project="carthop", merge=same("m1"))],
   known=[K("m1", "requirement", "deploy window", "Tuesday mornings", "Carthop deploys only happen on Tuesday mornings.", "carthop"),
          K("m2", "fact", "employer", "Carthop", "The user works at Carthop.")])

# 8 pure venting hyperbole
ex(J, "en", "B",
   [chat("User: I have been on hold with the bank for 400 years. I am a skeleton now. tell my family I loved them\nAssistant: Hang in there. Want me to draft a complaint while you wait?", 0)],
   [O("fact", "bank hold", "on hold for 400 years", "The user has been on hold with the bank for 400 years.", "joking", 0.1, "user", "on hold with the bank for 400 years")])

# 9 teasing by sister + real news about her
ex(J, "en", "C",
   [chat("User: My sister Hira has officially declared me the favourite child because I fixed Mum's wifi. Peak achievement, adding it to my CV. Anyway she's due in March!! first baby, I'm going to be an aunt\nAssistant: Congratulations, Auntie! That's lovely news.", 55)],
   [O("fact", "family rank", "the favourite child", "The user is the family's favourite child.", "joking", 0.1, "user", "the favourite child"),
    O("fact", "cv", "fixing wifi on CV", "The user is adding fixing Mum's wifi to their CV.", "joking", 0.1, "user", "adding it to my CV"),
    O("fact", "hira", "sister, expecting first baby in March", "Hira, the user's sister, is expecting her first baby in March.", "stated", 0.75, "person", "she's due in March")])

# 10 heard: teasing + real promotion (outside text -> implied)
ex(J, "en", "D",
   [heard("Heard around the user: Priya: haha you're basically married to that Jira board. Priya: oh and congrats on making team lead!! about time they noticed", 25)],
   [O("fact", "jira", "married to the Jira board", "The user is married to the Jira board.", "joking", 0.1, "user", "married to that Jira board"),
    O("fact", "job title", "team lead", "The user was promoted to team lead.", "implied", 0.7, "user", "congrats on making team lead")])

# 11 exaggeration only, known diet as distractor
ex(J, "en", "E",
   [chat("User: I'm never eating again. that brunch was a crime against my stomach. (I'll be hungry by 6, let's be real)\nAssistant: Ha, noted. Want a light dinner idea for later?", 90)],
   [O("preference", "eating", "never eating again", "The user is never eating again.", "joking", 0.1, "user", "I'm never eating again")],
   known=[K("m1", "preference", "diet", "vegetarian", "The user is vegetarian."),
          K("m2", "fact", "home city", "Dubai", "The user lives in Dubai.")])

# 12 code sarcasm + real project fact
ex(J, "en", "F",
   [chat("User: love how ledgerly's CI takes 3 business days to tell me I missed a comma. truly the pinnacle of engineering. can you help me split the test job into 4 shards? it's GitHub Actions, ubuntu runners\nAssistant: Sure. Add a matrix with shard: [1, 2, 3, 4] and pass it to pytest-split like this...", 6, "ledgerly")],
   [O("fact", "ci speed", "takes 3 business days", "Ledgerly's CI takes 3 business days to run.", "joking", 0.1, "project", "takes 3 business days", project="ledgerly"),
    O("fact", "ci", "GitHub Actions", "Ledgerly's CI runs on GitHub Actions with Ubuntu runners.", "stated", 0.6, "project", "it's GitHub Actions", project="ledgerly")],
   known=[K("m1", "decision", "test framework", "pytest", "Ledgerly uses pytest.", "ledgerly")])

# 13 Roman Urdu cricket venting + real plan
ex(J, "mixed", "A",
   [chat("User: Pakistan ne phir 40 pe 3 wicket gira diye, main toh cricket dekhna hi chor raha hoon forever 🙄\nAssistant: Tough day for the batting. Skipping the next one then?\nUser: haan obviously nahi lol. Saturday ko Asad ke ghar match dekhne ja raha hoon, uske naye projector pe", 12)],
   [O("preference", "cricket team", "Pakistan", "The user follows the Pakistan cricket team.", "implied", 0.55, "user", "Pakistan"),
    O("decision", "watching cricket", "quitting forever", "The user is quitting watching cricket forever.", "joking", 0.15, "user", "cricket dekhna hi chor raha hoon forever")],
   [P("Watch the match at Asad's place", "2026-10-31", "Asad ke ghar match dekhne", "Saturday ko", "Asad's house", ["Asad"])])

# 14 sincere, explicitly not sarcastic
ex(J, "en", "B",
   [chat("User: not being sarcastic for once: I actually enjoy doing code reviews. put me on more of the Orbit PRs, I mean it\nAssistant: Got it, I'll add you as a default reviewer on Orbit.", 5, "orbit")],
   [O("preference", "code reviews", "enjoys doing them", "The user genuinely enjoys doing code reviews.", "stated", 0.65, "user", "I actually enjoy doing code reviews")],
   known=[K("m1", "style", "review comments", "blunt and short", "The user writes blunt, short review comments.")])

# 15 teasing dad + real health fact + plan
ex(J, "en", "C",
   [chat("User: Dad has discovered WhatsApp forwards. We're 14 'good morning' roses deep and it's not even noon. A true poet.\nAssistant: A man who has found his calling.\nUser: lol. ok real thing, he's diabetic, so I need low-sugar dinner ideas for when he visits on the 21st", 8)],
   [O("fact", "dad", "a true poet", "The user's dad is a true poet.", "joking", 0.1, "person", "A true poet."),
    O("fact", "dad", "diabetic", "The user's dad is diabetic.", "stated", 0.8, "person", "he's diabetic")],
   [P("Dad's visit", "2026-11-21", "when he visits", "on the 21st", "", ["Dad"])])

# 16 student venting + real exam
ex(J, "en", "D",
   [chat("User: this semester is going to kill me. write 'died of organic chemistry' on my tombstone\nAssistant: Let's keep you alive. What's coming up?\nUser: orgo final is Dec 14 at 9am. can you make me a 2 week study plan, I'm weakest on reaction mechanisms", 30)],
   [O("fact", "tombstone", "died of organic chemistry", "The user is dying of organic chemistry.", "joking", 0.1, "user", "died of organic chemistry"),
    O("fact", "study", "taking organic chemistry", "The user is a student taking organic chemistry this semester.", "implied", 0.6, "user", "orgo final"),
    O("fact", "weak topic", "reaction mechanisms", "The user is weakest on reaction mechanisms in organic chemistry.", "stated", 0.5, "user", "I'm weakest on reaction mechanisms")],
   [P("Organic chemistry final exam", "2026-12-14T09:00", "orgo final", "Dec 14 at 9am")])

# 17 dry sarcasm, no markers + real routine
ex(J, "en", "E",
   [chat("User: Fantastic. Skyline lost my bag again, third time this year. I'm starting to think they just like my clothes.\nAssistant: That's awful. Want help filing the claim?\nUser: yes. and the annoying part is I fly them every month for work, you'd think they'd treat me better", 45)],
   [O("fact", "luggage", "airline likes their clothes", "Skyline keeps the user's bags because they like the user's clothes.", "joking", 0.1, "user", "they just like my clothes"),
    O("routine", "work travel", "monthly flights with Skyline", "The user flies Skyline every month for work.", "stated", 0.6, "user", "I fly them every month for work")])

# 18 sarcastic enthusiasm + real event
ex(J, "en", "F",
   [chat("User: write a reply to the HR email saying I'm thrilled about the mandatory team-building on Saturday. thrilled. make it sound sincere 😐\nAssistant: Here's a warm, sincere-sounding reply: \"Thanks for organising, looking forward to it!\"", 2)],
   [O("preference", "team-building", "thrilled about it", "The user is thrilled about mandatory team-building.", "joking", 0.15, "user", "I'm thrilled about")],
   [P("Mandatory team-building", "2026-11-14", "mandatory team-building", "on Saturday")])

# 19 exaggerated number + real doctor advice
ex(J, "en", "A",
   [chat("User: I've had roughly 900 coffees this week\nAssistant: That's... a lot of coffee.\nUser: ok not 900. but my doctor wants me at 2 cups max because of my blood pressure, so help me find a decaf that doesn't taste like sadness", 7)],
   [O("routine", "coffee", "900 coffees a week", "The user drinks about 900 coffees a week.", "joking", 0.1, "user", "roughly 900 coffees this week"),
    O("fact", "coffee limit", "2 cups max", "The user's doctor wants them to drink at most 2 cups of coffee because of their blood pressure.", "stated", 0.65, "user", "my doctor wants me at 2 cups max")])

# 20 Roman Urdu teasing by mother + real items
ex(J, "mixed", "B",
   [chat("User: ammi ka kehna hai ke shaadi nahi hui toh main officially 'budhi' ho gayi hoon 😂 30 ki hi toh hoon yaar\nAssistant: 30 is nothing! Anything I can help with?\nUser: haan, Sunday ko ammi ki birthday hai. Gulberg wali bakery se cake order karna hai, pista flavour, wohi unka favourite hai", 18)],
   [O("fact", "old age", "officially old", "The user is officially old.", "joking", 0.1, "user", "officially 'budhi' ho gayi hoon"),
    O("fact", "age", "30", "The user is 30 years old.", "stated", 0.6, "user", "30 ki hi toh hoon"),
    O("todo", "birthday cake", "order pistachio cake", "The user needs to order a pistachio cake from the Gulberg bakery for their mother's birthday.", "stated", 0.5, "user", "cake order karna hai"),
    O("fact", "ammi", "favourite cake is pistachio", "The user's mother's favourite cake flavour is pistachio.", "stated", 0.6, "person", "pista flavour, wohi unka favourite hai")],
   [P("Ammi's birthday", "2026-11-08", "ammi ki birthday", "Sunday ko", "", ["Ammi"])])

# 21 code sarcasm without markers + real project decision
ex(J, "en", "C",
   [chat("User: Yes, I absolutely want to maintain three different date libraries in one repo. Living the dream. Let's standardise budgetbee on date-fns and rip out moment and dayjs this sprint.\nAssistant: Good call. I'll start with the moment usages in the reports module.", 11, "budgetbee")],
   [O("preference", "date libraries", "wants three date libraries", "The user wants to maintain three date libraries in one repo.", "joking", 0.15, "user", "I absolutely want to maintain three different date libraries"),
    O("decision", "date library", "date-fns", "Budgetbee is standardising on date-fns, removing moment and dayjs.", "stated", 0.85, "project", "standardise budgetbee on date-fns", project="budgetbee")])

# 22 sincere excitement that sounds sarcastic + plan
ex(J, "en", "D",
   [chat("User: omg jury duty starts Monday the 7th and I'm SO excited. not kidding at all, I've wanted to see a real trial up close since law school\nAssistant: That's a refreshing take! Want me to block the week?\nUser: yes block the whole week", 14)],
   [O("preference", "jury duty", "genuinely excited", "The user is genuinely excited about jury duty.", "stated", 0.45, "user", "I'm SO excited"),
    O("fact", "education", "went to law school", "The user went to law school.", "implied", 0.65, "user", "since law school")],
   [P("Jury duty", "2026-12-07", "jury duty", "Monday the 7th")])

# 23 teasing brother; joke must not replace known
ex(J, "en", "E",
   [chat("User: Bilal just video called from Toronto to complain it's -5. My heart bleeds for him, truly, sitting here in 31 degrees 😌 every winter he swears he's moving back to Dubai and every spring he forgets\nAssistant: Classic. Want me to remind you to send him a care package?", 35)],
   [O("fact", "bilal", "lives in Toronto", "Bilal, the user's brother, lives in Toronto.", "implied", 0.6, "person", "from Toronto", merge=same("m1")),
    O("fact", "bilal", "moving back to Dubai", "Bilal, the user's brother, is moving back to Dubai.", "joking", 0.15, "person", "he swears he's moving back to Dubai")],
   known=[K("m1", "fact", "bilal", "lives in Toronto", "Bilal, the user's brother, lives in Toronto."),
          K("m2", "fact", "home city", "Dubai", "The user lives in Dubai.")])

# 24 joke + real leave plan
ex(J, "en", "F",
   [chat("User: update: achieved inbox zero. by archiving everything unread. productivity guru, book me for TED\nAssistant: Bold strategy.\nUser: also pls remember I'm off from the 16th to the 20th, cousin's wedding in Lahore", 50)],
   [O("fact", "productivity", "productivity guru", "The user is a productivity guru.", "joking", 0.1, "user", "productivity guru, book me for TED")],
   [P("Off for cousin's wedding in Lahore", "2026-11-16", "cousin's wedding in Lahore", "from the 16th to the 20th", "Lahore")])

# 25 very short sarcasm
ex(J, "en", "A",
   [chat("User: cool cool cool, love being the only one on this team who reads the docs\nAssistant: Want me to write a one-page summary the team might actually read?", 1)],
   [O("preference", "reading docs", "loves being the only reader", "The user loves being the only one on the team who reads the docs.", "joking", 0.1, "user", "love being the only one on this team who reads the docs")])

# 26 money venting; joke + true-in-passing fact + real decision
ex(J, "en", "B",
   [chat("User: rent went up AGAIN. at this point I'll live in my car. I don't have a car. I'll live at a bus stop.\nAssistant: Ouch. How much did it go up?\nUser: 8k. seriously though I need to start saving. put me down for 20k a month into the Sahil Bank savings account, starting this month", 22)],
   [O("fact", "housing", "living in their car", "The user is going to live in their car.", "joking", 0.1, "user", "I'll live in my car"),
    O("fact", "car", "does not own a car", "The user does not own a car.", "stated", 0.45, "user", "I don't have a car"),
    O("decision", "savings", "20k a month to Sahil Bank savings", "The user will save 20k a month into their Sahil Bank savings account.", "stated", 0.7, "user", "20k a month into the Sahil Bank savings account")])

# 27 religion: self-deprecating joke + real routine
ex(J, "en", "C",
   [chat("User: fasting the sunnah Mondays and Thursdays because apparently I enjoy suffering lol\nAssistant: That's quite a commitment. How's it going?\nUser: no honestly it's been really good for me. keeping it up, so no lunch meetings on those days pls", 16)],
   [O("routine", "fasting", "Mondays and Thursdays", "The user fasts the sunnah fasts on Mondays and Thursdays.", "stated", 0.75, "user", "fasting the sunnah Mondays and Thursdays"),
    O("preference", "suffering", "enjoys suffering", "The user enjoys suffering.", "joking", 0.1, "user", "apparently I enjoy suffering"),
    O("preference", "lunch meetings", "none on Mondays and Thursdays", "The user wants no lunch meetings on Mondays and Thursdays.", "stated", 0.7, "user", "no lunch meetings on those days")],
   known=[K("m1", "fact", "home city", "London", "The user lives in London.")])

# 28 teasing a friend + real allergy + plan
ex(J, "en", "D",
   [chat("User: my friend Marcus thinks he's the next MasterChef winner because he made carbonara once. anyway his birthday dinner is Saturday and he's allergic to shellfish, so the paella place is out\nAssistant: Noted. Want some shellfish-free restaurant ideas?", 9)],
   [O("fact", "marcus", "MasterChef-level cook", "Marcus, the user's friend, is the next MasterChef winner.", "joking", 0.15, "person", "the next MasterChef winner"),
    O("fact", "marcus", "allergic to shellfish", "Marcus, the user's friend, is allergic to shellfish.", "stated", 0.75, "person", "he's allergic to shellfish")],
   [P("Marcus's birthday dinner", "2026-12-05", "his birthday dinner", "Saturday", "", ["Marcus"])])

# 29 Roman Urdu: exaggeration + real work arrangement
ex(J, "mixed", "E",
   [chat("User: aaj last din tha office mein full time, AC itna tez tha ke main penguin ban gaya 🐧 ab se permanently remote hoon, sirf Thursdays ko office jaana hai\nAssistant: Congrats on going remote! I'll keep Thursdays for in-office stuff.", 60)],
   [O("fact", "penguin", "turned into a penguin", "The user turned into a penguin from the office AC.", "joking", 0.1, "user", "main penguin ban gaya"),
    O("routine", "work location", "remote, office on Thursdays", "The user now works remotely and goes to the office only on Thursdays.", "stated", 0.8, "user", "permanently remote hoon, sirf Thursdays ko office jaana hai")])

# 30 sarcasm about another editor; known editor must stay
ex(J, "en", "F",
   [chat("User: VS Code just ate 6GB of RAM to open a README. truly the editor of champions\nAssistant: Ha. Did the Lua config from earlier work out?\nUser: yeah thanks, neovim's been rock solid since", 3)],
   [O("preference", "editor", "VS Code", "The user thinks VS Code is the editor of champions.", "joking", 0.15, "user", "truly the editor of champions"),
    O("preference", "editor", "Neovim", "The user uses Neovim as their editor.", "implied", 0.7, "user", "neovim's been rock solid", merge=same("m1"))],
   known=[K("m1", "preference", "editor", "Neovim", "The user uses Neovim as their editor."),
          K("m2", "fact", "job", "backend developer", "The user is a backend developer.")])

# 31 long vent: jokes, a quote, real fiancee + wedding
ex(J, "en", "A",
   [chat("User: ok I need to vent. Mahnoor's family wants 1200 guests at the wedding. ONE THOUSAND TWO HUNDRED. I will have to sell a kidney. possibly both. my dad says just invite everyone and figure out the money later, which is very helpful, thanks dad\nAssistant: That's a lot of guests. Have you and Mahnoor talked numbers yet?\nUser: we have, and honestly she's on my side, she wants 300 max. the good news is we finally locked the date: 12 February, Shalimar Marquee. so at least that's done", 75)],
   [O("fact", "mahnoor", "the user's fiancee", "Mahnoor is the user's fiancee.", "implied", 0.85, "person", "Mahnoor's family wants 1200 guests at the wedding"),
    O("fact", "kidney", "selling a kidney", "The user will have to sell a kidney to pay for the wedding.", "joking", 0.1, "user", "I will have to sell a kidney"),
    O("preference", "guest list", "invite everyone", "The user's dad thinks they should invite everyone and figure out the money later.", "quoting", 0.15, "person", "just invite everyone and figure out the money later"),
    O("fact", "mahnoor", "wants 300 guests max", "Mahnoor wants at most 300 wedding guests.", "stated", 0.5, "person", "she wants 300 max")],
   [P("Wedding", "2027-02-12", "Shalimar Marquee", "12 February", "Shalimar Marquee", ["Mahnoor"])])

# 32 sarcasm about style + real style rule
ex(J, "en", "B",
   [chat("User: Oh wonderful, five paragraphs when I asked a yes or no question. Very efficient.\nAssistant: Sorry about that. Short version: yes.\nUser: thank you. just yes or no for those from now on", 4)],
   [O("style", "reply length", "loves long answers", "The user loves five-paragraph answers to yes/no questions.", "joking", 0.15, "user", "Oh wonderful, five paragraphs"),
    O("style", "yes/no answers", "just yes or no", "The user wants a plain yes or no for yes/no questions.", "stated", 0.8, "user", "just yes or no for those from now on")],
   known=[K("m1", "style", "reply language", "English", "The user wants replies in English.")])

# 33 sincere unpopular opinion
ex(J, "en", "C",
   [chat("User: Unpopular opinion but I genuinely love British weather. Grey and drizzly is my ideal day. Not being ironic, my friends think I'm broken\nAssistant: Each to their own! A drizzly walk can be lovely.", 26)],
   [O("preference", "weather", "loves grey drizzly weather", "The user genuinely loves grey, drizzly British weather.", "stated", 0.55, "user", "I genuinely love British weather")])

# 34 teasing manager + real fact + plan
ex(J, "en", "D",
   [chat("User: my manager Linda booked a 'quick sync' that's 2 hours long. she's a comedian honestly. it's Thursday 2-4pm, put it in my calendar I guess\nAssistant: Added: Quick sync with Linda, Thursday 2 to 4 PM.", 5)],
   [O("fact", "linda", "the user's manager", "Linda is the user's manager.", "stated", 0.65, "person", "my manager Linda"),
    O("fact", "linda", "a comedian", "Linda, the user's manager, is a comedian.", "joking", 0.1, "person", "she's a comedian honestly")],
   [P("Quick sync with Linda", "2026-12-03T14:00", "quick sync", "Thursday 2-4pm", "", ["Linda"])])

# 35 exaggeration; known routine untouched
ex(J, "en", "E",
   [chat("User: skipped the gym for the 47th day in a row. I am a couch now. a sofa with feelings 🛋️\nAssistant: Be kind to yourself! Getting back to it soon?\nUser: lol it's been 3 days, I had flu. back on monday as usual", 120)],
   [O("routine", "gym", "skipped 47 days in a row", "The user has skipped the gym 47 days in a row.", "joking", 0.1, "user", "skipped the gym for the 47th day in a row")],
   known=[K("m1", "routine", "gym", "Mon/Wed/Fri evenings", "The user goes to the gym on Monday, Wednesday and Friday evenings."),
          K("m2", "preference", "diet", "high protein", "The user follows a high-protein diet.")])

# 36 Roman Urdu food joke + real health decision
ex(J, "mixed", "F",
   [chat("User: main toh biryani kha kha ke khud biryani ban gaya hoon lol\nAssistant: Haha, time for a break?\nUser: haan seriously, doctor ne cholesterol ki wajah se oily khana kam karne ko bola hai. ab se sirf ghar ka khana, hafte mein ek cheat day", 13)],
   [O("fact", "biryani", "turned into biryani", "The user has turned into biryani.", "joking", 0.1, "user", "khud biryani ban gaya hoon"),
    O("fact", "cholesterol", "told to cut oily food", "The user's doctor told them to cut oily food because of cholesterol.", "stated", 0.6, "user", "doctor ne cholesterol ki wajah se oily khana kam karne ko bola hai"),
    O("decision", "diet", "home food only, one cheat day a week", "The user will eat only home-cooked food, with one cheat day a week.", "stated", 0.7, "user", "ab se sirf ghar ka khana, hafte mein ek cheat day")])

# 37 teasing daughter; known daughter + new routine + preference
ex(J, "en", "A",
   [chat("User: my 6 year old Zara informed me this morning that she is now CEO of the house. honestly she runs it better than me\nAssistant: Sounds like a capable CEO!\nUser: lol. anyway she's started swimming lessons on Saturday mornings, so no 9am Saturday calls for me anymore", 19)],
   [O("fact", "zara", "daughter, 6", "Zara is the user's 6-year-old daughter.", "stated", 0.85, "person", "my 6 year old Zara", merge=same("m1")),
    O("fact", "zara", "CEO of the house", "Zara, the user's daughter, is CEO of the house.", "joking", 0.15, "person", "she is now CEO of the house"),
    O("fact", "zara swimming", "Saturday morning lessons", "Zara has swimming lessons on Saturday mornings.", "stated", 0.6, "person", "swimming lessons on Saturday mornings"),
    O("preference", "saturday calls", "no 9am Saturday calls", "The user no longer takes 9am calls on Saturdays.", "stated", 0.7, "user", "no 9am Saturday calls for me anymore")],
   known=[K("m1", "fact", "zara", "daughter, 6", "Zara is the user's 6-year-old daughter."),
          K("m2", "preference", "meeting time", "mornings", "The user prefers morning meetings.")])

# 38 one-line sarcasm contradicting a known memory (must not update it)
ex(J, "en", "B",
   [chat("User: yeah I'm a morning person 🙄\nAssistant: Want me to move tomorrow's 8am to later then?\nUser: please. and nothing before 11, ever", 2)],
   [O("preference", "working hours", "morning person", "The user is a morning person.", "joking", 0.15, "user", "I'm a morning person"),
    O("preference", "meeting time", "nothing before 11am", "The user wants nothing scheduled before 11am.", "stated", 0.75, "user", "nothing before 11, ever")],
   known=[K("m1", "preference", "working hours", "night owl, after 10pm", "The user is a night owl and works best after 10pm.")])

# 39 email teasing from a friend + real dinner plan
ex(J, "en", "C",
   [email("Email the user received (from Jamie Cole <jamie.cole@fernmail.test>): Re: Saturday. Mate, you still owe me a pint for the time you 'navigated' us to the wrong Newport. World-class sense of direction. Anyway, table's booked at The Crooked Fern, Saturday the 21st at 7pm. Try not to end up in Wales.", 180)],
   [O("fact", "sense of direction", "world-class", "The user has a world-class sense of direction.", "joking", 0.1, "user", "World-class sense of direction")],
   [P("Dinner with Jamie at The Crooked Fern", "2026-11-21T19:00", "table's booked at The Crooked Fern", "Saturday the 21st at 7pm", "The Crooked Fern", ["Jamie Cole"])])

# 40 code-switching sports joke, "jk", real flight
ex(J, "mixed", "D",
   [chat("User: bhai Knicks phir haar gaye, main toh ab Lakers fan ban raha hoon 😤\nAssistant: Ouch, rough game.\nUser: jk jk, Knicks for life. btw meri Karachi ki flight 18 Dec ko hai, winter break ghar pe", 28)],
   [O("preference", "nba team", "Lakers", "The user is becoming a Lakers fan.", "joking", 0.15, "user", "main toh ab Lakers fan ban raha hoon"),
    O("preference", "nba team", "Knicks", "The user is a Knicks fan.", "stated", 0.6, "user", "Knicks for life", merge=same("m1")),
    O("fact", "hometown", "Karachi", "The user's family home is in Karachi.", "implied", 0.55, "user", "winter break ghar pe")],
   [P("Flight to Karachi", "2026-12-18", "Karachi ki flight", "18 Dec ko", "Karachi")],
   known=[K("m1", "preference", "nba team", "Knicks", "The user is a Knicks fan."),
          K("m2", "fact", "home city", "New York", "The user lives in New York.")])

# ---------------------------------------------------------------- hypothetical (35)

# 1 question; known decision must stay
ex(H, "en", "A",
   [chat("User: should we switch tasklane's backend from Node to Go? half the team keeps saying it'd be way faster. what do you think\nAssistant: It depends on where the bottleneck is. Have you profiled the slow endpoints?", 5, "tasklane")],
   [O("decision", "backend language", "Go", "Tasklane's backend might be rewritten in Go.", "hypothetical", 0.2, "project", "switch tasklane's backend from Node to Go", project="tasklane")],
   known=[K("m1", "decision", "backend language", "Node.js", "Tasklane's backend is written in Node.js.", "tasklane"),
          K("m2", "preference", "package manager", "pnpm", "The user uses pnpm.")])

# 2 conditional hire + decided move
ex(H, "en", "B",
   [chat("User: if the Almira invoice clears this month we'll hire a second designer. either way we're moving the studio into the new DHA office on Dec 1, lease is signed\nAssistant: Exciting! Want me to draft a moving checklist?", 33)],
   [O("decision", "hiring", "second designer", "The user's studio will hire a second designer if the Almira invoice clears.", "hypothetical", 0.25, "user", "we'll hire a second designer"),
    O("decision", "studio office", "new DHA office", "The user's studio is moving into a new office in DHA (lease signed).", "stated", 0.8, "user", "moving the studio into the new DHA office")],
   [P("Studio move to the DHA office", "2026-12-01", "moving the studio into the new DHA office", "on Dec 1", "DHA office")])

# 3 wish
ex(H, "en", "C",
   [chat("User: I wish I could take a year off and walk the Camino. One day.\nAssistant: That would be an incredible journey.", 2)],
   [O("idea", "camino", "year off to walk the Camino", "The user wishes to take a year off and walk the Camino.", "hypothetical", 0.15, "user", "take a year off and walk the Camino")])

# 4 thinking about moving; known home must stay
ex(H, "en", "D",
   [chat("User: thinking about moving to Philly, rent is like half. idk though, all my friends are here\nAssistant: Want me to compare a few neighbourhoods and commute times?", 40)],
   [O("fact", "home", "Philadelphia", "The user is moving to Philadelphia.", "hypothetical", 0.2, "user", "thinking about moving to Philly")],
   known=[K("m1", "fact", "home", "Brooklyn", "The user lives in Brooklyn."),
          K("m2", "fact", "jess", "roommate", "Jess is the user's roommate.")])

# 5 undecided options + real fact about mum
ex(H, "en", "E",
   [chat("User: torn between an iPhone and a Pixel for my mum's birthday. she mostly just does WhatsApp video calls with us and her eyesight isn't great. pixel's cheaper\nAssistant: Either works for video calls. For eyesight, a bigger screen and larger text settings help most.", 15)],
   [O("decision", "gift for mum", "iPhone or Pixel", "The user is choosing between an iPhone and a Pixel for their mum's birthday.", "hypothetical", 0.15, "user", "torn between an iPhone and a Pixel"),
    O("fact", "mum", "poor eyesight", "The user's mum has poor eyesight and mostly uses WhatsApp video calls.", "stated", 0.55, "person", "her eyesight isn't great")])

# 6 Roman Urdu maybe
ex(H, "mixed", "F",
   [chat("User: shayad next year MBA kar loon, LUMS ya IBA, abhi kuch decide nahi kiya. filhal toh job se fursat nahi\nAssistant: Dono ache options hain. Kis cheez pe focus karna chahte ho?", 70)],
   [O("idea", "mba", "MBA at LUMS or IBA next year", "The user might do an MBA at LUMS or IBA next year.", "hypothetical", 0.2, "user", "shayad next year MBA kar loon")])

# 7 question about tech + real project fact
ex(H, "en", "A",
   [chat("User: would it be dumb to use SQLite in production for stockroom? it's literally 5 users, all in one shop\nAssistant: Not dumb at all at that scale. Turn on WAL mode and keep backups.", 8, "stockroom")],
   [O("decision", "database", "SQLite", "Stockroom might use SQLite in production.", "hypothetical", 0.15, "project", "use SQLite in production for stockroom", project="stockroom"),
    O("fact", "users", "5 users in one shop", "Stockroom has about 5 users, all in one shop.", "stated", 0.5, "project", "it's literally 5 users, all in one shop", project="stockroom")])

# 8 booked trip + maybe extension
ex(H, "en", "B",
   [chat("User: booked the Hunza trip!! leaving 20 Nov with Saad and Fatima. might add Skardu after if the roads are open, we'll see\nAssistant: Amazing! Want a packing list for the cold?", 3)],
   [O("idea", "skardu", "add Skardu after Hunza", "The user might add Skardu after the Hunza trip.", "hypothetical", 0.2, "user", "might add Skardu after")],
   [P("Hunza trip", "2026-11-20", "the Hunza trip", "20 Nov", "Hunza", ["Saad", "Fatima"])])

# 9 dream job
ex(H, "en", "C",
   [chat("User: dream job would be F1 aerodynamics. ha. anyway, back to my spreadsheets\nAssistant: Never too late to dream. What are we working on in the spreadsheet?", 1)],
   [O("preference", "dream job", "F1 aerodynamics", "The user's dream job would be F1 aerodynamics.", "hypothetical", 0.2, "user", "dream job would be F1 aerodynamics")])

# 10 maybe change; known preference repeated in passing
ex(H, "en", "D",
   [chat("User: maybe I'll try the pumpkin spice latte this year instead of my usual oat flat white. maybe. probably not\nAssistant: Worth trying once!", 6)],
   [O("preference", "coffee order", "pumpkin spice latte", "The user will order a pumpkin spice latte.", "hypothetical", 0.15, "user", "maybe I'll try the pumpkin spice latte"),
    O("preference", "coffee order", "oat milk flat white", "The user's usual coffee is an oat milk flat white.", "implied", 0.6, "user", "my usual oat flat white", merge=same("m1"))],
   known=[K("m1", "preference", "coffee order", "oat milk flat white", "The user usually orders an oat milk flat white."),
          K("m2", "fact", "employer", "Northwind Labs", "The user works at Northwind Labs.")])

# 11 conditional money plan + real loan fact
ex(H, "en", "E",
   [chat("User: If my bonus comes through in December I'll pay off the car loan early. otherwise I just keep doing the 2,000 dirham a month\nAssistant: Paying early could save interest. Check whether there's an early settlement fee.", 24)],
   [O("decision", "car loan payoff", "pay off early", "The user will pay off the car loan early if the December bonus comes through.", "hypothetical", 0.2, "user", "I'll pay off the car loan early"),
    O("fact", "car loan", "2,000 AED a month", "The user pays 2,000 AED a month on a car loan.", "implied", 0.55, "user", "2,000 dirham a month")])

# 12 health question; known cricket repeated
ex(H, "en", "F",
   [chat("User: do you think I should get an MRI on my knee or just rest it another week? it's been swollen since the cricket match on Saturday\nAssistant: If the swelling hasn't gone down in a week, or you can't put weight on it, get it checked.", 90)],
   [O("decision", "knee mri", "get an MRI", "The user will get an MRI on their knee.", "hypothetical", 0.15, "user", "I should get an MRI on my knee"),
    O("fact", "knee", "swollen since cricket match", "The user's knee has been swollen since a cricket match.", "stated", 0.45, "user", "it's been swollen since the cricket match"),
    O("fact", "cricket", "club cricket on weekends", "The user plays club cricket on weekends.", "implied", 0.6, "user", "the cricket match on Saturday", merge=same("m1"))],
   known=[K("m1", "fact", "cricket", "club cricket on weekends", "The user plays club cricket on weekends.")])

# 13 Roman Urdu religious intentions
ex(H, "mixed", "A",
   [chat("User: Insha'Allah agle saal Hajj ka irada hai agar paisay jama ho gaye. aur abhi December mein Umrah ka bhi soch rahe hain, ammi abbu ke saath\nAssistant: Allah qubool kare. Dates bata dein toh main Umrah packages compare kar deta hoon.", 45)],
   [O("idea", "hajj", "Hajj next year", "The user intends to perform Hajj next year if they can save enough.", "hypothetical", 0.25, "user", "agle saal Hajj ka irada hai"),
    O("idea", "umrah", "Umrah in December with parents", "The user is considering Umrah in December with their parents.", "hypothetical", 0.2, "user", "December mein Umrah ka bhi soch rahe hain")])

# 14 decided + maybe later
ex(H, "en", "B",
   [chat("User: Decided: Postgres for hostelhop. might bolt on Redis later if caching becomes a problem but not now\nAssistant: Solid choice.", 12, "hostelhop")],
   [O("decision", "database", "Postgres", "Hostelhop will use Postgres.", "stated", 0.85, "project", "Postgres for hostelhop", project="hostelhop"),
    O("decision", "cache", "Redis later", "Hostelhop might add Redis for caching later.", "hypothetical", 0.2, "project", "might bolt on Redis later", project="hostelhop")])

# 15 question to assistant
ex(H, "en", "C",
   [chat("User: should I ask for a raise now or wait till after my review in January?\nAssistant: Asking after a strong review usually works better, unless budgets are set before then.", 30)],
   [O("decision", "raise", "ask for a raise now", "The user is asking for a raise now.", "hypothetical", 0.15, "user", "should I ask for a raise now")])

# 16 wish about a parent + real fact
ex(H, "en", "D",
   [chat("User: my dad keeps saying he'll come see NYC 'someday'. I'd love that. but he's 74 and hates flying, so probably not\nAssistant: A shorter route with a stopover might make it easier for him.", 17)],
   [O("idea", "dad visit", "dad visiting NYC someday", "The user's dad might visit NYC someday.", "hypothetical", 0.15, "person", "he'll come see NYC 'someday'"),
    O("fact", "dad", "74, hates flying", "The user's dad is 74 and hates flying.", "stated", 0.6, "person", "he's 74 and hates flying")])

# 17 thinking about learning
ex(H, "en", "E",
   [chat("User: been thinking about learning Arabic properly. would be useful here. not signing up for anything yet tho\nAssistant: Happy to suggest some options whenever you're ready.", 5)],
   [O("idea", "arabic", "learn Arabic", "The user is thinking about learning Arabic.", "hypothetical", 0.2, "user", "thinking about learning Arabic properly")],
   known=[K("m1", "fact", "home city", "Dubai", "The user lives in Dubai.")])

# 18 what-if; known framework must stay
ex(H, "en", "F",
   [chat("User: what if we rewrote quill's frontend in Svelte? just curious how much work that'd be, not planning it\nAssistant: Rough estimate: the component layer is the bulk of it, maybe 3 to 4 weeks for one dev.", 9, "quill")],
   [O("decision", "frontend framework", "Svelte", "Quill's frontend will be rewritten in Svelte.", "hypothetical", 0.15, "project", "rewrote quill's frontend in Svelte", project="quill")],
   known=[K("m1", "decision", "frontend framework", "React", "Quill's frontend uses React.", "quill"),
          K("m2", "decision", "hosting", "Vercel", "Quill is hosted on Vercel.", "quill")])

# 19 conditional venue + real fact + plans
ex(H, "en", "A",
   [chat("User: if it rains Saturday we'll do Ayaan's birthday at home instead of the park. need to order the cake by Friday either way, chocolate, it's his favourite\nAssistant: Got it. Want a reminder for the cake order?", 11)],
   [O("decision", "birthday venue", "home if it rains", "Ayaan's birthday will be at home if it rains.", "hypothetical", 0.2, "user", "we'll do Ayaan's birthday at home instead of the park"),
    O("fact", "ayaan", "favourite cake is chocolate", "Ayaan's favourite cake is chocolate.", "stated", 0.6, "person", "chocolate, it's his favourite")],
   [P("Ayaan's birthday", "2026-10-31", "Ayaan's birthday", "Saturday", "", ["Ayaan"]),
    P("Order Ayaan's birthday cake", "2026-10-30", "order the cake", "by Friday")])

# 20 short maybe
ex(H, "en", "B",
   [chat("User: maybe I should start a youtube channel\nAssistant: About what?\nUser: idk. cooking? code? both? forget it", 0)],
   [O("idea", "youtube channel", "start a YouTube channel", "The user might start a YouTube channel.", "hypothetical", 0.15, "user", "maybe I should start a youtube channel")])

# 21 conditional job change; known employer must stay
ex(H, "en", "C",
   [chat("User: If the Leeds offer comes through I'd probably take it. nothing's signed though and I haven't told anyone at Brightwater, so keep that between us\nAssistant: Understood.", 65)],
   [O("fact", "employer", "new job in Leeds", "The user is taking a new job in Leeds.", "hypothetical", 0.25, "user", "If the Leeds offer comes through I'd probably take it")],
   known=[K("m1", "fact", "employer", "Brightwater Insurance", "The user works at Brightwater Insurance."),
          K("m2", "fact", "home city", "Manchester", "The user lives in Manchester.")])

# 22 multi-turn undecided trip
ex(H, "en", "D",
   [chat("User: we've got 5 days over christmas. options: puerto rico or montreal. kids want snow, my wife wants a beach lol\nAssistant: Montreal has a lovely winter vibe; Puerto Rico is warm and an easy flight from NYC. What's the budget?\nUser: probably montreal then, but let me check flights first before I decide anything", 20)],
   [O("decision", "christmas trip", "Montreal", "The user is going to Montreal over Christmas.", "hypothetical", 0.25, "user", "probably montreal then")],
   known=[K("m1", "fact", "family", "married with two kids", "The user is married with two kids."),
          K("m2", "fact", "home city", "New York", "The user lives in New York.")])

# 23 Roman Urdu conditional + real family fact
ex(H, "mixed", "E",
   [chat("User: agar contract renew ho gaya toh next year family ko bhi yahan bula loonga. abhi wife aur bachay Multan mein hain, unke bina mushkil hai\nAssistant: InshaAllah ho jayega. Family visa ke documents ki list bana doon?", 38)],
   [O("decision", "family move", "bring family to Dubai next year", "The user will bring their family to Dubai next year if the contract is renewed.", "hypothetical", 0.25, "user", "next year family ko bhi yahan bula loonga"),
    O("fact", "family", "wife and kids in Multan", "The user's wife and children live in Multan.", "stated", 0.75, "user", "wife aur bachay Multan mein hain")])

# 24 other-life dream; known job repeated
ex(H, "en", "F",
   [chat("User: in another life I'd be a chef. in this one I'm a QA engineer who writes test cases for a living\nAssistant: There's overlap: both are about following the recipe exactly.", 14)],
   [O("idea", "dream career", "chef", "The user would be a chef.", "hypothetical", 0.15, "user", "in another life I'd be a chef"),
    O("fact", "job", "QA engineer", "The user works as a QA engineer.", "stated", 0.85, "user", "I'm a QA engineer", merge=same("m1"))],
   known=[K("m1", "fact", "job", "QA engineer", "The user works as a QA engineer.")])

# 25 hypothetical vs known diet
ex(H, "en", "A",
   [chat("User: would it be weird if a vegetarian tried fish just once? asking for myself. prob not gonna\nAssistant: Not weird at all; it's your call either way.", 4)],
   [O("preference", "diet", "trying fish", "The user will try fish.", "hypothetical", 0.15, "user", "tried fish just once")],
   known=[K("m1", "preference", "diet", "vegetarian", "The user is vegetarian."),
          K("m2", "fact", "home city", "Lahore", "The user lives in Lahore.")])

# 26 decided registration + undecided optional
ex(H, "en", "B",
   [chat("User: registered for the CSS exam in February, finally!! thinking I might take Gender Studies as an optional but haven't locked it yet\nAssistant: Congrats on registering! Want a comparison of the popular optionals?", 27)],
   [O("fact", "css exam", "registered for February", "The user has registered for the CSS exam in February.", "stated", 0.8, "user", "registered for the CSS exam in February"),
    O("decision", "css optional", "Gender Studies", "The user is taking Gender Studies as a CSS optional.", "hypothetical", 0.2, "user", "I might take Gender Studies as an optional")])

# 27 money question + implied fact
ex(H, "en", "C",
   [chat("User: is it worth overpaying the mortgage or should I put the extra £300 a month into my ISA instead?\nAssistant: Compare your mortgage rate with what you expect the ISA to return after fees.", 10)],
   [O("fact", "mortgage", "has a mortgage", "The user has a mortgage.", "implied", 0.5, "user", "overpaying the mortgage"),
    O("decision", "spare £300", "overpay mortgage or ISA", "The user is deciding whether to overpay the mortgage or put £300 a month into an ISA.", "hypothetical", 0.15, "user", "should I put the extra £300 a month into my ISA")])

# 28 email with conditional + real appointment
ex(H, "en", "D",
   [email("Email the user received (from Greenpoint Property Mgmt <maintenance@greenpointpm.test>): Bathroom repairs. Hi, the plumbers will be at your apartment Thursday at 10am to start on the bathroom. If the work runs over, we may need you to stay elsewhere for a few nights in January. We'll confirm closer to the date. Thanks, Greenpoint Maintenance", 240)],
   [O("fact", "january housing", "may stay elsewhere a few nights", "The user will stay elsewhere for a few nights in January during repairs.", "hypothetical", 0.15, "user", "we may need you to stay elsewhere for a few nights in January")],
   [P("Plumbers start bathroom repairs", "2026-12-03T10:00", "the plumbers will be at your apartment", "Thursday at 10am", "home")])

# 29 conditional trip + implied fandom
ex(H, "en", "E",
   [chat("User: if Pakistan make the final I'm flying out to watch it, wherever it is, no questions asked\nAssistant: That's dedication! Want me to track the fixtures?", 50)],
   [O("preference", "cricket team", "Pakistan", "The user supports the Pakistan cricket team.", "implied", 0.55, "user", "Pakistan"),
    O("decision", "cricket final", "fly to watch the final", "The user will fly out to watch the final if Pakistan qualify.", "hypothetical", 0.15, "user", "I'm flying out to watch it")])

# 30 decided rule + conditional future rule
ex(H, "en", "F",
   [chat("User: from now on every PR on ledgerly needs two approvals before merge. if the team grows past 8 we might move to CODEOWNERS\nAssistant: Got it. Want me to update the branch protection rules?", 7, "ledgerly")],
   [O("requirement", "pr approvals", "two approvals", "Every Ledgerly PR needs two approvals before merge.", "stated", 0.8, "project", "every PR on ledgerly needs two approvals", project="ledgerly"),
    O("decision", "codeowners", "move to CODEOWNERS", "Ledgerly might move to CODEOWNERS if the team grows past 8.", "hypothetical", 0.2, "project", "we might move to CODEOWNERS", project="ledgerly")],
   known=[K("m1", "fact", "ci", "GitHub Actions", "Ledgerly's CI runs on GitHub Actions.", "ledgerly")])

# 31 maybe about a sibling; known location must stay
ex(H, "en", "A",
   [chat("User: Nida might move to Lahore if her husband's transfer goes through!! would be so nice having her 20 min away\nAssistant: That would be lovely! When will they know?\nUser: end of the month apparently", 21)],
   [O("fact", "nida", "moving to Lahore", "Nida, the user's sister, is moving to Lahore.", "hypothetical", 0.2, "person", "Nida might move to Lahore"),
    O("fact", "home city", "Lahore", "The user lives in Lahore.", "implied", 0.5, "user", "having her 20 min away")],
   known=[K("m1", "fact", "nida", "sister, lives in Islamabad", "Nida, the user's sister, lives in Islamabad."),
          K("m2", "routine", "calls with mother", "every Sunday", "The user calls their mother every Sunday.")])

# 32 Roman Urdu undecided dinner
ex(H, "mixed", "B",
   [chat("User: aaj raat kya banaun? karahi ya daal chawal? ya phir order hi kar loon, dimagh kaam nahi kar raha\nAssistant: Agar thakan hai toh daal chawal sabse easy hai!", 0)],
   [O("decision", "dinner tonight", "karahi, daal chawal or order in", "The user is making karahi or daal chawal tonight, or ordering in.", "hypothetical", 0.1, "user", "karahi ya daal chawal")])

# 33 decided change of known + wondering
ex(H, "en", "C",
   [chat("User: we've decided to drop 3.9 support in pellet, 3.11 minimum from the next release\nAssistant: Makes sense. I'll update the classifiers and the CI matrix. Anything else?\nUser: also wondering if we should move from setuptools to hatch. no rush, just thinking out loud", 15, "pellet")],
   [O("decision", "python support", "3.11 minimum", "Pellet requires Python 3.11 minimum from the next release.", "stated", 0.85, "project", "3.11 minimum from the next release", project="pellet", merge=diff("m1")),
    O("decision", "build backend", "hatch", "Pellet will move from setuptools to hatch.", "hypothetical", 0.2, "project", "move from setuptools to hatch", project="pellet"),
    O("decision", "build backend", "setuptools", "Pellet currently builds with setuptools.", "implied", 0.5, "project", "setuptools", project="pellet")],
   known=[K("m1", "decision", "python support", "3.9 minimum", "Pellet supports Python 3.9 and up.", "pellet")])

# 34 hope about a brother + real fact
ex(H, "en", "D",
   [chat("User: really hoping my little brother Kev gets into med school this round. he applied to 9 schools, interviews start in January\nAssistant: Fingers crossed for him!", 32)],
   [O("fact", "kev", "gets into med school", "Kev, the user's brother, gets into med school.", "hypothetical", 0.2, "person", "Kev gets into med school"),
    O("fact", "kev", "applied to 9 med schools", "Kev, the user's younger brother, applied to 9 medical schools.", "stated", 0.65, "person", "he applied to 9 schools")])

# 35 thinking of; known car must stay
ex(H, "en", "E",
   [chat("User: thinking of trading the Corolla for a Model 3 next year. the charging situation in our building is the only thing stopping me\nAssistant: Some buildings let residents request a charger install. Worth asking management.", 13)],
   [O("fact", "car", "Model 3", "The user drives a Tesla Model 3.", "hypothetical", 0.2, "user", "trading the Corolla for a Model 3")],
   known=[K("m1", "fact", "car", "2019 Corolla", "The user drives a 2019 Toyota Corolla.")])

with open(OUT, "w", encoding="utf-8") as f:
    for i, e in enumerate(EX, 1):
        e = {"id": f"b-jk-{i:03d}", **e}
        f.write(json.dumps(e, ensure_ascii=False) + "\n")
print(len(EX))
