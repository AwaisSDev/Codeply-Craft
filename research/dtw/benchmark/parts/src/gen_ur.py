import json

OUT = "/home/user/Codeply-Craft/research/dtw/benchmark/parts/ur.jsonl"
EX = []


def chat(text, mins=2, project=None):
    e = {"source": "chat", "trust": "user", "minutes_ago": mins, "text": text}
    if project:
        e["project"] = project
    return e


def email(text, mins=30, project=None):
    e = {"source": "email", "trust": "external", "minutes_ago": mins, "text": text}
    if project:
        e["project"] = project
    return e


def heard(text, mins=10):
    return {"source": "heard", "trust": "mixed", "minutes_ago": mins, "text": text}


def O(kind, slot, value, text, cert, imp, ev, about="user", **kw):
    o = {"kind": kind, "slot": slot, "value": value, "text": text, "certainty": cert,
         "importance": imp, "about": about, "evidence": ev}
    o.update(kw)
    return o


def P(what, when, ev, tt=None, where="", who=None, **kw):
    p = {"what": what, "when": when, "where": where, "who": who or [], "evidence": ev}
    if tt:
        p["time_text"] = tt
    p.update(kw)
    return p


def K(i, kind, slot, value, text, **kw):
    m = {"id": f"m{i}", "kind": kind, "slot": slot, "value": value, "text": text}
    m.update(kw)
    return m


def add(task, lang, anchor, events, obs=(), plans=(), known=(), expect=None):
    EX.append({"task": task, "lang": lang, "anchor": anchor, "events": list(events), "known": list(known),
               "observations": list(obs), "plans": list(plans), "expect": expect or {}})


# ============================ lang "ur" (40) ============================

# preference
add("preference", "ur", "A", [chat(
    "User: chai mein cheeni nahi daalta main, doodh patti bas halki si. agar kabhi office ke liye order karo to yaad rakhna\n"
    "Assistant: Theek hai, bina cheeni ki halki doodh patti.")],
    [O("preference", "tea", "light doodh patti, no sugar", "The user drinks light doodh patti tea with no sugar.",
       "stated", 0.6, "chai mein cheeni nahi daalta main, doodh patti bas halki si")])

add("preference", "ur", "B", [chat(
    "User: bhai mujhe har cheez pe notification mat bhejo, raat 10 baje ek hi summary bhej dia karo, wohi kaafi hai\n"
    "Assistant: Theek hai, roz raat 10 baje ek summary bhejunga.")],
    [O("preference", "notification style", "one daily summary at 10pm",
       "The user wants one daily summary at 10pm instead of individual notifications.",
       "stated", 0.75, "raat 10 baje ek hi summary bhej dia karo")])

add("preference", "ur", "F", [chat(
    "User: Karachi ki flights dekho next month ke liye. aur hamesha window seat wali dekhna, aisle pe mujhe neend nahi aati\n"
    "Assistant: Theek hai, window seat ke saath options nikalta hoon.")],
    [O("preference", "flight seat", "window seat", "The user prefers a window seat on flights.",
       "stated", 0.65, "hamesha window seat wali dekhna")],
    known=[K(1, "fact", "home city", "Lahore", "The user lives in Lahore."),
           K(2, "preference", "airline", "avoids budget airlines", "The user avoids budget airlines.")])

# dislike
add("dislike", "ur", "A", [chat(
    "User: yaar koi bhi restaurant suggest karo to dhyan rakhna, mirchi wala khana mujh se nahi khaya jata, pet kharab ho jata hai\n"
    "Assistant: Samajh gaya, kam mirch wali jagah suggest karunga.")],
    [O("preference", "spicy food", "dislikes spicy food", "The user cannot eat spicy food.",
       "stated", 0.7, "mirchi wala khana mujh se nahi khaya jata")])

add("dislike", "ur", "B", [chat(
    "User: aur haan, subah 9 se pehle calls bilkul na rakhna mere saath. bachon ko school chhorne jata hoon us waqt\n"
    "Assistant: Theek hai, 9 se pehle kuch nahi.")],
    [O("preference", "call time", "no calls before 9am", "The user does not take calls before 9am.",
       "stated", 0.75, "subah 9 se pehle calls bilkul na rakhna"),
     O("routine", "school drop", "drops the kids at school in the morning",
       "The user drops the kids at school in the morning.", "stated", 0.6, "bachon ko school chhorne jata hoon")])

add("dislike", "ur", "F", [chat(
    "User: ye jo har email ke end pe 'umeed hai aap khairiyat se honge' likhte ho na, ye band karo. formal fazool baatein nahi, seedhi baat likha karo\n"
    "Assistant: Theek hai, seedha aur mukhtasar likhunga.")],
    [O("style", "email tone", "direct, no pleasantries",
       "The user wants emails written directly, without formal pleasantries.",
       "stated", 0.7, "seedhi baat likha karo")])

# fact
add("fact", "ur", "A", [chat(
    "User: main Faisalabad mein ek textile mill mein quality manager hoon, 8 saal ho gaye isi kaam mein. to report thori technical bhi chalegi\n"
    "Assistant: Acha, phir main technical terms rakh leta hoon.")],
    [O("fact", "job", "quality manager at a textile mill",
       "The user is a quality manager at a textile mill, with 8 years in the role.",
       "stated", 0.85, "textile mill mein quality manager hoon"),
     O("fact", "work city", "Faisalabad", "The user works in Faisalabad.", "stated", 0.7, "main Faisalabad mein")])

