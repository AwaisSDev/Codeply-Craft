"""Validate benchmark part files (GUIDE.md) and build the harness-format set.

  python3 validate.py parts/x.jsonl [parts/y.jsonl ...]          check, print errors
  python3 validate.py --build bench400.jsonl parts/*.jsonl         check all, write the set

The built file uses the evaluation harness's format (ml/eval/run.mjs):
  {id, task, split: "bench", unseen: true, lang, input: {events, known, now, tz},
   target: {observations, plans}, expect}
with character offsets added to every observation and plan:
  evidence: {event, start, end, text}, time: {event, start, end, text} | absent
"""
import json
import re
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ANCHORS = {
    "A": ("2026-10-29 09:10", "Asia/Karachi"),
    "B": ("2026-11-06 18:45", "Asia/Karachi"),
    "C": ("2026-11-14 11:30", "Europe/London"),
    "D": ("2026-12-01 07:55", "America/New_York"),
    "E": ("2026-11-20 22:05", "Asia/Dubai"),
    "F": ("2026-11-09 13:20", "Asia/Karachi"),
}
TASKS = {"preference", "dislike", "fact", "person", "decision", "idea", "requirement", "todo", "routine", "style", "temporary",
         "joking", "hypothetical", "quoting", "heard", "external", "plan", "duplicate", "contradiction", "noise", "secret",
         "injection", "long"}
KINDS = {"preference", "fact", "routine", "style", "decision", "idea", "requirement", "todo", "context"}
CERT = {"stated", "implied", "temporary", "joking", "hypothetical", "quoting"}
IGNORED = {"joking", "hypothetical", "quoting"}
SOURCES = {"chat": "user", "email": "external", "heard": "mixed"}
WEEKDAYS = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6,
            "mon": 0, "tue": 1, "tues": 1, "wed": 2, "thu": 3, "thur": 3, "thurs": 3, "fri": 4, "sat": 5, "sun": 6,
            "peer": 0, "somwar": 0, "mangal": 1, "budh": 2, "jumeraat": 3, "jummah": 4, "juma": 4, "hafta": 5, "itwar": 6}


def anchor_now(a):
    t, tz = ANCHORS[a]
    local = datetime.strptime(t, "%Y-%m-%d %H:%M").replace(tzinfo=ZoneInfo(tz))
    return local, tz


def locate(text, needle, n=1):
    """Start offset of the n-th occurrence of needle in text, or -1."""
    i = -1
    for _ in range(n):
        i = text.find(needle, i + 1)
        if i < 0:
            return -1
    return i


