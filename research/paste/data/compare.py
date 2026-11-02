"""Programmatic vs API realisation of the same plans (owner decision 2: compare, do not assume).

    python -m data.compare --prog <pilot-programmatic.jsonl> --api <pilot-api.jsonl> --train <train-programmatic.jsonl>

Diversity (user turns of segments with units):
  distinct-n (unique n-grams / total), vocabulary, mean words per turn, gzip compression ratio, and skeleton reuse:
  the share of turns whose text, with every labelled span replaced by a placeholder, occurs more than once.
Shortcut probe (no GPU): a multinomial naive Bayes on the +-6 words around each unit, trained on programmatic
training data, predicting the unit's route (PERSIST/TEMP/IGNORE/FORGET) and, for record targets, its relation.
Evaluated on the programmatic and the API wording of the same pilot plans. A large drop on API text means the
templates carry surface cues that real wording does not.
"""
import argparse
import collections
import gzip
import json
import math
import re

WORD = re.compile(r"[a-z0-9']+")


def load(f):
    return [json.loads(l) for l in open(f)]


def user_turns(eps):
    out = []
    for ep in eps:
        for s in ep["segments"]:
            if not s["units"] or any(p.get("act") == "real" for p in s.get("plan", [])):
                continue
            spans = sorted([u["char_span"] for u in s["units"]] + [m["char_span"] for m in s["mentions"]])
            txt = s["text"]
            skel, last = [], 0
            for a, b in spans:
                if a < last:
                    continue
                skel.append(txt[last:a]); skel.append("<X>"); last = b
            skel.append(txt[last:])
            for line in "".join(skel).split("\n"):
                if line.startswith("User: "):
                    out.append(line[6:])
    return out


def diversity(eps):
    turns = user_turns(eps)
    toks = [WORD.findall(t.lower()) for t in turns]
    res = {"user_turns": len(turns), "mean_words": round(sum(map(len, toks)) / max(1, len(toks)), 1),
           "vocabulary": len({w for t in toks for w in t})}
    for n in (1, 2, 3):
        grams = [tuple(t[i:i + n]) for t in toks for i in range(len(t) - n + 1)]
        res[f"distinct_{n}"] = round(len(set(grams)) / max(1, len(grams)), 3)
    blob = "\n".join(turns).encode()
    res["gzip_ratio"] = round(len(gzip.compress(blob)) / max(1, len(blob)), 3)
    c = collections.Counter(t.lower().strip(" .!?") for t in turns)
    res["skeleton_reuse"] = round(sum(v for v in c.values() if v > 1) / max(1, len(turns)), 3)
    return res


PRONOUNS = {"she", "he", "it", "her", "him", "his", "its", "hers", "woh", "unka", "unki", "uska", "uski", "inka", "inki"}
ROLE_WORDS = {  # English and Roman Urdu ways to name each role (a full mention must name the role)
    "sister": {"sister", "sis", "behen", "behn", "baji", "apa", "apii", "api"}, "brother": {"brother", "bro", "bhai", "bhaiya"},
    "mother": {"mother", "mom", "mum", "ammi", "amma", "maa", "walida", "ami"}, "father": {"father", "dad", "abbu", "abba", "walid", "abu"},
    "friend": {"friend", "dost"}, "uncle": {"uncle", "chacha", "mamu", "mamoo", "taya", "khalu", "phuppa"},
    "aunt": {"aunt", "auntie", "aunty", "khala", "phuppo", "chachi", "mumani"}, "neighbour": {"neighbour", "neighbor", "parosi", "padosi", "parosan", "hamsaya"},
    "coworker": {"coworker", "co-worker", "colleague", "saathi"}, "cousin": {"cousin", "kazan"}, "manager": {"manager", "boss"},
    "landlord": {"landlord", "malik"}, "landlady": {"landlady", "malkin"}, "teacher": {"teacher", "ustad", "ustani", "miss", "sir"},
    "trainer": {"trainer", "coach"}}
STRAY_EXCLUDE = {"relationship to user", "lead"}       # role words and person names, not facts


