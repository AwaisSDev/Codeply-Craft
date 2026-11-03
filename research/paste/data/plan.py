"""Episode planner: a symbolic world, a sequence of sessions and segments, and gold labels (DATASET-DESIGN.md §3-§5).

Every label comes from this plan, never from a realizer. A segment is a list of *beats*. A beat is one thing
somebody says, with tags the realizer must place in its text:
  u<i>  a unit (value-bearing span). `exact` tags must appear verbatim; free tags (PROMOTE "yes") may be reworded
  m<i>  an entity mention (free wording, e.g. "my cousin Bilal", "she")
The gold persistent store evolves through paste.brain_sim.BrainSim (the evaluator's executor), so gold stores and
evaluation semantics cannot drift apart.
"""
import copy
import math
import random

from paste.brain_sim import BrainSim
from paste.text import resolve_until

from . import ontology as O

# ---- name pools (disjoint per split: test and stress entities are never seen in training) -----------------
FEMALE = ["Ayesha", "Sara", "Hina", "Zara", "Mina", "Nadia", "Iqra", "Sana", "Fatima", "Maryam", "Amna", "Rabia", "Sadia",
          "Noor", "Mahnoor", "Kiran", "Laiba", "Areeba", "Bushra", "Huma", "Saba", "Farah", "Komal", "Anum"]
MALE = ["Ali", "Bilal", "Omar", "Usman", "Faraz", "Kamran", "Hamza", "Ahmed", "Hassan", "Zain", "Danish", "Saad", "Imran",
        "Tariq", "Junaid", "Waqas", "Fahad", "Adeel", "Shahid", "Asad", "Moiz", "Rehan", "Talha", "Yasir"]
PROJECTS = ["Atlas", "Falcon", "Mehfil", "Chirag", "Neem", "Saffron", "Kite", "Zephyr", "Tarang", "Basil", "Orbit", "Sitara",
            "Pulse", "Lantern", "Quill", "Ember", "Raahi", "Banyan"]
ROLES_F = ["sister", "cousin", "coworker", "manager", "neighbour", "friend", "mother", "aunt", "landlady", "teacher"]
ROLES_M = ["brother", "cousin", "coworker", "manager", "neighbour", "friend", "father", "uncle", "landlord", "trainer"]


def pool(names, split):
    """60 % train, 20 % val, 20 % test (stress uses the test pool)."""
    n = len(names)
    a, b = int(0.6 * n), int(0.8 * n)
    return names[:a] if split in ("train", "pilot") else names[a:b] if split == "val" else names[b:]


# ---- categories (the brief's 17, plus PROMOTE) ---------------------------------------------------------------
CATEGORIES = ["new_info", "repeated", "preference_change", "contradiction", "identity", "lookalike", "temp_plan",
              "expired_context", "project", "retrieval", "merge", "deletion", "irrelevant", "joke_hypothetical",
              "correction", "uncertain", "multilingual", "promote"]

# event weights (relative); availability is checked per segment
WEIGHTS = {"write": 10, "write_implied": 2, "repeat": 4, "change": 5, "contradict": 3, "correct": 3, "alias": 4,
           "lookalike": 3, "temp_plan": 6, "temp_update": 3, "temp_done": 3, "frame_open": 2, "frame_cont": 3,
           "frame_close": 1, "joke": 3, "quote": 2, "uncertain": 3,     # offer/promote/decline are structural (segment end/start)
           "forget": 2, "forget_profile": 0.4, "retrieve": 4, "merge": 4, "chitchat": 3, "real_distractor": 2,
           "project_write": 4, "project_change": 2}

DAY, HOUR, MIN = 86400.0, 3600.0, 60.0
T_START = 1_782_000_000.0          # 2026-06-21; episode start times are spread after this


class Entity:
    def __init__(self, key, kind, name=None, role=None, gender=None):
        self.key, self.kind, self.name, self.role, self.gender = key, kind, name, role, gender
        self.values = {}           # attribute -> current true value (the world, not the Brain)

    @property
    def text(self):            # profile display text in the Brain
        return "the user" if self.kind == "user" else (f"{self.name} ({self.role})" if self.kind == "person" else f"{self.name} (project)")

    def mention(self, rng, style):
        if self.kind == "user":
            return None
        if self.kind == "project":
            return {"full": f"the {self.name} project", "alias": self.name, "pronoun": "it"}[style]
        return {"full": f"my {self.role} {self.name}", "alias": rng.choice([self.name, f"my {self.role}"]),
                "pronoun": "she" if self.gender == "f" else "he"}[style]


