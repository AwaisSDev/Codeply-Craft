"""Iris output contract `iris.v1` (research/iris-arch/CONTRACT.md).

One model, three modes, one JSON envelope. The model proposes; deterministic code (this module first, then the
store) checks and enforces. Nothing the model writes is trusted until it passes:

  1. `validate(out, request)`   shape, enums, lengths, cross-field rules        -> list of errors (empty = valid)
  2. `verify_evidence(out, request)`  every quote occurs verbatim in a source event the model was given, every `ref`
     names a memory it was given, every `event` id exists                       -> list of errors
  3. `admit(out, request)`      drops what fails (never repairs facts), returns the safe subset + a report

Builds on the research schema v0 (`research/paste/iris/schema.py`, IRIS-DESIGN.md §2), which stays the compatibility
bridge to the production Brain: `to_v0()` and `to_brain_observation()` map every admitted item back.
"""
import json
import re

from iris.schema import (ABOUT, CERTAINTY, KINDS, PLAN_STATUS, RELATIONS, SECRET_RE, SENSITIVITY,
                         SENSITIVITY_CATEGORIES, ENTITY_TYPES, clip, norm)

VERSION = "iris.v1"
MODES = ("observe", "retrieve", "resolve")

# ---- observe: what to do with each piece of information -----------------------------------------------------------
# add        new information, no existing memory covers it
# reinforce  says again what a memory already holds (same value): evidence + confidence go up, nothing else changes
# refine     same fact, more precise or more complete ("Lahore" -> "DHA, Lahore"); old value kept in history
# update     the world changed ("launch moved to January"): old value closed (valid_to), new one current
# correct    an earlier value was wrong ("no, it was always Tuesday"): old value marked erroneous, not a past state
# conflict   disagrees with a memory and it is unclear which is right (two sources, no correction): both kept, flagged
# expire     a memory stops being true with no replacement (plan cancelled, project finished, no longer works there)
# link       connects existing memories / entities (same person under two names, task belongs to project)
# ignore     considered and deliberately not stored (small talk, a joke, a hypothetical, someone else's suggestion,
#            an unreliable source); stating it lets training and audits see the decision, the store does nothing
OPS = ("add", "reinforce", "refine", "update", "correct", "conflict", "expire", "link", "ignore")
NEEDS_REF = frozenset(("reinforce", "refine", "update", "correct", "conflict", "expire"))
WRITES_VALUE = frozenset(("add", "refine", "update", "correct", "conflict"))

BASIS = ("stated", "inferred")                     # said outright in the evidence vs concluded from it
PERSIST = ("store", "session", "ignore", "reject")  # keep / only for this conversation or until `valid.to` / drop / unsafe
LINKS = ("same_as", "part_of", "about", "updates", "contradicts", "depends_on")
SOURCE_KINDS = ("assistant_chat", "personal_chat", "work_chat", "email", "calendar", "screen", "document", "call",
                "task", "note", "activity")

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$")
REF_RE = re.compile(r"^[A-Za-z0-9:_.-]{1,40}$")

# ---- JSON Schema (also handed to the constrained decoder: llama.cpp grammar / outlines / xgrammar) ----------------
_STR = lambda n, mn=0: {"type": "string", "maxLength": n, **({"minLength": mn} if mn else {})}  # noqa: E731
EVIDENCE = {"type": "object", "additionalProperties": False, "required": ["event", "quote"],
            "properties": {"event": _STR(40, 1), "quote": _STR(240, 2)}}
ENTITY = {"type": "object", "additionalProperties": False, "required": ["name", "type"],
          "properties": {"id": _STR(40), "name": _STR(80, 1), "type": {"enum": list(ENTITY_TYPES)}}}
VALIDITY = {"type": "object", "additionalProperties": False,
            "properties": {"from": _STR(25), "to": _STR(25), "temporary": {"type": "boolean"}}}
PRIVACY = {"type": "object", "additionalProperties": False, "required": ["level"],
           "properties": {"level": {"enum": list(SENSITIVITY)}, "category": {"enum": list(SENSITIVITY_CATEGORIES)}}}
