"""Re-apply production's guard (check_extraction) to stored production-baseline rows that were produced before the
guard was ported (2026-11-05). Uses the stored raw model answer when present, else the stored output (same fields).

    python -m iris.baselines.reguard --pred P.jsonl --out P2.jsonl (--lives L.jsonl --rendered R.jsonl | --locomo locomo10.json)
"""
import argparse
import json

from .production import check_extraction, to_iris
from .run import SOURCE_MAP, event_text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--lives")
    ap.add_argument("--rendered")
    ap.add_argument("--locomo")
    a = ap.parse_args()
    texts = {}
    if a.locomo:
        from iris.eval.locomo import parse_when, sessions
        for c in json.load(open(a.locomo)):
            for s in sessions(c):
                texts[(s["conv"], s["session"])] = {"source": "chat", "trust": "mixed", "at": parse_when(s["when"]), "text": s["text"]}
    else:
        rend = {(r["life_id"], r["event_id"]): r for r in map(json.loads, open(a.rendered)) if r.get("ok")}
        for life in map(json.loads, open(a.lives)):
            for ev in life["events"]:
                k = (life["life_id"], ev["event_id"])
                if ev["render"] == "llm" and k not in rend:
                    continue
                src, trust = SOURCE_MAP[ev["source"]]
                texts[k] = {"source": src, "trust": trust, "at": ev["at"], "text": event_text(ev, rend.get(k))}
    n = 0
    with open(a.out, "w") as fh:
        for r in map(json.loads, open(a.pred)):
            k = (r["conv"], r["session"]) if "conv" in r else (r.get("life_id"), r.get("event_id"))
            if r.get("error") or k not in texts or r.get("system") not in ("prodprompt", "rules"):
                fh.write(json.dumps(r) + "\n"); continue
            ans = r.get("raw") or r["output"]
            r = dict(r, output=to_iris(check_extraction(ans, [texts[k]])), guarded=True)
            fh.write(json.dumps(r) + "\n"); n += 1
    print(json.dumps({"reguarded": n}))


if __name__ == "__main__":
    main()
