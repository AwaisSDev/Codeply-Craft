"""Re-apply the current verifier to stored renders (same fact sheets, current forbidden-list rules), so generators
rendered under an earlier verifier version are compared under one rule. Only the last attempt's turns are stored for a
failed event, so a re-verified failure may pass; a pass is re-checked too.

    python -m iris.render.reverify --lives L.jsonl --rendered R.jsonl --out R2.jsonl
"""
import argparse
import json

from .render import extra_forbidden
from .verify import verify


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lives", required=True)
    ap.add_argument("--rendered", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    lives = {l["life_id"]: l for l in map(json.loads, open(a.lives))}
    evs = {(lid, e["event_id"]): e for lid, l in lives.items() for e in l["events"]}
    n = ok = 0
    with open(a.out, "w") as fh:
        for r in map(json.loads, open(a.rendered)):
            ev = evs[(r["life_id"], r["event_id"])]
            life = lives[r["life_id"]]
            ctx = {x.lower() for x in life.get("projects", []) + [life.get("org", ""), life.get("school", "")] if x}
            purpose = ev["fact_sheet"]["purpose"].lower()
            old = {v for v in ev["fact_sheet"]["must_not_contain"] if v.lower() not in ctx and v.lower() not in purpose}
            ev = dict(ev, fact_sheet=dict(ev["fact_sheet"], must_not_contain=sorted(old | set(extra_forbidden(life, ev)))))
            good, reasons, spans = verify(ev, r["turns"]) if r.get("turns") else (False, ["no turns"], [])
            gate_fail = [x for x in r.get("reasons", []) if x.startswith("meaning")]   # a meaning-gate rejection stands
            if gate_fail:
                good, reasons = False, reasons + gate_fail
            fh.write(json.dumps(dict(r, ok=good, reasons=reasons, spans=spans, reverified=True)) + "\n")
            n += 1; ok += good
    print(json.dumps({"events": n, "ok": ok, "pass_rate": round(ok / max(1, n), 3)}))


if __name__ == "__main__":
    main()