ITEM = {
    "type": "object", "additionalProperties": False,
    "required": ["op", "evidence", "basis", "confidence", "persist", "reason"],
    "properties": {
        "op": {"enum": list(OPS)},
        "ref": _STR(40),                                     # existing memory id (from the request), for NEEDS_REF
        "entity": ENTITY,                                    # who / what it is about
        "about": {"enum": list(ABOUT)},
        "kind": {"enum": list(KINDS)},
        "attribute": _STR(80),                               # = Brain `slot` (open vocabulary, reuse existing names)
        "value": _STR(200),
        "text": _STR(280),                                   # one self-contained sentence, as stored
        "certainty": {"enum": list(CERTAINTY)},
        "basis": {"enum": list(BASIS)},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "valid": VALIDITY,
        "project": _STR(80),
        "privacy": PRIVACY,
        "persist": {"enum": list(PERSIST)},
        "evidence": {"type": "array", "items": EVIDENCE, "maxItems": 4},
        "related": {"type": "array", "items": _STR(40), "maxItems": 6},
        "link": {"enum": list(LINKS)},                       # for op link: relation between `ref`/entity and `related`
        "reason": _STR(160, 2),
    },
}
PLAN = {
    "type": "object", "additionalProperties": False, "required": ["what", "status", "evidence", "confidence"],
    "properties": {"ref": _STR(40), "what": _STR(200, 2), "when": _STR(25), "where": _STR(120),
                   "who": {"type": "array", "items": _STR(80), "maxItems": 12}, "status": {"enum": list(PLAN_STATUS)},
                   "evidence": {"type": "array", "items": EVIDENCE, "maxItems": 4},
                   "confidence": {"type": "number", "minimum": 0, "maximum": 1}, "privacy": PRIVACY},
}
RELATION = {
    "type": "object", "additionalProperties": False, "required": ["a", "relation", "b", "evidence"],
    "properties": {"a": _STR(80, 1), "relation": {"enum": list(RELATIONS)}, "b": _STR(80, 1), "detail": _STR(80),
                   "evidence": {"type": "array", "items": EVIDENCE, "maxItems": 2}},
}
PICK = {
    "type": "object", "additionalProperties": False, "required": ["ref", "relevance", "why"],
    "properties": {"ref": _STR(40, 1), "relevance": {"type": "number", "minimum": 0, "maximum": 1},
                   "why": _STR(120, 2), "stale": {"type": "boolean"}, "share": {"enum": ["yes", "local_only", "no"]}},
}
ENVELOPE = {
    "type": "object", "additionalProperties": False, "required": ["v", "mode"],
    "properties": {
        "v": {"enum": [VERSION]}, "mode": {"enum": list(MODES)},
        "items": {"type": "array", "items": ITEM, "maxItems": 16},          # observe
        "plans": {"type": "array", "items": PLAN, "maxItems": 6},           # observe
        "relations": {"type": "array", "items": RELATION, "maxItems": 8},   # observe
        "picks": {"type": "array", "items": PICK, "maxItems": 30},          # retrieve
        "conflicts": {"type": "array", "maxItems": 8,                       # retrieve / resolve
                      "items": {"type": "object", "additionalProperties": False, "required": ["refs", "note"],
                                "properties": {"refs": {"type": "array", "items": _STR(40), "minItems": 2, "maxItems": 4},
                                               "note": _STR(160, 2)}}},
        "missing": {"type": "array", "items": _STR(160), "maxItems": 4},    # retrieve: what the task needs and memory lacks
    },
}


def _check(obj, schema, path="$"):
    """Minimal JSON-Schema subset validator (no dependency), as in iris/schema.py, plus minItems / boolean."""
    errs = []
    if "enum" in schema:
        return [] if obj in schema["enum"] else [f"{path}: {obj!r} not in {schema['enum']}"]
    t = schema.get("type")
    if t == "object":
        if not isinstance(obj, dict):
            return [f"{path}: not an object"]
        errs += [f"{path}.{k}: missing" for k in schema.get("required", []) if k not in obj]
        props = schema.get("properties", {})
        for k, v in obj.items():
            if k in props:
                errs += _check(v, props[k], f"{path}.{k}")
            elif schema.get("additionalProperties") is False:
                errs.append(f"{path}.{k}: not allowed")
    elif t == "array":
        if not isinstance(obj, list):
            return [f"{path}: not an array"]
        if not schema.get("minItems", 0) <= len(obj) <= schema.get("maxItems", 10 ** 9):
            errs.append(f"{path}: {len(obj)} items outside bounds")
        for i, v in enumerate(obj):
            errs += _check(v, schema.get("items", {}), f"{path}[{i}]")
    elif t == "string":
        if not isinstance(obj, str):
            return [f"{path}: not a string"]
        if not schema.get("minLength", 0) <= len(obj) <= schema.get("maxLength", 10 ** 9):
            errs.append(f"{path}: length {len(obj)} outside bounds")
    elif t == "number":
        if not isinstance(obj, (int, float)) or isinstance(obj, bool):
            return [f"{path}: not a number"]
        if not schema.get("minimum", -1e18) <= obj <= schema.get("maximum", 1e18):
            errs.append(f"{path}: {obj} outside range")
    elif t == "boolean" and not isinstance(obj, bool):
        return [f"{path}: not a boolean"]
    return errs


