"""Research ports of production's extraction baselines (read-only references, not imported):
  * `rules_extract`   = codeply-cli/lib/context-model.js rulesExtract (rules-v1), the no-model floor;
  * `production_messages` = codeply-cli/lib/context-prompt.js buildExtractionMessages (PROMPT_VERSION 2, style
    'full'), the prompt production's local and cloud models get.
Outputs are production observations / plans; `to_iris` maps them to the iris.schema contract for scoring
(production has no entity, op or sensitivity: entity comes from `about` and the name in the text, op = new).
"""
import datetime
import re

JOKE_RE = re.compile(r"\b(lol|lmao|rofl|jk|just kidding|haha+|yeah right|as if|sure,? i (just )?love)\b|/s\b|🙄|😂", re.I)
HYPO_RE = re.compile(r"\b(what if|if i (were|was|had)|imagine|maybe|might|someday|would i|should i|i wish|i wonder)\b|\?\s*$", re.I)
QUOTE_RE = re.compile(r"\b(my (friend|mom|mum|mother|dad|father|boss|sister|brother|neighbou?r|colleague|manager|wife|husband)|he|she|they)"
                      r" (says|said|thinks|told me|reckons)\b|\baccording to\b", re.I)
TEMP_RE = re.compile(r"\b(today|tonight|this (week|weekend|morning|afternoon|evening)|right now|at the moment|for now|till|until)\b", re.I)
RELATIONS = "wife|husband|sister|brother|mom|mum|mother|dad|father|friend|girlfriend|boyfriend|son|daughter|partner|boss|cousin|uncle|aunt|colleague|cofounder|co-founder"
TECH = [
    ("auth", re.compile(r"\b(clerk|auth0|supabase auth|nextauth|firebase auth|magic links?|oauth|passkeys?)\b", re.I)),
    ("database", re.compile(r"\b(postgres(ql)?|mysql|mongo(db)?|sqlite|supabase|firebase|redis|dynamodb|planetscale|neon)\b", re.I)),
    ("hosting", re.compile(r"\b(vercel|netlify|aws|gcp|azure|fly\.io|render|railway|cloudflare|heroku)\b", re.I)),
    ("framework", re.compile(r"\b(next\.?js|react|vue|svelte|angular|django|rails|laravel|express|fastapi|flutter|react native|astro|remix)\b", re.I)),
    ("language", re.compile(r"\b(typescript|javascript|python|go|golang|rust|java|kotlin|swift|ruby|php|c#)\b", re.I)),
    ("styling", re.compile(r"\b(tailwind|css modules|styled[- ]components|bootstrap|sass)\b", re.I)),
]


def _split(t):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", str(t or "")) if s.strip()]


def _tidy(s, n=80):
    return re.sub(r"\s+", " ", re.sub(r"[.!?,;:]+$", "", str(s or ""))).strip()[:n]


def _first_words(s, n):
    return " ".join([w for w in _tidy(s).lower().split(" ") if not re.fullmatch(r"the|a|an|my|our|to|of|and|really|very|so", w)][:n])


def _user_lines(e):
    if e["source"] == "chat":
        lines, on = [], False
        for l in str(e["text"]).split("\n"):
            if re.match(r"^user:", l, re.I):
                on = True; lines.append(re.sub(r"^user:\s*", "", l, flags=re.I))
            elif re.match(r"^(assistant|[a-z]+):", l, re.I):
                on = False
            elif on:
                lines.append(l)
        return "\n".join(lines)
    return "" if e.get("trust") == "external" else e["text"]


def _until(s):
    m = re.search(r"\b(?:till|until|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?", s, re.I)
    if not m:
        return ""
    h = int(m.group(1))
    if m.group(3) and m.group(3).lower() == "pm" and h < 12:
        h += 12
    if not m.group(3) and 1 <= h <= 7:
        h += 12
    return f"{h:02d}:{m.group(2) or '00'}"