add("fact", "ur", "D", [chat(
    "User: ek baat note kar lo, mujhe penicillin se allergy hai. kabhi doctor ka appointment book karo to form mein likh dena\n"
    "Assistant: Note kar liya, penicillin allergy.")],
    [O("fact", "allergy", "penicillin", "The user is allergic to penicillin.", "stated", 0.9,
       "penicillin se allergy hai")])

# person
add("person", "ur", "A", [chat(
    "User: meri behen Saima doctor hai Al-Noor Hospital mein, uski duty aksar raat ki hoti hai, isliye usko call shaam ko hi karta hoon\n"
    "Assistant: Acha, samajh gaya.")],
    [O("fact", "saima", "sister, doctor at Al-Noor Hospital, often night shifts",
       "Saima, the user's sister, is a doctor at Al-Noor Hospital and often works night shifts.",
       "stated", 0.7, "meri behen Saima doctor hai Al-Noor Hospital mein", about="person"),
     O("routine", "calling saima", "calls Saima in the evening", "The user calls Saima in the evening.",
       "stated", 0.45, "usko call shaam ko hi karta hoon")])

add("person", "ur", "F", [chat(
    "User: Faisal mera business partner hai, accounts sab wohi dekhta hai. koi bhi invoice ka sawal ho to usko cc kar dena\n"
    "Assistant: Theek hai, invoice wali emails mein Faisal ko cc karunga.")],
    [O("fact", "faisal", "business partner, handles accounts",
       "Faisal, the user's business partner, handles all the accounts.",
       "stated", 0.75, "Faisal mera business partner hai", about="person"),
     O("preference", "invoice emails", "cc Faisal on invoice questions",
       "The user wants Faisal cc'd on any invoice questions.", "stated", 0.65, "usko cc kar dena")])

add("person", "ur", "E", [chat(
    "User: abbu ki sugar high rehti hai aaj kal, unke liye koi sugar free mithai bata do jo Dubai se Pakistan bhej sakoon\n"
    "Assistant: Kuch options hain: ...")],
    [O("fact", "abbu", "has high blood sugar", "The user's father has high blood sugar.", "stated", 0.6,
       "abbu ki sugar high rehti hai", about="person")],
    known=[K(1, "fact", "home city", "Dubai", "The user lives in Dubai."),
           K(2, "fact", "job", "accountant", "The user is an accountant.")])

# decision
add("decision", "ur", "A", [chat(
    "User: theek hai final kar do, dukaan-app ka payment JazzCash se hi hoga. Easypaisa baad mein dekhenge shayad\n"
    "Assistant: Done, pehle JazzCash integrate karta hoon.", project="dukaan-app")],
    [O("decision", "payments", "JazzCash", "The dukaan-app project will take payments through JazzCash.",
       "stated", 0.85, "payment JazzCash se hi hoga", about="project", project="dukaan-app"),
     O("idea", "second payment option", "Easypaisa later", "Easypaisa might be added to dukaan-app later.",
       "hypothetical", 0.2, "Easypaisa baad mein dekhenge shayad", about="project", project="dukaan-app")])

add("decision", "ur", "B", [chat(
    "User: bhai behen ki shaadi ka venue kaunsa lein, Gulmohar Hall ya Marquee 21?\n"
    "Assistant: Dono ke rates bata dein to compare kar deta hoon.\n"
    "User: rehne do, ammi ne Marquee 21 pe haan kar di hai, wohi final hai\n"
    "Assistant: Acha, Marquee 21 final.")],
    [O("decision", "wedding venue", "Marquee 21", "Marquee 21 is the final venue for the user's sister's wedding.",
       "stated", 0.7, "Marquee 21 pe haan kar di hai")])

# todo
add("todo", "ur", "F", [chat(
    "User: yaar mujhe yaad karwana ke gaari ka token tax jama karwana hai, 2 saal se pending hai lol\n"
    "Assistant: Theek hai, reminder laga diya.")],
    [O("todo", "car token tax", "pay the car token tax", "The user needs to pay the car's token tax.",
       "stated", 0.6, "gaari ka token tax jama karwana hai")])

add("todo", "ur", "B", [chat(
    "User: Ahmed bhai se 20 hazaar wapas lene hain, bhool na jaun. aur dhobi se kapre bhi uthane hain\n"
    "Assistant: Dono note kar liye.")],
    [O("todo", "money from ahmed", "collect 20,000 back from Ahmed", "The user needs to collect 20,000 back from Ahmed.",
       "stated", 0.6, "Ahmed bhai se 20 hazaar wapas lene hain"),
     O("todo", "laundry", "pick up clothes from the dhobi", "The user needs to pick up clothes from the dhobi.",
       "stated", 0.4, "dhobi se kapre bhi uthane hain")])

add("todo", "ur", "B", [chat(
    "User: zaroori: hisaab-kitab ka privacy policy page abhi tak nahi bana, Play Store wale reject kar denge. isko list mein daal do\n"
    "Assistant: List mein daal diya.", project="hisaab-kitab")],
    [O("todo", "privacy policy page", "create the privacy policy page",
       "The hisaab-kitab project still needs a privacy policy page before Play Store review.",
       "stated", 0.7, "privacy policy page abhi tak nahi bana", about="project", project="hisaab-kitab")])

# routine
add("routine", "ur", "A", [chat(
    "User: fajr ke baad main roz 40 minute walk karta hoon park mein, us waqt koi kaam mat daalna\n"
    "Assistant: Theek hai, subah walk ka time free rahega.")],
    [O("routine", "morning walk", "40-minute walk after Fajr daily",
       "The user walks for 40 minutes in the park every day after Fajr.",
       "stated", 0.65, "fajr ke baad main roz 40 minute walk karta hoon")],
    known=[K(1, "preference", "reply length", "short", "The user prefers short replies.")])