def validate(out, request=None):
    """Errors of a model output (empty list = valid): schema, then the rules a schema cannot say."""
    errs = _check(out, ENVELOPE)
    if errs:
        return errs
    mode = out["mode"]
    if request and request.get("mode") and request["mode"] != mode:
        errs.append(f"$.mode: {mode} answers a {request['mode']} request")
    if mode != "observe" and any(k in out for k in ("items", "plans", "relations")):
        errs.append("$: items / plans / relations only in observe mode")
    if mode == "observe" and "picks" in out:
        errs.append("$: picks only in retrieve mode")
    for i, it in enumerate(out.get("items", [])):
        p = f"$.items[{i}]"
        op = it["op"]
        if op in NEEDS_REF and not it.get("ref"):
            errs.append(f"{p}: op {op} needs ref")
        if op == "add" and it.get("ref"):
            errs.append(f"{p}: op add must not carry ref (use refine / update / correct)")
        if op in WRITES_VALUE:
            for k in ("entity", "about", "kind", "attribute", "value", "text", "certainty", "privacy"):
                if k not in it:
                    errs.append(f"{p}: op {op} needs {k}")
        if op == "link" and not (it.get("related") and it.get("link")):
            errs.append(f"{p}: op link needs related and link")
        if op != "ignore" and not it["evidence"]:
            errs.append(f"{p}: op {op} needs evidence")
        if op == "ignore" and it["persist"] not in ("ignore", "reject"):
            errs.append(f"{p}: op ignore must persist ignore or reject")
        if op in WRITES_VALUE and it["persist"] in ("ignore", "reject"):
            errs.append(f"{p}: op {op} with persist {it['persist']} (use op ignore)")
        if it.get("about") == "person" and it.get("kind") in ("preference", "routine", "style", "context"):
            errs.append(f"{p}: kind {it['kind']} about another person must be fact")
        if it.get("certainty") in ("joking", "hypothetical", "quoting") and op in WRITES_VALUE:
            errs.append(f"{p}: {it['certainty']} information cannot be written (op ignore)")
        lvl = (it.get("privacy") or {}).get("level")
        if SECRET_RE.search(" ".join(str(it.get(k, "")) for k in ("text", "value", "attribute"))) and lvl != "secret":
            errs.append(f"{p}: secret-looking content not labelled secret")
        if lvl == "secret" and it["persist"] == "store":
            errs.append(f"{p}: secrets are never stored (persist reject)")
        v = it.get("valid") or {}
        for k in ("from", "to"):
            if v.get(k) and not ISO_RE.match(v[k]):
                errs.append(f"{p}.valid.{k}: not ISO 8601")
        if v.get("temporary") and not v.get("to") and it["persist"] == "store":
            errs.append(f"{p}: temporary with no end should persist session")
        if it["basis"] == "inferred" and it["confidence"] > 0.9:
            errs.append(f"{p}: inferred information above confidence 0.9")
    for i, pl in enumerate(out.get("plans", [])):
        if pl.get("when") and not ISO_RE.match(pl["when"]):
            errs.append(f"$.plans[{i}].when: not ISO 8601")
    return errs


def _events(request):
    return {e["id"]: e for e in (request or {}).get("events", [])}


def _squash(s):
    return re.sub(r"\s+", " ", str(s)).strip().lower()


def verify_evidence(out, request):
    """Grounding errors: every quote must occur verbatim (whitespace / case folded) in the event it names, every event
    and memory id must come from the request. The model can never cite what it was not shown."""
    errs = []
    events = _events(request)
    mem_ids = {m["id"] for m in (request or {}).get("memories", [])}
    ent_ids = {e["id"] for e in (request or {}).get("entities", []) if e.get("id")}
    groups = [("items", out.get("items", [])), ("plans", out.get("plans", [])), ("relations", out.get("relations", []))]
    for name, rows in groups:
        for i, r in enumerate(rows):
            p = f"$.{name}[{i}]"
            for j, ev in enumerate(r.get("evidence", [])):
                e = events.get(ev["event"])
                if e is None:
                    errs.append(f"{p}.evidence[{j}]: unknown event {ev['event']!r}")
                elif _squash(ev["quote"]) not in _squash(e.get("text", "")):
                    errs.append(f"{p}.evidence[{j}]: quote not found in event {ev['event']}")
            ref = r.get("ref")
            if ref and name == "items" and ref not in mem_ids:
                errs.append(f"{p}.ref: unknown memory {ref!r}")
            if name == "items":
                for x in r.get("related", []):
                    if x not in mem_ids and x not in ent_ids:
                        errs.append(f"{p}.related: unknown id {x!r}")
                eid = (r.get("entity") or {}).get("id")
                if eid and eid not in ent_ids:
                    errs.append(f"{p}.entity.id: unknown entity {eid!r} (new entities have no id)")
            if name == "items" and r.get("basis") == "stated" and r.get("value") and r["op"] in WRITES_VALUE:
                quotes = " ".join(_squash(ev["quote"]) for ev in r.get("evidence", []))
                if norm(r["value"]) and not all(w in norm(quotes) for w in norm(r["value"]).split()[:6]):
                    errs.append(f"{p}: basis stated but the value is not in its evidence (say inferred)")
    for i, pk in enumerate(out.get("picks", [])):
        if pk["ref"] not in mem_ids:
            errs.append(f"$.picks[{i}].ref: unknown memory {pk['ref']!r}")
    for i, c in enumerate(out.get("conflicts", [])):
        for x in c["refs"]:
            if x not in mem_ids:
                errs.append(f"$.conflicts[{i}]: unknown memory {x!r}")
    return errs