def rules_extract(events):
    """Port of rulesExtract (rules-v1)."""
    obs = []

    def push(o):
        if len(obs) < 8 and not any(x["slot"] == o["slot"] and x["kind"] == o["kind"] for x in obs):
            obs.append(o)
    for e in events:
        for s in _split(_user_lines(e)):
            cert = "joking" if JOKE_RE.search(s) else "quoting" if QUOTE_RE.search(s) else "hypothetical" if HYPO_RE.search(s) else "stated"
            base = {"certainty": cert, "about": "user", **({"project": e["project"]} if e.get("project") else {})}
            m = re.search(r"\bmy (?:favou?rite) ([a-z ]{2,30}?) is ([^.!?]{2,60})", s, re.I)
            if m:
                slot = f"favorite {_tidy(m.group(1)).lower()}"
                push({**base, "kind": "preference", "slot": slot, "value": _tidy(m.group(2), 60),
                      "text": f"The user's {slot} is {_tidy(m.group(2), 60)}.", "importance": 0.7}); continue
            m = re.search(rf"\b[Mm]y ({RELATIONS}),? ([A-Z][a-z]+)(?:,)? (is|was|loves|likes|hates|works|lives)\b([^.!?]{{0,80}})", s)
            if m:
                rel, name = m.group(1).lower(), m.group(2)
                v = _tidy(f"{m.group(3)}{m.group(4)}", 80)
                push({**base, "about": "person", "kind": "fact", "slot": f"{name.lower()} {rel}", "value": v,
                      "text": f"{name}, the user's {rel}, {_tidy(m.group(3) + m.group(4), 100)}.", "importance": 0.65, "_name": name}); continue
            m = re.search(r"\bI(?:'m| am) (?:in|at|on|with) ([^.!?]{2,50}?)(?: (?:till|until|this|today|tonight|for now)\b[^.!?]*)$", s, re.I)
            if m and TEMP_RE.search(s):
                u = _until(s)
                push({**base, "kind": "context", "certainty": "temporary" if cert == "stated" else cert, "slot": _first_words(m.group(1), 3),
                      "value": _tidy(m.group(1), 60), "text": f"The user is at {_tidy(m.group(1), 60)}.", "importance": 0.5,
                      **({"until": u} if u else {})}); continue
            m = re.search(r"\bI (?:really |strongly )?(prefer|like|love|hate|dislike|can't stand|cannot stand|enjoy)\s+([^.!?]{2,80})", s, re.I)
            if m:
                verb, ob = m.group(1).lower(), _tidy(m.group(2), 80)
                neg = bool(re.search(r"hate|dislike|stand", verb))
                push({**base, "kind": "preference", "slot": _first_words(re.sub(r"\bover\b.*$", "", ob, flags=re.I), 3),
                      "value": f"dislikes {ob}" if neg else ob, "text": f"The user {'dislikes' if neg else verb + 's'} {ob}.", "importance": 0.7}); continue
            m = re.search(r"\bI(?:'m| am) (?:a|an) ([a-z][a-z -]{2,40})\b", s, re.I)
            if m and not TEMP_RE.search(s):
                push({**base, "kind": "fact", "slot": "occupation", "value": _tidy(m.group(1), 40), "text": f"The user is a {_tidy(m.group(1), 40)}.", "importance": 0.75}); continue
            m = re.search(r"\bI (?:live|am based) in ([A-Z][a-zA-Z ]{1,40})", s)
            if m:
                push({**base, "kind": "fact", "slot": "home city", "value": _tidy(m.group(1), 40), "text": f"The user lives in {_tidy(m.group(1), 40)}.", "importance": 0.75}); continue
            m = re.search(r"\b(?:let'?s|let us|we(?:'ll| will)|we decided to|we're going with|go with|switch(?:ing)? to|we use|use)\s+(?:use\s+)?([^.!?]{2,80})", s, re.I)
            if m:
                what = _tidy(m.group(1), 80)
                area = next((k for k, rx in TECH if rx.search(what)), "")
                if not area and not e.get("project"):
                    continue
                val = next(rx for k, rx in TECH if k == area).search(what).group(0) if area else what
                push({**base, "kind": "decision", "about": "project", "slot": area or _first_words(what, 3), "value": val,
                      "text": f"The project uses {what}.", "importance": 0.8}); continue
            m = re.search(r"\b(?:remind me to|I need to|I have to|I must|don't let me forget to|todo:?)\s+([^.!?]{3,100})", s, re.I)
            if m:
                push({**base, "kind": "todo", "slot": _first_words(m.group(1), 3), "value": _tidy(m.group(1), 80),
                      "text": f"The user needs to {_tidy(m.group(1), 100)}.", "importance": 0.6}); continue
            m = re.search(r"\bI (?:usually|always|normally) ([^.!?]{3,80})", s, re.I) or \
                re.search(r"\b(?:every (?:day|morning|evening|night|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)),? I ([^.!?]{3,80})", s, re.I)
            if m:
                push({**base, "kind": "routine", "slot": _first_words(m.group(1), 3), "value": _tidy(m.group(1), 80),
                      "text": f"The user regularly {_tidy(m.group(1), 80)}.", "importance": 0.6})
    return {"observations": obs, "plans": []}