add("routine", "ur", "F", [chat(
    "User: har jumeraat ko maghrib ke baad hum sab nani ke ghar jaate hain, us din raat ka koi plan na banana\n"
    "Assistant: Theek hai, jumeraat raat free rakhunga.")],
    [O("routine", "thursday nani visit", "visits grandmother every Thursday after Maghrib",
       "Every Thursday after Maghrib the user's family visits the user's grandmother.",
       "stated", 0.7, "har jumeraat ko maghrib ke baad hum sab nani ke ghar jaate hain")])

add("routine", "ur", "B", [chat(
    "User: Ramzan mein to har saal aakhri 10 din itikaf baithta hoon, us waqt laptop bhi band. abhi se bata raha hoon taake client ko pata ho\n"
    "Assistant: Note kar liya.")],
    [O("routine", "itikaf", "itikaf in the last 10 days of Ramzan every year",
       "The user does itikaf in the last 10 days of Ramzan every year and is offline then.",
       "stated", 0.65, "har saal aakhri 10 din itikaf baithta hoon")],
    known=[K(1, "routine", "jummah", "leaves early on Fridays for Jummah", "The user leaves early on Fridays for Jummah prayer.")])

# temporary
add("temporary", "ur", "A", [chat(
    "User: aaj roza hai mera, to lunch meeting wali baat rehne do. iftar ke baad baat karte hain\n"
    "Assistant: Theek hai, iftar ke baad.")],
    [O("context", "fasting", "fasting today", "The user is fasting today.", "temporary", 0.5,
       "roza hai mera", until="23:59", time_text="aaj")])

add("temporary", "ur", "F", [chat(
    "User: sir mein shadeed dard hai, aaj ghar se kaam kar raha hoon. kal tak theek ho jaunga inshallah\n"
    "Assistant: Apna khayal rakhein.")],
    [O("context", "working from home", "working from home with a headache",
       "The user has a bad headache and is working from home today.", "temporary", 0.5,
       "ghar se kaam kar raha hoon", until="23:59", time_text="aaj")])

add("temporary", "ur", "F", [chat(
    "User: is hafte main Islamabad mein hoon training ke liye, Lahore office wale kaam agle peer se dekhenge\n"
    "Assistant: Theek hai, Lahore wale kaam agle hafte.")],
    [O("context", "location", "in Islamabad for training", "The user is in Islamabad for training this week.",
       "temporary", 0.55, "Islamabad mein hoon training ke liye", until="2026-11-15T23:59", time_text="is hafte")])

# plan
add("plan", "ur", "A", [chat(
    "User: kal 3 baje dentist ka appointment hai Johar Town mein, aur parson Saima ki mehndi hai raat ko\n"
    "Assistant: Dono calendar mein daal diye.")],
    plans=[P("Dentist appointment", "2026-10-30T15:00", "dentist ka appointment", "kal 3 baje", where="Johar Town"),
           P("Saima's mehndi", "2026-10-31", "Saima ki mehndi", "parson", who=["Saima"])])

add("plan", "ur", "B", [chat(
    "User: kal raat cousin ki barat thi, 3 baje ghar pohncha 😴 aur peer ko 11 baje client ke saath call hai, wo yaad rakhna\n"
    "Assistant: Peer 11 baje ki call note kar li.")],
    plans=[P("Call with client", "2026-11-09T11:00", "client ke saath call", "peer ko 11 baje")])

add("plan", "ur", "F", [chat(
    "User: jummah ko namaz ke baad bank jana hai cheque clear karwane, aur hafta ko family ke saath Murree nikal rahe hain 2 din ke liye\n"
    "Assistant: Theek hai, dono note kar liye.")],
    plans=[P("Bank visit to clear a cheque", "2026-11-13", "bank jana hai cheque clear karwane", "jummah ko"),
           P("Family trip to Murree", "2026-11-14", "Murree nikal rahe hain", "hafta ko", where="Murree")])

# joking
add("joking", "ur", "A", [chat(
    "User: haan bilkul, mujhe to traffic bohat pasand hai, roz Canal Road pe 1 ghanta khara rehna meri hobby hai 🙃 koi aur rasta batao office ka\n"
    "Assistant: Jail Road try karein, subah thora kam rush hota hai.")],
    [O("preference", "traffic", "loves traffic", "The user loves traffic.", "joking", 0.1,
       "mujhe to traffic bohat pasand hai"),
     O("preference", "hobby", "standing in traffic", "The user's hobby is standing in traffic on Canal Road.", "joking", 0.1,
       "meri hobby hai")])

add("joking", "ur", "B", [chat(
    "User: bas yaar, ab main naukri chhor ke pakoron ki rehri lagaunga, wohi zyada kamati hai 😂 waise ye report kal tak bhejni hai\n"
    "Assistant: Haha. Theek hai, report wala reminder laga diya.")],
    [O("fact", "career", "quitting job to sell pakoras", "The user is quitting their job to sell pakoras.",
       "joking", 0.1, "naukri chhor ke pakoron ki rehri lagaunga")],
    plans=[P("Send the report", "2026-11-07", "report kal tak bhejni hai", "kal tak")])

