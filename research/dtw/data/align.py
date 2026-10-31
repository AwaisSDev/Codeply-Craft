"""Turn dumped examples (dump.mjs) into span-labelled training records.

For every target observation and plan, find the characters in the (redacted)
event text that carry it, as offsets into the model input sequence:
  * benchmark examples carry an exact `evidence` string: found directly;
  * generated examples do not: the value is found verbatim (87 % of them),
    else the smallest window holding most of its content words (then the
    slot's), searching the user's own lines first.
Merge labels come from the known memories: the target is the known memory
with the observation's slot; relation "same" when the value is unchanged.

  python3 -I align.py dumped.jsonl out.jsonl
"""
import json
import re
import sys
from collections import Counter

STOP = set("the a an and or to of in on at for with my me i is are was be it this that we our you your from by as up so do not no".split())
MEMORABLE = {"stated", "implied", "temporary"}
WORD = re.compile(r"[A-Za-z0-9؀-ۿ][A-Za-z0-9'؀-ۿ.+#-]*")


def norm(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def content_words(s):
    return [w for w in (m.group(0).lower().strip(".") for m in WORD.finditer(str(s or ""))) if w and w not in STOP and len(w) > 1]


def user_ranges(text):
    """Character ranges of the user's own lines (chat), or the whole text."""
    out, pos = [], 0
    for line in text.split("\n"):
        if line.startswith("User:"):
            out.append((pos + 5, pos + len(line)))
        pos += len(line) + 1
    return out or [(0, len(text))]


def find_verbatim(text, needle, ranges):
    if not needle or len(needle) < 2:
        return None
    low, nl = text.lower(), needle.lower()
    for a, b in ranges + [(0, len(text))]:
        i = low.find(nl, a, b)
        if i >= 0:
            return (i, i + len(needle))
    return None


def find_window(text, words, ranges):
    """Smallest span covering as many of `words` as possible (at least half)."""
    if not words:
        return None
    toks = [(m.start(), m.end(), m.group(0).lower().strip(".")) for m in WORD.finditer(text)]
    want = set(words)
    best = None
    for a, b in ranges + [(0, len(text))]:
        tk = [t for t in toks if a <= t[0] < b]
        for i in range(len(tk)):
            if tk[i][2] not in want and not any(tk[i][2].startswith(w[:5]) for w in want if len(w) >= 5):
                continue
            seen = set()
            for j in range(i, min(len(tk), i + 25)):
                w = tk[j][2]
                for x in want:
                    if w == x or (len(x) >= 5 and w.startswith(x[:5])):
                        seen.add(x)
                need = max(1, (len(want) + 1) // 2)
                if len(seen) >= need:
                    cand = (len(seen), -(tk[j][1] - tk[i][0]), tk[i][0], tk[j][1])
                    if best is None or cand > best:
                        best = cand
                    if len(seen) == len(want):
                        break
        if best:
            break
    return (best[2], best[3]) if best else None


def locate(ev, item, kind):
    """(start, end) inside the event's redacted text, or None."""
    red = ev["red"]
    ranges = user_ranges(red) if red.startswith("User:") else [(0, len(red))]
    evd = item.get("evidence")
    if isinstance(evd, dict) and evd.get("text"):
        s = find_verbatim(red, evd["text"], [(0, len(red))])
        if s:
            return s
        return find_window(red, content_words(evd["text"]), [(0, len(red))])
    if kind == "obs":
        s = find_verbatim(red, item.get("value"), ranges)
        if s:
            return s
        s = find_window(red, content_words(item.get("value")), ranges)
        if s:
            return s
        return find_window(red, content_words(item.get("slot")), ranges)
    words = [w for w in content_words(item.get("what")) if w not in ("meeting", "call")] + [w.lower() for w in item.get("who", [])]
    if item.get("where"):
        words += content_words(item["where"])[:2]
    return find_window(red, words or content_words(item.get("what")), ranges)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    stats = Counter()
    with open(dst, "w", encoding="utf-8") as out:
        for line in open(src, encoding="utf-8"):
            d = json.loads(line)
            stats["examples"] += 1
            spans, ok = [], True
            known = d["mems"]
            for kind, items in (("obs", d["target"]["observations"]), ("plan", d["target"]["plans"])):
                for it in items:
                    stats[kind] += 1
                    ei = (it.get("evidence") or {}).get("event", 0) if isinstance(it.get("evidence"), dict) else 0
                    ei = ei if ei < len(d["events"]) else 0
                    loc = None
                    order = [ei] + [i for i in range(len(d["events"])) if i != ei]
                    for i in order:
                        loc = locate(d["events"][i], it, kind)
                        if loc:
                            ei = i
                            break
                    if not loc:
                        stats[f"{kind} unaligned"] += 1
                        ok = False
                        continue
                    base = d["events"][ei]["start"]
                    rec = {"type": kind, "start": base + loc[0], "end": base + loc[1]}
                    if kind == "obs":
                        tgt, rel = -1, "none"
                        mg = it.get("merge")
                        for m in known:
                            if (mg and m.get("id") == mg.get("target")) or (not mg and m.get("slot") and norm(m["slot"]) == norm(it.get("slot"))):
                                tgt = m["index"]
                                rel = (mg or {}).get("relation") or ("same" if norm(m.get("value")) == norm(it.get("value")) else "different")
                                break
                        rec.update({"kind": it["kind"], "certainty": it["certainty"], "about": it.get("about") or ("project" if it.get("project") else "user"),
                                    "importance": float(it.get("importance", 0.5)), "merge": tgt, "relation": rel,
                                    "slot": it.get("slot", ""), "value": it.get("value", "")})
                    spans.append(rec)
            spans.sort(key=lambda s: s["start"])
            clean = []
            for s in spans:
                if clean and s["start"] < clean[-1]["end"]:
                    stats["overlap dropped"] += 1
                    if s["type"] == "plan" and clean[-1]["type"] == "obs":
                        clean[-1] = s  # a plan wins over an observation on the same words
                    continue
                clean.append(s)
            gate = any(s["type"] == "plan" or s.get("certainty") in MEMORABLE for s in clean)
            stats["fully aligned" if ok else "partly aligned"] += 1
            out.write(json.dumps({"id": d["id"], "task": d["task"], "lang": d.get("lang", "en"), "unseen": d.get("unseen", False),
                                  "text": d["text"], "events": [{"start": e["start"], "end": e["end"]} for e in d["events"]],
                                  "mems": [{"start": m["start"], "end": m["end"]} for m in known], "spans": clean, "gate": gate,
                                  "complete": ok}, ensure_ascii=False) + "\n")
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
