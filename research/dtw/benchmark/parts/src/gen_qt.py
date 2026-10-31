import json

OUT = "/home/user/Codeply-Craft/research/dtw/benchmark/parts/qt.jsonl"
EX = []


def chat(text, m=2, project=None):
    e = {"source": "chat", "trust": "user", "minutes_ago": m, "text": text}
    if project:
        e["project"] = project
    return e


def heard(text, m=5, project=None):
    e = {"source": "heard", "trust": "mixed", "minutes_ago": m, "text": "Heard around the user: " + text}
    if project:
        e["project"] = project
    return e


def email(frm, text, m=30, project=None):
    e = {"source": "email", "trust": "external", "minutes_ago": m, "text": f"Email the user received (from {frm}): {text}"}
    if project:
        e["project"] = project
    return e


def K(i, kind, slot, value, text, **kw):
    d = {"id": f"m{i}", "kind": kind, "slot": slot, "value": value, "text": text}
    d.update(kw)
    return d


def O(kind, slot, value, text, cert, imp, about, evidence, **kw):
    d = {"kind": kind, "slot": slot, "value": value, "text": text, "certainty": cert, "importance": imp,
         "about": about, "evidence": evidence}
    d.update(kw)
    return d


def P(what, when, evidence, time_text, where="", who=None, **kw):
    d = {"what": what, "when": when, "where": where, "who": who or [], "evidence": evidence, "time_text": time_text}
    d.update(kw)
    return d


def add(task, lang, anchor, events, obs=(), plans=(), known=(), expect=None):
    n = len(EX) + 1
    EX.append({"id": f"b-qt-{n:03d}", "task": task, "lang": lang, "anchor": anchor, "events": list(events),
               "known": list(known), "observations": list(obs), "plans": list(plans), "expect": expect or {}})


# ---------------------------------------------------------------- quoting (35)

add("quoting", "en", "A", [chat(
    "User: my dad keeps saying I should put my savings in gold instead of the bank. idk, feels very 1990s to me\n"
    "Assistant: Fair, gold has its fans. Want a quick comparison with a savings account or an index fund?", 3)],
    obs=[O("idea", "savings", "put savings in gold", "The user's dad says the user should put their savings in gold.",
           "quoting", 0.2, "user", "I should put my savings in gold")])

add("quoting", "en", "B", [chat(
    "User: Ali thinks React is dead and everyone should move to Svelte. he says this every year lol. anyway why does this useEffect run twice\n"
    "Assistant: In development, React 18's StrictMode mounts components twice on purpose to surface side effects.", 4)],
    known=[K(1, "preference", "frontend framework", "React", "The user builds frontends with React."),
           K(2, "fact", "home city", "Karachi", "The user lives in Karachi.")],
    obs=[O("preference", "frontend framework", "Svelte", "Ali thinks React is dead and everyone should move to Svelte.",
           "quoting", 0.15, "person", "everyone should move to Svelte")])

add("quoting", "en", "C", [chat(
    "User: doctor said cut sugar so I'm off sugar now. no more chai with 2 spoons 😭 suggest a dessert that isn't sad\n"
    "Assistant: Baked cinnamon apples with Greek yoghurt are a good start.", 2)],
    obs=[O("requirement", "sugar", "no sugar", "The user has cut out sugar on their doctor's advice.",
           "stated", 0.75, "user", "I'm off sugar now")])

add("quoting", "en", "D", [chat(
    "User: doctor told me to cut down on caffeine. yeah not happening this week, I have three deadlines. third coffee incoming ☕\n"
    "Assistant: Hang in there. Want help ordering the three deadlines by urgency?", 1)],
    obs=[O("requirement", "caffeine", "cut down on caffeine", "The user's doctor told the user to cut down on caffeine.",
           "quoting", 0.2, "user", "cut down on caffeine"),
         O("context", "workload", "three deadlines this week", "The user has three deadlines this week.",
           "temporary", 0.45, "user", "I have three deadlines", until="2026-12-06T23:59", time_text="this week")])

add("quoting", "mixed", "E", [chat(
    "User: Ammi kehti hain shaadi ke baad wapas Lahore aa jao, Dubai mein family settle karna mushkil hai. main nahi maanta yaar, yahan job achi hai, main yahin rahunga\n"
    "Assistant: Samajh sakta hun. Agar chahein to main dono options ke pros aur cons likh deta hun.", 6)],
    obs=[O("idea", "moving back", "move back to Lahore", "The user's mother says the user should move back to Lahore after marriage.",
           "quoting", 0.2, "user", "wapas Lahore aa jao"),
         O("fact", "home city", "Dubai", "The user lives and works in Dubai and intends to stay.",
           "implied", 0.75, "user", "yahan job achi hai, main yahin rahunga")])

add("quoting", "en", "F", [chat(
    "User: my cofounder Bilal is convinced we need a mobile app before launch. I think the PWA is enough for v1 and I told him so. can you list what a PWA can't do on iOS\n"
    "Assistant: Sure. Push notifications only work for home-screen web apps since iOS 16.4, there's no background sync, and storage can be evicted.",
    3, project="tiffin-box")],
    obs=[O("fact", "bilal", "cofounder", "Bilal is the user's cofounder.", "stated", 0.7, "person", "my cofounder Bilal"),
         O("decision", "mobile app", "native app before launch", "Bilal thinks tiffin-box needs a mobile app before launch.",
           "quoting", 0.2, "project", "we need a mobile app before launch", project="tiffin-box"),
         O("idea", "pwa", "PWA is enough for v1", "The user thinks a PWA is enough for tiffin-box v1.",
           "stated", 0.55, "project", "I think the PWA is enough for v1", project="tiffin-box")])

