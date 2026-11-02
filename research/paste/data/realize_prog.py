"""Programmatic realizer: beats -> tagged text, from template families (DATASET-DESIGN.md §6).

Every template list is split into families A/B/C by position (i mod 3). Train and val draw from A and B only;
test and stress draw from all three, so family C measures generalisation to unseen phrasings.
Tags: [[u0|value]] units, [[m0|mention]] mentions, [[u1+m0|text]] a span that is both.
"""
import random
import re

from data import ontology as O

FAM = {"train": "AB", "pilot": "AB", "val": "AB", "test": "ABC", "stress": "ABC"}

STATE = {
    "home city": ["I live in {U}", "I'm based in {U}", "home for me is {U}", "I stay in {U} these days", "I've lived in {U} for years", "{U} is where I live"],
    "hometown": ["I'm originally from {U}", "I grew up in {U}", "my hometown is {U}"],
    "employer": ["I work at {U}", "I'm at {U}", "my company is {U}", "I've been working at {U} for a while"],
    "job title": ["I'm a {U}", "I work as a {U}", "my role is {U}"],
    "favourite drink": ["I love {U}", "{U} is my go-to drink", "I mostly drink {U}"],
    "favourite food": ["I love {U}", "{U} is my favourite food", "nothing beats {U}"],
    "diet": ["I'm {U}", "I eat {U}", "I keep things {U} food-wise"],
    "music genre": ["I'm into {U}", "I mostly listen to {U}", "{U} is my kind of music"],
    "birthday": ["my birthday is {U}", "I was born on {U}", "{U} is my birthday"],
    "wake-up time": ["I wake up at {U}", "I'm up by {U} every day", "my alarm goes off at {U}"],
    "commute": ["I commute {U}", "I get to work {U}", "I go to the office {U}"],
    "pet": ["I have {U}", "I've got {U} at home", "we have {U}"],
    "learning": ["I'm learning {U}", "I've started learning {U}", "I'm studying {U} on the side"],
    "hobby": ["I'm into {U}", "{U} is my hobby", "I spend my weekends on {U}"],
    "editor theme": ["I prefer {U}", "I use {U} everywhere", "please always use {U}"],
    "favourite sport": ["I play {U}", "{U} is my sport", "I'm really into {U}"],
    "allergy": ["I'm allergic to {U}", "I have an allergy to {U}", "{U} gives me an allergic reaction"],
}
THIRD = {
    "home city": ["{M} lives in {U}", "{M} is based in {U}", "{M} stays in {U}"],
    "hometown": ["{M} is from {U}", "{M} grew up in {U}", "{M} is originally from {U}"],
    "employer": ["{M} works at {U}", "{M} is at {U}", "{M} has a job at {U}"],
    "job title": ["{M} is a {U}", "{M} works as a {U}", "{M}'s job is {U}"],
    "favourite drink": ["{M} loves {U}", "{M} always drinks {U}", "{M}'s go-to is {U}"],
    "birthday": ["{M}'s birthday is {U}", "{M} was born on {U}", "{M} celebrates on {U}"],
    "pet": ["{M} has {U}", "{M} got {U}", "{M} owns {U}"],
    "kids": ["{M} has {U}", "{M} is raising {U}", "{M}'s got {U}"],
    "spouse": ["{M} is {U}", "{M} got {U}", "turns out {M} is {U}"],
}
PROJECT_BY_KIND = {
    "decision": ["for {M} we went with {U}", "we picked {U} for {M}", "{M} will use {U}"],
    "requirement": ["for {M}, the {attr} is {U}", "the {attr} for {M} is {U}", "{M}'s {attr}: {U}"],
    "todo": ["next up on {M}: {U}", "for {M} I still need to {U}", "todo for {M}: {U}"],
    "idea": ["idea for {M}: {U}", "maybe {M} should get {U}, I like that idea", "{M} could use {U}, that's the plan"],
    "fact": ["for {M}, the {attr} is {U}", "{M}'s {attr} is {U}", "the {attr} for {M} is {U}"],
}
PROJECT_BY_ATTR = {
    "status": ["{M} is {U}", "{M} status: {U}", "right now {M} is {U}"],
    "deadline": ["{M} is due {U}", "the deadline for {M} is {U}", "{M} has to ship by {U}"],
    "launch date": ["{M} launches {U}", "we launch {M} {U}", "launch date for {M}: {U}"],
    "budget": ["the budget for {M} is {U}", "{M} has {U} to spend", "{M}'s budget: {U}"],
    "target users": ["{M} is for {U}", "{M} targets {U}", "we're building {M} for {U}"],
    "main requirement": ["{M} needs {U}", "for {M} it has to have {U}", "{M}'s must-have: {U}"],
    "repo": ["{M} lives {U}", "the code for {M} is {U}", "{M}'s repo is {U}"],
}
GENERIC_STATE = ["my {attr} is {U}", "{U} is my {attr}", "fyi, my {attr} is {U}", "for the record, my {attr} is {U}",
                 "my {attr}? {U}", "just so you know, my {attr} is {U}"]
