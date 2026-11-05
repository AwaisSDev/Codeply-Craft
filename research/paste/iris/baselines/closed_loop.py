"""Closed-loop run of an extraction system over rendered lives (IrisBench, IRIS-DESIGN §3.4): before each event the
system sees ITS OWN store (iris.eval.pipeline.Store: ids s<i>), not the gold, so errors compound over the life as in
production. Outputs per event (for iris.eval.extraction) plus the end-of-life pipeline score (iris.eval.pipeline).

    python -m iris.baselines.closed_loop --lives L.jsonl --rendered R.jsonl --system iris|prodprompt|rules --out pred.jsonl
        [--base-url ...] [--model ...] [--extra-body JSON] [--max-lives N]
"""
import argparse
import json
import os
import time

from iris import schema as S
from iris.eval.pipeline import Store

from . import run as R
from .production import production_messages, rules_extract, to_iris


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lives", required=True)
    ap.add_argument("--rendered", required=True)
    ap.add_argument("--system", required=True, choices=("rules", "prodprompt", "iris"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default="local")
    ap.add_argument("--extra-body", default="")
    ap.add_argument("--max-lives", type=int, default=0)
    a = ap.parse_args()
    if a.extra_body:
        R.EXTRA.update(json.loads(a.extra_body))
    rend = {(r["life_id"], r["event_id"]): r for r in map(json.loads, open(a.rendered)) if r.get("ok")}
    done_lives = set()
    if os.path.exists(a.out):
        for r in map(json.loads, open(a.out)):
            if r.get("life_done"):
                done_lives.add(r["life_id"])
    n = 0
    with open(a.out, "a") as fh:
        for line in open(a.lives):
            life = json.loads(line)
            if life["life_id"] in done_lives:
                continue
            if a.max_lives and n >= a.max_lives:
                break
            st = Store()
            for ev in life["events"]:
                key = (life["life_id"], ev["event_id"])
                if ev["render"] == "llm" and key not in rend:
                    continue                                # unverified render: event skipped for every system alike
                text = R.event_text(ev, rend.get(key))
                src, trust = R.SOURCE_MAP[ev["source"]]
                pev = {"source": src, "trust": trust, "at": ev["at"], "text": text}
                known = [{"id": m["id"], "entity": m["entity"], "slot": m["slot"], "value": m["value"], "kind": m["kind"]} for m in st.known()]
                plans = [{"id": f"sp{i}", **{k: p.get(k, "") for k in ("what", "when", "where", "status")}} for i, p in enumerate(st.plans[-20:])]
                t0, err = time.time(), ""
                try:
                    if a.system == "rules":
                        out = to_iris(rules_extract([pev]))
                    elif a.system == "prodprompt":
                        raw, _ = R.call(a.base_url, a.model, production_messages([pev], known=known, now=ev["at"], projects=life["projects"]))
                        out = to_iris(raw)
                    else:
                        raw, _ = R.call(a.base_url, a.model, R.iris_messages(ev, text, known, plans, life), schema=S.EXTRACTION_SCHEMA)
                        out = raw
                except Exception as e:
                    raise SystemExit(f"{life['life_id']} {ev['event_id']}: {type(e).__name__}: {str(e)[:160]} "
                                     f"(life aborted; it restarts from its first event on resume)")
                st.apply(out, ev["at"])
                fh.write(json.dumps({"life_id": life["life_id"], "event_id": ev["event_id"], "system": a.system, "model": a.model,
                                     "output": out, "error": err, "seconds": round(time.time() - t0, 2)}) + "\n"); fh.flush()
            fh.write(json.dumps({"life_id": life["life_id"], "life_done": True}) + "\n"); fh.flush()
            n += 1


if __name__ == "__main__":
    main()