add("joking", "ur", "C", [chat(
    "User: Usman ne phir se biryani mein aloo daal diye, isko to jail honi chahiye 😤😂\n"
    "Assistant: Haha, aloo wali biryani ka debate kabhi khatam nahi hoga.")],
    [O("preference", "biryani", "no potatoes in biryani", "The user does not like potatoes in biryani.",
       "implied", 0.45, "phir se biryani mein aloo daal diye"),
     O("fact", "usman", "should go to jail", "Usman should go to jail.", "joking", 0.1,
       "isko to jail honi chahiye", about="person")])

# hypothetical
add("hypothetical", "ur", "A", [chat(
    "User: agar ye job mil gayi to Karachi shift ho jaunga, phir ammi ko bhi saath le jaunga\n"
    "Assistant: Inshallah, best of luck!")],
    [O("fact", "relocation", "Karachi if the job comes through", "The user might move to Karachi if they get the job.",
       "hypothetical", 0.2, "Karachi shift ho jaunga")],
    known=[K(1, "fact", "home city", "Lahore", "The user lives in Lahore."),
           K(2, "fact", "job", "bank officer", "The user is a bank officer.")])

add("hypothetical", "ur", "F", [chat(
    "User: soch raha hoon apni City bech ke Corolla le loon, kya khayal hai? abhi pakka nahi\n"
    "Assistant: Resale dono ki achi hai, budget pe depend karta hai.")],
    [O("fact", "car", "Honda City", "The user owns a Honda City.", "implied", 0.5, "apni City"),
     O("decision", "car change", "sell City, buy Corolla", "The user is thinking of selling the City for a Corolla.",
       "hypothetical", 0.2, "City bech ke Corolla le loon")])

add("hypothetical", "ur", "B", [chat(
    "User: kaash main bhi is saal Hajj pe ja sakta, Allah bulaye to\n"
    "Assistant: Ameen, Allah asaani kare.")],
    [O("fact", "hajj", "wishes to perform Hajj", "The user wishes to go for Hajj this year.",
       "hypothetical", 0.25, "kaash main bhi is saal Hajj pe ja sakta")])

# quoting
add("quoting", "ur", "C", [chat(
    "User: ammi kehti hain raat ko dahi nahi khani chahiye, gala kharab hota hai. pata nahi sach hai ya nahi\n"
    "Assistant: Ye zyada tar purani kahawat hai, koi khaas saboot nahi.")],
    [O("preference", "yogurt at night", "avoid yogurt at night",
       "The user's mother says one should not eat yogurt at night.", "quoting", 0.15,
       "raat ko dahi nahi khani chahiye", about="person")])

add("quoting", "ur", "F", [chat(
    "User: mere manager ka kehna hai ke saari team ko roz office aana chahiye, mera to khayal hai hybrid behtar hai, 2 din office kaafi hain\n"
    "Assistant: Dono taraf ke points hain.")],
    [O("requirement", "office attendance", "everyone in the office daily",
       "The user's manager thinks the whole team should come to the office daily.", "quoting", 0.2,
       "saari team ko roz office aana chahiye", about="person"),
     O("preference", "work mode", "hybrid, 2 office days", "The user prefers hybrid work with 2 office days.",
       "stated", 0.6, "hybrid behtar hai, 2 din office kaafi hain")])

add("quoting", "ur", "B", [chat(
    "User: Bilal bhai bolte hain abhi crypto mein paisa lagao, 3 mahine mein double. main nahi lagane wala yaar, mujhe ye sab jua lagta hai\n"
    "Assistant: Ehtiyat behtar hai.")],
    [O("idea", "crypto investment", "invest in crypto now", "Bilal says to invest in crypto now and double it in 3 months.",
       "quoting", 0.15, "abhi crypto mein paisa lagao", about="person"),
     O("preference", "crypto", "won't invest, sees it as gambling", "The user does not want to invest in crypto; it feels like gambling.",
       "stated", 0.5, "main nahi lagane wala yaar")])

# duplicate
add("duplicate", "ur", "A", [chat(
    "User: phir se keh raha hoon, choti replies do yaar, itna lamba mat likho, phone pe parhta hoon\n"
    "Assistant: Maafi, choti rakhunga.")],
    [O("preference", "reply length", "short", "The user prefers short replies.", "stated", 0.8,
       "choti replies do yaar", merge={"target": "m1", "relation": "same"})],
    known=[K(1, "preference", "reply length", "short", "The user prefers short replies."),
           K(2, "fact", "home city", "Lahore", "The user lives in Lahore.")])

add("duplicate", "ur", "F", [chat(
    "User: jumma ko 1 baje ke baad kuch mat rakhna, namaz ke liye nikal jata hoon jaise tumhe pata hai\n"
    "Assistant: Ji, yaad hai.")],
    [O("preference", "friday schedule", "nothing after 1pm on Fridays", "The user wants nothing scheduled after 1pm on Fridays.",
       "stated", 0.75, "jumma ko 1 baje ke baad kuch mat rakhna", merge={"target": "m2", "relation": "same"}),
     O("routine", "jummah", "leaves early on Fridays for Jummah", "The user leaves early on Fridays for Jummah prayer.",
       "stated", 0.7, "namaz ke liye nikal jata hoon", merge={"target": "m1", "relation": "same"})],
    known=[K(1, "routine", "jummah", "leaves early on Fridays for Jummah", "The user leaves early on Fridays for Jummah prayer."),
           K(2, "preference", "friday schedule", "nothing after 1pm on Fridays", "The user wants nothing scheduled after 1pm on Fridays."),
           K(3, "fact", "allergy", "penicillin", "The user is allergic to penicillin.")])

