#!/usr/bin/env python3
"""Author Iris teacher episodes through the Anthropic API, one episode per call, from the existing shard briefs.

    ANTHROPIC_API_KEY=... python author_api.py --brief spec/briefs/tr04.md --out raw_api/tr04.jsonl \
        [--model claude-sonnet-5-5] [--effort high] [--workers 6] [--only e01 e02]

* The system prompt is data/spec/TEACHER-SPEC.md, verbatim. The user prompt is the brief's name pool, one row of its
  episode table, and its focus list; the model returns one JSON object (one episode).
* Every episode goes through validate_raw.check_episode. Failures get up to --fixes correction rounds that show the
  model its own episode and the validator's errors. Episodes that still fail are written to <out>.rejected.jsonl and
  never to <out>: nothing that fails the validator is kept, and no threshold is relaxed.
* <out>.log.jsonl records tokens, attempts and outcome per episode, so cost and first-try validity are measured.
* Meaning (unlabelled facts, wrong dates, unsupported labels) is not checked here: that is the blind review.
Nothing in this file reads, writes or depends on the val or test splits.
"""
import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import anthropic

sys.path.insert(0, str(Path(__file__).parent))
import validate_raw  # noqa: E402

HERE = Path(__file__).parent
SPEC = (HERE / "spec" / "TEACHER-SPEC.md").read_text(encoding="utf-8")
SYSTEM = (
    SPEC.replace("to the output path you\nwere given", "as your reply")
    + "\n\n## 8. Reply format for this job\n\nYou are writing ONE episode. Your entire reply must be that one episode as a single-line JSON object "
      "(no markdown fence, no commentary before or after). You cannot run the validator; instead check your own work "
      "against §6 before replying: every `evid` must be a character-exact substring of the message it points to, "
      "`change` / `repeat` / `retract` must follow the rules, weekdays must match the calendar, and no memorable "
      "statement may be left unlabelled.\n"
)


def parse_brief(path):
    t = Path(path).read_text(encoding="utf-8")
    first = re.search(r"First names:\s*(.+)", t).group(1).strip()
    last = re.search(r"Surnames:\s*(.+)", t).group(1).strip()
    split = re.search(r"\((train|val|test)\)", t).group(1)
    focus = t.split("## Focus for this shard", 1)[1].split("## Working method", 1)[0].strip()
    shard = re.search(r"shard `(\w+)`", t).group(1)
    rows = [(m.group(1), m.group(2), m.group(3).strip())
            for m in re.finditer(r"^\|\s*(e\d+)\s*\|\s*`?([\w-]+)`?\s*\|\s*(.+?)\s*\|\s*$", t, re.M)]
    return {"shard": shard, "split": split, "first": first, "last": last, "focus": focus, "rows": rows}


def user_prompt(b, eid, lang, desc, n_eps):
    return (
        f"Write episode `{b['shard']}-{eid}` of shard `{b['shard']}` ({b['split']} split).\n\n"
        f"Language: `{lang}`\nUser (starting point; develop it into a specific, vivid person): {desc}\n\n"
        f"## People\nUse only these first names and surnames for people (users, friends, family, colleagues); combine them "
        f"freely, and reuse a first name with two surnames when you need look-alikes. Other names are rejected by the validator.\n"
        f"First names: {b['first']}\nSurnames: {b['last']}\n"
        f"Invent your own organisations, products, projects and places-within-cities; make them specific and varied. "
        f"Do not reuse any name from the worked example in the spec (Finlo, Helios, Hira, Zainab).\n\n"
        f"## Focus for the shard this episode belongs to (cover what fits this one episode; the other episodes cover the rest)\n{b['focus']}\n\n"
        f"This is one of {n_eps} episodes in the shard, so give this one a distinct shape: choose its own mix of sources, "
        f"3-5 sessions, 2-3 queries. Include whatever of spec §3 this episode can naturally carry, with at least one skip "
        f"and at least one session without facts. Reply with the episode JSON only.\n"
    )


def extract_json(text):
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s)
    i, j = s.find("{"), s.rfind("}")
    return json.loads(s[i:j + 1])


lock = threading.Lock()