add("quoting", "en", "A", [chat(
    "User: Sara (my sister) says I'm terrible at replying to texts. she's not wrong honestly 😅\n"
    "Assistant: Ha, it happens to the best of us.", 2)],
    obs=[O("fact", "sara", "sister", "Sara is the user's sister.", "stated", 0.65, "person", "Sara (my sister)"),
         O("fact", "replying to texts", "slow to reply to texts", "The user is slow at replying to texts (they agree with their sister).",
           "implied", 0.45, "user", "she's not wrong honestly")])

add("quoting", "en", "B", [chat(
    "User: my accountant says I should move my freelance income into a sole proprietorship for tax. no idea if he's right, same guy told me crypto was safe in 2021 lol\n"
    "Assistant: Worth a second opinion. Want me to list the questions to ask a tax consultant?", 5)],
    obs=[O("idea", "tax setup", "register a sole proprietorship", "The user's accountant says the user should move freelance income into a sole proprietorship.",
           "quoting", 0.2, "user", "move my freelance income into a sole proprietorship"),
         O("fact", "freelance work", "has freelance income", "The user earns freelance income.",
           "implied", 0.55, "user", "my freelance income")])

add("quoting", "en", "C", [chat(
    "User: my landlord says the boiler is 'perfectly fine' and the cold is in my head 🙄 it's 14 degrees in here. what are my rights as a tenant in England\n"
    "Assistant: Your landlord has to keep the heating and hot water in repair (Landlord and Tenant Act 1985, section 11). Report it in writing first.", 4)],
    obs=[O("fact", "boiler", "perfectly fine", "The user's landlord says the boiler is perfectly fine.",
           "quoting", 0.15, "person", "the boiler is 'perfectly fine'"),
         O("fact", "housing", "renting in England", "The user rents their home in England.",
           "implied", 0.55, "user", "a tenant in England")])

add("quoting", "en", "D", [chat(
    "User: my knee's been acting up again and coach says I need to stop running on concrete. not paying for a treadmill gym tho. ALSO I signed up for a half marathon in March!!\n"
    "Assistant: Congrats on signing up! Trails or a track could be a free middle ground for the knee.", 3)],
    obs=[O("fact", "knee", "recurring knee trouble", "The user has recurring knee trouble.", "stated", 0.55, "user",
           "my knee's been acting up again"),
         O("requirement", "running surface", "stop running on concrete", "The user's coach says the user should stop running on concrete.",
           "quoting", 0.2, "user", "stop running on concrete"),
         O("fact", "half marathon", "signed up, March", "The user signed up for a half marathon in March.", "stated", 0.7, "user",
           "signed up for a half marathon in March")])

add("quoting", "en", "E", [chat(
    "User: my boss says no one reads docs anyway. hard disagree. I'm writing a proper README for fleetlog before the release, setup + env vars + deploy steps\n"
    "Assistant: Good call. Want a skeleton with those three sections?", 2, project="fleetlog")],
    obs=[O("preference", "documentation", "docs not worth writing", "The user's boss thinks no one reads docs.",
           "quoting", 0.15, "person", "no one reads docs anyway"),
         O("todo", "readme", "write README before release", "The user will write a proper README for fleetlog before the release.",
           "stated", 0.55, "project", "I'm writing a proper README for fleetlog before the release", project="fleetlog")])

add("quoting", "mixed", "F", [chat(
    "User: Ahmed bhai ka kehna hai ke Bahria Town mein plot le lo abhi, 2 saal mein double ho jaye ga. mujhe nahi lagta, pichli dafa bhi yehi kaha tha aur kuch nahi hua\n"
    "Assistant: Aise claims check karne chahiye. Kya main pichle saalon ke price trends dekh lun?", 7)],
    obs=[O("idea", "plot", "buy a plot in Bahria Town", "Ahmed says the user should buy a plot in Bahria Town now.",
           "quoting", 0.2, "user", "Bahria Town mein plot le lo abhi")])

add("quoting", "en", "A", [chat(
    "User: my wife thinks I work too much and should take Fridays off. she's probably right but we're short staffed rn so no\n"
    "Assistant: Understandable. Maybe a shorter Friday once you've hired?", 3)],
    known=[K(1, "fact", "occupation", "runs a dental clinic", "The user runs a dental clinic in DHA.")],
    obs=[O("fact", "marital status", "married", "The user is married.", "stated", 0.65, "user", "my wife"),
         O("routine", "fridays off", "take Fridays off", "The user's wife thinks the user should take Fridays off.",
           "quoting", 0.2, "user", "should take Fridays off")])

add("quoting", "en", "B", [chat("User: Hamza says Arsenal will win the league 😂\nAssistant: Bold prediction!", 1)],
    obs=[O("fact", "premier league", "Arsenal will win", "Hamza says Arsenal will win the league.",
           "quoting", 0.1, "person", "Arsenal will win the league")])

add("quoting", "en", "C", [chat(
    "User: vet said Biscuit is overweight and needs to go on diet food. she's a cat, she will riot. ordering the diet food anyway, which brand is least gross\n"
    "Assistant: Most cats accept the wet versions of the light ranges more easily than the dry ones.", 4)],
    obs=[O("fact", "biscuit", "the user's cat, overweight", "Biscuit, the user's cat, is overweight according to the vet.",
           "implied", 0.6, "person", "Biscuit is overweight"),
         O("decision", "biscuit diet", "diet food", "The user is switching Biscuit to diet food.", "stated", 0.5, "user",
           "ordering the diet food anyway")])

add("quoting", "en", "D", [chat(
    "User: my teammate keeps saying VS Code is objectively better than vim and I'm a dinosaur. anyway how do I make telescope ignore node_modules\n"
    "Assistant: Add file_ignore_patterns = { \"node_modules\" } to the defaults in your telescope setup.", 2)],
    known=[K(1, "preference", "editor", "Neovim", "The user codes in Neovim.")],
    obs=[O("preference", "editor", "VS Code", "The user's teammate thinks VS Code is better than vim.",
           "quoting", 0.15, "person", "VS Code is objectively better than vim")])