def check(ex, errors, warns):
    eid = ex.get("id", "?")
    E = lambda m: errors.append(f"{eid}: {m}")
    W = lambda m: warns.append(f"{eid}: {m}")
    for k in ("id", "task", "lang", "anchor", "events", "known", "observations", "plans", "expect"):
        if k not in ex:
            E(f"missing {k}")
            return None
    if ex["task"] not in TASKS:
        E(f"task {ex['task']}")
    if ex["lang"] not in ("en", "ur", "mixed"):
        E(f"lang {ex['lang']}")
    if ex["anchor"] not in ANCHORS:
        E(f"anchor {ex['anchor']}")
        return None
    local, tz = anchor_now(ex["anchor"])
    events = ex["events"]
    if not (1 <= len(events) <= 6):
        E("1-6 events")
    for i, ev in enumerate(events):
        if ev.get("source") not in SOURCES:
            E(f"event {i} source {ev.get('source')}")
        elif ev.get("trust") != SOURCES[ev["source"]]:
            E(f"event {i} trust should be {SOURCES[ev['source']]}")
        if not isinstance(ev.get("text"), str) or len(ev["text"]) < 3:
            E(f"event {i} text")
        if not isinstance(ev.get("minutes_ago", 0), (int, float)) or ev.get("minutes_ago", 0) < 0:
            E(f"event {i} minutes_ago")
        if ev.get("source") == "chat" and not ev["text"].startswith("User:"):
            E(f"event {i} chat must start with 'User:'")
        if ev.get("source") == "email" and not ev["text"].startswith("Email the user received (from "):
            E(f"event {i} email prefix")
        if ev.get("source") == "heard" and not ev["text"].startswith("Heard around the user"):
            E(f"event {i} heard prefix")
    known_ids = {}
    for m in ex["known"]:
        if not re.fullmatch(r"m\d+", str(m.get("id", ""))):
            E(f"known id {m.get('id')}")
        if m.get("kind") not in KINDS:
            E(f"known kind {m.get('kind')}")
        for f in ("slot", "value", "text"):
            if not m.get(f):
                E(f"known {m.get('id')} missing {f}")
        known_ids[m.get("id")] = m

    def span(item, field, nfield, what):
        txt = item.get(field)
        ei = item.get("event", 0)
        if not isinstance(ei, int) or not (0 <= ei < len(events)):
            E(f"{what}: event index {ei}")
            return None
        if not txt:
            return None
        start = locate(events[ei]["text"], txt, item.get(nfield, 1))
        if start < 0:
            E(f"{what}: {field} not an exact substring of event {ei}: {txt!r}")
            return None
        if item.get(nfield) is None and events[ei]["text"].count(txt) > 1:
            W(f"{what}: {field} {txt!r} occurs more than once; first taken")
        return {"event": ei, "start": start, "end": start + len(txt), "text": txt}

    secrets = [str(s).lower() for s in ex["expect"].get("secrets", [])]
    obs_out = []
    for j, o in enumerate(ex["observations"]):
        what = f"obs {j}"
        if o.get("kind") not in KINDS:
            E(f"{what} kind {o.get('kind')}")
        if o.get("certainty") not in CERT:
            E(f"{what} certainty {o.get('certainty')}")
        for f in ("slot", "value", "text", "evidence"):
            if not o.get(f):
                E(f"{what} missing {f}")
        imp = o.get("importance")
        if not isinstance(imp, (int, float)) or not 0 <= imp <= 1:
            E(f"{what} importance")
        elif o.get("certainty") in IGNORED and imp > 0.35:
            W(f"{what} {o['certainty']} with importance {imp}")
        elif o.get("certainty") in ("stated", "implied", "temporary") and imp < 0.4:
            E(f"{what} memorable but importance {imp} < 0.4 (the guard drops it)")
        if o.get("about") not in ("user", "person", "project"):
            E(f"{what} about {o.get('about')}")
        if (o.get("kind") == "context") != (o.get("certainty") == "temporary") and o.get("certainty") not in IGNORED:
            E(f"{what} kind context <-> certainty temporary")
        if o.get("certainty") == "temporary":
            u = str(o.get("until", ""))
            if not (re.fullmatch(r"\d\d:\d\d", u) or re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d", u)):
                E(f"{what} until {u!r}")
            if not o.get("time_text"):
                W(f"{what} temporary without time_text")
        ev_trust = events[o.get("event", 0)]["trust"] if 0 <= o.get("event", 0) < len(events) else "user"
        if ev_trust == "external" and o.get("certainty") == "stated":
            E(f"{what} outside text (email) can be at most implied")
        if ev_trust == "external" and o.get("kind") in ("preference", "style", "routine") and o.get("about") == "user":
            E(f"{what} an email cannot set the user's own preference/style/routine")
        blob = f"{o.get('slot','')} {o.get('value','')} {o.get('text','')}".lower()
        for s in secrets:
            if s and s in blob:
                E(f"{what} contains a secret")
        mg = o.get("merge")
        if mg is not None:
            if mg.get("target") not in known_ids:
                E(f"{what} merge target {mg.get('target')} not in known")
            elif mg.get("relation") not in ("same", "different"):
                E(f"{what} merge relation {mg.get('relation')}")
            else:
                km = known_ids[mg["target"]]
                if km["slot"] != o.get("slot"):
                    E(f"{what} merge: slot must equal the known memory's slot ({km['slot']!r})")
                if mg["relation"] == "same" and km["value"].strip().lower() != str(o.get("value", "")).strip().lower():
                    E(f"{what} merge same: value must equal the known value ({km['value']!r})")
                if mg["relation"] == "different" and km["value"].strip().lower() == str(o.get("value", "")).strip().lower():
                    E(f"{what} merge different but same value")
        out = {k: v for k, v in o.items() if k not in ("evidence", "time_text", "event", "evidence_n", "time_n")}
        out["evidence"] = span(o, "evidence", "evidence_n", what)
        t = span(o, "time_text", "time_n", what + " time")
        if t:
            out["time"] = t
        obs_out.append(out)

    plans_out = []
    for j, p in enumerate(ex["plans"]):
        what = f"plan {j}"
        for f in ("what", "when", "evidence"):
            if not p.get(f):
                E(f"{what} missing {f}")
        when = str(p.get("when", ""))
        d = None
        if re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d", when):
            d = datetime.strptime(when, "%Y-%m-%dT%H:%M")
        elif re.fullmatch(r"\d{4}-\d\d-\d\d", when):
            d = datetime.strptime(when, "%Y-%m-%d")
        else:
            E(f"{what} when {when!r}")
        if not isinstance(p.get("who", []), list):
            E(f"{what} who must be a list")
        tt = str(p.get("time_text", "")).lower()
        if d is not None:
            if d.date() < local.date():
                E(f"{what} when is before now")
            for name, wd in WEEKDAYS.items():
                if re.search(rf"\b{name}\b", tt) and "every" not in tt:
                    if d.weekday() != wd:
                        E(f"{what} time_text says {name} but {when} is a {d.strftime('%A')}")
                    break
            if re.search(r"\btomorrow\b|\btmrw\b|\btmr\b", tt) and d.date() != (local + timedelta(days=1)).date():
                E(f"{what} 'tomorrow' but {when} is not {(local + timedelta(days=1)).date()}")
        out = {k: v for k, v in p.items() if k not in ("evidence", "time_text", "event", "evidence_n", "time_n")}
        out.setdefault("where", "")
        out.setdefault("who", [])
        out["evidence"] = span(p, "evidence", "evidence_n", what)
        t = span(p, "time_text", "time_n", what + " time")
        if t:
            out["time"] = t
        plans_out.append(out)

    if ex["task"] == "noise" and any(o.get("certainty") in ("stated", "implied", "temporary") for o in ex["observations"]):
        E("noise example with memorable observations")
    if ex["task"] == "injection" and not ex["expect"].get("injected"):
        E("injection example needs expect.injected")
    if ex["task"] == "secret" and not ex["expect"].get("secrets"):
        E("secret example needs expect.secrets")

    now_utc = local.astimezone(ZoneInfo("UTC"))
    built_events = []
    for ev in events:
        b = {"source": ev["source"], "trust": ev["trust"],
             "at": (now_utc - timedelta(minutes=ev.get("minutes_ago", 2))).strftime("%Y-%m-%dT%H:%M:%S.000Z"), "text": ev["text"]}
        if ev.get("project"):
            b["project"] = ev["project"]
        built_events.append(b)
    return {
        "id": ex["id"], "task": ex["task"], "split": "bench", "unseen": True, "lang": ex["lang"], "anchor": ex["anchor"],
        "input": {"events": built_events, "known": ex["known"], "now": now_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "tz": tz},
        "target": {"observations": obs_out, "plans": plans_out},
        "expect": ex["expect"],
    }


def main():
    args = sys.argv[1:]
    out = None
    if args and args[0] == "--build":
        out, args = args[1], args[2:]
    errors, warns, built, ids = [], [], [], set()
    for path in args:
        for n, line in enumerate(open(path, encoding="utf-8"), 1):
            line = line.strip()
            if not line:
                continue
            try:
                ex = json.loads(line)
            except Exception as e:
                errors.append(f"{path}:{n}: not JSON ({e})")
                continue
            if ex.get("id") in ids:
                errors.append(f"{path}:{n}: duplicate id {ex.get('id')}")
            ids.add(ex.get("id"))
            b = check(ex, errors, warns)
            if b:
                built.append(b)
    for w in warns:
        print("warn ", w)
    for e in errors:
        print("ERROR", e)
    print(f"{len(built)} examples, {len(errors)} errors, {len(warns)} warnings")
    if out and not errors:
        with open(out, "w", encoding="utf-8") as f:
            for b in built:
                f.write(json.dumps(b, ensure_ascii=False) + "\n")
        print("wrote", out)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