GENERIC_THIRD = ["{M}'s {attr} is {U}", "for {M}, the {attr} is {U}", "{M} told me their {attr} is {U}"]
CHANGE = ["my {attr} is {U} now", "I changed my {attr} to {U}", "these days my {attr} is {U}", "no more {old}, my {attr} is {U} now",
          "I've switched my {attr} to {U}", "update: my {attr} is {U} now"]
CHANGE_SPECIFIC = {"home city": ["I moved to {U}", "I've relocated to {U}", "I just moved to {U}"],
                   "employer": ["I joined {U}", "I switched jobs, I'm at {U} now", "I started at {U}"],
                   "favourite drink": ["I've switched to {U}", "these days it's {U} for me", "I'm on {U} now"]}
CHANGE_THIRD = ["{M}'s {attr} is {U} now", "{M} switched to {U}", "{M} changed their {attr} to {U}"]
CORRECT = ["sorry, I meant {U}, not {old}", "correction: my {attr} is {U}, not {old}", "wait, I got that wrong, it's {U}",
           "no sorry, {U}, I mixed it up with {old}", "my mistake, the right one is {U}", "small fix: {U}, not {old}"]
CORRECT_THIRD = ["sorry, {M}'s {attr} is {U}, not {old}", "correction: for {M} it's {U}", "wait, {M}'s is {U}, I said {old} by mistake"]
REPEAT = ["like I said, my {attr} is {U}", "still {U} for my {attr}", "yeah, {U}, same as always", "my {attr} is {U}, as I mentioned"]
REPEAT_THIRD = ["{M}'s {attr} is still {U}", "like I said, {M}'s {attr} is {U}", "{M} is still on {U}"]
IMPLIED = ["another day, another {U}", "as usual it's {U} for me", "classic me, {U} again", "of course I went with {U} again"]
IMPLIED_THIRD = ["{M} went with {U} again, as always", "typical {M}, {U} again", "{M} picked {U} yet again"]
ALSO = ["I'm into {U} too", "same here, my {attr} is {U} too", "I also go for {U}"]
ALSO_THIRD = ["{M} also likes {U}", "{M}'s {attr} is {U} too", "funny, {M} has {U} as well"]
JOKE = ["lol my {attr} is basically {U} at this point", "haha sure, {U}, totally", "yeah right, my {attr} is {U} 😂",
        "jk jk, as if my {attr} would be {U}", "lmao imagine me with {U}", "my {attr} is {U}, said no one ever"]
QUOTE = ["my mom keeps saying {U} is the best", "\"{U} for life\" is what my cousin always says",
         "my teacher used to say everyone needs {U}", "my friend's motto is literally '{U}'", "as my dad puts it, {U} or nothing",
         "my boss keeps telling everyone about {U}"]
UNCERTAIN = ["I might switch my {attr} to {U}", "maybe {U}? not sure yet", "thinking about {U} for my {attr}, haven't decided",
             "possibly {U}, still deciding", "not sure, maybe {U} someday", "I could go with {U}, we'll see"]
FRAME_OPEN = ["imagine if my {attr} was {U}", "let's pretend I had {U} as my {attr}", "hypothetically, say my {attr} were {U}",
              "picture this: my {attr} is {U}", "what if my {attr} was {U}", "in an alternate life my {attr} would be {U}"]
FRAME_CONT = ["then I'd probably go for {U} as my {attr}", "and in that world my {attr} would be {U}", "I'd totally pick {U} then",
              "so my {attr} would be {U} in that case", "and obviously {U} for my {attr} there", "in that version of me it's {U}"]