add("quoting", "en", "E", [chat(
    "User: my nutritionist wants me on 120g protein a day\n"
    "Assistant: That's a solid target. Want a meal plan to hit it?\n"
    "User: lol no. I'm vegetarian and I hate protein shakes, not doing that. just give me one normal dinner idea\n"
    "Assistant: Paneer bhurji with whole wheat roti and a cucumber raita.", 3)],
    known=[K(1, "fact", "diet", "vegetarian", "The user is vegetarian."),
           K(2, "preference", "reply language", "English", "The user wants replies in English.")],
    obs=[O("requirement", "protein", "120g a day", "The user's nutritionist wants the user on 120g of protein a day.",
           "quoting", 0.2, "user", "120g protein a day"),
         O("fact", "diet", "vegetarian", "The user is vegetarian.", "stated", 0.8, "user", "I'm vegetarian",
           merge={"target": "m1", "relation": "same"}),
         O("preference", "protein shakes", "hates protein shakes", "The user hates protein shakes.", "stated", 0.55, "user",
           "I hate protein shakes")])

add("quoting", "en", "F", [chat(
    "User: Usman from finance says the Q1 budget is getting cut by 30%. nothing official yet so who knows. should I still pitch the analytics hire?\n"
    "Assistant: I'd still pitch it, but frame it around cost savings in case the cut is real.", 5)],
    obs=[O("fact", "q1 budget", "cut by 30%", "Usman from finance says the Q1 budget will be cut by 30%.",
           "quoting", 0.2, "person", "the Q1 budget is getting cut by 30%"),
         O("idea", "analytics hire", "pitch an analytics hire", "The user is considering pitching an analytics hire.",
           "hypothetical", 0.2, "user", "should I still pitch the analytics hire?")])

add("quoting", "mixed", "A", [chat(
    "User: Nani kehti hain Ramzan se pehle Umrah kar lo, tab tickets saste hote hain. abhi paise nahi hain yaar, next year dekhte hain\n"
    "Assistant: InshaAllah. Agar chahein to main ek saving plan bana deta hun.", 8)],
    obs=[O("idea", "umrah", "do Umrah before Ramzan", "The user's grandmother says the user should do Umrah before Ramzan.",
           "quoting", 0.2, "user", "Ramzan se pehle Umrah kar lo"),
         O("idea", "umrah", "maybe next year", "The user might do Umrah next year.", "hypothetical", 0.2, "user",
           "next year dekhte hain")])

add("quoting", "en", "B", [chat(
    "User: ok so context. I got an offer from Tessellate Labs, fully remote, ~40% more than now. my mentor Farah thinks I'd be crazy to leave before my vesting cliff in Feb. "
    "my brother thinks I'd be crazy NOT to take it. I'm leaning towards taking it but haven't decided anything. can you help me write questions to ask their HR?\n"
    "Assistant: Sure. Start with equity terms, whether they'd compensate the unvested portion, notice period buyout, and how remote salaries are banded.", 6)],
    obs=[O("fact", "job offer", "Tessellate Labs, remote, ~40% raise", "The user has a job offer from Tessellate Labs (fully remote, about 40% more pay).",
           "stated", 0.7, "user", "I got an offer from Tessellate Labs"),
         O("fact", "farah", "mentor", "Farah is the user's mentor.", "stated", 0.6, "person", "my mentor Farah"),
         O("decision", "job offer", "stay until vesting cliff", "Farah thinks the user should not leave before their vesting cliff.",
           "quoting", 0.2, "user", "crazy to leave before my vesting cliff"),
         O("fact", "vesting cliff", "February", "The user's vesting cliff at their current job is in February.",
           "stated", 0.55, "user", "vesting cliff in Feb"),
         O("decision", "job offer", "take the offer", "The user's brother thinks the user should take the offer.",
           "quoting", 0.15, "user", "my brother thinks I'd be crazy NOT to take it"),
         O("decision", "job offer", "leaning towards taking it", "The user is leaning towards taking the Tessellate Labs offer.",
           "hypothetical", 0.25, "user", "I'm leaning towards taking it")])

add("quoting", "en", "C", [chat(
    "User: my flatmate swears oat milk is worse for you than dairy. I'll keep my oat flat white thanks. any good cafes near Angel open on Sunday?\n"
    "Assistant: A few independents around Upper Street open on Sundays; want me to list some?", 2)],
    obs=[O("fact", "living situation", "has a flatmate", "The user lives with a flatmate.", "implied", 0.45, "user", "my flatmate"),
         O("fact", "oat milk", "worse than dairy", "The user's flatmate thinks oat milk is worse for you than dairy.",
           "quoting", 0.15, "person", "oat milk is worse for you than dairy"),
         O("preference", "coffee order", "oat flat white", "The user drinks oat flat whites.", "stated", 0.6, "user",
           "I'll keep my oat flat white")])

add("quoting", "en", "D", [chat(
    "User: lol my uncle told the whole thanksgiving table AI will take every job by 2030 and then asked me to fix his printer\n"
    "Assistant: Classic.", 1)],
    obs=[O("fact", "ai and jobs", "AI takes every job by 2030", "The user's uncle says AI will take every job by 2030.",
           "quoting", 0.1, "person", "AI will take every job by 2030")])

add("quoting", "en", "E", [chat(
    "User: my trainer said try fasted cardio in the mornings. did it all week and honestly I love it, doing it every morning now. what should I eat after?\n"
    "Assistant: Eggs or Greek yoghurt with fruit within an hour works well.", 4)],
    known=[K(1, "fact", "gym", "member at FitZone JLT", "The user is a member at FitZone JLT.")],
    obs=[O("routine", "morning cardio", "fasted cardio every morning", "The user does fasted cardio every morning.",
           "stated", 0.65, "user", "doing it every morning now")])