def to_iris(out):
    """Production observation / plan -> iris.schema observation / plan (for scoring)."""
    obs = []
    for o in (out or {}).get("observations", []) or []:
        if not isinstance(o, dict):
            continue
        ent = "user"
        if o.get("about") == "person":
            ent = o.get("_name") or (re.match(r"\s*([A-Z][a-z]+)", str(o.get("text", ""))) or [None, "person"])[1]
        elif o.get("about") == "project":
            ent = o.get("project") or "project"
        obs.append({"kind": o.get("kind"), "slot": o.get("slot", ""), "value": o.get("value", ""), "text": o.get("text", ""),
                    "certainty": o.get("certainty", "implied"), "importance": o.get("importance", 0.5), "about": o.get("about", "user"),
                    "entity": ent, "op": "new", "sensitivity": "personal"})
    plans = [{"what": p.get("what", ""), "when": p.get("when", ""), "where": p.get("where", ""), "who": p.get("who", []),
              "status": "confirmed"} for p in (out or {}).get("plans", []) or [] if isinstance(p, dict)]
    return {"observations": obs, "plans": plans, "relations": []}


# ---- production prompt (context-prompt.js v2, style 'full'), verbatim text ------------------------------------
RULES = open(__file__.replace("production.py", "production_prompt.txt")).read().split("\n=====\n")[0]
EXAMPLES = open(__file__.replace("production.py", "production_prompt.txt")).read().split("\n=====\n")[1]
TRUST_LABEL = {"user": "user", "mixed": "user and others", "external": "someone else"}


def local_time(t):
    d = datetime.datetime.fromtimestamp(t, datetime.timezone.utc)
    return d.strftime("%Y-%m-%d %H:%M (%A)")


def production_messages(events, known=(), now=None, projects=()):
    known_l = [f"- {m['kind']}{' (' + m['project'] + ')' if m.get('project') else ''} · {m.get('slot') or '-'}: {m.get('value') or m.get('text')}"
               for m in list(known)[:40]]
    block = "\n\n".join(
        f"[{i + 1}] {e['source']}{' · project ' + e['project'] if e.get('project') else ''} · {local_time(e['at'])} · from: "
        f"{TRUST_LABEL.get(e.get('trust'), 'someone else')}\n" + re.sub(r"(?im)^\s*JSON:", "json:", re.sub(r"</?events>", "", str(e["text"]), flags=re.I))
        for i, e in enumerate(events))
    user = "\n\n".join(x for x in [f"Now: {local_time(now or events[-1]['at'])}",
                                   f"Known projects: {', '.join(projects)}" if projects else "",
                                   "KNOWN memories:\n" + ("\n".join(known_l) if known_l else "(none)"),
                                   f"<events>\n{block}\n</events>", "JSON:"] if x)
    return [{"role": "system", "content": f"{RULES}\n\n{EXAMPLES}"}, {"role": "user", "content": user}]