def fidelity(eps):
    """Mention-style violations, and ontology values in user text outside every labelled span (possible unlabelled
    facts), excluding values the plan itself mentions (old values of changes and corrections, frame premises,
    other units of the segment)."""
    from data import ontology as O
    vals = sorted({v.lower() for c in O.CLASSES if c[0] not in STRAY_EXCLUDE for v in c[3] if len(v) >= 4}, key=len, reverse=True)
    m_total = m_bad = 0
    stray, segs = 0, 0
    examples = []
    for ep in eps:
        world = ep["world"]
        for s in ep["segments"]:
            if any(p.get("act") == "real" for p in s.get("plan", [])):
                continue
            segs += 1
            for m in s["mentions"]:
                m_total += 1
                ent = world[m["entity"]]; t = m["text"].lower()
                words = set(WORD.findall(t))
                if m["style"] == "full" and ent["kind"] == "person" and not (words & ROLE_WORDS.get(ent["role"], {ent["role"]})):
                    m_bad += 1; examples.append(("full mention without role", m["text"], ent["text"]))
                elif m["style"] == "pronoun" and t not in PRONOUNS:
                    m_bad += 1; examples.append(("pronoun mention not a pronoun", m["text"], ent["text"]))
            allowed = {str(u["value"]).lower() for u in s["units"]} | {str(u["text"]).lower() for u in s["units"]}
            for b in s.get("plan", []):
                for k in ("old", "frame_value", "ref"):
                    if b.get(k):
                        allowed |= {x.strip().lower() for x in str(b[k]).split("|")}
            masked = list(s["text"].lower())
            for x in s["units"] + s["mentions"]:
                for i in range(*x["char_span"]):
                    masked[i] = " "
            user = "\n".join(l for l in "".join(masked).split("\n") if l.startswith("user:"))
            for v in vals:
                if v in allowed or any(v in a for a in allowed):     # part of a value the plan already uses
                    continue
                if re.search(r"(?<![a-z0-9])" + re.escape(v) + r"(?![a-z0-9])", user):
                    stray += 1; examples.append(("value outside spans", v, s["text"][:120].replace("\n", " | ")))
                    break
    return {"mentions": m_total, "mention_style_violations": m_bad, "mention_violation_rate": round(m_bad / max(1, m_total), 3),
            "segments": segs, "segments_with_stray_values": stray, "stray_rate": round(stray / max(1, segs), 3),
            "examples": examples[:8]}


def unit_examples(eps, rel=False):
    xs = []
    for ep in eps:
        for s in ep["segments"]:
            for u in s["units"]:
                if rel and not (u.get("target") and u["target"]["type"] == "record" and u["route"] == "PERSIST"):
                    continue
                a, b = u["char_span"]
                left = WORD.findall(s["text"][:a].lower())[-6:]
                right = WORD.findall(s["text"][b:].lower())[:6]
                feats = [f"L:{w}" for w in left] + [f"R:{w}" for w in right]
                xs.append((feats, u["rel"] if rel else u["route"]))
    return xs


class NB:
    def fit(self, data):
        self.cls = collections.Counter(y for _, y in data)
        self.cnt = collections.defaultdict(collections.Counter)
        for f, y in data:
            self.cnt[y].update(f)
        self.vocab = {w for c in self.cnt.values() for w in c}
        self.tot = {y: sum(c.values()) for y, c in self.cnt.items()}
        return self

    def predict(self, f):
        n = sum(self.cls.values()); V = len(self.vocab)
        def score(y):
            return math.log(self.cls[y] / n) + sum(math.log((self.cnt[y][w] + 1) / (self.tot[y] + V)) for w in f)
        return max(self.cls, key=score)

    def acc(self, data):
        return round(sum(self.predict(f) == y for f, y in data) / max(1, len(data)), 3) if data else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prog", required=True)
    ap.add_argument("--api", required=True)
    ap.add_argument("--train", required=True)
    ap.add_argument("--json")
    a = ap.parse_args()
    prog, api, train = load(a.prog), load(a.api), load(a.train)
    ids = {ep["id"] for ep in api}
    prog_same = [ep for ep in prog if ep["id"] in ids]          # identical plans, two wordings
    res = {"episodes_compared": len(prog_same),
           "diversity": {"programmatic": diversity(prog_same), "api": diversity(api)}}
    res["fidelity"] = {"programmatic": fidelity(prog_same), "api": fidelity(api)}
    route = NB().fit(unit_examples(train)); rel = NB().fit(unit_examples(train, rel=True))
    majority_route = max(collections.Counter(y for _, y in unit_examples(prog_same)).values()) / max(1, len(unit_examples(prog_same)))
    res["shortcut_probe_trained_on_programmatic_train"] = {
        "route_accuracy": {"programmatic": route.acc(unit_examples(prog_same)), "api": route.acc(unit_examples(api)),
                           "majority_baseline": round(majority_route, 3)},
        "relation_accuracy": {"programmatic": rel.acc(unit_examples(prog_same, True)), "api": rel.acc(unit_examples(api, True))}}
    print(json.dumps(res, indent=1))
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1)


if __name__ == "__main__":
    main()