add("quoting", "en", "F", [chat(
    "User: my son's teacher says he's 'easily distracted' and might need an assessment. he's 8 ffs, he's just bored in class. how do I reply to her without sounding defensive\n"
    "Assistant: Thank her, ask what she's observed specifically, and suggest a short meeting.", 3)],
    obs=[O("fact", "son", "easily distracted, may need assessment", "The user's son's teacher says he is easily distracted and might need an assessment.",
           "quoting", 0.2, "person", "might need an assessment"),
         O("fact", "son", "8 years old", "The user has an 8-year-old son.", "stated", 0.65, "person", "he's 8")])

add("quoting", "en", "A", [chat(
    "User: Kamran said in standup we should rip out Postgres and use Mongo because 'schemas slow us down'. nobody agreed, we're staying on postgres. anyway help me write the migration for the new allowances table\n"
    "Assistant: Sure. Here's a CREATE TABLE allowances migration with a foreign key to employees.", 3, project="payroll-app")],
    known=[K(1, "decision", "database", "Postgres", "The payroll-app project uses Postgres.", project="payroll-app"),
           K(2, "fact", "role", "tech lead on payroll-app", "The user is the tech lead on payroll-app.")],
    obs=[O("decision", "database", "MongoDB", "Kamran suggested replacing Postgres with MongoDB on payroll-app.",
           "quoting", 0.15, "project", "rip out Postgres and use Mongo", project="payroll-app"),
         O("decision", "database", "Postgres", "The payroll-app project is staying on Postgres.", "stated", 0.85, "project",
           "we're staying on postgres", project="payroll-app", merge={"target": "m1", "relation": "same"})])

add("quoting", "mixed", "B", [chat(
    "User: Ammi ne bola hai Saturday ko Faisalabad aana hai, phupho ki beti ki mehndi hai. theek hai, 9 baje wali train le lunga. ek acha sa gift idea do\n"
    "Assistant: Ek khoobsurat jewellery box ya mehndi ke liye customised cushion acha rahega.", 5)],
    plans=[P("Train to Faisalabad for cousin's mehndi", "2026-11-07T09:00", "9 baje wali train", "Saturday", where="Faisalabad")])

add("quoting", "en", "C", [chat(
    "User: my PhD supervisor says my intro chapter 'reads like a blog post'. rude. and wrong. can you check the first paragraph anyway\n"
    "Assistant: Sure, paste it in.", 2)],
    obs=[O("fact", "education", "doing a PhD", "The user is doing a PhD.", "stated", 0.8, "user", "my PhD supervisor"),
         O("fact", "thesis intro", "reads like a blog post", "The user's PhD supervisor says the intro chapter reads like a blog post.",
           "quoting", 0.2, "user", "'reads like a blog post'")])

add("quoting", "en", "D", [chat(
    "User: everyone at work says the new Thai place on 5th Ave is amazing. haven't been. is it worth it if I want proper spice or is it the toned-down kind\n"
    "Assistant: I can't check that restaurant directly, but asking for 'Thai spicy' when ordering usually helps.", 3)],
    known=[K(1, "preference", "cuisine", "Thai, extra spicy", "The user loves Thai food, extra spicy.")],
    obs=[O("preference", "thai place on 5th", "amazing", "The user's coworkers say the new Thai place on 5th Ave is amazing.",
           "quoting", 0.15, "person", "the new Thai place on 5th Ave is amazing"),
         O("preference", "cuisine", "Thai, extra spicy", "The user loves Thai food, extra spicy.", "implied", 0.6, "user",
           "I want proper spice", merge={"target": "m1", "relation": "same"})])

add("quoting", "en", "E", [chat(
    "User: guy at the showroom said the Corolla holds its value better than anything else. salesman gonna salesman. still leaning Civic tbh\n"
    "Assistant: Both hold value well in the UAE; want a 5-year cost comparison?", 2)],
    obs=[O("fact", "corolla", "best resale value", "A car salesman says the Corolla holds its value better than anything else.",
           "quoting", 0.1, "person", "the Corolla holds its value better than anything else"),
         O("preference", "car", "leaning Civic", "The user is leaning towards buying a Civic.", "hypothetical", 0.25, "user",
           "still leaning Civic")])

add("quoting", "en", "F", [chat(
    "User: my brother Zain says I should stop putting everything on my credit card. anyway Zain's wedding is on the 20th, need to book flights to Karachi before prices jump\n"
    "Assistant: Want me to compare morning flights to Karachi for the 18th and 19th?", 4)],
    obs=[O("fact", "zain", "brother", "Zain is the user's brother.", "stated", 0.65, "person", "my brother Zain"),
         O("idea", "credit card", "stop using credit card for everything", "The user's brother Zain says the user should stop putting everything on their credit card.",
           "quoting", 0.2, "user", "stop putting everything on my credit card"),
         O("todo", "flights to karachi", "book flights to Karachi", "The user needs to book flights to Karachi for Zain's wedding.",
           "stated", 0.55, "user", "need to book flights to Karachi")],
    plans=[P("Zain's wedding", "2026-11-20", "Zain's wedding", "the 20th", where="Karachi", who=["Zain"])])

add("quoting", "en", "A", [chat(
    "User: my colleague said you give better answers when you keep them short. I don't care, I like the detailed ones, keep doing that\n"
    "Assistant: Will do.", 2)],
    known=[K(1, "preference", "reply length", "detailed answers", "The user prefers detailed answers.")],
    obs=[O("style", "reply length", "short answers", "The user's colleague thinks short answers are better.",
           "quoting", 0.15, "person", "better answers when you keep them short"),
         O("preference", "reply length", "detailed answers", "The user prefers detailed answers.", "stated", 0.8, "user",
           "I like the detailed ones", merge={"target": "m1", "relation": "same"})])

add("quoting", "mixed", "B", [chat(
    "User: molana sahab ne aaj khutbe mein kaha ke har Jumma sadqa do, chahe thora sa ho. mujhe bohot acha laga, aaj se start kar raha hun. har Jumma 500 rupay\n"
    "Assistant: MashaAllah, bohat achi niyat hai.", 20)],
    obs=[O("routine", "sadqa", "Rs 500 every Friday", "The user gives Rs 500 in sadqa every Friday.", "stated", 0.65, "user",
           "har Jumma 500 rupay")])

