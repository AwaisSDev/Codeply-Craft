"""Build the candidate pool of real-text examples for Claude labelling.

  python build.py --raw <dir with the downloads> --out ../data/pool.jsonl [--seed 1]

Every example is in the evaluation harness's format ({id, task, input: {events,
known, now, tz}, ...}) plus `source` provenance: dataset, licence, url,
revision, file, sha256 of the file, original id, turns used. Nothing here is
labelled; known memories for merge examples are added later (merge.py), from
labels. Same inputs + same seed -> same pool.

Sources (licences in ../DATA-SOURCES.md):
  wildchat  allenai/WildChat-1M, ODC-BY: real users talking to an assistant
  multiwoz  MultiWOZ 2.2, MIT: bookings, plans with days and times
  topical   Topical-Chat, CDLA-Sharing-1.0: human-human chat (as "heard")
  romanurdu UCI Roman Urdu Data Set (458), CC BY 4.0: real Roman Urdu text
"""
import argparse
import csv
import glob
import hashlib
import json
import os
import random
import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

SOURCES = {
    "wildchat": {"dataset": "allenai/WildChat-1M", "licence": "ODC-BY-1.0", "url": "https://huggingface.co/datasets/allenai/WildChat-1M",
                 "revision": "7d6490e462285cf85d91eabea0f9a954fbddcd1f"},
    "multiwoz": {"dataset": "MultiWOZ 2.2", "licence": "MIT", "url": "https://github.com/budzianowski/multiwoz/tree/master/data/MultiWOZ_2.2",
                 "revision": "master"},
    "topical": {"dataset": "Topical-Chat", "licence": "CDLA-Sharing-1.0", "url": "https://github.com/alexa/Topical-Chat", "revision": "master"},
    "romanurdu": {"dataset": "UCI Roman Urdu Data Set (458)", "licence": "CC-BY-4.0", "url": "https://archive.ics.uci.edu/dataset/458", "revision": "uci-458"},
}
# Target sizes of the candidate pool (the labelled set is drawn from it).
TARGET = {"wildchat": 3600, "multiwoz": 700, "topical": 450, "romanurdu": 450}
TZS = ["Asia/Karachi"] * 3 + ["Europe/London", "America/New_York", "Asia/Dubai", "America/Los_Angeles", "Asia/Kolkata"]
NAMES = ["Sana", "Bilal", "Hira", "Omar", "Ayesha", "Daniel", "Priya", "Tom", "Fatima", "Kamran", "Leila", "Jake", "Nadia", "Ravi", "Zainab", "Chris"]

DISCLOSE = re.compile(r"\b(i|i'm|im|i've|ive|my|we|our|me)\b", re.I)
PERSONAL = re.compile(r"\b(prefer|like|love|hate|can't stand|work|job|boss|team|project|startup|company|client|live|moved|wife|husband|son|daughter|"
                      r"kids?|mom|mum|dad|brother|sister|friend|girlfriend|boyfriend|tomorrow|tonight|meeting|deadline|exam|usually|always|never|"
                      r"allerg|vegetarian|vegan|diet|gym|studying|student|university|college|school|birthday|wedding|trip|flight|budget|salary)", re.I)
ALL_WILDCHAT = False  # --wildchat-all: every English candidate, for screening (pool v2)
TEMPORAL = re.compile(r"\b(today|tonight|right now|at the moment|for now|currently|this week|this weekend|till|until|back by|on leave|out of office|"
                      r"sick|abhi|aaj|is hafte|kal tak)\b", re.I)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def clean(s, limit):
    s = re.sub(r"[ \t]+", " ", str(s).replace("\r", "")).strip()
    s = " / ".join(x.strip() for x in s.split("\n") if x.strip())
    if len(s) > limit:
        cut = s[:limit]
        m = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
        s = (cut[: m + 1] if m > limit * 0.5 else cut.rsplit(" ", 1)[0]) + " …"
    return s


def make_now(rng):
    tz = rng.choice(TZS)
    day = datetime(2026, 11, 1) + timedelta(days=rng.randrange(0, 50))
    local = day.replace(hour=rng.randrange(8, 23), minute=rng.randrange(0, 60), tzinfo=ZoneInfo(tz))
    return local, tz


def example(rng, src, oid, events_text, kind_of_event, file, digest, turns, extra=None):
    local, tz = make_now(rng)
    now = local.astimezone(ZoneInfo("UTC"))
    evs = []
    ago = rng.randrange(1, 120)
    for i, (text, source) in enumerate(zip(events_text, kind_of_event)):
        at = now - timedelta(minutes=ago * (len(events_text) - i))
        evs.append({"source": source, "trust": {"chat": "user", "email": "external", "heard": "mixed"}[source],
                    "at": at.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "text": text})
    ex = {"id": f"rl-{src}-{hashlib.sha1(str(oid).encode()).hexdigest()[:10]}", "task": "labelled", "split": "train-real", "unseen": False,
          "input": {"events": evs, "known": [], "now": now.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "tz": tz}, "target": None, "expect": {},
          "source": {**SOURCES[src], "file": file, "sha256": digest, "original_id": str(oid), "turns": turns}}
    ex["route"] = "opus-temporary" if TEMPORAL.search(" ".join(events_text)) else "sonnet"
    if extra:
        ex.update(extra)
    return ex