FRAME_CLOSE = ["ok enough daydreaming", "anyway, back to reality", "lol ok, back to real life", "alright, fantasy over",
               "ok back to the real world", "anyway, that was just a thought experiment"]
TEMP = ["note: {U}", "reminder for me: {U}", "fyi, {U}", "heads up, {U}", "for today: {U}", "just so you know, {U}"]
TEMP_UPDATE = ["oh wait, {U}", "change: {U}", "scratch that, {U}", "small change, {U}", "actually, {U}", "update on that: {U}"]
TEMP_DONE = ["done with that", "ok that's sorted", "finished, phew", "all done with what I mentioned", "that's handled now", "ticked that off"]
CONFIRM = ["yes please", "yes", "sure, save it", "yep, remember that", "go ahead", "please do"]
DECLINE = ["no, don't save that", "nah, skip it", "no thanks", "please don't", "not now", "no, leave it"]
OFFER = ["Want me to remember that you prefer {U}?", "Should I save {U} as your {attr}?", "Shall I remember {U} for your {attr}?",
         "Do you want me to note {U} as your {attr}?", "I can remember {U} as your {attr}, want that?", "Save {U} as your {attr}?"]
FORGET = ["please forget my {U}", "delete what you know about my {U}", "can you forget my {U}?", "remove my {U} from memory",
          "forget about my {U}, it's private", "drop my {U} please"]
FORGET_THIRD = ["please forget {M}'s {U}", "delete {M}'s {U}", "forget what I said about {M}'s {U}"]
FORGET_PROFILE = ["forget everything about {UM}", "please delete all you know about {UM}", "remove {UM} from your memory",
                  "erase what you have on {UM}", "drop everything about {UM}", "can you forget {UM} completely?"]
ASK = ["what's my {attr} again?", "remind me, what's my {attr}?", "do you remember my {attr}?", "what did I say my {attr} was?"]
ASK_THIRD = ["remind me, what's {M}'s {attr}?", "do you remember {M}'s {attr}?", "what did I tell you about {M}'s {attr}?"]
MERGE = ["btw {M} and my {dup_role} {name} are the same person, I mixed them up. also their {attr} is {U}",
         "oh, {M} is actually the {name} I called my {dup_role} before. {name}'s {attr} is {U} by the way",
         "quick fix: my {dup_role} {name} is {M}, same person. and their {attr} is {U}"]
CHITCHAT = ["how's your day going?", "the weather is crazy today", "lol that's funny", "ok thanks!", "can you help me with something later?",
            "I'm so tired today", "did you see the match last night?", "what a week", "hmm let me think"]
ACK = ["Got it.", "Noted.", "Okay!", "Thanks for telling me.", "Sure thing.", "Understood.", "Alright, noted.", "Makes sense."]
ANSWER = ["You told me {V}.", "I have {V} noted.", "That's {V}, as far as I know.", "From what you said: {V}."]
OPENERS = ["", "", "", "btw ", "oh and ", "also, ", "ok so ", "hey, ", "fyi "]
# Roman Urdu / mixed (used for lang = ur; mixed adds fillers to English templates)
UR = {
    "state": ["mera {attr} {U} hai", "yaar mera {attr} {U} hai", "{U} hi hai mera {attr}"],
    "third": ["{M} ka {attr} {U} hai", "{M} ne bataya ke {attr} {U} hai", "{M} ka {attr} to {U} hai"],
    "change": ["ab mera {attr} {U} hai", "maine {attr} {U} kar diya hai", "aaj kal {U} hai mera {attr}"],
    "correct": ["sorry, {U} tha, {old} nahi", "galti ho gayi, {U} hai", "nahi nahi, {U} sahi hai"],
    "repeat": ["jaisa maine kaha, {U} hi hai", "abhi bhi {U} hai mera {attr}", "wohi {U}"],
    "joke": ["haha mera {attr} to {U} hai 😂", "mazak kar raha tha, {U} lol", "haan haan {U}, bilkul 😂"],
    "uncertain": ["shayad {attr} {U} kar loon", "pata nahi, {U} ho sakta hai", "soch raha hoon {U}"],
    "temp": ["aaj {U}", "yaad rakhna, {U}", "abhi {U}"],
    "temp_update": ["acha {U}", "change, {U}", "nahi, {U}"],
    "temp_done": ["ho gaya", "done ho gaya", "woh kaam ho gaya"],
    "forget": ["mera {U} bhool jao", "{U} wali baat delete kar do", "mera {U} yaad mat rakhna"],
    "ask": ["mera {attr} kya tha?", "yaad hai mera {attr}?", "mera {attr} kya bataya tha?"],
    "confirm": ["haan yaad rakho", "haan please", "ji haan"],
    "decline": ["nahi rehne do", "nahi, mat save karo", "nahi shukriya"],
    "chitchat": ["kya haal hai?", "aaj bohot garmi hai", "acha theek hai"],
}
FILLERS = ["yaar ", "acha ", "bas ", "matlab ", ""]