add("quoting", "en", "C", [chat(
    "User: my mum thinks I should do a master's straight after graduating. dad thinks I should work first and do it later. I genuinely have no clue\n"
    "Assistant: Both are valid. What field are you in?", 3)],
    obs=[O("idea", "masters", "master's straight away", "The user's mum thinks the user should do a master's straight after graduating.",
           "quoting", 0.2, "user", "I should do a master's straight after graduating"),
         O("fact", "education", "about to graduate", "The user is a student close to graduating.", "implied", 0.5, "user",
           "straight after graduating"),
         O("idea", "masters", "work first", "The user's dad thinks the user should work first and do a master's later.",
           "quoting", 0.2, "user", "I should work first")])

add("quoting", "en", "D", [chat(
    "User: my girlfriend Maya says she's allergic to shellfish so the seafood place is out for her birthday dinner. find me something nice near Williamsburg instead?\n"
    "Assistant: Sure. Do you want Italian, Japanese without shellfish, or a steakhouse?", 2)],
    obs=[O("fact", "maya", "girlfriend, allergic to shellfish", "Maya, the user's girlfriend, is allergic to shellfish.",
           "stated", 0.75, "person", "Maya says she's allergic to shellfish")])

add("quoting", "en", "E", [chat(
    "User: manager reviewed the plan and said \"ship android first, iOS can wait\"\n"
    "Assistant: Does that change the timeline?\n"
    "User: no, we already decided android first last week. but he also wants us to drop dark mode for launch and I'm fighting that one, it's half built already\n"
    "Assistant: Want me to estimate what's left on dark mode so you have numbers?", 4, project="souq-cart")],
    known=[K(1, "decision", "first platform", "Android first", "souq-cart ships on Android first.", project="souq-cart")],
    obs=[O("decision", "first platform", "Android first", "souq-cart ships on Android first.", "stated", 0.8, "project",
           "we already decided android first last week", project="souq-cart", merge={"target": "m1", "relation": "same"}),
         O("decision", "dark mode", "drop for launch", "The user's manager wants to drop dark mode from the souq-cart launch.",
           "quoting", 0.2, "project", "drop dark mode for launch", project="souq-cart"),
         O("preference", "dark mode", "keep for launch, half built", "The user wants to keep dark mode (already half built) in the souq-cart launch.",
           "stated", 0.5, "project", "I'm fighting that one, it's half built already", project="souq-cart")])

# ---------------------------------------------------------------- heard (20)

add("heard", "en", "A", [heard(
    "Kashif: ok final, we stay closed on Sundays from next month, nobody comes anyway. Nida: fine, I'll update the Google listing tonight.", 25)],
    known=[K(1, "fact", "business", "runs a bakery with Kashif", "The user runs a bakery, Crumbs & Co, with Kashif.")],
    obs=[O("decision", "sunday closing", "closed Sundays from next month", "The bakery will stay closed on Sundays from next month.",
           "implied", 0.6, "user", "we stay closed on Sundays from next month")])

add("heard", "en", "B", [heard(
    "TV news: ...petrol prices are expected to go up by 12 rupees a litre from the 16th, the ministry said in a statement this evening. In other news, the Karachi Eat festival returns in January...", 40)])

add("heard", "en", "C", [heard(
    "Priya: did you hear Tom from accounts is leaving? handed his notice in on Friday apparently, going to some fintech. Jake: no way, he's been there like ten years", 15)])

add("heard", "en", "D", [heard(
    "Mom: honey remember Grandpa can't have anything with gluten now, the doctor was very clear. and Lily only eats plain pasta, no sauce, don't even try.", 10)],
    obs=[O("fact", "grandpa", "can't have gluten", "The user's grandpa can't have gluten anymore.", "implied", 0.55, "person",
           "Grandpa can't have anything with gluten now"),
         O("fact", "lily", "only eats plain pasta", "Lily, a family member, only eats plain pasta with no sauce.", "implied", 0.4, "person",
           "Lily only eats plain pasta, no sauce")])

add("heard", "mixed", "E", [heard(
    "Faraz (to the user): bhai next Friday team dinner hai Lahori Tikka House mein, 8 baje. sab aa rahe hain, tum bhi aana. Saad: done, main Ali ko bhi bata deta hun", 12)],
    plans=[P("Team dinner at Lahori Tikka House", "2026-11-27T20:00", "team dinner hai Lahori Tikka House mein", "next Friday",
             where="Lahori Tikka House", who=["Faraz", "Saad"])])

add("heard", "en", "F", [heard(
    "Dr. Khan (to the nurse): tell the family she's being discharged Wednesday morning, the fever's gone. keep the IV till tonight.", 35)],
    known=[K(1, "fact", "ammi", "mother, in hospital with typhoid", "Ammi, the user's mother, is in hospital with typhoid.")],
    plans=[P("Ammi's discharge from hospital", "2026-11-11", "she's being discharged", "Wednesday morning", who=["Ammi", "Dr. Khan"])])

add("heard", "en", "A", [heard(
    "TV (cricket show): ...and honestly Haris Nadeem should be dropped for the Australia series, he's completely out of form, the selectors need to be brave for once...", 60)],
    obs=[O("fact", "haris nadeem", "should be dropped", "A TV pundit says Haris Nadeem should be dropped for the Australia series.",
           "quoting", 0.1, "person", "Haris Nadeem should be dropped for the Australia series")])

add("heard", "en", "B", [heard(
    "Hira (to the user): Asad doesn't eat beef at all, so make it chicken karahi for Saturday. Asad: and no dhaniya please 😅", 8)],
    obs=[O("fact", "asad", "no beef, no coriander", "Asad doesn't eat beef or coriander.", "implied", 0.45, "person",
           "Asad doesn't eat beef at all")],
    plans=[P("Dinner with Hira and Asad (chicken karahi)", "2026-11-07", "chicken karahi", "for Saturday", who=["Hira", "Asad"])])