class Planner:
    def __init__(self, split, seed, long=False, max_store=32):
        self.split, self.rng, self.long, self.max_store = split, random.Random(seed), long, max_store
        self.brain = BrainSim(capacity=10_000)
        self.fact_n = 0
        self.temp = []             # gold temporary items
        self.temp_n = 0
        self.frame = None          # open hypothetical frame item id
        self.pending = None        # (item id, attribute) offered by the assistant last segment
        self.last_mention = {}     # entity key -> segment index of last full mention
        self.last_gender_mention = {}   # gender -> (entity key, segment)
        self.ops_log = []

    # ------------------------------------------------------------------ world
    def build_world(self):
        r = self.rng
        fpool, mpool, ppool = pool(FEMALE, self.split), pool(MALE, self.split), pool(PROJECTS, self.split)
        self.user = Entity("user", "user")
        ents = [self.user]
        used = set()
        for _ in range(r.randint(2, 5)):
            g = r.choice("fm")
            name = r.choice([n for n in (fpool if g == "f" else mpool) if n not in used] or (fpool if g == "f" else mpool))
            role = r.choice(ROLES_F if g == "f" else ROLES_M)
            used.add(name)
            ents.append(Entity(f"{role}:{name}", "person", name, role, g))
        # look-alike: the same first name for two different people (identity vs similarity)
        self.lookalike_names = False
        if r.random() < 0.5:
            src = r.choice([e for e in ents if e.kind == "person"])
            roles = [x for x in (ROLES_F if src.gender == "f" else ROLES_M) if x != src.role]
            role = r.choice(roles)
            ents.append(Entity(f"{role}:{src.name}", "person", src.name, role, src.gender))
            self.lookalike_names = True
        for _ in range(r.randint(0, 2)):
            name = r.choice([p for p in ppool if p not in used] or ppool); used.add(name)
            ents.append(Entity(f"project:{name}", "project", name))
        self.entities = {e.key: e for e in ents}
        for e in ents:                            # true values of the world
            for a in O.NAMES:
                if self.applies(e, a) and r.random() < 0.35:
                    e.values[a] = r.choice(O.values(a, self.split))
        # merge scenario: the same person stored under two profiles with a duplicate record
        self.merge_pair = None
        if r.random() < 0.6:                      # owner decision 2026-11-02: 60 % of episodes (was 30 %)
            p = r.choice([e for e in ents if e.kind == "person"])
            role2 = r.choice([x for x in (ROLES_F if p.gender == "f" else ROLES_M) if x != p.role])
            dup = Entity(f"{role2}:{p.name}#dup", "person", p.name, role2, p.gender)
            dup.values = {}
            self.entities[dup.key] = dup
            self.merge_pair = (p.key, dup.key)

    def applies(self, e, a):
        t = O.APPLIES[a]
        return (e.kind == "user" and "user" in t) or (e.kind == "person" and "person" in t and a != "relationship to user") or \
            (e.kind == "project" and "project" in t)

    # ------------------------------------------------------------------ gold store helpers
    def new_fact(self):
        self.fact_n += 1
        return f"f{self.fact_n}"

    def store_records(self):
        return [r for r in self.brain.records.values()]

    def has(self, ek, a):
        return [r for r in self.brain.records.values() if r["entity"] == ek and r["attribute"] == a]

    def seed_store(self):
        """The Brain's state before the episode: earlier memories, including look-alike records."""
        r = self.rng
        n0 = r.randint(3, 10) if not self.long else r.randint(15, 40)
        cands = [(e, a) for e in self.entities.values() for a in e.values if not e.key.endswith("#dup")]
        r.shuffle(cands)
        for e, a in cands[:n0]:
            fid = self.new_fact()
            res = self.brain.add(e.key, e.text, {"attribute": a, "value": e.values[a], "kind": O.KIND[a],
                                                 "certainty": r.choice(["stated"] * 4 + ["implied"])}, rid=fid, provenance=fid)
            if res["action"] != "added":
                raise ValueError(f"seed record rejected by the Brain: {res}")
            self.brain.records[res["id"]]["evidence"] = r.randint(1, 3)
        # look-alike record: another entity with the same attribute and value as a user record
        user_recs = [x for x in self.brain.records.values() if x["entity"] == "user"]
        others = [e for e in self.entities.values() if e.kind == "person" and not e.key.endswith("#dup")]
        if user_recs and others and r.random() < 0.7:
            ur = r.choice(user_recs)
            o = r.choice([e for e in others if self.applies(e, ur["attribute"])] or [None])
            if o is not None and not self.has(o.key, ur["attribute"]):
                o.values[ur["attribute"]] = ur["value"]
                fid = self.new_fact()
                self.brain.add(o.key, o.text, {"attribute": ur["attribute"], "value": ur["value"], "kind": O.KIND[ur["attribute"]],
                                               "certainty": "stated"}, rid=fid, provenance=fid)
        if self.merge_pair:
            pk, dk = self.merge_pair
            p, d = self.entities[pk], self.entities[dk]
            a = r.choice([x for x in O.NAMES if self.applies(p, x) and x not in ("relationship to user",)])
            v = p.values.get(a) or r.choice(O.values(a, self.split))
            p.values[a] = v
            for e, ev in ((p, 2), (d, 1)):
                if not self.has(e.key, a):
                    fid = self.new_fact()
                    self.brain.add(e.key, e.text, {"attribute": a, "value": v, "kind": O.KIND[a], "certainty": "stated"}, rid=fid, provenance=fid)
                    self.brain.records[fid]["evidence"] = ev          # the real profile's copy wins the merge
            self.merge_attr = a

    # ------------------------------------------------------------------ temporary state (gold mirror of the adapter)
    def temp_prepare(self, now, session_changed):
        expired = []
        keep = []
        for it in self.temp:
            if session_changed and it["ttl"] == "SESSION":
                expired.append((it["id"], "session ended"))
            elif it["ttl"] == "UNTIL" and it["until"] is not None and now > it["until"]:
                expired.append((it["id"], "until passed"))
            elif now - it["created_at"] > 14 * DAY:
                expired.append((it["id"], "14-day cap"))
            else:
                keep.append(it)
        self.temp = keep
        ids = {i for i, _ in expired}
        if self.frame in ids:
            self.frame = None
        if self.pending and self.pending[0] in ids:
            self.pending = None
        return expired

    def temp_new(self, ttype, ttl, text, now, seg):
        self.temp_n += 1
        it = {"id": f"t{self.temp_n}", "type": ttype, "ttl": ttl, "until": resolve_until(text, now) if ttl == "UNTIL" else None,
              "created_at": now, "created_seg": seg, "text": text[:280]}
        self.temp.append(it)
        evicted = None
        while len(self.temp) > 8:
            sess = [i for i, x in enumerate(self.temp) if x["ttl"] == "SESSION"]
            v = min(sess or range(len(self.temp)), key=lambda i: self.temp[i]["created_seg"])
            evicted = self.temp.pop(v)["id"]
        return it, evicted

    def temp_get(self, tid):
        return next((x for x in self.temp if x["id"] == tid), None)

    def temp_drop(self, tid):
        self.temp = [x for x in self.temp if x["id"] != tid]
        if self.frame == tid:
            self.frame = None
        if self.pending and self.pending[0] == tid:
            self.pending = None

    # ------------------------------------------------------------------ mentions
    def mention_for(self, e, seg):
        """Choose how an entity is referred to; returns (style, text, dep_distance)."""
        r = self.rng
        if e.kind == "user":
            return None, None, 0
        last = self.last_mention.get(e.key)
        g_last = self.last_gender_mention.get(e.gender if e.kind == "person" else "n")
        style = "full"
        if last is not None and seg - last <= 3 and g_last and g_last[0] == e.key and r.random() < 0.45:
            style = "pronoun"
        elif last is not None and r.random() < 0.4:
            style = "alias"
            if any(o.key != e.key and o.kind == e.kind and (o.name == e.name or o.role == e.role) and not o.key.endswith("#dup")
                   for o in self.entities.values()):
                style = "full"                    # an alias would be ambiguous: use the full mention
        text = e.mention(r, style)
        dep = (seg - last) if style == "pronoun" else 0
        return style, text, dep

    def note_mention(self, e, seg, style):
        if e.kind == "user":
            return
        if style in ("full", "alias"):
            self.last_mention[e.key] = seg
        self.last_gender_mention[e.gender if e.kind == "person" else "n"] = (e.key, seg)

    # ------------------------------------------------------------------ the episode
    def plan(self, real_pool=None):
        r = self.rng
        self.build_world()
        self.seed_store()
        n_sess = r.randint(1, 3) if not self.long else r.randint(3, 6)
        t = T_START + r.uniform(0, 120 * DAY)
        segs, s_idx = [], 0
        lang_bias = r.random()            # some users write more Roman Urdu than others
        for sess in range(n_sess):
            if sess:
                t += r.uniform(6 * HOUR, 5 * DAY)
            n_seg = r.randint(3, 6) if not self.long else r.randint(5, 10)
            for k in range(n_seg):
                t += r.uniform(1 * MIN, 12 * MIN) if k else 0
                segs.append(self.segment(s_idx, f"s{sess + 1}", t, k == 0 and sess > 0, lang_bias, real_pool))
                s_idx += 1
        return {"world": {k: {"kind": e.kind, "name": e.name, "role": e.role, "text": e.text} for k, e in self.entities.items()},
                "lookalike_names": self.lookalike_names, "merge_pair": self.merge_pair, "segments": segs}

    def segment(self, s, sess_id, now, new_session, lang_bias, real_pool):
        r = self.rng
        expired = self.temp_prepare(now, new_session)
        if new_session:
            self.pending = None
        lang = "en"
        x = r.random()
        if x < 0.10 + 0.15 * lang_bias:
            lang = "ur"
        elif x < 0.20 + 0.2 * lang_bias:
            lang = "mixed"
        store_before = copy.deepcopy(self.store_records())
        self.seg_start_ids = {x["id"] for x in store_before}
        self.seg_start_store = store_before
        temp_before = copy.deepcopy(self.temp)
        seg = {"index": s, "session_id": sess_id, "at": now, "lang": lang, "beats": [], "units": [], "mentions": [],
               "retrieve": [], "merges": [], "expire": [], "gold_ops": [], "temp_ops": [], "categories": set(),
               "store_before": store_before, "temp_before": temp_before, "det_expired": expired}
        if lang != "en":
            seg["categories"].add("multilingual")
        if expired:
            seg["categories"].add("expired_context")
        # a pending offer from the previous segment must be answered first
        if self.pending:
            ev = "promote" if r.random() < 0.8 else "decline"
            getattr(self, "ev_" + ev)(seg, s, now)
        n_events = r.choice([1, 1, 1, 2, 2, 3])
        tried = 0
        while len([b for b in seg["beats"] if b["speaker"] == "user"]) < n_events and tried < 30:
            tried += 1
            ev = r.choices(list(WEIGHTS), weights=list(WEIGHTS.values()))[0]
            if ev == "real_distractor" and (not real_pool or seg["beats"]):
                continue
            ok = getattr(self, "ev_" + ev)(seg, s, now, real_pool) if ev == "real_distractor" else getattr(self, "ev_" + ev)(seg, s, now)
            if ok and ev == "real_distractor":
                break
        # the assistant replies (and sometimes offers to remember something: a PENDING item)
        if not seg.get("real"):
            if not self.pending and r.random() < 0.12:
                self.ev_offer(seg, s, now)
            else:
                seg["beats"].append({"speaker": "assistant", "act": "ack", "tags": []})
        seg["categories"] = sorted(seg["categories"])
        return seg

    # ------------------------------------------------------------------ unit / op helpers
    def add_unit(self, seg, beat, tag, **lab):
        u = {"tag": tag, **lab}
        seg["units"].append(u)
        beat["tags"].append({"tag": tag, "text": lab["value"], "exact": lab.get("exact", True)})
        return u

    def add_mention(self, seg, beat, e, style, text):
        mi = len(seg["mentions"])
        tag = f"m{mi}"
        seg["mentions"].append({"tag": tag, "entity": e.key, "style": style})
        beat["tags"].append({"tag": tag, "text": text, "exact": False})
        return mi

    def pick_entity(self, kinds=("user", "person"), need_attr=None, has_record=None):
        cands = [e for e in self.entities.values() if e.kind in kinds and not e.key.endswith("#dup")]
        if need_attr is not None:
            cands = [e for e in cands if self.applies(e, need_attr)]
        if has_record is not None:
            cands = [e for e in cands if bool([x for x in self.brain.records.values() if x["entity"] == e.key]) == has_record]
        return self.rng.choice(cands) if cands else None

    def target_for_write(self, e):
        """Gold address of a new fact about e: NEW-ATTR(e) when e has a profile in the store, else NEW-ENT."""
        # The model reads the store as it was at the start of the segment: a profile created earlier in this
        # segment is not addressable yet, so later facts about it in the same segment are NEW-ENT too.
        known = e.kind == "user" or any(x["entity"] == e.key for x in self.seg_start_store)
        return {"type": "new_attr", "entity": e.key} if known else {"type": "new_ent", "entity": e.key}

    def persist_write(self, seg, beat, e, a, v, cert, cat, dep=0, mention=None, src=None, tag=None, value_text=None):
        tgt = self.target_for_write(e)
        if tgt["type"] == "new_ent" and mention is None:
            return None
        fid = self.new_fact()
        tag = tag or f"u{len(seg['units'])}"
        u = self.add_unit(seg, beat, tag, value=value_text or v, route="PERSIST", kind=O.KIND[a], cert=cert, attr=a,
                          entity=e.key, target=tgt, rel=None, src=src, dep=dep, category=cat, mention=mention,
                          exact=value_text is None)
        res = self.brain.add(e.key, e.text, {"attribute": a, "value": v, "kind": O.KIND[a], "certainty": cert}, provenance=fid, rid=fid)
        if res["action"] != "added":
            raise ValueError(f"gold WRITE rejected by the Brain: {res}")
        seg["gold_ops"].append({"op": "WRITE", "fact": fid, "entity": e.key, "attribute": a, "value": v, "kind": O.KIND[a],
                                "certainty": cert, "new_entity": tgt["type"] == "new_ent", "unit": tag, "brain": res["action"]})
        e.values[a] = v
        return u

    def persist_update(self, seg, beat, rec, v, rel, cert, cat, dep=0, mention=None):
        e = self.entities[rec["entity"]]
        tag = f"u{len(seg['units'])}"
        self.add_unit(seg, beat, tag, value=v, route="PERSIST", kind=O.KIND[rec["attribute"]], cert=cert, attr=rec["attribute"],
                      entity=e.key, target={"type": "record", "fact": rec["id"]}, rel=rel, src=None, dep=dep, category=cat, mention=mention)
        op = {"op": "MERGE_INTO" if rel == "SAME" else "UPDATE", "fact": rec["id"], "entity": e.key, "attribute": rec["attribute"],
              "value": v, "certainty": cert, "subtype": rel, "unit": tag}
        res = self.brain.apply({"op": op["op"], "target": rec["id"], "challenge": rel == "CONTRADICTION",
                                "payload": {"attribute": rec["attribute"], "value": v, "certainty": cert}})
        op["brain"] = res["action"]
        seg["gold_ops"].append(op)
        if rel != "SAME" and res["action"] == "replaced":
            e.values[rec["attribute"]] = v

    # ------------------------------------------------------------------ events: persistent facts
    def ev_write(self, seg, s, now, cert="stated", cat="new_info"):
        r = self.rng
        e = self.pick_entity()
        if e is None or len(self.brain.records) >= self.max_store:
            return False
        attrs = [a for a in O.NAMES if self.applies(e, a) and not self.has(e.key, a)]
        if not attrs:
            return False
        a = r.choice(attrs)
        v = e.values.get(a) or r.choice(O.values(a, self.split))
        style, mtext, dep = self.mention_for(e, s)
        beat = {"speaker": "user", "act": "state" if cert == "stated" else "imply", "entity": e.key, "attr": a, "tags": []}
        mi = self.add_mention(seg, beat, e, style, mtext) if e.kind != "user" else None
        if self.persist_write(seg, beat, e, a, v, cert, cat, dep=dep, mention=mi) is None:
            return False
        beat["pronoun"] = style == "pronoun"
        seg["beats"].append(beat)
        seg["categories"].add(cat)
        if style == "pronoun" or style == "alias":
            seg["categories"].add("identity")
        self.note_mention(e, s, style)
        return True

    def ev_write_implied(self, seg, s, now):
        return self.ev_write(seg, s, now, cert="implied")

    def ev_project_write(self, seg, s, now):
        if not [e for e in self.entities.values() if e.kind == "project"]:
            return False
        r = self.rng
        e = self.pick_entity(kinds=("project",))
        attrs = [a for a in O.NAMES if self.applies(e, a) and not self.has(e.key, a)]
        if not attrs or len(self.brain.records) >= self.max_store:
            return False
        a = r.choice(attrs)
        v = e.values.get(a) or r.choice(O.values(a, self.split))
        style, mtext, dep = self.mention_for(e, s)
        beat = {"speaker": "user", "act": "state", "entity": e.key, "attr": a, "tags": []}
        mi = self.add_mention(seg, beat, e, style, mtext)
        if self.persist_write(seg, beat, e, a, v, "stated", "project", dep=dep, mention=mi) is None:
            return False
        seg["beats"].append(beat); seg["categories"] |= {"project", "new_info"}
        self.note_mention(e, s, style)
        return True

    def _existing(self, kinds=("user", "person", "project"), confirmed=None):
        """Records that existed before this segment (an update of a fact stated in the same breath is not a scenario)."""
        recs = [x for x in self.brain.records.values() if self.entities[x["entity"]].kind in kinds and not x["entity"].endswith("#dup")
                and x["id"] in self.seg_start_ids]
        if confirmed is not None:
            recs = [x for x in recs if (x["status"] == "confirmed") == confirmed]
        return recs

    def _ref_beat(self, seg, s, rec, act):
        e = self.entities[rec["entity"]]
        style, mtext, dep = self.mention_for(e, s)
        beat = {"speaker": "user", "act": act, "entity": e.key, "attr": rec["attribute"], "old": rec["value"], "tags": []}
        mi = self.add_mention(seg, beat, e, style, mtext) if e.kind != "user" else None
        beat["pronoun"] = style == "pronoun"
        if style in ("pronoun", "alias"):
            seg["categories"].add("identity")
        self.note_mention(e, s, style)
        return beat, mi, dep

    def ev_repeat(self, seg, s, now):
        recs = self._existing()
        if not recs:
            return False
        rec = self.rng.choice(recs)
        beat, mi, dep = self._ref_beat(seg, s, rec, "repeat")
        self.persist_update(seg, beat, rec, rec["value"], "SAME", "stated", "repeated", dep, mi)
        seg["beats"].append(beat); seg["categories"].add("repeated")
        return True

    def _new_value(self, rec):
        vals = [v for v in O.values(rec["attribute"], self.split) if v.lower() != str(rec["value"]).lower()]
        return self.rng.choice(vals) if vals else None

    def ev_change(self, seg, s, now):
        recs = self._existing()
        if not recs:
            return False
        rec = self.rng.choice(recs)
        v = self._new_value(rec)
        if v is None:
            return False
        beat, mi, dep = self._ref_beat(seg, s, rec, "change")
        cat = "preference_change" if O.KIND[rec["attribute"]] == "preference" else ("project" if self.entities[rec["entity"]].kind == "project" else "new_info")
        self.persist_update(seg, beat, rec, v, "UPDATE", "stated", cat, dep, mi)
        seg["beats"].append(beat); seg["categories"].add(cat)
        return True

    ev_project_change = ev_change

    def ev_contradict(self, seg, s, now):
        recs = self._existing(confirmed=True)
        if not recs:
            return False
        rec = self.rng.choice(recs)
        v = self._new_value(rec)
        if v is None:
            return False
        beat, mi, dep = self._ref_beat(seg, s, rec, "contradict")
        self.persist_update(seg, beat, rec, v, "CONTRADICTION", "stated", "contradiction", dep, mi)
        seg["beats"].append(beat); seg["categories"].add("contradiction")
        return True

    def ev_correct(self, seg, s, now):
        recs = self._existing()
        if not recs:
            return False
        rec = self.rng.choice(recs)
        v = self._new_value(rec)
        if v is None:
            return False
        beat, mi, dep = self._ref_beat(seg, s, rec, "correct")
        self.persist_update(seg, beat, rec, v, "CORRECTION", "stated", "correction", dep, mi)
        seg["beats"].append(beat); seg["categories"].add("correction")
        return True

    def ev_alias(self, seg, s, now):
        """A new fact about a known person, referred to by alias or pronoun (identity)."""
        cands = [e for e in self.entities.values() if e.kind == "person" and e.key in self.last_mention]
        if not cands:
            return False
        e = self.rng.choice(cands)
        attrs = [a for a in O.NAMES if self.applies(e, a) and not self.has(e.key, a)]
        if not attrs or len(self.brain.records) >= self.max_store:
            return False
        a = self.rng.choice(attrs)
        v = e.values.get(a) or self.rng.choice(O.values(a, self.split))
        style, mtext, dep = self.mention_for(e, s)
        beat = {"speaker": "user", "act": "state", "entity": e.key, "attr": a, "tags": [], "pronoun": style == "pronoun"}
        mi = self.add_mention(seg, beat, e, style, mtext)
        if self.persist_write(seg, beat, e, a, v, "stated", "identity", dep=dep, mention=mi) is None:
            return False
        seg["beats"].append(beat); seg["categories"] |= {"identity", "new_info"}
        self.note_mention(e, s, style)
        return True

    def ev_lookalike(self, seg, s, now):
        """A fact about person B with the same attribute and value as a record of somebody else (hard negative)."""
        recs = [x for x in self.brain.records.values() if not x["entity"].endswith("#dup") and x["id"] in self.seg_start_ids]
        r = self.rng
        r.shuffle(recs)
        for rec in recs:
            others = [e for e in self.entities.values() if e.key != rec["entity"] and e.kind in ("user", "person")
                      and not e.key.endswith("#dup") and self.applies(e, rec["attribute"]) and not self.has(e.key, rec["attribute"])]
            if not others or len(self.brain.records) >= self.max_store:
                continue
            e = r.choice(others)
            style, mtext, dep = self.mention_for(e, s)
            beat = {"speaker": "user", "act": "state_also", "entity": e.key, "attr": rec["attribute"], "tags": [],
                    "pronoun": style == "pronoun", "other": rec["entity"]}
            mi = self.add_mention(seg, beat, e, style, mtext) if e.kind != "user" else None
            if self.persist_write(seg, beat, e, rec["attribute"], rec["value"], "stated", "lookalike", dep=dep, mention=mi) is None:
                return False
            seg["beats"].append(beat); seg["categories"] |= {"lookalike", "new_info"}
            self.note_mention(e, s, style)
            return True
        return False

    # ------------------------------------------------------------------ events: ignored statements
    def _ignore(self, seg, s, cert, cat, act):
        r = self.rng
        e = self.user                     # templates attribute quotes/jokes in their own words; the unit is about the user
        a = r.choice([x for x in O.NAMES if self.applies(e, x)])
        v = r.choice(O.values(a, self.split))
        beat = {"speaker": "user", "act": act, "entity": e.key, "attr": a, "tags": []}
        mi = None
        if e.kind != "user":
            style, mtext, _ = self.mention_for(e, s)
            mi = self.add_mention(seg, beat, e, style, mtext); self.note_mention(e, s, style)
        self.add_unit(seg, beat, f"u{len(seg['units'])}", value=v, route="IGNORE", kind=O.KIND[a], cert=cert, attr=a,
                      entity=e.key, target=None, rel=None, src=None, dep=0, category=cat, mention=mi)
        seg["beats"].append(beat); seg["categories"].add(cat)
        return True

    def ev_joke(self, seg, s, now):
        return self._ignore(seg, s, "joking", "joke_hypothetical", "joke")

    def ev_quote(self, seg, s, now):
        return self._ignore(seg, s, "quoting", "joke_hypothetical", "quote")

    def ev_uncertain(self, seg, s, now):
        return self._ignore(seg, s, "hypothetical", "uncertain", "uncertain")

    def ev_frame_open(self, seg, s, now):
        if self.frame:
            return False
        a = self.rng.choice(["home city", "employer", "job title", "car", "holiday destination", "hobby"])
        v = self.rng.choice(O.values(a, self.split))
        beat = {"speaker": "user", "act": "frame_open", "entity": "user", "attr": a, "tags": []}
        tag = f"u{len(seg['units'])}"
        self.add_unit(seg, beat, tag, value=v, route="TEMP", kind=O.KIND[a], cert="hypothetical", attr=a, entity="user",
                      target=None, rel=None, src=None, dep=0, category="joke_hypothetical", tmp="NEW", ttype="FRAME", ttl="SESSION")
        it, ev = self.temp_new("FRAME", "SESSION", v, now, s)
        self.frame = it["id"]
        seg["temp_ops"].append({"op": "T-WRITE", "item": it["id"], "unit": tag, "evicted": ev})
        seg["beats"].append(beat); seg["categories"].add("joke_hypothetical")
        return True

    def ev_frame_cont(self, seg, s, now):
        it = self.temp_get(self.frame) if self.frame else None
        if not it or it["created_seg"] == s:
            return False
        a = self.rng.choice(["favourite food", "hobby", "car", "commute", "favourite drink", "neighbourhood"])
        v = self.rng.choice(O.values(a, self.split))
        beat = {"speaker": "user", "act": "frame_cont", "entity": "user", "attr": a, "frame_value": it["text"], "tags": []}
        self.add_unit(seg, beat, f"u{len(seg['units'])}", value=v, route="IGNORE", kind=O.KIND[a], cert="hypothetical", attr=a,
                      entity="user", target=None, rel=None, src=None, dep=s - it["created_seg"], category="joke_hypothetical")
        seg["beats"].append(beat); seg["categories"].add("joke_hypothetical")
        return True

    def ev_frame_close(self, seg, s, now):
        it = self.temp_get(self.frame) if self.frame else None
        if not it or it["created_seg"] == s:
            return False
        seg["beats"].append({"speaker": "user", "act": "frame_close", "frame_value": it["text"], "tags": []})
        seg["expire"].append({"item": it["id"], "dep": s - it["created_seg"]})
        seg["temp_ops"].append({"op": "T-EXPIRE", "item": it["id"]})
        self.temp_drop(it["id"])
        seg["categories"].add("expired_context")
        return True

    # ------------------------------------------------------------------ events: temporary state
    TEMP_PLANS = [  # (template value text, ttype, ttl)
        ("call the bank at 3pm today", "TASK", "UNTIL"), ("pick up the kids at 4pm today", "TASK", "UNTIL"),
        ("finish the slides by tonight", "TASK", "UNTIL"), ("dentist appointment tomorrow", "PLAN", "UNTIL"),
        ("dinner with my parents tonight", "PLAN", "UNTIL"), ("working from the cafe today", "CONTEXT", "UNTIL"),
        ("in Islamabad this week", "CONTEXT", "UNTIL"), ("fixing the login bug right now", "TASK", "SESSION"),
        ("on a train with bad signal", "CONTEXT", "SESSION"), ("writing my thesis chapter", "TASK", "OPEN"),
        ("renovating the kitchen", "TASK", "OPEN"), ("job hunting", "CONTEXT", "OPEN"), ("fasting today", "CONTEXT", "UNTIL"),
        ("send the invoice by 6pm", "TASK", "UNTIL"), ("meeting Hina at 5pm today", "PLAN", "UNTIL"),
        ("reviewing pull requests this afternoon", "TASK", "UNTIL"), ("packing for Skardu", "TASK", "OPEN"),
        ("waiting for a parcel today", "CONTEXT", "UNTIL"), ("on call this week", "CONTEXT", "UNTIL"),
        ("planning a surprise party for Saturday", "PLAN", "OPEN"),
    ]

    def ev_temp_plan(self, seg, s, now):
        plans = self.TEMP_PLANS
        cut = int(0.8 * len(plans))
        pool_ = plans if self.split in ("test", "stress") else plans[:cut]
        text, ttype, ttl = self.rng.choice(pool_)
        if any(x["text"] == text for x in self.temp):
            return False
        beat = {"speaker": "user", "act": "temp", "ttype": ttype, "tags": []}
        tag = f"u{len(seg['units'])}"
        self.add_unit(seg, beat, tag, value=text, route="TEMP", kind="context", cert="temporary", attr="OTHER", entity="user",
                      target=None, rel=None, src=None, dep=0, category="temp_plan", tmp="NEW", ttype=ttype, ttl=ttl)
        it, ev = self.temp_new(ttype, ttl, text, now, s)
        seg["temp_ops"].append({"op": "T-WRITE", "item": it["id"], "unit": tag, "evicted": ev})
        seg["beats"].append(beat); seg["categories"].add("temp_plan")
        return True

    UPDATES = ["make that 5pm", "push it to tomorrow", "actually 7pm instead", "move it to the evening", "make it 10am",
               "change of plan, Friday instead", "do it after lunch", "make it next week"]

    def ev_temp_update(self, seg, s, now):
        items = [x for x in self.temp if x["type"] in ("TASK", "PLAN") and x["ttl"] == "UNTIL" and x["created_seg"] < s]
        if not items:
            return False
        it = self.rng.choice(items)
        text = self.rng.choice(self.UPDATES)
        beat = {"speaker": "user", "act": "temp_update", "ref": it["text"], "tags": []}
        tag = f"u{len(seg['units'])}"
        self.add_unit(seg, beat, tag, value=text, route="TEMP", kind="context", cert="temporary", attr="OTHER", entity="user",
                      target=None, rel=None, src=None, dep=s - it["created_seg"], category="correction", tmp=it["id"],
                      ttype=it["type"], ttl=it["ttl"])
        it["text"] = " | ".join((it["text"].split(" | ") + [text])[-2:])[:280]
        seg["temp_ops"].append({"op": "T-UPDATE", "item": it["id"], "unit": tag})
        seg["beats"].append(beat); seg["categories"] |= {"correction", "temp_plan"}
        return True

    def ev_temp_done(self, seg, s, now):
        items = [x for x in self.temp if x["type"] in ("TASK", "PLAN", "CONTEXT") and x["created_seg"] < s]
        if not items:
            return False
        it = self.rng.choice(items)
        seg["beats"].append({"speaker": "user", "act": "temp_done", "ref": it["text"], "tags": []})
        seg["expire"].append({"item": it["id"], "dep": s - it["created_seg"]})
        seg["temp_ops"].append({"op": "T-EXPIRE", "item": it["id"]})
        self.temp_drop(it["id"])
        seg["categories"].add("expired_context")
        return True

    # ------------------------------------------------------------------ events: pending offer / promote / decline
    def ev_offer(self, seg, s, now):
        r = self.rng
        a = r.choice([x for x in O.NAMES if self.applies(self.user, x) and not self.has("user", x)
                      and O.KIND[x] in ("preference", "style", "routine")] or [None])
        if a is None:
            return False
        v = r.choice(O.values(a, self.split))
        beat = {"speaker": "assistant", "act": "offer", "attr": a, "tags": []}
        tag = f"u{len(seg['units'])}"
        self.add_unit(seg, beat, tag, value=v, route="TEMP", kind=O.KIND[a], cert="stated", attr=a, entity="user",
                      target=None, rel=None, src=None, dep=0, category="promote", tmp="NEW", ttype="PENDING", ttl="SESSION")
        it, ev = self.temp_new("PENDING", "SESSION", v, now, s)
        self.pending = (it["id"], a)
        seg["temp_ops"].append({"op": "T-WRITE", "item": it["id"], "unit": tag, "evicted": ev})
        seg["beats"].append(beat); seg["categories"].add("promote")
        return True

    def ev_promote(self, seg, s, now):
        if not self.pending:
            return False
        tid, a = self.pending
        it = self.temp_get(tid)
        if it is None:
            self.pending = None
            return False
        beat = {"speaker": "user", "act": "confirm", "tags": []}
        tag = f"u{len(seg['units'])}"
        u = self.persist_write(seg, beat, self.user, a, it["text"], "stated", "promote", dep=s - it["created_seg"], src=tid,
                               tag=tag, value_text="yes")
        seg["gold_ops"][-1]["promote"] = tid
        seg["temp_ops"].append({"op": "PROMOTE", "item": tid, "unit": tag})
        self.temp_drop(tid)
        seg["beats"].append(beat); seg["categories"].add("promote")
        return u is not None

    def ev_decline(self, seg, s, now):
        if not self.pending:
            return False
        tid, _ = self.pending
        it = self.temp_get(tid)
        seg["beats"].append({"speaker": "user", "act": "decline", "tags": []})
        if it:
            seg["expire"].append({"item": tid, "dep": s - it["created_seg"]})
            seg["temp_ops"].append({"op": "T-EXPIRE", "item": tid})
        self.temp_drop(tid)
        seg["categories"] |= {"promote", "expired_context"}
        return True

    # ------------------------------------------------------------------ events: forget, retrieve, merge, noise
    def ev_forget(self, seg, s, now):
        recs = self._existing()
        if not recs:
            return False
        rec = self.rng.choice(recs)
        e = self.entities[rec["entity"]]
        beat, mi, dep = self._ref_beat(seg, s, rec, "forget")
        tag = f"u{len(seg['units'])}"
        self.add_unit(seg, beat, tag, value=rec["attribute"], route="FORGET", kind=O.KIND[rec["attribute"]], cert="stated",
                      attr=rec["attribute"], entity=e.key, target={"type": "record", "fact": rec["id"]}, rel=None, src=None,
                      dep=dep, category="deletion", mention=mi, exact=False)
        self.brain.apply({"op": "FORGET", "target": rec["id"]})
        seg["gold_ops"].append({"op": "FORGET", "fact": rec["id"], "entity": e.key, "attribute": rec["attribute"], "unit": tag})
        seg["beats"].append(beat); seg["categories"].add("deletion")
        return True

    def ev_forget_profile(self, seg, s, now):
        ents = [e for e in self.entities.values() if e.kind == "person" and not e.key.endswith("#dup")
                and any(x["entity"] == e.key for x in self.seg_start_store)]      # addressable: in the segment-start store
        if not ents:
            return False
        e = self.rng.choice(ents)
        style, mtext, dep = self.mention_for(e, s)
        beat = {"speaker": "user", "act": "forget_profile", "entity": e.key, "tags": []}
        mi = self.add_mention(seg, beat, e, style, mtext)
        tag = f"u{len(seg['units'])}"
        self.add_unit(seg, beat, tag, value=mtext, route="FORGET", kind="fact", cert="stated", attr="OTHER", entity=e.key,
                      target={"type": "new_attr", "entity": e.key}, rel=None, src=None, dep=dep, category="deletion",
                      mention=mi, exact=False)
        self.brain.apply({"op": "FORGET_PROFILE", "entity": e.key})
        seg["gold_ops"].append({"op": "FORGET_PROFILE", "entity": e.key, "unit": tag})
        seg["beats"].append(beat); seg["categories"].add("deletion")
        self.note_mention(e, s, style)
        return True

    def ev_retrieve(self, seg, s, now):
        recs = self._existing()
        if not recs:
            return False
        rec = self.rng.choice(recs)
        beat, mi, dep = self._ref_beat(seg, s, rec, "ask")
        seg["retrieve"].append({"fact": rec["id"], "dep": dep})
        seg["beats"].append(beat); seg["categories"].add("retrieval")
        seg["answer"] = {"value": rec["value"]}
        return True

    def ev_merge(self, seg, s, now):
        if not self.merge_pair:
            return False
        pk, dk = self.merge_pair
        a = getattr(self, "merge_attr", None)
        recs = [x for x in self.brain.records.values() if x["attribute"] == a and x["entity"] in (pk, dk)]
        if len(recs) != 2:
            return False
        p, d = self.entities[pk], self.entities[dk]
        attrs = [x for x in O.NAMES if self.applies(p, x) and not self.has(pk, x)]
        if not attrs:
            return False
        a2 = self.rng.choice(attrs)
        v2 = p.values.get(a2) or self.rng.choice(O.values(a2, self.split))
        beat = {"speaker": "user", "act": "merge_reveal", "entity": pk, "dup_text": d.text, "attr": a2, "tags": []}
        mi = self.add_mention(seg, beat, p, "full", p.mention(self.rng, "full"))
        u = self.persist_write(seg, beat, p, a2, v2, "stated", "merge", mention=mi)       # the licensing gated unit (D1)
        if u is None:
            return False
        res = self.brain.apply({"op": "MERGE", "target": recs[0]["id"], "with": recs[1]["id"]})
        seg["merges"].append({"facts": [recs[0]["id"], recs[1]["id"]], "licensed_by": u["tag"]})
        seg["gold_ops"].append({"op": "MERGE", "facts": [recs[0]["id"], recs[1]["id"]], "kept": res.get("kept"), "licensed_by": u["tag"]})
        seg["beats"].append(beat); seg["categories"] |= {"merge", "identity"}
        self.merge_pair = None
        self.note_mention(p, s, "full")
        return True

    def ev_chitchat(self, seg, s, now):
        seg["beats"].append({"speaker": "user", "act": "chitchat", "tags": []})
        seg["categories"].add("irrelevant")
        return True

    def ev_real_distractor(self, seg, s, now, real_pool):
        row = self.rng.choice(real_pool)
        seg["beats"] = [{"speaker": "real", "act": "real", "turns": row["turns"], "source": row["source"], "tags": []}]
        seg["real"] = True
        seg["categories"].add("irrelevant")
        return True