PRON_POSS = {"she": "her", "he": "his", "it": "its"}
PRON_OBJ = {"she": "her", "he": "him", "it": "it"}


class ProgRealizer:
    name = "programmatic"

    def __init__(self, split, seed):
        self.split, self.rng = split, random.Random(seed)

    def pick(self, lst):
        allowed = FAM[self.split]
        opts = [(i, t) for i, t in enumerate(lst) if "ABC"[i % 3] in allowed]
        i, t = self.rng.choice(opts)
        self.families.append("ABC"[i % 3])
        return t

    def fill(self, tpl, beat, tags, mention_text=None):
        """Insert tags into a template. {U} unit, {M} mention, {UM} combined."""
        u = next((t for t in tags if t["tag"].startswith("u")), None)
        m = next((t for t in tags if t["tag"].startswith("m")), None)
        out = tpl
        if m is not None:
            mt = m["text"]
            if mt in PRON_POSS:
                out = out.replace("{M}'s", "[[%s|%s]]" % (m["tag"], PRON_POSS[mt]))
                for prep in ("for ", "about ", "with ", "on ", "typical "):
                    out = out.replace(prep + "{M}", prep + "[[%s|%s]]" % (m["tag"], PRON_OBJ[mt]))
            out = out.replace("{M}", "[[%s|%s]]" % (m["tag"], mt))
        if "{UM}" in out:
            out = out.replace("{UM}", "[[%s+%s|%s]]" % (u["tag"], m["tag"], m["text"]))
        elif u is not None:
            out = out.replace("{U}", "[[%s|%s]]" % (u["tag"], u["text"]))
        attr = beat.get("attr", "thing")
        for t in tags:
            if f"[[{t['tag']}|" not in out and f"+{t['tag']}|" not in out and f"[[{t['tag']}+" not in out:
                raise ValueError(f"template {tpl!r} has no slot for tag {t['tag']} (act {beat['act']})")
        return (out.replace("{attr}", attr).replace("{old}", str(beat.get("old", ""))).replace("{name}", beat.get("name", ""))
                .replace("{dup_role}", beat.get("dup_role", "")))

    def beat_text(self, beat, lang, seg):
        act, tags = beat["act"], beat["tags"]
        third = beat.get("entity") not in (None, "user")
        a = beat.get("attr")
        kind = O.KIND.get(a)
        ur = lang == "ur"
        P = self.pick
        if act in ("state", "contradict"):
            if third and beat["entity"].startswith("project:"):
                t = P(PROJECT_BY_ATTR.get(a) or PROJECT_BY_KIND.get(kind, PROJECT_BY_KIND["fact"]))
            elif ur:
                t = P(UR["third" if third else "state"])
            elif third:
                t = P(THIRD.get(a, GENERIC_THIRD) + GENERIC_THIRD)
            else:
                t = P(STATE.get(a, GENERIC_STATE) + GENERIC_STATE)
        elif act == "imply":
            t = P(IMPLIED_THIRD if third else IMPLIED)
        elif act == "state_also":
            t = P(ALSO_THIRD if third else ALSO)
        elif act == "repeat":
            t = P(UR["repeat"]) if ur and not third else P(REPEAT_THIRD if third else REPEAT)
        elif act == "change":
            t = P(UR["change"]) if ur and not third else P(CHANGE_THIRD if third else CHANGE_SPECIFIC.get(a, []) + CHANGE)
        elif act == "correct":
            t = P(UR["correct"]) if ur and not third else P(CORRECT_THIRD if third else CORRECT)
        elif act == "joke":
            t = P(UR["joke"] if ur else JOKE)
        elif act == "quote":
            t = P(QUOTE)
        elif act == "uncertain":
            t = P(UR["uncertain"] if ur else UNCERTAIN)
        elif act == "frame_open":
            t = P(FRAME_OPEN)
        elif act == "frame_cont":
            t = P(FRAME_CONT)
        elif act == "frame_close":
            t = P(FRAME_CLOSE)
        elif act == "temp":
            t = P(UR["temp"] if ur else TEMP)
        elif act == "temp_update":
            t = P(UR["temp_update"] if ur else TEMP_UPDATE)
        elif act == "temp_done":
            t = P(UR["temp_done"] if ur else TEMP_DONE)
        elif act == "offer":
            t = P(OFFER)
        elif act == "confirm":
            u = tags[0]
            u["text"] = P(UR["confirm"] if ur else CONFIRM)
            t = "{U}"
        elif act == "decline":
            t = P(UR["decline"] if ur else DECLINE)
        elif act == "forget":
            t = P(UR["forget"]) if ur and not third else P(FORGET_THIRD if third else FORGET)
        elif act == "forget_profile":
            t = P(FORGET_PROFILE)
        elif act == "ask":
            t = P(UR["ask"]) if ur and not third else P(ASK_THIRD if third else ASK)
        elif act == "merge_reveal":
            world = seg["_world"]
            dup = world[beat["entity"]]
            beat["name"] = dup["name"]
            beat["dup_role"] = beat["dup_text"].split("(")[-1].rstrip(")")
            t = P(MERGE)
        elif act == "chitchat":
            t = P(UR["chitchat"] if ur else CHITCHAT)
        elif act == "ack":
            t = P(ANSWER).replace("{V}", seg["answer"]["value"]) if seg.get("answer") else P(ACK)
        else:
            raise ValueError(act)
        txt = self.fill(t, beat, tags)
        if beat["speaker"] == "user" and act not in ("confirm", "decline"):
            if lang == "mixed":
                txt = self.rng.choice(FILLERS) + txt
            elif lang == "en":
                txt = self.rng.choice(OPENERS) + txt
        return txt

    def noise(self, s):
        """Typos and casing outside tags only (tag contents stay exact)."""
        r = self.rng
        if r.random() < 0.12:
            parts = s.split("[[")
            out = []
            for i, p in enumerate(parts):
                if i == 0:
                    out.append(p.lower()); continue
                inner, _, rest = p.partition("]]")
                out.append(inner + "]]" + rest.lower())
            s = "[[".join(out)
        if r.random() < 0.15:
            protected = [(m.start(), m.end()) for m in re.finditer(r"\[\[.*?\]\]", s)]
            words = [(m.start(), m.end()) for m in re.finditer(r"[A-Za-z]{4,}", s)]
            cand = [(a, b) for a, b in words if not any(a < pe and b > ps for ps, pe in protected)]
            if cand:
                a, b = r.choice(cand); w = s[a:b]; j = r.randrange(len(w) - 1)
                s = s[:a] + w[:j] + w[j + 1] + w[j] + w[j + 2:] + s[b:]
        return s

    def realize(self, ep):
        """Returns per segment: list of turns [{speaker, text-with-tags}] and the template families used."""
        out = []
        for seg in ep["segments"]:
            self.families = []
            seg["_world"] = ep["world"]
            if seg.get("real"):
                out.append({"turns": [dict(t) for t in seg["beats"][0]["turns"]], "families": []})
                continue
            turns = []
            for beat in seg["beats"]:
                txt = self.beat_text(beat, seg["lang"], seg)
                if beat["speaker"] == "user":
                    txt = self.noise(txt)
                if turns and turns[-1]["speaker"] == beat["speaker"]:
                    sep = self.rng.choice([". ", ", and ", ". Also ", "! ", " - "])
                    turns[-1]["text"] = turns[-1]["text"].rstrip(".!?") + sep + txt
                else:
                    turns.append({"speaker": beat["speaker"], "text": txt})
            for t in turns:
                t["text"] = t["text"][:1].upper() + t["text"][1:] if not t["text"].startswith("[[") else t["text"]
                if t["speaker"] == "user" and self.rng.random() < 0.7 and t["text"][-1:] not in ".!?":
                    t["text"] += self.rng.choice([".", "", "!"])
            out.append({"turns": turns, "families": list(self.families)})
            del seg["_world"]
        return out