add("heard", "en", "C", [heard(
    "Gemma (stand-up): right, we're freezing the release branch on Wednesday. nothing merges after 5pm Tuesday unless it's a blocker, and Sam owns the changelog this time.", 20)],
    known=[K(1, "fact", "workplace", "backend dev at Lumen Health", "The user is a backend developer at Lumen Health.")],
    obs=[O("decision", "release freeze", "freeze Wednesday, blockers only after Tuesday 5pm",
           "The team's release branch freezes on Wednesday; after 5pm Tuesday only blockers get merged.",
           "implied", 0.55, "user", "freezing the release branch on Wednesday")],
    plans=[P("Merge cutoff before release freeze", "2026-11-17T17:00", "nothing merges after 5pm Tuesday", "5pm Tuesday", who=["Gemma"])])

add("heard", "en", "D", [heard(
    "Dana (neighbor, on the phone): ...we're finally doing Cancun for New Year's! the kids are losing their minds, Rob wants all-inclusive, I want the place with the cenote tour...", 30)])

add("heard", "en", "E", [heard(
    "Leena: did you see the fireworks at the marina got moved to the 2nd? Omar: yeah because of the National Day crowds, they said 9pm.", 45)])

add("heard", "mixed", "F", [heard(
    "Abbu (to the user): beta Sunday ko Ahsan ke rishte wale aa rahe hain, shaam 5 baje. ghar pe rehna, koi plan mat banana.", 15)],
    plans=[P("Rishta visit for Ahsan at home", "2026-11-15T17:00", "Ahsan ke rishte wale aa rahe hain", "Sunday ko", where="home",
             who=["Abbu", "Ahsan"])])

add("heard", "en", "A", [heard(
    "Maham (sister): I'm not watching Khamoshi ke Rang anymore, it's so dragged. Ammi: I still love it, don't spoil it for me.", 50)],
    obs=[O("fact", "maham", "the user's sister", "Maham is the user's sister.", "implied", 0.5, "person", "Maham (sister)")])

add("heard", "en", "B", [heard(
    "Landlord (at the door): from January the rent will be 85,000, I'll send it in writing. Mehwish: that's a big jump, but okay, we'll manage.", 25)],
    known=[K(1, "fact", "rent", "Rs 70,000 a month", "The user pays Rs 70,000 a month in rent.")],
    obs=[O("fact", "rent", "Rs 85,000 a month from January", "The user's rent goes up to Rs 85,000 a month from January.",
           "implied", 0.6, "user", "from January the rent will be 85,000", merge={"target": "m1", "relation": "different"})])

add("heard", "en", "C", [heard(
    "man at the next table: nah mate, Leeds is overrated, I'd never live there again, rent's gone mental too", 5)],
    known=[K(1, "fact", "home city", "Leeds", "The user lives in Leeds.")],
    obs=[O("fact", "leeds", "overrated", "A stranger says Leeds is overrated and he'd never live there again.",
           "quoting", 0.1, "person", "Leeds is overrated")])

add("heard", "en", "D", [heard(
    "Noah (the user's son): dad I don't want peanut butter anymore, it's gross. only the cheese ones for school ok?", 10)],
    obs=[O("fact", "noah", "son, wants cheese not peanut butter", "Noah, the user's son, doesn't want peanut butter anymore and wants cheese sandwiches for school.",
           "implied", 0.5, "person", "I don't want peanut butter anymore")])

add("heard", "en", "E", [heard(
    "Rania (on speaker): so the client approved the blue theme, we go with that. and they want the demo moved to Tuesday 3pm, can you make that?", 18,
    project="oasis-crm")],
    obs=[O("decision", "theme", "blue theme", "The client approved the blue theme for oasis-crm.", "implied", 0.6, "project",
           "the client approved the blue theme", project="oasis-crm")],
    plans=[P("oasis-crm client demo", "2026-11-24T15:00", "the demo", "Tuesday 3pm", who=["Rania"])])

add("heard", "en", "F", [heard(
    "radio: ...one lane closed near Faizabad interchange after an accident, expect 20 minute delays towards Rawalpindi. Now back to the music...", 40)])

add("heard", "mixed", "A", [heard(
    "Tariq: yaar mere liye green tea, aur do sugar daal dena. Waiter: ji sir, aur aap ke liye?", 3)],
    known=[K(1, "preference", "tea", "doodh patti, no sugar", "The user drinks doodh patti with no sugar.")])

add("heard", "en", "B", [heard(
    "Coach Imran: under-14 practice moves to 7am on Sundays from this week, parents please drop the boys at the main ground, not the back gate.", 30)],
    known=[K(1, "fact", "ibrahim", "son, plays in under-14s", "Ibrahim, the user's son, plays cricket for the under-14s.")],
    obs=[O("routine", "ibrahim cricket practice", "Sundays 7am at main ground",
           "Ibrahim's under-14 cricket practice is now at 7am on Sundays at the main ground.",
           "implied", 0.55, "person", "under-14 practice moves to 7am on Sundays")])

# ---------------------------------------------------------------- external (20)

add("external", "en", "A", [email(
    "Hamid Raza <hamid@brightpixel.example>",
    "Kiosk app launch moved. Hi, the client wants to push the kiosk app launch to Nov 16 because their hardware shipment is late. "
    "Can you confirm by Monday whether the team can hold the build till then? Thanks, Hamid", 90, project="kiosk-app")],
    obs=[O("decision", "launch date", "November 16", "The kiosk-app launch moved to November 16 (per Hamid).", "implied", 0.65, "project",
           "push the kiosk app launch to Nov 16", project="kiosk-app")],
    plans=[P("Confirm kiosk-app launch timing to Hamid", "2026-11-02", "Can you confirm", "by Monday", who=["Hamid"])])