def call(client, model, effort, messages, max_tokens):
    t = time.time()
    with client.messages.stream(model=model, max_tokens=max_tokens, system=SYSTEM, messages=messages,
                                thinking={"type": "adaptive"}, output_config={"effort": effort}) as s:
        msg = s.get_final_message()
    text = "".join(b.text for b in msg.content if b.type == "text")
    u = msg.usage
    return msg.stop_reason, text, {"in": u.input_tokens, "out": u.output_tokens, "s": round(time.time() - t)}


def author(client, a, b, eid, lang, desc):
    base = [{"role": "user", "content": user_prompt(b, eid, lang, desc, len(b["rows"]))}]
    log = {"id": f"{b['shard']}-{eid}", "model": a.model, "effort": a.effort, "attempts": [], "ok": False}
    ep, text, errors = None, "", []
    for attempt in range(a.fixes + 1):
        msgs = base if attempt == 0 else base + [
            {"role": "assistant", "content": text},
            {"role": "user", "content": "The validator rejected this episode:\n" + "\n".join(errors[:40])
             + "\n\nReturn the complete corrected episode as one single-line JSON object, nothing else. Fix every error; "
               "keep everything else unless a fix requires a change. Do not add facts that lack a quote."}]
        for retry in range(3):
            try:
                stop, text, use = call(client, a.model, a.effort, msgs, a.max_tokens)
                break
            except (anthropic.APIConnectionError, anthropic.RateLimitError, anthropic.InternalServerError) as e:
                time.sleep(20 * (retry + 1))
                stop, text, use = "error:" + type(e).__name__, "", {"in": 0, "out": 0, "s": 0}
        rec = {"stop": stop, **use}
        if stop in ("refusal",) or stop.startswith("error"):
            rec["errors"] = [stop]
            log["attempts"].append(rec)
            break
        try:
            ep = extract_json(text)
            ep["id"] = f"{b['shard']}-{eid}"
            errors, warns = validate_raw.check_episode(ep, b["split"])
        except Exception as e:  # noqa: BLE001
            ep, errors, warns = None, [f"invalid JSON: {e}"], []
        rec["errors"], rec["warnings"] = len(errors), len(warns)
        log["attempts"].append(rec)
        if not errors:
            log["ok"] = True
            break
    log["first_try_ok"] = bool(log["attempts"]) and log["attempts"][0].get("errors") == 0
    return ep if log["ok"] else None, log, (text if not log["ok"] else ""), errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--brief", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--effort", default="high")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--fixes", type=int, default=2)
    ap.add_argument("--max-tokens", type=int, default=48000)
    ap.add_argument("--only", nargs="*", default=[])
    a = ap.parse_args()
    key = os.environ["ANTHROPIC_API_KEY"].strip().strip("'\"")
    client = anthropic.Anthropic(api_key=key, max_retries=3, timeout=1800)
    b = parse_brief(a.brief)
    rows = [r for r in b["rows"] if not a.only or r[0] in a.only]
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out.exists():
        done = {json.loads(l)["id"] for l in out.read_text(encoding="utf-8").splitlines() if l.strip()}
    rows = [r for r in rows if f"{b['shard']}-{r[0]}" not in done]
    print(f"{b['shard']}: {len(rows)} episodes to write ({len(done)} already in {out}), model {a.model}, effort {a.effort}", flush=True)
    rej = open(str(out) + ".rejected.jsonl", "a", encoding="utf-8")
    logf = open(str(out) + ".log.jsonl", "a", encoding="utf-8")
    with ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(author, client, a, b, *r): r for r in rows}
        for f in as_completed(futs):
            ep, log, raw, errors = f.result()
            with lock:
                logf.write(json.dumps(log) + "\n")
                logf.flush()
                if ep:
                    with out.open("a", encoding="utf-8") as fo:
                        fo.write(json.dumps(ep, ensure_ascii=False) + "\n")
                else:
                    rej.write(json.dumps({"id": log["id"], "errors": errors[:40], "raw": raw}, ensure_ascii=False) + "\n")
                    rej.flush()
                toks = sum(x["out"] for x in log["attempts"])
                print(f"  {log['id']}: {'ok' if log['ok'] else 'REJECTED'} after {len(log['attempts'])} attempt(s), "
                      f"{toks} output tokens, first-try {'valid' if log['first_try_ok'] else 'invalid'}", flush=True)


if __name__ == "__main__":
    main()
