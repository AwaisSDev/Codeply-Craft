"""Where do the output tokens of the current model go?

Splits every answer the model gave in an evaluation run into
  structure  JSON punctuation and key names: fixed by the grammar once the
             model has chosen to open an object (a runtime can emit them
             without running the model: "jump-forward" decoding)
  decision   enum values and numbers (kind, certainty, about, importance):
             a choice among a few options (a classifier head could make it)
  free text  slot, value, text, project, until, plan what/when/where/who:
             needs real generation
and counts tokens with the model's own tokenizer (llama-server /tokenize).

  python3 -I token_anatomy.py <details.jsonl> [port]
"""
import json
import sys
import urllib.request

DECISION = {"kind", "certainty", "about", "importance"}


def tokens(port, text):
    if not text:
        return 0
    req = urllib.request.Request(f"http://127.0.0.1:{port}/tokenize", data=json.dumps({"content": text}).encode(), headers={"Content-Type": "application/json"})
    return len(json.load(urllib.request.urlopen(req))["tokens"])


def split(answer):
    """Strings for each class, from the parsed answer re-serialised the way the model writes it."""
    decision, free = [], []
    for o in answer.get("observations", []):
        for k, v in o.items():
            (decision if k in DECISION else free).append(json.dumps(v, ensure_ascii=False))
    for p in answer.get("plans", []):
        for k, v in p.items():
            free.append(json.dumps(v, ensure_ascii=False))
    return decision, free


def main():
    path = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 18090
    tot = {"all": 0, "decision": 0, "free": 0}
    n = 0
    for line in open(path, encoding="utf-8"):
        r = json.loads(line)
        raw = r.get("raw") or ""
        try:
            ans = json.loads(raw)
        except Exception:
            continue
        n += 1
        tot["all"] += tokens(port, raw)
        d, f = split(ans)
        # Tokenised one value at a time, so a value's own quotes are counted with it.
        tot["decision"] += sum(tokens(port, x) for x in d)
        tot["free"] += sum(tokens(port, x) for x in f)
    tot["structure"] = tot["all"] - tot["decision"] - tot["free"]
    out = {"answers": n, "tokensPerAnswer": round(tot["all"] / n, 1)}
    for k in ("structure", "decision", "free"):
        out[k] = {"tokensPerAnswer": round(tot[k] / n, 1), "share": round(tot[k] / tot["all"], 3)}
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