add("external", "en", "B", [email(
    "Nimbus Hosting Billing <billing@nimbushost.example>",
    "Invoice INV-20931 is due. Hi there, your invoice of $48.00 for the VPS plan Pro-2 (server: api-prod-1) is due on November 12. "
    "Pay online to avoid service interruption.", 300)],
    obs=[O("fact", "hosting", "Nimbus Hosting VPS Pro-2", "The user has a Pro-2 VPS with Nimbus Hosting.", "implied", 0.5, "user",
           "VPS plan Pro-2")],
    plans=[P("Nimbus Hosting invoice due ($48)", "2026-11-12", "your invoice of $48.00", "November 12")])

add("external", "en", "C", [email(
    "The Weekend Edit <hello@weekendedit.example>",
    "7 cosy autumn reads + 20% off. This week: our favourite cosy autumn novels, a recipe for spiced pear cake, and 20% off all tote bags with code COSY20. "
    "You're receiving this because you subscribed at weekendedit.example.", 180)],
    known=[K(1, "preference", "reading", "sci-fi", "The user mostly reads sci-fi.")])

add("external", "en", "D", [email(
    "Jordan Ellis <jordan.ellis@harborpoint.example>",
    "Quick sync on Q1 roadmap? Hey, could we grab 30 min Thursday at 2pm ET to go through the Q1 roadmap? I'll send an invite if that works. Jordan", 45)],
    plans=[P("Q1 roadmap sync with Jordan", "2026-12-03T14:00", "go through the Q1 roadmap", "Thursday at 2pm ET", who=["Jordan Ellis"])])

add("external", "en", "E", [email(
    "Lina at FreshBox <lina@freshbox.example>",
    "Your new favourite: the Keto Box! We know you love low-carb meals, so we've switched your default plan to the Keto Box starting next week. "
    "Prefer the Classic? Change it any time in the app.", 240)],
    obs=[O("fact", "freshbox plan", "Keto Box from next week", "The user's FreshBox meal subscription switches to the Keto Box next week.",
           "implied", 0.45, "user", "switched your default plan to the Keto Box")])

add("external", "mixed", "F", [email(
    "Bilal Sheikh <bilal@tiffinbox.example>",
    "Investor call shift. Yaar investor call Wednesday se Thursday shift ho gayi hai, 4 baje. Deck final kar lena Wednesday raat tak pls, unhon ne pehle dekhna hai.",
    60, project="tiffin-box")],
    plans=[P("tiffin-box investor call", "2026-11-12T16:00", "investor call", "Thursday", who=["Bilal"]),
           P("Finalize investor deck", "2026-11-11", "Deck final kar lena", "Wednesday raat tak", who=["Bilal"])])

add("external", "en", "A", [email(
    "Bazaarly Deals <noreply@deals.bazaarly.example>",
    "11.11 is almost here! Up to 70% off phones, air fryers and winter wear. Add to cart now, prices go live at midnight. Unsubscribe anytime.", 500)])

add("external", "en", "B", [email(
    "Beaconfield School <office@beaconfield.example>",
    "Parent-teacher meeting, Grade 4. Dear Parent, the parent-teacher meeting for Grade 4 (Section B) is on Saturday 14 November, 9:00-12:00. "
    "Please collect Hania's report card from the class teacher. Regards, School Office", 120)],
    known=[K(1, "fact", "hania", "daughter, grade 4", "Hania, the user's daughter, is in grade 4.")],
    plans=[P("Parent-teacher meeting (Grade 4)", "2026-11-14T09:00", "the parent-teacher meeting for Grade 4", "Saturday 14 November, 9:00",
             where="Beaconfield School", who=["Hania"])])

add("external", "en", "C", [email(
    "SkyBridge Airways <notifications@skybridge.example>",
    "Schedule change for booking QX7RT2. Your flight SB204 London Heathrow → Lahore on 22 November has been retimed. New departure: 21:40 (was 19:15). No action needed.",
    75)],
    plans=[P("Flight SB204 London Heathrow to Lahore", "2026-11-22T21:40", "flight SB204 London Heathrow → Lahore", "22 November",
             where="London Heathrow")])

add("external", "en", "D", [email(
    "Dr. Alvarez's office <frontdesk@riversidefamilymed.example>",
    "Your lab results + follow-up. Hi, Dr. Alvarez reviewed your labs: vitamin D is low, everything else is normal. She recommends 2000 IU daily "
    "and a follow-up on Dec 10 at 10:30am. Reply to confirm.", 150)],
    obs=[O("fact", "vitamin d", "low", "The user's vitamin D is low (per lab results).", "implied", 0.55, "user", "vitamin D is low"),
         O("requirement", "vitamin d supplement", "2000 IU daily", "Dr. Alvarez recommends the user take 2000 IU of vitamin D daily.",
           "quoting", 0.2, "user", "She recommends 2000 IU daily")],
    plans=[P("Follow-up with Dr. Alvarez", "2026-12-10T10:30", "a follow-up on Dec 10", "Dec 10 at 10:30am",
             where="Riverside Family Medicine", who=["Dr. Alvarez"])])

add("external", "en", "E", [email(
    "Rashid Properties <leasing@rashidprops.example>",
    "Tenancy renewal - Apt 1204, Marina Heights. Dear Tenant, your tenancy ends on 15 December 2026. The renewed annual rent will be AED 98,000 "
    "(previously AED 92,000), payable in 4 cheques. The DEWA deposit carries over. Please confirm renewal by 30 November, otherwise the unit will be "
    "listed for viewing from 1 December. Kind regards, Leasing Team", 400)],
    known=[K(1, "fact", "rent", "AED 92,000 a year", "The user pays AED 92,000 a year in rent."),
           K(2, "fact", "home city", "Dubai", "The user lives in Dubai.")],
    obs=[O("fact", "rent", "AED 98,000 a year", "The user's rent goes up to AED 98,000 a year on renewal.", "implied", 0.65, "user",
           "AED 98,000", merge={"target": "m1", "relation": "different"})],
    plans=[P("Confirm tenancy renewal", "2026-11-30", "Please confirm renewal", "by 30 November", who=[])])

