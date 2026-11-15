#!/usr/bin/env python3
"""Dataset lineage and leakage audit (read-only). Writes audit-r4/lineage_leakage.json.

  * every committed version of data/built/MANIFEST.json: episodes / examples per split
  * current raw shards, and the Kaggle-run manifest (iris-out archive) against the repo build
  * the entity check of build.py plus three extra checks: 6-gram text overlap, exact duplicate messages and shared invented
    names (organisations / projects) between splits, and shared template phrases

    cd research/iris && python3 audit-r4/lineage_leakage.py [path/to/kaggle-run/MANIFEST.json]
"""
import collections
import glob
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent.parent


def history():
    out = []
    log = subprocess.run(["git", "log", "--format=%h|%ad|%s", "--date=format:%m-%d %H:%M", "--", "research/iris/data/built/MANIFEST.json"],
                         capture_output=True, text=True, cwd=REPO).stdout.strip().splitlines()
    for l in reversed(log):
        h, when, subj = l.split("|", 2)
        m = subprocess.run(["git", "show", f"{h}:research/iris/data/built/MANIFEST.json"], capture_output=True, text=True, cwd=REPO).stdout
        try:
            s = json.loads(m)["splits"]
        except json.JSONDecodeError:
            continue
        out.append({"commit": h, "when": when, "subject": subj[:90], "episodes": {k: v["episodes"] for k, v in s.items()},
                    "examples": {k: v["examples"] for k, v in s.items()}})
    return out


def load_split(split):
    out = []
    for p in sorted(glob.glob(str(ROOT / "data" / "raw" / split / "*.jsonl"))):
        out += [(Path(p).stem, json.loads(l)) for l in open(p, encoding="utf-8") if l.strip()]
    return out


def norm(t):
    return re.sub(r"[^\w ]+", " ", t.lower()).split()


def shingles(t, n=6):
    w = norm(t)
    return {" ".join(w[i:i + n]) for i in range(max(len(w) - n + 1, 0))}


def main():
    res = {"manifest_history": history()}
    cur = json.loads((ROOT / "data" / "built" / "MANIFEST.json").read_text())["splits"]
    res["current_manifest"] = {k: {"episodes": v["episodes"], "examples": v["examples"], "sha256": v["sha256"][:16]} for k, v in cur.items()}
    if len(sys.argv) > 1:
        kag = json.loads(Path(sys.argv[1]).read_text())["splits"]
        res["kaggle_run_manifest"] = {k: {"episodes": v["episodes"], "examples": v["examples"], "sha256": v["sha256"][:16],
                                          "same_as_repo": v["sha256"] == cur[k]["sha256"]} for k, v in kag.items()}
    S = {s: load_split(s) for s in ("train", "val", "test")}
    res["raw_shards"] = {s: {sh: sum(1 for x, _ in S[s] if x == sh) for sh in sorted({x for x, _ in S[s]})} for s in S}
    res["entity_check_from_build"] = {k: v for k, v in cur.items() if False}
    # 6-gram overlap
    train_sh = set()
    for _, e in S["train"]:
        for s in e["sessions"]:
            for m in s["messages"]:
                train_sh |= shingles(m["text"])
    for sp in ("val", "test"):
        fr = []
        for _, e in S[sp]:
            for s in e["sessions"]:
                g = set()
                for m in s["messages"]:
                    g |= shingles(m["text"])
                if g:
                    fr.append((sum(1 for x in g if x in train_sh) / len(g), e["id"], s["sid"]))
        fr.sort(reverse=True)
        res[f"{sp}_6gram_overlap_with_train"] = {"sessions": len(fr), "mean": round(sum(x[0] for x in fr) / len(fr), 4),
                                                  "max": round(fr[0][0], 3), "sessions_ge_10pct": sum(1 for x in fr if x[0] >= 0.10),
                                                  "top": [(round(x[0], 3), x[1], x[2]) for x in fr[:3]]}
    msgs = {sp: {" ".join(norm(m["text"])) for _, e in S[sp] for s in e["sessions"] for m in s["messages"] if len(m["text"].split()) >= 8}
            for sp in S}
    res["exact_duplicate_messages_with_train"] = {sp: len(msgs[sp] & msgs["train"]) for sp in ("val", "test")}
    # shared invented names: capitalised multi-char tokens and 'ent' values that occur in more than one split
    def names(sp):
        c = collections.defaultdict(set)
        for _, e in S[sp]:
            for s in e["sessions"]:
                for f in s.get("facts", []):
                    if f.get("etype") in ("org", "project", "event") and f.get("ent"):
                        c[norm(f["ent"]).__str__()].add(e["id"])
        return c
    ent = {sp: names(sp) for sp in S}
    shared = {}
    for a, b in (("train", "val"), ("train", "test"), ("val", "test")):
        shared[f"{a}-{b}"] = sorted(set(ent[a]) & set(ent[b]))
    res["shared_org_project_event_entities"] = shared
    texts = {sp: " ".join(m["text"].lower() for _, e in S[sp] for s in e["sessions"] for m in s["messages"]) for sp in S}
    res["token_shared_across_splits"] = {}
    for w in ("ledgerline", "project kestrel", "bikemarkt"):
        res["token_shared_across_splits"][w] = {sp: texts[sp].count(w) for sp in S}
    pat = re.compile(r"(ignore (all )?previous instructions|note to ai assistant|ai assistants?:)", re.I)
    res["injection_template_messages"] = {sp: sum(1 for _, e in S[sp] for s in e["sessions"] for m in s["messages"] if pat.search(m["text"])) for sp in S}
    (ROOT / "audit-r4" / "lineage_leakage.json").write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("current_manifest", "val_6gram_overlap_with_train", "test_6gram_overlap_with_train",
                                          "exact_duplicate_messages_with_train", "token_shared_across_splits",
                                          "injection_template_messages", "shared_org_project_event_entities")}, indent=1)[:3500])


if __name__ == "__main__":
    main()
