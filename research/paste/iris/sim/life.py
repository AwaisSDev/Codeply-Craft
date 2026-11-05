"""Life simulator v2 (IRIS-DESIGN.md §3.1): one user's life over several weeks, as a stream of events from several
sources, with exact gold for every layer of the context-management pipeline.

Every label comes from the simulator's world, never from a renderer. An event is either rendered by a template here
(calendar entries, screen text) or handed to the step-3 renderer as a *fact sheet*: what the conversation is for, which
facts it must express (with exact anchor strings), and what it must not contain. The gold observations of an event
are fixed before rendering; the step-3 verifier rejects renders that do not match them.

Gold memory semantics (what a perfect Iris would hold), one record per (entity, slot):
  first statement            -> op "new"        (record gm<i> created)
  same value again           -> op "reinforce"  (target gm<i>)
  the world changed          -> op "update"     (target; old value moves to history with valid_to)
  an earlier statement fixed -> op "contradict" (target; the earlier value was wrong, no history interval)
  joking / hypothetical / quoting / suggestion by someone else -> op "none" (nothing changes)
Plans have their own records (gp<i>) with a status that moves suggested -> confirmed / declined -> moved / cancelled
/ done. Conflicts are pairs of live plans that overlap in time.

    python -m iris.sim.life --split train --n 3 --out lives.jsonl [--seed 1] [--days 21]
"""
import argparse
import copy
import datetime
import json
import random
import sys

from data import ontology as O

from iris.schema import brain_would_store

from . import pools as P

DAY, HOUR = 86400, 3600
T0 = 1_791_000_000                                      # 2026-10-03 (UTC); lives start here or later
TRUST = {"assistant_chat": "user", "personal_chat": "mixed", "work_chat": "mixed", "email": "external",
         "calendar": "user", "screen": "user", "document": "mixed"}
STORE_CERTS = ("stated", "implied")


def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M")


def human_time(t):
    d = datetime.datetime.fromtimestamp(t, datetime.timezone.utc)
    return d.strftime("%A %d %B at %I:%M %p").replace(" 0", " ").replace("at 0", "at ")


class GoldStore:
    """The gold memory state a perfect system would hold (records keyed by (entity, slot))."""

    def __init__(self):
        self.mem, self.by_key, self.plans, self.n, self.np = {}, {}, {}, 0, 0

    def observe(self, t, entity, slot, value, kind, certainty, sensitivity, category, correction=False):
        """Returns (op, target, record_id) for a statement; mutates the gold state."""
        if certainty not in STORE_CERTS:
            return "none", self.by_key.get((entity, slot)), None
        cur = self.mem.get(self.by_key.get((entity, slot)))
        if cur is None:
            self.n += 1
            rid = f"gm{self.n}"
            self.mem[rid] = {"id": rid, "entity": entity, "slot": slot, "value": value, "kind": kind,
                             "certainty": certainty, "sensitivity": sensitivity, "category": category, "created": t,
                             "updated": t, "valid_from": t, "evidence": 1, "history": []}
            self.by_key[(entity, slot)] = rid
            return "new", None, rid
        if cur["value"] == value:
            cur["evidence"] += 1; cur["updated"] = t
            if certainty == "stated":
                cur["certainty"] = "stated"
            return "reinforce", cur["id"], cur["id"]
        if correction:
            cur["history"].append({"value": cur["value"], "corrected_at": t})
            cur.update(value=value, updated=t, certainty=certainty, evidence=1)
            return "contradict", cur["id"], cur["id"]
        cur["history"].append({"value": cur["value"], "valid_from": cur["valid_from"], "valid_to": t})
        cur.update(value=value, updated=t, valid_from=t, certainty=certainty, evidence=1)
        return "update", cur["id"], cur["id"]

    def current(self, entity, slot):
        r = self.mem.get(self.by_key.get((entity, slot)))
        return r["value"] if r else None

    def plan(self, t, what, when, where, who, status, pid=None):
        if pid is None:
            self.np += 1
            pid = f"gp{self.np}"
            self.plans[pid] = {"id": pid, "what": what, "when": when, "where": where, "who": who, "status": status,
                               "created": t, "updated": t, "history": []}
            return "new", pid
        p = self.plans[pid]
        p["history"].append({k: p[k] for k in ("when", "where", "status")} | {"at": t})
        p.update(what=what, when=when, where=where, who=who, status=status, updated=t)
        return "update", pid


