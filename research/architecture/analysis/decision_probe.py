"""Can a classifier on frozen features make the decisions the generative model gets wrong?

Each example with at most one gold observation gets one decision label:
  none      nothing to keep (noise, injection without a plan, small talk)
  plan      a plan and no observation
  stated / implied / temporary / joking / hypothetical / quoting
            the certainty of its one observation
and, for examples with an observation, its kind.

Features (the events' text only; no prompt, no known memories):
  tfidf     word 1-2 grams + char 2-5 grams (a template detector)
  <name>    mean-pooled hidden states from a llama-server --embedding endpoint
            (e.g. nomic-embed 137M encoder, LFM3-1.7B decoder)
A logistic regression is trained on a sample of train and scored on the
full generated test set, its unseen-template part, and the hand-written gold
set. The generative model's own decision (from its raw answers in an
evaluation run) is scored on the same examples where it has answers.

  venv/bin/python -I decision_probe.py --emb nomic=18092:"classification: " --emb lfm3=18091 \
      --gen ml/results/details/local_lfm3-1.7b-qad-q4-test-mini-p2.jsonl,ml/results/details/local_lfm3-1.7b-qad-q4-gold-p2.jsonl
"""
import argparse
import json
import os
import random
import urllib.request

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score
from scipy.sparse import hstack

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
CACHE = os.environ.get("PROBE_CACHE", "/tmp/probe-cache")


def load(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def label(ex):
    obs = ex["target"]["observations"]
    plans = ex["target"]["plans"]
    if len(obs) > 1:
        return None, None
    if not obs:
        return ("plan" if plans else "none"), None
    if plans:
        return None, None
    return obs[0]["certainty"], obs[0]["kind"]


def text(ex):
    return "\n".join(e["text"] for e in ex["input"]["events"])


def embed(port, prefix, texts, name):
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, f"{name}.json")
    cache = json.load(open(f)) if os.path.exists(f) else {}
    todo = [t for t in dict.fromkeys(texts) if t not in cache]
    for i in range(0, len(todo), 16):
        batch = todo[i:i + 16]
        req = urllib.request.Request(f"http://127.0.0.1:{port}/embedding", data=json.dumps({"content": [prefix + t for t in batch]}).encode(), headers={"Content-Type": "application/json"})
        res = json.load(urllib.request.urlopen(req, timeout=600))
        for t, r in zip(batch, sorted(res, key=lambda x: x["index"])):
            v = np.array(r["embedding"][0] if isinstance(r["embedding"][0], list) else r["embedding"], dtype=np.float32)
            cache[t] = (v / (np.linalg.norm(v) + 1e-9)).tolist()
        if i % 320 == 0:
            json.dump(cache, open(f, "w"))
            print(f"  {name}: {len(cache)} embedded", flush=True)
    json.dump(cache, open(f, "w"))
    return np.array([cache[t] for t in texts])


def gen_label(answer):
    """The generative model's decision, from its raw answer, on the same label scale."""
    obs = answer.get("observations", [])
    if not obs:
        return ("plan" if answer.get("plans") else "none"), None
    top = max(obs, key=lambda o: o.get("importance", 0))
    return top.get("certainty"), top.get("kind")


def score(y, p):
    return {"n": len(y), "acc": round(accuracy_score(y, p), 3), "macroF1": round(f1_score(y, p, average="macro", zero_division=0), 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-n", type=int, default=3000)
    ap.add_argument("--emb", action="append", default=[], help="name=port[:prefix]")
    ap.add_argument("--gen", default="")
    a = ap.parse_args()
    random.seed(7)
    train = [e for e in load(f"{ROOT}/ml/data/out/train.jsonl") if label(e)[0]]
    train = random.sample(train, min(a.train_n, len(train)))
    sets = {
        "test": [e for e in load(f"{ROOT}/ml/data/out/test.jsonl") if label(e)[0]],
        "gold": [e for e in load(f"{ROOT}/ml/eval/gold.jsonl") if label(e)[0]],
    }
    sets["test-unseen"] = [e for e in sets["test"] if e.get("unseen")]
    mini_ids = {e["id"] for e in load(f"{ROOT}/ml/data/out/test-mini.jsonl")}
    sets["test-mini"] = [e for e in sets["test"] if e["id"] in mini_ids]

    feats = {"tfidf": None}
    for spec in a.emb:
        name, rest = spec.split("=", 1)
        port, _, prefix = rest.partition(":")
        feats[name] = (int(port), prefix)

    results = {"trainN": len(train), "sets": {k: len(v) for k, v in sets.items()}}
    for task, idx in (("decision", 0), ("kind", 1)):
        tr = [e for e in train if label(e)[idx]]
        ytr = [label(e)[idx] for e in tr]
        for name, spec in feats.items():
            if spec is None:
                w = TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True)
                c = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), min_df=2, sublinear_tf=True)
                xtr = hstack([w.fit_transform([text(e) for e in tr]), c.fit_transform([text(e) for e in tr])])
                fx = lambda es: hstack([w.transform([text(e) for e in es]), c.transform([text(e) for e in es])])
            else:
                port, prefix = spec
                xtr = embed(port, prefix, [text(e) for e in tr], name)
                fx = lambda es, port=port, prefix=prefix, name=name: embed(port, prefix, [text(e) for e in es], name)
            clf = LogisticRegression(max_iter=3000, C=4.0, class_weight="balanced").fit(xtr, ytr)
            for s, es in sets.items():
                es = [e for e in es if label(e)[idx]]
                if es:
                    results.setdefault(task, {}).setdefault(s, {})[name] = score([label(e)[idx] for e in es], clf.predict(fx(es)))
    # The generative model on the examples it answered.
    if a.gen:
        raw, kept = {}, {}
        for p in a.gen.split(","):
            for r in load(os.path.join(ROOT, p)):
                try:
                    raw[r["id"]] = json.loads(r["raw"])
                except Exception:
                    continue
                # What the pipeline keeps: the guard's surviving observations and plans.
                kept[r["id"]] = {"observations": r.get("predicted", []), "plans": r.get("plans", [])}
        for task, idx in (("decision", 0), ("kind", 1)):
            for s in ("test-mini", "gold"):
                for nm, answers in (("generative raw", raw), ("generative after guard", kept)):
                    es = [e for e in sets[s] if label(e)[idx] and e["id"] in answers]
                    if es:
                        results[task][s][nm] = score([label(e)[idx] for e in es], [str(gen_label(answers[e["id"]])[idx]) for e in es])
    print(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