# contradiction
add("contradiction", "ur", "B", [chat(
    "User: ab hum Islamabad shift ho gaye hain, pichle mahine. to ab restaurants wagera wahan ke batana\n"
    "Assistant: Mubarak ho! Theek hai, Islamabad ke options dunga.")],
    [O("fact", "home city", "Islamabad", "The user moved to Islamabad last month.", "stated", 0.85,
       "ab hum Islamabad shift ho gaye hain", merge={"target": "m1", "relation": "different"})],
    known=[K(1, "fact", "home city", "Lahore", "The user lives in Lahore."),
           K(2, "preference", "spicy food", "dislikes spicy food", "The user cannot eat spicy food.")])

add("contradiction", "ur", "F", [chat(
    "User: chai chhor di hai maine, doctor ne mana kiya hai. ab sirf green tea\n"
    "Assistant: Acha, sehat pehle.")],
    [O("preference", "drink", "green tea only", "The user has given up regular tea and now drinks only green tea.",
       "stated", 0.75, "ab sirf green tea", merge={"target": "m1", "relation": "different"})],
    known=[K(1, "preference", "drink", "doodh patti chai", "The user drinks doodh patti chai."),
           K(2, "routine", "morning walk", "40-minute walk after Fajr daily", "The user walks for 40 minutes every day after Fajr.")])

# noise
add("noise", "ur", "A", [chat(
    "User: bhai ye error kyun aa raha hai 'undefined is not a function' samajh nahi aa rahi\n"
    "Assistant: Shayad aap kisi aise object pe method call kar rahe hain jo exist nahi karta.")])

add("noise", "ur", "A", [chat(
    "User: aaj kaunsa din hai, jumeraat ya juma? dimagh kaam nahi kar raha 😵\n"
    "Assistant: Aaj jumeraat hai, 29 October.")])

# ============================ lang "mixed" (35) ============================

add("preference", "mixed", "A", [chat(
    "User: bhai please code reviews mein comments English mein hi likhna, baaki chat Urdu mein theek hai\n"
    "Assistant: Done, reviews English mein, chat Urdu mein.")],
    [O("preference", "code review language", "English for code review comments",
       "The user wants code review comments in English; chat can be in Urdu.",
       "stated", 0.75, "code reviews mein comments English mein hi likhna")],
    known=[K(1, "fact", "job", "backend developer", "The user is a backend developer.")])

add("preference", "mixed", "F", [chat(
    "User: yaar mujhe dark mode default chahiye har project mein, light theme se aankhein dukhti hain\n"
    "Assistant: Noted, dark mode default rakhunga.")],
    [O("preference", "theme", "dark mode by default", "The user wants dark mode by default in every project.",
       "stated", 0.7, "dark mode default chahiye har project mein")])

add("dislike", "mixed", "B", [chat(
    "User: mujhe ye ORM wagera pasand nahi, raw SQL likhna prefer karta hoon, zyada control hota hai\n"
    "Assistant: Theek hai, queries raw SQL mein likhunga.")],
    [O("preference", "database access", "raw SQL, no ORMs", "The user prefers raw SQL over ORMs.",
       "stated", 0.75, "raw SQL likhna prefer karta hoon")])

add("dislike", "mixed", "C", [chat(
    "User: honestly mujhe WhatsApp groups se allergy hai 😩 koi bhi update ho email kar do, groups mein add mat karna please\n"
    "Assistant: Samajh gaya, sirf email.")],
    [O("preference", "communication channel", "email, not WhatsApp groups",
       "The user wants updates by email and does not want to be added to WhatsApp groups.",
       "stated", 0.7, "koi bhi update ho email kar do")])

add("fact", "mixed", "A", [chat(
    "User: btw main freelance Flutter developer hoon, mostly Gulf ke clients hain, Upwork se kaam milta hai\n"
    "Assistant: Nice, phir proposals ke liye help kar sakta hoon.")],
    [O("fact", "job", "freelance Flutter developer", "The user is a freelance Flutter developer.",
       "stated", 0.85, "freelance Flutter developer"),
     O("fact", "clients", "mostly Gulf clients via Upwork", "The user's clients are mostly from the Gulf, found via Upwork.",
       "stated", 0.6, "mostly Gulf ke clients hain")],
    known=[K(1, "preference", "reply length", "short", "The user prefers short replies.")])

add("fact", "mixed", "E", [chat(
    "User: main Dubai mein 6 saal se hoon, visa company sponsor karti hai. agla renewal March mein hai, so passport tab tak valid hona chahiye\n"
    "Assistant: Theek hai, passport expiry check kar lein.")],
    [O("fact", "residence", "in Dubai for 6 years", "The user has lived in Dubai for 6 years.",
       "stated", 0.8, "Dubai mein 6 saal se hoon"),
     O("fact", "visa renewal", "company-sponsored visa, renewal in March",
       "The user's company-sponsored visa is up for renewal in March.", "stated", 0.6, "agla renewal March mein hai")])

add("person", "mixed", "F", [chat(
    "User: meri wife Mehreen ka birthday 18 November ko hai, usko surprise dena hai, koi idea? she loves books aur chai\n"
    "Assistant: Ek book cafe ka plan kaisa rahega?")],
    [O("fact", "mehreen", "wife, birthday 18 November, loves books and chai",
       "Mehreen, the user's wife, has her birthday on 18 November and loves books and chai.",
       "stated", 0.85, "meri wife Mehreen ka birthday 18 November ko hai", about="person"),
     O("todo", "mehreen birthday surprise", "plan a birthday surprise for Mehreen",
       "The user wants to plan a birthday surprise for Mehreen.", "stated", 0.55, "usko surprise dena hai")])

