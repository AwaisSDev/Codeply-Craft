#!/usr/bin/env python3
"""Measure candidate deterministic guard rules on committed validation outputs (no model, nothing changed).

Each rule is applied after contract.guard; in closed loop the replay applies it inside the loop, so the store evolves
as it would in production. Reported per rule: strict P / R / F1 and false memories per 100 sessions, and how many
strictly-correct ops the rule removed (its cost). Rules come from the contract and data spec, not from the numbers:

  R1 secret_pin      attr/value names a PIN (the current SECRET_RE has "pin code" only)
  R2 update_attr     an update must reuse the stored memory's attribute (CONTRACT.md: "reuses the stored attribute on
                     update"), so an update whose attr differs from its ref's attr is refused
  R3 injection_span  an op whose quote sits in the same sentence as an instruction addressed to AI assistants /
                     summarisers ("note to AI", "AI assistants ...", "ignore previous instructions") is refused
  R4 other_question  an op about the user, quoted from another speaker's question (quote or sentence ends with '?'),
                     is refused

Caveat: measured on validation, which is also where these rules were noticed. Treat gains as optimistic.

    cd research/iris && python3 foundation-2026-11/pilot/infra_rules.py
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "audit-r4")); sys.path.insert(0, str(HERE.parent))
import diagnose as D  # noqa: E402
from codeply_iris import build, contract, metrics  # noqa: E402
from codeply_iris.contract import squash  # noqa: E402
from codeply_iris.store import MemoryStore, derive_ops  # noqa: E402

PIN = re.compile(r"(?<![a-z])(pin|pins|pin number|passkey)(?![a-z])", re.I)
INJ = re.compile(r"(note (for|to) (ai|automated)|ai assistants?\b|automated summari[sz]ers?|ignore (all )?previous instructions|"
                 r"assistants? (reading|processing) this)", re.I)


def sentence_of(text, quote):
    t = squash(text)
    i = t.find(squash(quote))
    if i < 0:
        return ""
    start = max(t.rfind(".", 0, i), t.rfind("\n", 0, i), t.rfind("[", 0, i)) + 1
    ends = [j for j in (t.find(".", i + len(squash(quote))), t.find("]", i + len(squash(quote)))) if j >= 0]
    return t[start:(min(ends) + 1 if ends else len(t))]


def rule_hits(op, messages, memories):
    hits = set()
    msg = messages[op["src"] - 1] if 1 <= op["src"] <= len(messages) else {"who": "", "text": ""}
    if op["op"] in contract.PERSISTENT_OPS and PIN.search(f"{op.get('attr', '')} {op.get('val', '')}"):
        hits.add("R1_secret_pin")
    if op["op"] == "update":
        ref = next((m for m in memories if m["id"] == op.get("ref")), None)
        if ref and contract.norm(ref.get("attr", "")) != contract.norm(op.get("attr", "")):
            hits.add("R2_update_attr")
    if op["op"] in contract.PERSISTENT_OPS and INJ.search(sentence_of(msg["text"], op["evid"]) or ""):
        hits.add("R3_injection_span")
    if (op["op"] in contract.PERSISTENT_OPS and op.get("ent") == "user" and str(msg["who"]).lower() not in ("user", "note")
            and not str(msg["who"]).startswith(("email from user", "calendar", "screen"))
            and (squash(op["evid"]).endswith("?") or sentence_of(msg["text"], op["evid"]).rstrip().endswith("?"))):
        hits.add("R4_other_question")
    return hits


RULES = ["R1_secret_pin", "R2_update_attr", "R3_injection_span", "R4_other_question"]


def run(cache_path, loop, active, val_built, eps):
    cache = {json.loads(l)["id"]: json.loads(l) for l in Path(cache_path).read_text().splitlines() if l.strip()}
    total, removed = Counter(), Counter()

    def score(key, s_messages, s_source, rows, gold):
        hit = cache.get(key)
        if hit is None:
            return None, None
        parsed = contract.parse(hit.get("answer", hit.get("raw", "")))
        shown = [{k: v for k, v in m.items() if k != "key"} for m in rows]
        ops, rej = contract.guard(parsed["ops"], s_messages, shown, s_source)
        c0, _ = metrics.score_observe(ops, gold, rows, rej)
        strict_ok = {id(p) for p, g, ok in D.pairs_of(ops, gold, rows)[0] if ok}
        kept = []
        for o in ops:
            h = rule_hits(o, s_messages, shown) & active
            if h:
                removed["ops"] += 1
                removed["correct_ops_removed"] += id(o) in strict_ok
            else:
                kept.append(o)
        c, keys = metrics.score_observe(kept, gold, rows, rej)
        return c, (kept, keys)

    if loop == "open":
        for ex in val_built:
            c, _ = score(ex["id"], ex["messages"], ex["source"], ex["memories"], ex["gold"])
            if c is not None:
                total.update(c)
    else:
        for ep in eps:
            store = MemoryStore()
            for s in ep["sessions"]:
                rows = store.view(s["now"][:10])
                gold = derive_ops(s, rows)
                c, res = score(f"{ep['id']}-s{s['sid']}", s["messages"], s["source"], rows, gold)
                if c is None:
                    break
                total.update(c)
                kept, keys = res
                for o in kept:
                    store.apply({k: v for k, v in o.items() if not k.startswith("_")}, session=s["sid"], key=keys.get(id(o)))
    s = metrics.summarise(total)
    return {"precision": round(s["extraction_precision"], 3), "recall": round(s["extraction_recall"], 3),
            "f1": round(s["extraction_f1"], 3), "false_per_100": round(100 * total["false_memory"] / total["sessions"], 1),
            "ops_removed": removed["ops"], "correct_ops_removed": removed["correct_ops_removed"]}


def main():
    val_built = [e for e in (json.loads(l) for l in (ROOT / "data/built/val.jsonl").read_text().splitlines() if l.strip())
                 if e["task"] == "observe"]
    eps, _ = build.load_raw(str(ROOT / "data/raw"), "val")
    systems = {"qwen3-4b-2507 (zero-shot)": ROOT / "results/foundation-2026-11/qwen3-4b-2507",
               "gemma-4-e2b (zero-shot)": ROOT / "results/foundation-2026-11/gemma-4-e2b",
               "iris-1.7b-r3 (fine-tuned)": ROOT / "results/gpu-r2/val/iris-1.7b-r3"}
    out = {}
    for name, d in systems.items():
        out[name] = {}
        for loop in ("open", "closed"):
            p = d / f"preds-val-{loop}.jsonl"
            row = {"none": run(p, loop, set(), val_built, eps)}
            for r in RULES:
                row[r] = run(p, loop, {r}, val_built, eps)
            row["all"] = run(p, loop, set(RULES), val_built, eps)
            out[name][loop] = row
            print(name, loop)
            for k, v in row.items():
                print(f"   {k:18s} P {v['precision']} R {v['recall']} F1 {v['f1']} false/100 {v['false_per_100']} removed {v['ops_removed']} (correct {v['correct_ops_removed']})")
    (HERE / "infra_rules.json").write_text(json.dumps(out, indent=1) + "\n")


if __name__ == "__main__":
    main()