class Life:
    def __init__(self, seed, split="train", days=21):
        self.rng = random.Random(f"iris-life-{split}-{seed}")
        self.seed, self.split, self.days = seed, split, days
        self.t0 = (T0 // DAY) * DAY + self.rng.randrange(0, 120) * DAY     # midnight (user-local clock, UTC labels)
        self.gold = GoldStore()
        self.events, self.relations, self.tasks = [], [], []
        self.n_ev = 0

    # ---- world -----------------------------------------------------------------------------------------------
    def build_world(self):
        r, s = self.rng, self.split
        first = P.split_pool(P.FIRST_F, s) + P.split_pool(P.FIRST_M, s)
        surn = P.split_pool(P.SURNAMES, s)
        gender = r.choice("fm")
        self.user = {"id": "user", "type": "user", "name": r.choice(P.split_pool(P.FIRST_F if gender == "f" else P.FIRST_M, s))}
        roles = (["mother", "father", "sister", "brother", "partner"] + ["friend"] * 4 + ["colleague"] * 3 +
                 ["manager", "investor", "teacher", "classmate", "client", "doctor", "neighbour"])
        n_people = r.randint(8, 16)
        used, self.people = {self.user["name"]}, []
        for i in range(n_people):
            name = r.choice([x for x in first if x not in used])
            used.add(name)
            role = roles[i] if i < len(roles) else r.choice(roles)
            full = f"{name} {r.choice(surn)}" if role in ("colleague", "manager", "investor", "teacher", "client", "doctor") else name
            self.people.append({"id": f"p{i + 1}", "type": "person", "name": full, "first": name, "role": role})
        self.org = r.choice(P.split_pool(P.ORGS, s))
        self.school = r.choice(P.split_pool(P.SCHOOLS, s))
        self.projects = r.sample(P.split_pool(P.PROJECTS, s), 2)
        rel = {"mother": "family", "father": "family", "sister": "family", "brother": "family", "partner": "partner",
               "friend": "friend", "colleague": "colleague", "manager": "manager", "investor": "investor",
               "teacher": "teacher", "classmate": "classmate", "client": "client", "doctor": "doctor", "neighbour": "neighbour"}
        for p in self.people:
            self.relations.append({"a": "user", "relation": rel[p["role"]], "b": p["name"], "detail": p["role"]})
        self.relations.append({"a": "user", "relation": "works_at", "b": self.org, "detail": ""})
        self.relations.append({"a": "user", "relation": "studies_at", "b": self.school, "detail": ""})
        for pr in self.projects:
            self.relations.append({"a": "user", "relation": "leads", "b": pr, "detail": "project"})
        friends = [p for p in self.people if p["role"] in ("friend", "classmate", "colleague")]
        if len(friends) >= 2:
            a, b = r.sample(friends, 2)
            self.relations.append({"a": a["name"], "relation": "friend", "b": b["name"], "detail": "know each other"})
        # facts to reveal over the life: (entity, slot, kind, about, value pool, sensitivity, category)
        self.fact_specs = []
        user_classes = [c for c in O.CLASSES if "user" in c[2]]
        for c in r.sample(user_classes, 14):
            self.fact_specs.append(("user", c[0], c[1], "user", O.values(c[0], s), "personal", "none"))
        for slot, kind, about, vals in P.IRIS_SLOTS:
            ent = r.choice(self.projects) if about == "project" else "user"
            if slot == "midterm mark":                      # one slot per subject: different subjects are not updates
                for subject in r.sample(P.SUBJECTS, 3):
                    self.fact_specs.append(("user", f"{subject} midterm mark", kind, about,
                                            [str(x) for x in P.split_values(P.MARKS, s)], "personal", "none"))
                continue
            vals = [r.choice(self.projects)] if vals is None else P.split_values(vals, s)
            self.fact_specs.append((ent, slot, kind, about, vals, "personal", "none"))
        person_classes = [c for c in O.CLASSES if "person" in c[2]]
        for p in r.sample(self.people, min(6, len(self.people))):
            for c in r.sample(person_classes, 2):
                self.fact_specs.append((p["name"], c[0], "fact", "person", O.values(c[0], s), "personal", "none"))
            if p["role"] in ("friend", "partner", "sister", "brother", "mother", "father"):
                self.fact_specs.append((p["name"], "birthday", "fact", "person", O.values("birthday", s), "personal", "none"))
        for slot, sens, cat, vals in r.sample(P.SENSITIVE, 3):
            self.fact_specs.append(("user", slot, "fact", "user", vals, sens, cat))
        r.shuffle(self.fact_specs)

    # ---- events ----------------------------------------------------------------------------------------------
    def _event(self, t, source, purpose, participants, units, plans=(), relations=(), render="llm", text=None,
               n_user_turns=None):
        self.n_ev += 1
        eid = f"ev{self.n_ev}"
        obs = []
        for u in units:
            op, target, rid = self.gold.observe(t, u["entity"], u["slot"], u["value"], u["kind"], u["certainty"],
                                                u["sensitivity"], u["category"], correction=u.get("correction", False))
            ent_name = "the user" if u["entity"] == "user" else u["entity"]
            text_s = f"{ent_name}'s {u['slot']} is {u['value']}" if u["about"] != "project" else f"{u['entity']} project: {u['slot']} is {u['value']}"
            obs.append({"kind": u["kind"], "slot": u["slot"], "value": u["value"], "text": text_s[0].upper() + text_s[1:] + ".",
                        "certainty": u["certainty"], "importance": u.get("importance", 0.6), "about": u["about"],
                        "entity": u["entity"], "op": op, **({"target": target} if target else {}),
                        "sensitivity": u["sensitivity"], "sensitivity_category": u["category"],
                        "valid_from": iso(t) if op in ("new", "update") else "", "_memory": rid, "_how": u["how"]})
            obs[-1]["_brain"] = brain_would_store(obs[-1])          # what production's observe() would do with it
        if n_user_turns is None and source in ("assistant_chat", "personal_chat", "work_chat"):
            # ~10-20 % of user turns carry a fact (LongMemEval oracle: 15 % evidence turns; 1 fact -> 6 user messages)
            n_user_turns = max(len(units) + len(plans), self.rng.randint(2, 6), round(len(units) / 0.18))
        ev = {"event_id": eid, "at": t, "at_iso": iso(t), "day": (t - self.t0) // DAY, "source": source,
              "trust": TRUST[source], "participants": participants, "render": render,
              "gold": {"observations": obs, "plans": list(plans), "relations": list(relations)}}
        if render == "llm":
            ev["fact_sheet"] = self._fact_sheet(source, purpose, participants, units, plans, n_user_turns)
        else:
            ev["text"] = text
        self.events.append(ev)
        return ev

    def _fact_sheet(self, source, purpose, participants, units, plans, n_user_turns):
        must, forbid = [], set()
        for u in units:
            anchors = [u["value"]] + ([u["entity"].split()[0]] if u["about"] == "person" else [])
            must.append({"speaker": u.get("speaker", "user"), "how": u["how"], "anchors": anchors,
                         "instruction": u["instruction"]})
        for p in plans:
            must.append({"speaker": p.get("speaker", "user"), "how": p["how"], "anchors": p["anchors"], "instruction": p["instruction"]})
        said = {a for m in must for a in m["anchors"]}
        own = " ".join(m["instruction"] for m in must) + " " + purpose
        context = set(self.projects) | {self.org, self.school}           # the life's own names are context, not facts
        for (ent, slot, kind, about, vals, sens, cat) in self.fact_specs:       # no stray values of tracked slots
            for v in vals:
                if v not in said and len(v) > 3 and v not in own and v not in context:
                    forbid.add(v)
        return {"source": source, "purpose": purpose, "participants": participants,
                "n_user_turns": n_user_turns, "language": self.lang(), "must_express": must,
                "must_not_contain": sorted(forbid)[:200]}

    def lang(self):
        return self.rng.choices(["en", "en with a few Urdu words"], [0.75, 0.25])[0]

    def _unit(self, spec, value, certainty="stated", how="said plainly in passing", correction=False, speaker="user"):
        ent, slot, kind, about, vals, sens, cat = spec
        who = ("their" if speaker == "user" else "the user's") if ent == "user" else (f"{ent}'s" if about == "person" else f"the {ent} project's")
        verb = {"stated": "mentions", "implied": "makes it clear without saying it outright that",
                "joking": "jokes (not seriously) that", "hypothetical": "wonders hypothetically whether",
                "quoting": "quotes someone else saying that"}[certainty]
        instr = f"{'The user' if speaker == 'user' else speaker} {verb} {who} {slot} is \"{value}\""
        if correction:
            instr = f"The user corrects an earlier mistake: {who} {slot} is actually \"{value}\""
        return {"entity": ent, "slot": slot, "value": value, "kind": kind, "about": about, "certainty": certainty,
                "sensitivity": sens, "category": cat, "how": how, "instruction": instr, "correction": correction,
                "speaker": speaker, "importance": 0.9 if sens in ("secret", "private") else 0.6}

    def simulate(self):
        self.build_world()
        r = self.rng
        pending = list(self.fact_specs)
        later_changes = []
        self._pending, self._later = pending, later_changes
        for d in range(self.days):
            day0 = self.t0 + d * DAY
            # the day's schedule, processed in time order so gold ids and ops follow the timeline
            sched = [(day0 + r.randint(8, 22) * HOUR + r.randint(0, 59) * 60, "assistant") for _ in range(r.randint(1, 3))]
            if r.random() < 0.8:
                sched.append((day0 + r.randint(9, 23) * HOUR + r.randint(0, 59) * 60, "personal"))
            if r.random() < 0.5:
                sched.append((day0 + r.randint(9, 18) * HOUR, "work"))
            if r.random() < 0.4:
                sched.append((day0 + r.randint(7, 20) * HOUR, "email"))
            if r.random() < 0.6:
                sched.append((day0 + r.randint(9, 23) * HOUR, "screen"))
            for t, kind in sorted(sched):
                {"assistant": self._assistant_chat, "personal": self._personal_chat, "work": self._work_chat,
                 "email": self._email, "screen": self._screen}[kind](t)
        self._inject_conflict()
        self._agent_tasks()
        self.events.sort(key=lambda e: e["at"])
        return self.to_json()


    def _assistant_chat(self, t):
        r, pending, later_changes = self.rng, self._pending, self._later
        units = []
        for _ in range(r.choices([0, 1, 2], [0.3, 0.5, 0.2])[0]):
            roll = r.random()
            if roll < 0.55 and pending:                                   # first statement of a fact
                spec = pending.pop()
                cert = r.choices(["stated", "implied"], [0.8, 0.2])[0]
                units.append(self._unit(spec, r.choice(spec[4]), cert))
                if spec[3] != "project" and spec[5] == "personal" and len(spec[4]) > 1:
                    later_changes.append(spec)
                continue
            known = list(self.gold.mem.values())
            if not known:
                continue
            if roll < 0.72 and later_changes:                             # the world changed
                spec = later_changes.pop(r.randrange(len(later_changes)))
                cur = self.gold.current(spec[0], spec[1])
                if cur is None:
                    continue
                new = r.choice([v for v in spec[4] if v != cur] or [cur])
                units.append(self._unit(spec, new, "stated", "says this changed recently"))
                continue
            rec = r.choice(known)
            spec = next((x for x in self.fact_specs if x[0] == rec["entity"] and x[1] == rec["slot"]), None)
            if spec is None:
                continue
            other = r.choice([v for v in spec[4] if v != rec["value"]] or [rec["value"]])
            if roll < 0.84:
                units.append(self._unit(spec, rec["value"], "stated", "mentioned again in passing"))
            elif roll < 0.9:
                units.append(self._unit(spec, other, "stated", "corrects themselves", correction=True))
            else:
                units.append(self._unit(spec, other, r.choice(["joking", "hypothetical", "quoting"]), "not meant as a real fact"))
        self._event(t, "assistant_chat", f"The user {r.choice(P.ASSISTANT_PURPOSES)}.", [self.user["name"], "assistant"], units)

    def _personal_chat(self, t):
        r = self.rng
        p = r.choice(self.people)
        units, plans = [], []
        spec = next((x for x in self._pending if x[0] == p["name"]), None)
        if spec:
            self._pending.remove(spec)
            units.append(self._unit(spec, r.choice(spec[4]), "stated", "comes up naturally", speaker=p["first"]))
        if r.random() < 0.45:
            plans += self._plan_flow(t, p, "personal_chat")
        self._event(t, "personal_chat", f"{p['first']} and the user are {r.choice(P.CHAT_PURPOSES)}.",
                    [self.user["name"], p["name"]], units, plans)

    def _work_chat(self, t):
        r = self.rng
        c = r.choice([x for x in self.people if x["role"] in ("colleague", "manager", "client", "investor")] or self.people)
        spec = next((x for x in self._pending if x[3] == "project"), None)
        units = []
        if spec:
            self._pending.remove(spec)
            units.append(self._unit(spec, r.choice(spec[4]), "stated", "agreed in the discussion"))
        plans = self._plan_flow(t, c, "work_chat") if r.random() < 0.4 else []
        self._event(t, "work_chat", f"{c['name']} and the user discuss the {spec[0] if spec else self.projects[0]} project.",
                    [self.user["name"], c["name"]], units, plans)

    # ---- plans, conflicts, templates -------------------------------------------------------------------------
    def _plan_flow(self, t, person, source):
        r = self.rng
        when = (t // DAY + r.randint(1, 4)) * DAY + r.choice([12, 18, 19, 20]) * HOUR
        what = {"personal_chat": r.choice(["dinner", "coffee", "a movie", "a birthday party", "badminton", "a study session"]),
                "work_chat": r.choice(["the investor meeting", "a design review", "the sprint planning", "a client call"])}[source]
        where = r.choice(P.split_pool(P.PLACES, self.split))
        suggested = r.random() < 0.6 and source == "personal_chat"
        status = "suggested" if suggested else "confirmed"
        op, pid = self.gold.plan(t, what, when, where, [person["name"]], status)
        plans = [{"op": op, "id": pid, "what": what, "when": iso(when), "where": where, "who": [person["name"]], "status": status,
                  "how": "proposed by them, not yet agreed" if suggested else "agreed by the user",
                  "speaker": person["first"] if suggested else "user",
                  "anchors": [where, human_time(when).split(" at ")[1]],
                  "instruction": (f"{person['first']} suggests {what} at {where} on {human_time(when)}; the user does not commit yet"
                                  if suggested else f"The user agrees to {what} with {person['first']} at {where} on {human_time(when)}")}]
        if not suggested:                                # confirmed plans land in the calendar (template)
            self._calendar(t + 600, pid)
        elif r.random() < 0.6:                           # later the user confirms or declines
            later = t + r.randint(2, 20) * HOUR
            if later < when:
                status2 = r.choice(["confirmed", "declined"])
                op2, _ = self.gold.plan(later, what, when, where, [person["name"]], status2, pid=pid)
                self._event(later, "personal_chat", f"{person['first']} and the user follow up on {what}.", [self.user["name"], person["name"]], [],
                            [{"op": op2, "id": pid, "what": what, "when": iso(when), "where": where, "who": [person["name"]], "status": status2,
                              "how": "follow-up", "speaker": "user", "anchors": [where],
                              "instruction": f"The user {'confirms' if status2 == 'confirmed' else 'declines'} the {what} at {where}"}])
                if status2 == "confirmed":
                    self._calendar(later + 300, pid)
        return plans

    def _inject_conflict(self):
        """The owner's example: a confirmed 7 PM investor meeting (work chat + calendar), then a friend suggests a
        7 PM hangout the same evening, and the user mentions the investor meeting to the assistant."""
        r = self.rng
        inv = next((p for p in self.people if p["role"] == "investor"), r.choice(self.people))
        friend = next((p for p in self.people if p["role"] == "friend"), r.choice(self.people))
        d = self.t0 + (self.days // 2) * DAY
        when = d + 2 * DAY + 19 * HOUR
        where = r.choice(P.split_pool(P.PLACES, self.split))
        op, pid = self.gold.plan(d + 10 * HOUR, "the investor meeting", when, "the office", [inv["name"]], "confirmed")
        self._event(d + 10 * HOUR, "work_chat", f"{inv['name']} and the user fix the time of the investor meeting.",
                    [self.user["name"], inv["name"]], [],
                    [{"op": op, "id": pid, "what": "the investor meeting", "when": iso(when), "where": "the office",
                      "who": [inv["name"]], "status": "confirmed", "how": "agreed by the user", "speaker": "user",
                      "anchors": ["7", "investor"], "instruction": f"The user confirms the investor meeting with {inv['name']} at the office on {human_time(when)}"}])
        self._calendar(d + 10 * HOUR + 300, pid)
        op2, pid2 = self.gold.plan(d + 20 * HOUR, "a hangout", when, where, [friend["name"]], "suggested")
        self._event(d + 20 * HOUR, "personal_chat", f"{friend['first']} wants to hang out.", [self.user["name"], friend["name"]], [],
                    [{"op": op2, "id": pid2, "what": "a hangout", "when": iso(when), "where": where, "who": [friend["name"]],
                      "status": "suggested", "how": "proposed by them, not yet agreed", "speaker": friend["first"],
                      "anchors": [where, "7"], "instruction": f"{friend['first']} suggests hanging out at {where} on {human_time(when)}; the user does not answer yet"}])

    def _calendar(self, t, pid):
        p = self.gold.plans[pid]
        text = f"Calendar event: {p['what'].capitalize()} | {human_time(p['when'])} | {p['where']} | with {', '.join(p['who'])}"
        self._event(t, "calendar", "calendar entry", [self.user["name"]], [],
                    [{"op": "reinforce", "id": pid, "what": p["what"], "when": iso(p["when"]), "where": p["where"], "who": p["who"],
                      "status": "confirmed"}], render="template", text=text)

    def _email(self, t):
        r = self.rng
        if r.random() < 0.6:          # newsletters and notifications: nothing to remember
            self._event(t, "email", r.choice(["a newsletter from an online store", "a shipping notification",
                                               "a university announcement about the library hours", "a promotional offer"]),
                        ["external"], [])
            return
        c = r.choice([x for x in self.people if x["role"] in ("colleague", "manager", "client", "investor", "teacher")] or self.people)
        when = (t // DAY + r.randint(1, 5)) * DAY + r.choice([10, 15, 19]) * HOUR
        what = r.choice(["a meeting", "a review", "the quarterly check-in"])
        where = r.choice(["Zoom", "Google Meet", "the office", r.choice(P.split_pool(P.PLACES, self.split))])
        op, pid = self.gold.plan(t, what, when, where, [c["name"]], "tentative")
        self._event(t, "email", f"{c['name']} emails to propose {what}.", [c["name"], self.user["name"]], [],
                    [{"op": op, "id": pid, "what": what, "when": iso(when), "where": where, "who": [c["name"]], "status": "tentative",
                      "how": "proposed by email", "speaker": c["first"], "anchors": [where],
                      "instruction": f"{c['name']} proposes {what} on {human_time(when)} via {where}; awaiting the user's reply"}])

    def _screen(self, t):
        r = self.rng
        app = r.choice(["Figma", "VS Code", "Google Docs", "Chrome", "Notion", "Excel"])
        title = r.choice([f"{self.projects[0]} - landing page", "Untitled document", f"{self.projects[1]} roadmap",
                          "Inbox", "Weekly planner", "Budget 2026"])
        self._event(t, "screen", "screen text", [self.user["name"]], [], render="template",
                    text=f"[{app}] {title}")

    def _agent_tasks(self):
        """Agent requests with the gold context they need and what must never be shared (frontier agents)."""
        t = self.t0 + self.days * DAY + 9 * HOUR
        mem = self.gold.mem
        secret = sorted(k for k, m in mem.items() if m["sensitivity"] in ("secret", "private"))
        def ids(pred):
            return sorted(k for k, m in mem.items() if pred(m))
        specs = [
            ("design_agent", f"Design a landing page hero for the {self.projects[0]} project.",
             ids(lambda m: m["slot"] in ("brand colours", "design style", "favourite colour") or m["entity"] == self.projects[0])),
            ("study_agent", "Help me plan my revision for the coming week.",
             ids(lambda m: m["slot"] in ("academic goal", "midterm mark", "study plan", "sleep target"))),
            ("coding_agent", f"Set up the repository for {self.projects[0]}.",
             ids(lambda m: m["entity"] == self.projects[0] or m["slot"] in ("tech stack", "operating system", "editor theme"))),
        ]
        bdays = [m for m in mem.values() if m["slot"] == "birthday" and m["entity"] != "user"]
        if bdays:
            b = self.rng.choice(bdays)
            specs.append(("gift_agent", f"Suggest a birthday gift for {b['entity']}.",
                          ids(lambda m, e=b["entity"]: m["entity"] == e)))
        live = sorted(p["id"] for p in self.gold.plans.values() if p["status"] in ("confirmed", "tentative", "suggested"))
        specs.append(("planner_agent", "What do I have coming up, and is anything clashing?", live))
        for i, (agent, req, needed) in enumerate(specs):
            self.tasks.append({"task_id": f"task{i + 1}", "at": t, "agent": agent, "frontier": True, "request": req,
                               "needed": needed, "forbidden": secret})

    def conflicts(self):
        live = [p for p in self.gold.plans.values() if p["status"] in ("confirmed", "tentative", "suggested")]
        out = []
        for i, a in enumerate(live):
            for b in live[i + 1:]:
                if abs(a["when"] - b["when"]) < HOUR:
                    out.append({"plans": [a["id"], b["id"]], "kinds": [a["status"], b["status"]], "at": iso(min(a["when"], b["when"]))})
        return out

    def nudges(self):
        out = [{"key": f"plan:{p['id']}", "due": iso(p["when"] - HOUR), "about": p["id"], "why": f"{p['what']} in an hour"}
               for p in self.gold.plans.values() if p["status"] == "confirmed"]
        return out

    def to_json(self):
        return {"life_id": f"{self.split}-{self.seed}", "split": self.split, "seed": self.seed, "start": iso(self.t0),
                "days": self.days, "user": self.user, "people": self.people, "org": self.org, "school": self.school,
                "projects": self.projects, "relations": self.relations, "events": self.events,
                "final_memories": copy.deepcopy(self.gold.mem), "final_plans": copy.deepcopy(self.gold.plans),
                "conflicts": self.conflicts(), "nudges": self.nudges(), "tasks": self.tasks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="train", choices=("train", "val", "test", "stress", "pilot"))
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--seed", type=int, default=0, help="first seed")
    ap.add_argument("--days", type=int, default=21)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.split in ("test", "stress") and "frozen" not in a.out:
        sys.exit("test / stress lives are written only under a 'frozen' path (IRISBENCH-PROTOCOL, frozen before training)")
    with open(a.out, "w") as f:
        for i in range(a.n):
            f.write(json.dumps(Life(a.seed + i, a.split, a.days).simulate()) + "\n")


if __name__ == "__main__":
    main()