def chat_text(turns):
    return "\n".join(f"{'User' if r == 'user' else 'Assistant'}: {t}" for r, t in turns)


def wildchat(raw, rng):
    import pyarrow.parquet as pq
    files = sorted(glob.glob(os.path.join(raw, "wildchat", "*.parquet")))
    out_pos, out_rand = [], []
    for f in files:
        digest = sha256(f)
        t = pq.read_table(f, columns=["conversation_hash", "conversation", "language", "toxic"])
        for row in t.to_pylist():
            if row["language"] != "English" or str(row["toxic"]) == "True":
                continue
            conv = row["conversation"]
            turns = []
            n_user = rng.choice([1, 1, 2, 2, 3])
            for c in conv:
                role = c.get("role")
                if role == "user":
                    if sum(1 for r, _ in turns if r == "user") >= n_user:
                        break
                    turns.append(("user", clean(c.get("content", ""), 1200)))
                elif role == "assistant" and turns:
                    turns.append(("assistant", clean(c.get("content", ""), 280)))
            if not turns or len(turns[0][1]) < 15:
                continue
            user = " ".join(t for r, t in turns if r == "user")
            ex = example(rng, "wildchat", row["conversation_hash"], [chat_text(turns)], ["chat"], os.path.basename(f), digest, len(turns))
            (out_pos if DISCLOSE.search(user) and PERSONAL.search(user) else out_rand).append(ex)
    if ALL_WILDCHAT:
        rows = out_pos + out_rand
        rows.sort(key=lambda r: r["id"])
        seen = set()
        return [r for r in rows if not (r["id"] in seen or seen.add(r["id"]))]  # WildChat repeats some conversation hashes
    rng.shuffle(out_pos)
    rng.shuffle(out_rand)
    n = TARGET["wildchat"]
    k = min(len(out_pos), n * 2 // 3)  # oversample self-disclosure; keep real negatives too
    return out_pos[:k] + out_rand[: n - k]


def multiwoz(raw, rng):
    out = []
    for f in sorted(glob.glob(os.path.join(raw, "multiwoz", "dialogues_*.json"))):
        digest = sha256(f)
        for d in json.load(open(f)):
            k = rng.randrange(4, 9)
            turns = [("user" if t["speaker"] == "USER" else "assistant", clean(t["utterance"], 400)) for t in d["turns"][:k]]
            out.append(example(rng, "multiwoz", d["dialogue_id"], [chat_text(turns)], ["chat"], os.path.basename(f), digest, len(turns)))
    rng.shuffle(out)
    return out[: TARGET["multiwoz"]]


def topical(raw, rng):
    f = os.path.join(raw, "topical", "train.json")
    digest = sha256(f)
    data = json.load(open(f))
    out = []
    for cid, c in data.items():
        a, b = rng.sample(NAMES, 2)
        start = rng.randrange(0, max(1, len(c["content"]) - 6))
        msgs = c["content"][start: start + rng.randrange(3, 7)]
        lines = " / ".join(f"{a if m['agent'] == 'agent_1' else b}: {clean(m['message'], 300)}" for m in msgs)
        out.append(example(rng, "topical", f"{cid}#{start}", [f"Heard around the user: {lines}"], ["heard"], "conversations/train.json", digest, len(msgs)))
    rng.shuffle(out)
    return out[: TARGET["topical"]]


def romanurdu(raw, rng):
    f = os.path.join(raw, "romanurdu", "Roman Urdu DataSet.csv")
    digest = sha256(f)
    out = []
    for i, row in enumerate(csv.reader(open(f, encoding="utf-8", errors="replace"))):
        if not row or len(row[0].strip()) < 25:
            continue
        ex = example(rng, "romanurdu", f"row{i}", [f"User: {clean(row[0], 600)}"], ["chat"], "Roman Urdu DataSet.csv", digest, 1)
        out.append(ex)
    rng.shuffle(out)
    return out[: TARGET["romanurdu"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--wildchat-all", action="store_true", help="write every English WildChat candidate (pool v2 screening input)")
    a = ap.parse_args()
    if a.wildchat_all:
        global ALL_WILDCHAT
        ALL_WILDCHAT = True
        rows = wildchat(a.raw, random.Random(f"{a.seed}-wildchat"))
        with open(a.out, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"wildchat candidates: {len(rows)} -> {a.out}")
        return
    pool = []
    for name, fn in [("wildchat", wildchat), ("multiwoz", multiwoz), ("topical", topical), ("romanurdu", romanurdu)]:
        rows = fn(a.raw, random.Random(f"{a.seed}-{name}"))
        print(f"{name}: {len(rows)} (opus-temporary route {sum(r['route'] != 'sonnet' for r in rows)})")
        pool += rows
    seen = set()
    pool = [r for r in pool if not (r["id"] in seen or seen.add(r["id"]))]
    random.Random(a.seed).shuffle(pool)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        for r in pool:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"pool: {len(pool)} -> {a.out}")


if __name__ == "__main__":
    main()
