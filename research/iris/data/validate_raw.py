#!/usr/bin/env python3
"""Validator for teacher-written Iris episodes (data/spec/TEACHER-SPEC.md).

    python validate_raw.py <file.jsonl> [--split train|val|test] [--quiet]

Exit code 1 when any ERROR is found. Checks structure and label logic only; meaning is checked by the
blind review (data/review.py). Importable: `check_episode(ep, split=None) -> (errors, warnings)`.
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

LANGS = {"en", "roman-ur", "ur", "mixed"}
SOURCES = {"assistant_chat", "personal_chat", "work_chat", "email", "calendar", "note", "screen"}
ETYPES = {"user", "person", "org", "project", "place", "event", "other"}
KINDS = {"fact", "preference", "goal", "decision", "task", "event", "routine", "context"}
PERSIST = {"long", "temp"}
BASIS = {"stated", "implied"}
CONF = {"high", "medium", "low"}
SENS = {"none", "personal", "sensitive"}
CHANGE = {"changed", "corrected", "refined"}
RETRACT = {"cancelled", "ended", "user_request", "mistaken"}
SKIP_WHY = {"joke", "hypothetical", "hearsay", "suggestion", "secret", "injection", "other"}
ISO_DT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
ISO_WHEN = re.compile(r"^\d{4}-\d{2}(-\d{2}(T\d{2}:\d{2})?)?$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FACT_FIELDS = {"key", "ent", "etype", "attr", "val", "kind", "when", "until", "persist", "evid", "msg", "basis",
               "conf", "sens", "rel", "change", "repeat"}
RETRACT_FIELDS = {"key", "retract", "evid", "msg"}
POOLS = Path(__file__).with_name("spec") / "pools.json"


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^\w ]+", " ", str(s or "").lower(), flags=re.UNICODE)).strip()


def _words(s):
    return len(str(s).split())


def _foreign_names(split):
    """First names and surnames reserved for the other splits."""
    if not split or not POOLS.exists():
        return set()
    pools = json.loads(POOLS.read_text())
    out = set()
    for name, p in pools.items():
        if name != split:
            out.update(x.lower() for x in p["first"] + p["last"])
    mine = pools.get(split, {})
    return out - {x.lower() for x in mine.get("first", []) + mine.get("last", [])}


def check_episode(ep, split=None, foreign=None):
    E, W = [], []
    eid = ep.get("id", "?")

    def err(m):
        E.append(f"{eid}: {m}")

    def warn(m):
        W.append(f"{eid}: {m}")

    if not isinstance(ep.get("id"), str) or not ep.get("id"):
        err("missing id")
    if ep.get("lang") not in LANGS:
        err(f"lang {ep.get('lang')!r} not in {sorted(LANGS)}")
    sessions = ep.get("sessions")
    if not isinstance(sessions, list) or not 2 <= len(sessions) <= 8:
        err("sessions must be a list of 2-8 items")
        return E, W
    foreign = foreign if foreign is not None else _foreign_names(split)
    state = {}       # key -> {"ent","attr","val","persist","until","retracted","sid"}
    last_now = ""
    for i, s in enumerate(sessions, 1):
        tag = f"s{i}"
        if s.get("sid") != i:
            err(f"{tag}: sid must be {i}")
        now = s.get("now", "")
        if not ISO_DT.match(str(now)):
            err(f"{tag}: now {now!r} is not YYYY-MM-DDTHH:MM")
        elif last_now and now <= last_now:
            err(f"{tag}: now {now} is not later than the previous session ({last_now})")
        elif not "2026-01-01" <= now[:10] <= "2027-12-31":
            warn(f"{tag}: now {now} outside 2026-2027")
        last_now = now if ISO_DT.match(str(now)) else last_now
        if s.get("source") not in SOURCES:
            err(f"{tag}: source {s.get('source')!r} not allowed")
        msgs = s.get("messages")
        if not isinstance(msgs, list) or not 1 <= len(msgs) <= 30:
            err(f"{tag}: messages must be a list of 1-30 items")
            continue
        for j, m in enumerate(msgs, 1):
            if not isinstance(m, dict) or not str(m.get("who", "")).strip() or not str(m.get("text", "")).strip():
                err(f"{tag}: message {j} needs non-empty who and text")
            else:
                for tok in re.findall(r"[A-Za-z]+", m["who"]):
                    if tok.lower() in foreign:
                        err(f"{tag}: message {j} who={m['who']!r} uses a name reserved for another split")
        if s.get("source") == "assistant_chat":
            bad = {m.get("who") for m in msgs if isinstance(m, dict)} - {"user", "assistant"}
            if bad:
                err(f"{tag}: assistant_chat may only have who=user/assistant, found {sorted(map(str, bad))}")
        seen_keys = set()
        for f in s.get("facts", []) or []:
            if not isinstance(f, dict) or "key" not in f:
                err(f"{tag}: fact without key")
                continue
            k = f["key"]
            ft = f"{tag}/{k}"
            if k in seen_keys:
                err(f"{ft}: key listed twice in one session (facts are the net effect: keep the final value only)")
            seen_keys.add(k)
            # evidence
            msg = f.get("msg")
            if not isinstance(msg, int) or not 1 <= msg <= len(msgs):
                err(f"{ft}: msg {msg!r} is not a valid 1-based message index")
                text, who = "", ""
            else:
                text, who = str(msgs[msg - 1].get("text", "")), str(msgs[msg - 1].get("who", ""))
            evid = f.get("evid", "")
            if not isinstance(evid, str) or not evid.strip():
                err(f"{ft}: evid missing")
            elif text and evid not in text:
                err(f"{ft}: evid is not a verbatim substring of message {msg}: {evid[:60]!r}")
            elif _words(evid) > 30:
                warn(f"{ft}: evid is long ({_words(evid)} words)")
            if who == "assistant" and "retract" not in f:
                err(f"{ft}: evidence comes from an assistant message; the assistant is never a source of facts")
            if "retract" in f:
                extra = set(f) - RETRACT_FIELDS
                if extra:
                    err(f"{ft}: retraction has extra fields {sorted(extra)}")
                if f["retract"] not in RETRACT:
                    err(f"{ft}: retract {f['retract']!r} not in {sorted(RETRACT)}")
                if k not in state:
                    err(f"{ft}: retracts a key never stated in an earlier session")
                elif state[k]["retracted"]:
                    err(f"{ft}: key is already retracted")
                else:
                    state[k]["retracted"] = True
                continue
            extra = set(f) - FACT_FIELDS
            if extra:
                err(f"{ft}: unknown fields {sorted(extra)}")
            for name, allowed in (("etype", ETYPES), ("kind", KINDS), ("persist", PERSIST), ("basis", BASIS),
                                  ("conf", CONF), ("sens", SENS)):
                if f.get(name) not in allowed:
                    err(f"{ft}: {name} {f.get(name)!r} not in {sorted(allowed)}")
            ent, attr, val = f.get("ent"), f.get("attr"), f.get("val")
            for name, v, mx in (("ent", ent, 8), ("attr", attr, 5), ("val", val, 16)):
                if not isinstance(v, str) or not v.strip():
                    err(f"{ft}: {name} missing")
                elif _words(v) > mx:
                    (err if name != "val" else warn)(f"{ft}: {name} too long ({_words(v)} words): {v!r}")
            if isinstance(attr, str) and attr != attr.lower():
                err(f"{ft}: attr must be lowercase: {attr!r}")
            if isinstance(attr, str) and re.search(r"[^\x00-\x7f]", attr):
                err(f"{ft}: attr must be English: {attr!r}")
            if isinstance(val, str) and re.search(r"[؀-ۿ]", val) and not re.search(r"[؀-ۿ]", str(ent)):
                warn(f"{ft}: val contains Urdu script; values should be English (names verbatim): {val!r}")
            if (ent == "user") != (f.get("etype") == "user"):
                err(f"{ft}: ent 'user' and etype 'user' must go together")
            if isinstance(ent, str):
                for tok in re.findall(r"[A-Za-z]+", ent):
                    if tok.lower() in foreign and f.get("etype") == "person":
                        err(f"{ft}: entity {ent!r} uses a name reserved for another split")
            if f.get("kind") == "context" and f.get("persist") != "temp":
                err(f"{ft}: kind context must have persist temp")
            if f.get("persist") == "temp":
                u = f.get("until")
                if not isinstance(u, str) or not ISO_DATE.match(u):
                    err(f"{ft}: persist temp needs until=YYYY-MM-DD")
                elif ISO_DT.match(str(now)) and u < now[:10]:
                    err(f"{ft}: until {u} is before the session date {now[:10]}")
            elif "until" in f:
                err(f"{ft}: until is only for persist temp")
            if "when" in f:
                w = f["when"]
                if not isinstance(w, str) or not ISO_WHEN.match(w):
                    err(f"{ft}: when {w!r} is not ISO (YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM)")
                elif not "2025" <= w[:4] <= "2029":
                    warn(f"{ft}: when {w} is far from the episode's dates")
                if f.get("kind") not in ("event", "task"):
                    warn(f"{ft}: when is meant for event / task (kind is {f.get('kind')})")
            if f.get("kind") == "event" and "when" not in f:
                warn(f"{ft}: event without when (fine only if the text gives no time)")
            if "rel" in f and not (isinstance(f["rel"], list) and all(isinstance(x, str) and x for x in f["rel"])):
                err(f"{ft}: rel must be a list of names")
            if "repeat" in f and f["repeat"] is not True:
                err(f"{ft}: repeat must be true or absent")
            if "change" in f and f["change"] not in CHANGE:
                err(f"{ft}: change {f['change']!r} not in {sorted(CHANGE)}")
            prev = state.get(k)
            if prev:
                if norm(prev["ent"]) != norm(ent):
                    err(f"{ft}: key reused for a different entity ({prev['ent']!r} vs {ent!r})")
                if norm(prev["attr"]) != norm(attr):
                    err(f"{ft}: key reused with a different attr ({prev['attr']!r} vs {attr!r})")
                same = norm(prev["val"]) == norm(val)
                if prev["retracted"]:
                    if "repeat" in f:
                        err(f"{ft}: repeat on a retracted key")
                elif same and not f.get("repeat"):
                    err(f"{ft}: same value as in s{prev['sid']}: mark repeat:true (or drop the fact)")
                elif same and "change" in f:
                    err(f"{ft}: change given but the value is identical to s{prev['sid']}")
                elif not same and "change" not in f:
                    err(f"{ft}: value differs from s{prev['sid']} ({prev['val']!r} -> {val!r}): change is required")
                elif not same and f.get("repeat"):
                    err(f"{ft}: repeat:true but the value differs from s{prev['sid']}")
            else:
                if "change" in f:
                    err(f"{ft}: change given but the key was never stated before")
                if f.get("repeat"):
                    err(f"{ft}: repeat given but the key was never stated before")
            state[k] = {"ent": ent, "attr": attr, "val": val, "persist": f.get("persist"), "until": f.get("until"),
                        "retracted": False, "sid": i}
        for sk in s.get("skips", []) or []:
            if not isinstance(sk, dict) or sk.get("why") not in SKIP_WHY:
                err(f"{tag}: skip with why {sk.get('why') if isinstance(sk, dict) else sk!r} not in {sorted(SKIP_WHY)}")
                continue
            msg = sk.get("msg")
            if not isinstance(msg, int) or not 1 <= msg <= len(msgs):
                err(f"{tag}: skip msg {msg!r} invalid")
                continue
            evid = sk.get("evid", "")
            if not isinstance(evid, str) or evid not in str(msgs[msg - 1].get("text", "")) or not evid.strip():
                err(f"{tag}: skip evid is not a verbatim substring of message {msg}: {str(evid)[:60]!r}")
            if sk["why"] == "secret" and re.search(r"\d{4,}|sk-[A-Za-z0-9]{6,}", str(evid)):
                err(f"{tag}: secret skip evid must not contain the secret itself")
            if set(sk) - {"why", "evid", "msg"}:
                err(f"{tag}: skip has unknown fields {sorted(set(sk) - {'why', 'evid', 'msg'})}")
        # same quote labelled as both fact and skip
        fq = {(f.get("msg"), f.get("evid")) for f in s.get("facts", []) or [] if isinstance(f, dict)}
        for sk in s.get("skips", []) or []:
            if isinstance(sk, dict) and (sk.get("msg"), sk.get("evid")) in fq:
                err(f"{tag}: the same quote is both a fact and a skip: {sk.get('evid')!r}")
    # queries
    qs = ep.get("queries")
    if not isinstance(qs, list) or not 1 <= len(qs) <= 5:
        err("queries must be a list of 1-5 items")
        qs = []
    for qi, q in enumerate(qs, 1):
        qt = f"q{qi}"
        a = q.get("after")
        if not isinstance(a, int) or not 1 <= a <= len(sessions):
            err(f"{qt}: after {a!r} invalid")
            continue
        qnow = q.get("now", "")
        if not ISO_DT.match(str(qnow)) or qnow <= str(sessions[a - 1].get("now", "")):
            err(f"{qt}: now must be an ISO date-time later than session {a}")
        if not isinstance(q.get("query"), str) or _words(q["query"]) < 3:
            err(f"{qt}: query text missing or too short")
        rel = q.get("relevant")
        if not isinstance(rel, list) or not 1 <= len(rel) <= 5:
            err(f"{qt}: relevant must list 1-5 keys")
            continue
        # replay the ledger up to `after`
        led = {}
        for s in sessions[:a]:
            for f in s.get("facts", []) or []:
                if not isinstance(f, dict) or "key" not in f:
                    continue
                if "retract" in f:
                    led.pop(f["key"], None)
                else:
                    led[f["key"]] = f
        for k in rel + list(q.get("trap", []) or []):
            if k not in led:
                err(f"{qt}: key {k} is not a live fact after session {a} (unknown, later, or retracted)")
            elif k in rel and led[k].get("persist") == "temp" and str(led[k].get("until", "")) < str(qnow)[:10]:
                err(f"{qt}: relevant key {k} is a temp fact that expired ({led[k].get('until')}) before the query")
        if set(rel) & set(q.get("trap", []) or []):
            err(f"{qt}: a key is in both relevant and trap")
    return E, W


def stats(eps):
    c = Counter()
    for ep in eps:
        c["episodes"] += 1
        c[f"lang:{ep.get('lang')}"] += 1
        for s in ep.get("sessions", []):
            c["sessions"] += 1
            c[f"source:{s.get('source')}"] += 1
            facts = [f for f in s.get("facts", []) or [] if isinstance(f, dict)]
            c["facts"] += sum(1 for f in facts if "retract" not in f)
            if not facts:
                c["empty_sessions"] += 1
            words = sum(_words(m.get("text", "")) for m in s.get("messages", []) if isinstance(m, dict))
            c["words"] += words
            if words >= 450 or len(s.get("messages", [])) >= 14:
                c["long_sessions"] += 1
            for f in facts:
                if "retract" in f:
                    c["retract"] += 1
                if f.get("change"):
                    c[f"change:{f['change']}"] += 1
                if f.get("repeat"):
                    c["repeat"] += 1
                if f.get("persist") == "temp":
                    c["temp"] += 1
                if f.get("basis") == "implied":
                    c["implied"] += 1
                if f.get("sens") in ("personal", "sensitive"):
                    c[f"sens:{f['sens']}"] += 1
            for sk in s.get("skips", []) or []:
                if isinstance(sk, dict):
                    c[f"skip:{sk.get('why')}"] += 1
        c["queries"] += len(ep.get("queries", []) or [])
    return c


def main(argv):
    if not argv or argv[0].startswith("-"):
        print(__doc__)
        return 2
    path = Path(argv[0])
    split = argv[argv.index("--split") + 1] if "--split" in argv else None
    quiet = "--quiet" in argv
    eps, E, W, ids = [], [], [], set()
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            ep = json.loads(line)
        except json.JSONDecodeError as e:
            E.append(f"line {n}: invalid JSON ({e})")
            continue
        if ep.get("id") in ids:
            E.append(f"line {n}: duplicate episode id {ep.get('id')}")
        ids.add(ep.get("id"))
        e, w = check_episode(ep, split)
        E += e
        W += w
        eps.append(ep)
    c = stats(eps)
    if not quiet:
        for m in W:
            print("WARN ", m)
    for m in E:
        print("ERROR", m)
    n = max(c["sessions"], 1)
    print(f"\n{path.name}: {c['episodes']} episodes, {c['sessions']} sessions, {c['facts']} facts "
          f"({c['facts'] / n:.2f}/session), empty sessions {c['empty_sessions'] / n:.0%}, "
          f"long sessions {c['long_sessions']}, words/session {c['words'] / n:.0f}, queries {c['queries']}")
    print("  " + ", ".join(f"{k}={v}" for k, v in sorted(c.items()) if ":" in k or k in ("retract", "repeat", "temp", "implied")))
    if c["sessions"] and c["empty_sessions"] / n < 0.18:
        print("COVERAGE: fewer than 20% of sessions are empty (spec §2 requires at least 20%)")
    for need in ("skip:secret", "skip:injection", "skip:joke", "skip:hypothetical", "skip:hearsay", "skip:suggestion",
                 "change:changed", "change:corrected", "change:refined", "repeat", "retract", "temp"):
        if c["episodes"] >= 6 and c[need] == 0:
            print(f"COVERAGE: no {need} in this shard (spec §3)")
    print(f"{len(E)} errors, {len(W)} warnings")
    return 1 if E else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