add("person", "mixed", "B", [chat(
    "User: Hamza ko onboard karna hai next week, wo naya backend dev hai team mein\n"
    "Assistant: Kis cheez se start karwaun?\n"
    "User: Node aur Postgres aata hai usay, bas humara deploy pipeline samjha do. aur haan wo remote hai, Peshawar se\n"
    "Assistant: Theek hai, ek onboarding doc bana deta hoon.")],
    [O("fact", "hamza", "new remote backend dev from Peshawar, knows Node and Postgres",
       "Hamza is a new remote backend developer on the user's team, based in Peshawar, who knows Node and Postgres.",
       "stated", 0.7, "wo naya backend dev hai team mein", about="person"),
     O("todo", "hamza onboarding", "onboard Hamza next week", "The user needs to onboard Hamza next week.",
       "stated", 0.55, "Hamza ko onboard karna hai next week")])

add("decision", "mixed", "A", [chat(
    "User: theek hai, pharmacy-pos ki state management Zustand pe karte hain, Redux mein bohat boilerplate hai. final\n"
    "Assistant: Done, Zustand setup kar deta hoon.", project="pharmacy-pos")],
    [O("decision", "state management", "Zustand", "The pharmacy-pos project uses Zustand for state management (not Redux).",
       "stated", 0.85, "state management Zustand pe karte hain", about="project", project="pharmacy-pos")],
    known=[K(1, "decision", "database", "SQLite", "The pharmacy-pos project uses SQLite.", project="pharmacy-pos")])

add("contradiction", "mixed", "F", [chat(
    "User: Stripe Pakistan mein available hi nahi yaar, so bazaar-app pe Safepay use karenge. decision lock\n"
    "Assistant: Theek hai, Safepay integrate karta hoon.", project="bazaar-app")],
    [O("decision", "payments", "Safepay", "The bazaar-app project will use Safepay for payments instead of Stripe.",
       "stated", 0.85, "bazaar-app pe Safepay use karenge", about="project", project="bazaar-app",
       merge={"target": "m1", "relation": "different"})],
    known=[K(1, "decision", "payments", "Stripe", "The bazaar-app project uses Stripe for payments.", project="bazaar-app"),
           K(2, "preference", "reply length", "short", "The user prefers short replies.")])

add("decision", "mixed", "C", [chat(
    "User: socha bohat, ab decide kar liya hai: PhD nahi karunga, industry job hi lunga UK mein. supervisor ko next week bata dunga\n"
    "Assistant: Acha decision, CV update karne mein help chahiye?")],
    [O("decision", "career path", "industry job in the UK, no PhD", "The user decided against a PhD and will take an industry job in the UK.",
       "stated", 0.85, "PhD nahi karunga, industry job hi lunga UK mein")])

add("todo", "mixed", "B", [chat(
    "User: mujhe reminder chahiye CNIC renew karwani hai, last month expire ho gayi. NADRA jana parega kisi din\n"
    "Assistant: Note kar liya.")],
    [O("todo", "cnic renewal", "renew the expired CNIC at NADRA", "The user needs to renew their expired CNIC at NADRA.",
       "stated", 0.65, "CNIC renew karwani hai")])

add("todo", "mixed", "D", [chat(
    "User: before I forget — khata-app ke release notes likhne hain aur App Store screenshots bhi update karne hain, dono pending\n"
    "Assistant: Dono todo mein daal diye.", project="khata-app")],
    [O("todo", "release notes", "write the release notes", "The khata-app release notes need to be written.",
       "stated", 0.6, "release notes likhne hain", about="project", project="khata-app"),
     O("todo", "app store screenshots", "update the App Store screenshots", "The khata-app App Store screenshots need updating.",
       "stated", 0.55, "App Store screenshots bhi update karne hain", about="project", project="khata-app")])

add("routine", "mixed", "A", [chat(
    "User: main roz raat 11 se 1 baje tak side project pe kaam karta hoon, us time koi notification nahi please\n"
    "Assistant: Theek hai, 11 se 1 quiet hours.")],
    [O("routine", "side project hours", "works on a side project 11pm-1am nightly",
       "The user works on a side project every night from 11pm to 1am.", "stated", 0.6,
       "roz raat 11 se 1 baje tak side project pe kaam karta hoon"),
     O("preference", "quiet hours", "no notifications 11pm-1am", "The user wants no notifications from 11pm to 1am.",
       "stated", 0.7, "us time koi notification nahi please")],
    known=[K(1, "fact", "job", "freelance Flutter developer", "The user is a freelance Flutter developer."),
           K(2, "preference", "notification style", "one daily summary at 10pm", "The user wants one daily summary at 10pm.")])

add("routine", "mixed", "E", [chat(
    "User: weekdays pe Zuhr office ke prayer room mein parhta hoon, 1:15 se 1:35, uss time pe meetings mat dalna please\n"
    "Assistant: Done, calendar pe block kar diya.")],
    [O("routine", "zuhr prayer", "prays Zuhr at the office 1:15-1:35pm on weekdays",
       "The user prays Zuhr in the office prayer room from 1:15 to 1:35pm on weekdays.", "stated", 0.7,
       "Zuhr office ke prayer room mein parhta hoon"),
     O("preference", "meeting time", "no meetings 1:15-1:35pm on weekdays",
       "The user wants no meetings from 1:15 to 1:35pm on weekdays.", "stated", 0.7,
       "uss time pe meetings mat dalna please")])