def parse(text):
    """Model text -> dict or None. Accepts a bare object or one fenced block; nothing else is guessed."""
    s = str(text or "").strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", s, re.S)
    if m:
        s = m.group(1)
    try:
        obj = json.loads(s)
    except (ValueError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


def admit(out, request):
    """The safe subset of a model output. Whole-output failures (unparseable, wrong envelope) admit nothing; a bad
    item is dropped on its own, never repaired. Returns (admitted, report)."""
    if isinstance(out, str):
        out = parse(out)
    if out is None:
        return None, {"ok": False, "fatal": "unparseable", "dropped": []}
    env = {k: out.get(k) for k in ("v", "mode")}
    if _check(env, {"type": "object", "required": ["v", "mode"], "properties": ENVELOPE["properties"]}):
        return None, {"ok": False, "fatal": "envelope", "dropped": []}
    kept, dropped = {"v": out["v"], "mode": out["mode"]}, []
    for key in ("items", "plans", "relations", "picks", "conflicts", "missing"):
        rows = out.get(key)
        if rows is None:
            continue
        if not isinstance(rows, list):
            dropped.append({"where": f"$.{key}", "errors": ["not an array"]})
            continue
        good = []
        for i, r in enumerate(rows):
            probe = {"v": out["v"], "mode": out["mode"], key: [r]}
            errs = validate(probe, request) + verify_evidence(probe, request)
            if errs:
                dropped.append({"where": f"$.{key}[{i}]", "errors": errs})
            else:
                good.append(r)
        kept[key] = good
    return kept, {"ok": not dropped, "fatal": None, "dropped": dropped}


# ---- bridges ------------------------------------------------------------------------------------------------------
_V0_OP = {"add": "new", "reinforce": "reinforce", "refine": "update", "update": "update", "correct": "contradict",
          "conflict": "contradict", "expire": "update", "link": "none", "ignore": "none"}


def to_v0(item):
    """iris.v1 item -> research schema v0 observation (iris/schema.py), so v0 tools and IrisBench v0 still score it."""
    lvl = (item.get("privacy") or {}).get("level", "personal")
    o = {"kind": item.get("kind", "fact"), "slot": item.get("attribute", ""), "value": item.get("value", ""),
         "text": item.get("text") or item.get("reason", "")[:280], "certainty": item.get("certainty", "implied"),
         "importance": round(float(item.get("confidence", 0.5)), 3), "about": item.get("about", "user"),
         "entity": (item.get("entity") or {}).get("name", "user"), "op": _V0_OP[item["op"]], "sensitivity": lvl}
    if item.get("ref"):
        o["target"] = item["ref"]
    cat = (item.get("privacy") or {}).get("category")
    if cat:
        o["sensitivity_category"] = cat
    if item.get("project"):
        o["project"] = item["project"]
    v = item.get("valid") or {}
    if v.get("from"):
        o["valid_from"] = v["from"]
    if v.get("to"):
        o["valid_to"] = v["to"]
        if v.get("temporary"):
            o["until"] = v["to"]
    if item.get("evidence"):
        o["evidence"] = clip(item["evidence"][0]["quote"], 300)
    return o


def to_brain_observation(item, scope="me"):
    """iris.v1 item -> the dict production `brain.observe()` takes (codeply-cli/lib/brain.js), or None when the item
    must not reach the Brain (ignore / reject / session-only / link-only)."""
    if item["op"] not in WRITES_VALUE and item["op"] != "reinforce":
        return None
    if item["persist"] != "store":
        return None
    out = {"kind": item["kind"], "text": item["text"], "slot": norm(item["attribute"])[:80], "value": item["value"],
           "certainty": "temporary" if (item.get("valid") or {}).get("temporary") else item["certainty"],
           "scope": f"project:{norm(item['project']).replace(' ', '-')}" if item.get("project") else scope}
    v = item.get("valid") or {}
    if v.get("to"):
        out["until"] = v["to"]
    return out