add("external", "en", "F", [email(
    "This Week in Rust <newsletter@twir.example>",
    "Issue 571. Updates from the Rust project, crate of the week, 14 RFCs in final comment period, and call for participation. Read online.", 600)],
    known=[K(1, "preference", "backend language", "Rust", "The user writes backends in Rust.")])

add("external", "en", "A", [email(
    "Saima Qureshi <saima@lumaskincare.example>",
    "Website revamp kickoff. Hi! Excited to start. Can we do the kickoff call on Monday at 11am? Also, we've decided to drop the blog section for phase 1. Best, Saima",
    50, project="luma-website")],
    obs=[O("decision", "blog section", "dropped for phase 1", "The client dropped the blog section from luma-website phase 1.", "implied", 0.6,
           "project", "drop the blog section for phase 1", project="luma-website")],
    plans=[P("luma-website kickoff call with Saima", "2026-11-02T11:00", "the kickoff call", "Monday at 11am", who=["Saima"])])

add("external", "en", "B", [email(
    "Registrar, Indus Tech University <registrar@itu-lahore.example>",
    "Fee challan - Spring 2027. The fee challan for the Spring 2027 semester is now available on the student portal. Last date to deposit: 20 November 2026. "
    "Late fee Rs. 2,000 per week.", 200)],
    obs=[O("fact", "education", "student at Indus Tech University", "The user is a student at Indus Tech University.", "implied", 0.55, "user",
           "the Spring 2027 semester")],
    plans=[P("Deposit Spring 2027 fee", "2026-11-20", "Last date to deposit", "20 November 2026")])

add("external", "en", "C", [email(
    "Oliver Grant <oliver.grant@fernleaf.example>",
    "Re: dashboard fonts. Honestly I think we should switch everything to Inter, Roboto looks dated. Also heads up, the design review moved to Thursday 10am.",
    25, project="fernleaf-dashboard")],
    obs=[O("preference", "font", "Inter", "Oliver thinks the dashboard should switch to Inter because Roboto looks dated.", "quoting", 0.15,
           "project", "we should switch everything to Inter", project="fernleaf-dashboard")],
    plans=[P("fernleaf-dashboard design review", "2026-11-19T10:00", "the design review", "Thursday 10am", who=["Oliver Grant"])])

add("external", "en", "D", [email(
    "Parcelwise <tracking@parcelwise.example>",
    "Your package is out for delivery. Your order #88412 (Standing desk frame, oak top) is out for delivery today between 2pm and 6pm. Someone may need to sign.",
    20)],
    plans=[P("Standing desk delivery", "2026-12-01T14:00", "Standing desk frame", "today between 2pm and 6pm")])

add("external", "en", "E", [email(
    "Gulf Gold & Diamonds <offers@gulfgold.example>",
    "Weekend gold rush. 0% making charges on 22K bangles this weekend only. Visit any of our 12 branches. T&Cs apply.", 700)],
    known=[K(1, "fact", "home city", "Dubai", "The user lives in Dubai.")])

add("external", "en", "F", [email(
    "PyLahore Conf Program Committee <program@pylahore.example>",
    "Your talk has been accepted! Congratulations, your talk 'Typing the untyped: gradual types in a 200k-line Django codebase' has been accepted for "
    "PyLahore Conf, 5–6 December. Please confirm your slot by November 15 and send a speaker bio.", 240)],
    obs=[O("fact", "conference talk", "talk accepted at PyLahore Conf", "The user's talk on gradual typing in Django was accepted at PyLahore Conf.",
           "implied", 0.7, "user", "has been accepted for PyLahore Conf")],
    plans=[P("Confirm PyLahore Conf talk slot", "2026-11-15", "Please confirm your slot", "by November 15"),
           P("PyLahore Conf (user speaking)", "2026-12-05", "PyLahore Conf, 5–6 December", "5–6 December")])

add("external", "mixed", "A", [email(
    "Ahsan Malik <ahsan.malik@mailbox.example>",
    "Shaadi card. Assalam o alaikum bhai! Meri shaadi 8 November ko hai, Lahore mein. Barat Shalimar Hall se shaam 7 baje niklegi. "
    "Zaroor aana, bhabhi aur bachon ke saath. Card attach hai.", 140)],
    known=[K(1, "fact", "family", "married, two kids", "The user is married with two kids.")],
    plans=[P("Ahsan's wedding (barat)", "2026-11-08T19:00", "Meri shaadi", "8 November ko", where="Shalimar Hall, Lahore", who=["Ahsan"])])

add("external", "ur", "B", [email(
    "Ammi <nasreen.begum@mailbox.example>",
    "Thand. Beta thand barh rahi hai, garam kapre pehna karo aur raat ko der tak mat jaga karo. Aur Khala Rubina Sunday ko lunch pe aa rahi hain, time pe aa jana.",
    100)],
    obs=[O("idea", "sleep and warmth", "wear warm clothes, don't stay up late",
           "The user's mother says the user should wear warm clothes and not stay up late.", "quoting", 0.15, "user",
           "raat ko der tak mat jaga karo")],
    plans=[P("Lunch with Khala Rubina", "2026-11-08", "Khala Rubina Sunday ko lunch pe aa rahi hain", "Sunday ko", who=["Rubina"])])

with open(OUT, "w", encoding="utf-8") as f:
    for ex in EX:
        f.write(json.dumps(ex, ensure_ascii=False) + "\n")

from collections import Counter
print(len(EX), Counter(e["task"] for e in EX), Counter(e["lang"] for e in EX), Counter(e["anchor"] for e in EX),
      sum(1 for e in EX if e["known"]))