add("temporary", "mixed", "F", [chat(
    "User: aaj area mein light nahi hai, UPS pe chal raha hoon shaam 6 tak shayad. heavy builds mat chalwana abhi\n"
    "Assistant: Theek hai, builds rok deta hoon.")],
    [O("context", "power outage", "no electricity, running on UPS", "The user has no electricity and is running on a UPS.",
       "temporary", 0.5, "UPS pe chal raha hoon", until="18:00", time_text="shaam 6 tak")])

add("temporary", "mixed", "B", [chat(
    "User: yaar fever ho gaya hai, is hafte ab main offline hoon. koi urgent ho to Danish ko bol dena\n"
    "Assistant: Get well soon! Urgent cheezein Danish ko forward kar dunga.")],
    [O("context", "health", "has a fever, offline", "The user has a fever and is offline.", "temporary", 0.55,
       "fever ho gaya hai", until="2026-11-08T23:59", time_text="is hafte")])

add("temporary", "mixed", "C", [chat(
    "User: aaj bachon ke saath park mein hoon, phone silent pe hai 4 baje tak. kuch urgent ho to email kar dena\n"
    "Assistant: Theek hai, enjoy!")],
    [O("context", "availability", "out with the kids, phone on silent",
       "The user is out at the park with the kids and their phone is on silent.", "temporary", 0.5,
       "phone silent pe hai", until="16:00", time_text="4 baje tak")],
    known=[K(1, "fact", "home city", "London", "The user lives in London.")])

add("plan", "mixed", "A", [chat(
    "User: kal ki meeting confirm hai na Zubair ke saath?\n"
    "Assistant: Haan, kal 11 baje.\n"
    "User: nahi yaar, 3 baje kar do, subah mera dentist hai\n"
    "Assistant: Theek hai, kal 3 baje Zubair ke saath, aur subah dentist.")],
    plans=[P("Meeting with Zubair", "2026-10-30T15:00", "meeting confirm hai na Zubair ke saath", "3 baje kar do", who=["Zubair"]),
           P("Dentist", "2026-10-30", "subah mera dentist hai", "subah", time_n=1)],
    known=[K(1, "preference", "meeting time", "afternoons", "The user prefers meetings in the afternoon.")])

add("plan", "mixed", "F", [chat(
    "User: Mangal ko subah 7 baje Lahore se Karachi ki flight hai, aur Budh ko 2pm client demo hai Clifton office mein. dono calendar pe daal do\n"
    "Assistant: Done.")],
    plans=[P("Flight Lahore to Karachi", "2026-11-10T07:00", "Lahore se Karachi ki flight", "Mangal ko subah 7 baje", where="Lahore"),
           P("Client demo", "2026-11-11T14:00", "client demo", "Budh ko 2pm", where="Clifton office")])

add("plan", "mixed", "E", [chat(
    "User: Itwar raat 9 baje Ammar ki birthday dinner hai Lahori Darbar mein, 6 logon ka table book kar do please\n"
    "Assistant: Done, Sunday 9pm, 6 log.")],
    plans=[P("Ammar's birthday dinner", "2026-11-22T21:00", "Ammar ki birthday dinner", "Itwar raat 9 baje",
             where="Lahori Darbar", who=["Ammar"])])

add("joking", "mixed", "A", [chat(
    "User: haan haan, load shedding to blessing hai, laptop ki battery ki exercise ho jati hai 🙃 anyway ye file save kar lo cloud pe\n"
    "Assistant: Saved to Drive.")],
    [O("preference", "load shedding", "likes load shedding", "The user likes load shedding.", "joking", 0.1,
       "load shedding to blessing hai")],
    known=[K(1, "fact", "home city", "Karachi", "The user lives in Karachi.")])

add("joking", "mixed", "F", [chat(
    "User: mera next career move: full time PUBG player 😂 office ka kaam to waise bhi koi nahi dekhta. anyway ye PR merge kar do\n"
    "Assistant: Merged.")],
    [O("fact", "career", "full-time PUBG player", "The user is becoming a full-time PUBG player.", "joking", 0.1,
       "full time PUBG player")])

add("joking", "mixed", "C", [chat(
    "User: biwi ne kaha aaj khana tum banao, so dinner mein Maggi hai. 5-star chef hoon main basically 😎\n"
    "Assistant: Haha, enjoy the gourmet Maggi.")],
    [O("fact", "cooking skill", "5-star chef", "The user is a 5-star chef.", "joking", 0.1, "5-star chef hoon main")],
    known=[K(1, "fact", "home city", "London", "The user lives in London."),
           K(2, "fact", "sana", "user's wife, works in a bank", "Sana, the user's wife, works in a bank.")])

add("hypothetical", "mixed", "B", [chat(
    "User: agar next year promotion mil gaya to Civic le lunga, warna yahi Mehran zindabad 😅\n"
    "Assistant: Inshallah!")],
    [O("decision", "car purchase", "Civic if promoted", "The user might buy a Civic if promoted next year.",
       "hypothetical", 0.2, "Civic le lunga"),
     O("fact", "car", "Suzuki Mehran", "The user drives a Mehran.", "implied", 0.45, "yahi Mehran zindabad")])

add("hypothetical", "mixed", "D", [chat(
    "User: ledger-api ko Rust mein rewrite karein? pata nahi, abhi sirf idea hai, team se baat nahi ki\n"
    "Assistant: Pehle bottlenecks profile kar lein.", project="ledger-api")],
    [O("decision", "backend language", "Rust", "The user is considering rewriting ledger-api in Rust.",
       "hypothetical", 0.2, "Rust mein rewrite karein?", about="project", project="ledger-api")])

