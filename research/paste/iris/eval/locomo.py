"""LoCoMo extraction evaluation (internal research only; CC BY-NC 4.0, Maharana et al. 2024; results reported in the
non-commercial table, never used for training). Exploratory, LLM-free scoring against LoCoMo's per-session
`observation` annotations (natural-language facts per speaker with evidence turn ids).

Each session becomes one event (production batches events): speaker A is "the user", speaker B the other person;
lines are "User: ..." / "<B name>: ...". A system's stored observations for the session are compared with the
session's gold observations about speaker A:
  recall      share of gold observations about A matched by a stored memory (token F1 of the memory text or
              "slot value" >= 0.4 against the observation sentence, with A's name replaced by "the user")
  precision   share of stored memories that match any gold observation of the session (either speaker)

    python -m iris.eval.locomo --data locomo10.json --system iris|prodprompt|rules --out pred.jsonl [--base-url ...]
    python -m iris.eval.locomo --data locomo10.json --score pred.jsonl --out score.json
"""
import argparse
import ast
import datetime
import json
import os
import re
import time

from paste.evaluate import value_f1


def sessions(conv_rec):
    c = conv_rec["conversation"]
    a, b = c["speaker_a"], c["speaker_b"]
    obs = conv_rec.get("observation", {})
    k = 1
    while f"session_{k}" in c:
        turns = c[f"session_{k}"]
        when = c.get(f"session_{k}_date_time", "")
        text = "\n".join(f"{'User' if t['speaker'] == a else t['speaker']}: {t.get('text', '')}" for t in turns)
        raw = obs.get(f"session_{k}_observation", {})
        if isinstance(raw, str):
            try:
                raw = ast.literal_eval(raw)
            except Exception:
                raw = {}
        gold_a = [o[0] for o in raw.get(a, [])]
        gold_all = gold_a + [o[0] for o in raw.get(b, [])]
        yield {"conv": conv_rec["sample_id"], "session": k, "when": when, "a": a, "b": b, "text": text,
               "gold_a": gold_a, "gold_all": gold_all}
        k += 1


def parse_when(s):
    try:
        return datetime.datetime.strptime(s.strip(), "%I:%M %p on %d %B, %Y").replace(tzinfo=datetime.timezone.utc).timestamp()
    except Exception:
        return 1_683_000_000


def mem_texts(o, a_name):
    t = str(o.get("text", ""))
    return [t, f"{o.get('slot', '')} {o.get('value', '')}", t.replace("The user", a_name).replace("the user", a_name)]


def score(sess, out):
    a = sess["a"]
    mems = [o for o in (out or {}).get("observations", []) or [] if isinstance(o, dict) and
            o.get("certainty", "stated") in ("stated", "implied", "temporary")]
    gold_a = [g.replace(a, "the user") for g in sess["gold_a"]]
    gold_all = [g.replace(a, "the user") for g in sess["gold_all"]]
    hit = lambda g, m: max(value_f1(x, g) for x in mem_texts(m, "the user")) >= 0.4
    rec = sum(any(hit(g, m) for m in mems) for g in gold_a)
    prec = sum(any(hit(g, m) for g in gold_all) for m in mems)
    return {"gold": len(gold_a), "recalled": rec, "pred": len(mems), "supported": prec}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--system", choices=("rules", "prodprompt", "iris"))
    ap.add_argument("--score")
    ap.add_argument("--out", required=True)
    ap.add_argument("--base-url", default="http://127.0.0.1:8080/v1")
    ap.add_argument("--model", default="local")
    ap.add_argument("--extra-body", default="")
    ap.add_argument("--max-sessions", type=int, default=0)
    a = ap.parse_args()
    data = json.load(open(a.data))
    S = [s for c in data for s in sessions(c)]
    if a.score:
        preds = {(r["conv"], r["session"]): r["output"] for r in map(json.loads, open(a.score)) if not r.get("error")}
        rows = [score(s, preds[(s["conv"], s["session"])]) for s in S if (s["conv"], s["session"]) in preds]
        t = {k: sum(r[k] for r in rows) for k in ("gold", "recalled", "pred", "supported")}
        rep = {"sessions": len(rows), "licence": "CC BY-NC 4.0 (internal research only)", **t,
               "recall": round(t["recalled"] / max(1, t["gold"]), 4), "precision": round(t["supported"] / max(1, t["pred"]), 4),
               "memories_per_session": round(t["pred"] / max(1, len(rows)), 2)}
        json.dump(rep, open(a.out, "w"), indent=1); print(json.dumps(rep)); return
    from iris.baselines import run as R
    from iris.baselines.production import production_messages, rules_extract, to_iris
    from iris import schema as SC
    if a.extra_body:
        R.EXTRA.update(json.loads(a.extra_body))
    # failed calls (server down, malformed JSON) are not done: they are retried and never scored
    done = {(r["conv"], r["session"]) for r in map(json.loads, open(a.out)) if not r.get("error")} if os.path.exists(a.out) else set()
    n = 0
    with open(a.out, "a") as fh:
        for s in S:
            if (s["conv"], s["session"]) in done:
                continue
            if a.max_sessions and n >= a.max_sessions:
                break
            ev = {"source": "chat", "trust": "mixed", "at": parse_when(s["when"]), "text": s["text"]}
            t0, err = time.time(), ""
            try:
                if a.system == "rules":
                    out = to_iris(rules_extract([ev]))
                elif a.system == "prodprompt":
                    raw, _ = R.call(a.base_url, a.model, production_messages([ev], now=ev["at"])); out = to_iris(raw)
                else:
                    fake = {"at_iso": datetime.datetime.fromtimestamp(ev["at"], datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M"),
                            "source": "personal_chat", "trust": "mixed"}
                    raw, _ = R.call(a.base_url, a.model, R.iris_messages(fake, s["text"], [], [], {"user": {"name": s["a"]}}),
                                    schema=SC.EXTRACTION_SCHEMA)
                    out = raw
            except Exception as e:
                out, err = {"observations": [], "plans": []}, f"{type(e).__name__}: {str(e)[:160]}"
                if "Connection refused" in err or "URLError" in err:
                    raise SystemExit(f"model server unavailable: {err}")      # do not burn through sessions
            fh.write(json.dumps({"conv": s["conv"], "session": s["session"], "system": a.system, "model": a.model, "output": out,
                                 "error": err, "seconds": round(time.time() - t0, 1)}) + "\n"); fh.flush()
            n += 1


if __name__ == "__main__":
    main()