add("quoting", "mixed", "A", [chat(
    "User: Abbu ka kehna hai government job hi safe hai, private mein koi future nahi. I mean, main to startup mein hi khush hoon\n"
    "Assistant: Dono ke apne pros hain.")],
    [O("preference", "job type", "government job is safest", "The user's father thinks a government job is the only safe option.",
       "quoting", 0.15, "government job hi safe hai", about="person"),
     O("fact", "workplace", "works at a startup, happy there", "The user works at a startup and is happy there.",
       "stated", 0.6, "main to startup mein hi khush hoon")],
    known=[K(1, "fact", "abbu", "retired government officer", "The user's father is a retired government officer.", )])

add("quoting", "mixed", "E", [chat(
    "User: Ali bhai keh rahe the ke Next.js ab overkill hai small sites ke liye, Astro use karo. mujhe abhi tak convince nahi hua\n"
    "Assistant: Use case pe depend karta hai.")],
    [O("decision", "framework", "Astro over Next.js for small sites", "Ali thinks Astro is better than Next.js for small sites.",
       "quoting", 0.15, "Astro use karo", about="person")])

add("duplicate", "mixed", "F", [chat(
    "User: yaar 9:30 wali standup phir se lag gayi calendar pe 😩 maine bola tha na 11 se pehle meetings nahi, please move it\n"
    "Assistant: Sorry, 11:30 pe move kar di.")],
    [O("preference", "meeting time", "no meetings before 11am", "The user does not take meetings before 11am.",
       "stated", 0.8, "11 se pehle meetings nahi", merge={"target": "m1", "relation": "same"})],
    known=[K(1, "preference", "meeting time", "no meetings before 11am", "The user does not take meetings before 11am."),
           K(2, "preference", "theme", "dark mode by default", "The user wants dark mode by default.")])

add("duplicate", "mixed", "B", [chat(
    "User: cart ke liye Redux add kar doon?\n"
    "Assistant: Aapne pehle pharmacy-pos ke liye Zustand final kiya tha.\n"
    "User: haan haan right, Zustand hi rahega, bas bhool gaya tha 😅\n"
    "Assistant: Theek hai, cart store Zustand mein bana deta hoon.", project="pharmacy-pos")],
    [O("decision", "state management", "Zustand", "The pharmacy-pos project uses Zustand for state management.",
       "stated", 0.85, "Zustand hi rahega", about="project", project="pharmacy-pos",
       merge={"target": "m1", "relation": "same"})],
    known=[K(1, "decision", "state management", "Zustand", "The pharmacy-pos project uses Zustand for state management.",
             project="pharmacy-pos"),
           K(2, "routine", "zuhr prayer", "prays Zuhr at 1:15pm", "The user prays Zuhr at 1:15pm.")])

add("contradiction", "mixed", "A", [chat(
    "User: update: Techverse chhor di finally, ab Nexlify mein Senior SDET join kar liya hai. pehla hafta tha, so far so good\n"
    "Assistant: Congrats!")],
    [O("fact", "job", "Senior SDET at Nexlify", "The user now works as a Senior SDET at Nexlify (left Techverse).",
       "stated", 0.85, "Nexlify mein Senior SDET join kar liya hai", merge={"target": "m1", "relation": "different"})],
    known=[K(1, "fact", "job", "QA engineer at Techverse", "The user is a QA engineer at Techverse."),
           K(2, "preference", "reply length", "short", "The user prefers short replies.")])

add("external", "mixed", "F", [email(
    "Email the user received (from Tariq Builders <info@tariqbuilders.example>): Plot possession - Block C. "
    "Assalam o alaikum, aap ke plot ki possession 15 November ko subah 10 baje site office pe di jayegi. "
    "Original allotment letter aur CNIC copy saath laayein. Shukriya.")],
    [O("fact", "plot", "plot in Block C with Tariq Builders", "The user owns a plot in Block C with Tariq Builders.",
       "implied", 0.55, "aap ke plot ki possession")],
    plans=[P("Plot possession handover", "2026-11-15T10:00", "plot ki possession", "15 November ko subah 10 baje",
             where="site office")])

add("noise", "mixed", "B", [chat(
    "User: python mein list ko reverse kaise karte hain bina slicing ke?\n"
    "Assistant: list.reverse() ya reversed() use karein.")])

add("heard", "mixed", "A", [heard(
    "Heard around the user: Kashif: yaar kal wali meeting mein decide hua ke office next month Gulberg se DHA shift hoga. "
    "Nida: acha? chalo parking ka masla to khatam")],
    [O("decision", "office location", "moving from Gulberg to DHA next month",
       "The office is moving from Gulberg to DHA next month.", "implied", 0.6,
       "office next month Gulberg se DHA shift hoga")])

add("secret", "mixed", "D", [chat(
    "User: server ka root password Karachi#2291 hai, isko .env mein daal do. aur haan staging hamesha Hetzner pe hi rahega, AWS bohat mehnga hai\n"
    "Assistant: .env update kar di.", project="rozgar-portal")],
    [O("decision", "staging hosting", "Hetzner", "The rozgar-portal staging environment stays on Hetzner (AWS is too expensive).",
       "stated", 0.8, "staging hamesha Hetzner pe hi rahega", about="project", project="rozgar-portal")],
    expect={"secrets": ["Karachi#2291"]})

for i, ex in enumerate(EX, 1):
    ex["id"] = f"b-ur-{i:03d}"
with open(OUT, "w", encoding="utf-8") as f:
    for ex in EX:
        ex = {"id": ex["id"], **{k: v for k, v in ex.items() if k != "id"}}
        f.write(json.dumps(ex, ensure_ascii=False) + "\n")
print(len(EX))
