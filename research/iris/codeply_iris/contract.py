"""Iris output contract `iris.ops/1`.

Iris proposes operations on the user's context; it never executes them. Deterministic infrastructure (the
Brain / `codeply_iris.store.MemoryStore`) validates each operation with `guard()` and decides what is
stored, for how long and under which permissions.

    {"ops":[ <op>, ... ]}            observe task
    {"use":[ "m3", "m7", ... ]}      retrieve task

Every op starts with its evidence (`src` message index + verbatim `evid` quote), then the decision:

| op        | meaning                                                         | Brain outcome |
|-----------|-----------------------------------------------------------------|---------------|
| add       | a new fact                                                      | insert        |
| update    | an existing memory (`ref`) has a new value; `why` says how      | replace       |
| confirm   | the input restates an existing memory (`ref`): no new memory    | reinforce     |
| retract   | an existing memory (`ref`) no longer holds                      | forget        |
| conflict  | the input disagrees with `ref` but is too uncertain to replace  | challenge     |
| skip      | memory-like text that must not be stored; `why` says why        | ignored       |

An empty list is a complete, valid answer: nothing in the input belongs in long-term context.
"""
import json
import re

VERSION = "iris.ops/1"
OPS = ("add", "update", "confirm", "retract", "conflict", "skip")
PERSISTENT_OPS = ("add", "update", "conflict")          # ops that assert a value
REF_OPS = ("update", "confirm", "retract", "conflict")
ETYPES = ("user", "person", "org", "project", "place", "event", "other")
KINDS = ("fact", "preference", "goal", "decision", "task", "event", "routine", "context")
KEEP = ("long", "temp")
BASIS = ("stated", "implied")
CONF = ("high", "medium", "low")
SENS = ("none", "personal", "sensitive")
WHY_UPDATE = ("changed", "corrected", "refined")
WHY_RETRACT = ("cancelled", "ended", "user_request", "mistaken")
WHY_SKIP = ("joke", "hypothetical", "hearsay", "suggestion", "secret", "injection", "other")
KEY_ORDER = ("src", "evid", "op", "ref", "ent", "type", "attr", "val", "kind", "when", "until", "keep", "why",
             "basis", "conf", "sens", "rel")
REQUIRED = {
    "add": ("src", "evid", "op", "ent", "type", "attr", "val", "kind", "keep", "basis", "conf", "sens"),
    "update": ("src", "evid", "op", "ref", "ent", "attr", "val", "kind", "keep", "why", "basis", "conf", "sens"),
    "conflict": ("src", "evid", "op", "ref", "ent", "attr", "val", "kind", "keep", "basis", "conf", "sens"),
    "confirm": ("src", "evid", "op", "ref"),
    "retract": ("src", "evid", "op", "ref", "why"),
    "skip": ("src", "evid", "op", "why"),
}
OPTIONAL = {
    "add": ("when", "until", "rel"), "update": ("when", "until", "rel"), "conflict": ("when", "until", "rel"),
    "confirm": (), "retract": (), "skip": (),
}
ENUMS = {"op": OPS, "type": ETYPES, "kind": KINDS, "keep": KEEP, "basis": BASIS, "conf": CONF, "sens": SENS}
WHY = {"update": WHY_UPDATE, "retract": WHY_RETRACT, "skip": WHY_SKIP}
MAXLEN = {"evid": 400, "ent": 80, "attr": 60, "val": 200, "ref": 12}
ISO_WHEN = re.compile(r"^\d{4}-\d{2}(-\d{2}(T\d{2}:\d{2})?)?$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REF_RE = re.compile(r"^m\d{1,6}$")
# Port of codeply-cli/lib/brain.js SECRET_RE, plus long digit runs and key-like tokens.
SECRET_RE = re.compile(r"(api[_ -]?key|password|passwd|passcode|secret key|bearer|private key|pin code|cvv|card number|"
                       r"iban|ssn|recovery phrase|seed phrase|otp)\b|\bsk-[a-z0-9]{8,}|\b\d{12,19}\b", re.I)


def squash(s):
    """Canonical text form used everywhere (prompts, evidence checks): whitespace collapsed."""
    return re.sub(r"\s+", " ", str(s if s is not None else "")).strip()


def norm(s):
    """Loose comparison form: lowercase, punctuation removed (Unicode-aware, so Urdu survives)."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w ]+", " ", str(s or "").lower(), flags=re.UNICODE)).strip()


def order(op):
    """An op with its keys in contract order (unknown keys dropped)."""
    return {k: op[k] for k in KEY_ORDER if k in op and op[k] not in (None, "", [])}


def dumps(ops):
    """Canonical serialisation of an observe answer: the training target and the wire format."""
    return json.dumps({"ops": [order(o) for o in ops]}, ensure_ascii=False, separators=(",", ":"))


def dumps_use(ids):
    return json.dumps({"use": list(ids)}, ensure_ascii=False, separators=(",", ":"))


def _first_json_object(text):
    """The first balanced {...} in text, or None. Used only as a fallback for chatty baselines."""
    start = text.find("{")
    while start >= 0:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    return None


def validate_op(op):
    """Schema check of one op. Returns (clean_op, None) or (None, reason)."""
    if not isinstance(op, dict):
        return None, "not_an_object"
    kind = op.get("op")
    if kind not in OPS:
        return None, "unknown_op"
    out = {}
    for k in REQUIRED[kind] + OPTIONAL[kind]:
        if k not in op or op[k] in (None, "", []):
            if k in REQUIRED[kind]:
                return None, f"missing_{k}"
            continue
        v = op[k]
        if k == "src":
            if isinstance(v, bool) or not isinstance(v, int) or v < 1:
                return None, "bad_src"
        elif k == "rel":
            if not isinstance(v, list) or not all(isinstance(x, str) and x.strip() for x in v) or len(v) > 8:
                return None, "bad_rel"
            v = [squash(x)[:80] for x in v]
        elif not isinstance(v, str):
            return None, f"bad_{k}"
        else:
            v = squash(v)
            if not v:
                return None, f"missing_{k}"
            if k in ENUMS and v not in ENUMS[k]:
                return None, f"bad_{k}"
            if k == "why" and v not in WHY[kind]:
                return None, "bad_why"
            if k == "ref" and not REF_RE.match(v):
                return None, "bad_ref"
            if k == "when" and not ISO_WHEN.match(v):
                return None, "bad_when"
            if k == "until" and not ISO_DATE.match(v):
                return None, "bad_until"
            if k in MAXLEN and len(v) > MAXLEN[k]:
                return None, f"long_{k}"
        out[k] = v
    if kind in PERSISTENT_OPS:
        if (out["ent"] == "user") != (out.get("type", "user" if out["ent"] == "user" else "x") == "user"):
            return None, "user_type_mismatch"
        if out["keep"] == "temp" and "until" not in out:
            return None, "temp_without_until"
        if out["kind"] == "context" and out["keep"] != "temp":
            return None, "context_not_temp"
    return order(out), None


def parse(text):
    """Parse a model answer for the observe task.

    Returns {"ok": strict-valid JSON with an "ops" list, "ops": [valid ops], "dropped": [(op, reason)]}.
    A malformed answer yields ok=False and no ops: the safe outcome is to store nothing.
    """
    raw = str(text or "").strip()
    strict = True
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        strict = False
        obj = _first_json_object(raw)
    if not isinstance(obj, dict) or not isinstance(obj.get("ops"), list):
        return {"ok": False, "ops": [], "dropped": [(raw[:200], "unparseable")]}
    ops, dropped = [], []
    for o in obj["ops"]:
        clean, why = validate_op(o)
        if clean is None:
            dropped.append((o, why))
        else:
            ops.append(clean)
    return {"ok": strict and not dropped, "ops": ops, "dropped": dropped}


def parse_use(text, known_ids=None):
    """Parse a retrieve answer. Unknown ids are dropped. Returns {"ok", "use"}."""
    raw = str(text or "").strip()
    try:
        obj = json.loads(raw)
        strict = True
    except json.JSONDecodeError:
        obj, strict = _first_json_object(raw), False
    if not isinstance(obj, dict) or not isinstance(obj.get("use"), list):
        return {"ok": False, "use": []}
    use, seen = [], set()
    for x in obj["use"]:
        if isinstance(x, str) and REF_RE.match(x) and x not in seen and (known_ids is None or x in known_ids):
            use.append(x)
            seen.add(x)
    return {"ok": strict and len(use) == len(obj["use"]), "use": use}


def ent_tokens(s):
    return set(norm(s).split())


def same_entity(a, b):
    """Loose entity equality: equal after normalisation, or one name's tokens contain the other's."""
    ta, tb = ent_tokens(a), ent_tokens(b)
    return bool(ta) and bool(tb) and (ta <= tb or tb <= ta)


def guard(ops, messages, memories, source=""):
    """Deterministic checks that every op must pass before infrastructure may act on it.

    messages: [{"who", "text"}]; memories: [{"id", "ent", ...}] as shown to the model.
    Returns (accepted, rejected) where rejected is [(op, reason)]. Reasons:
      bad_src, ungrounded_evidence (the quote is not in the cited message: evidence is never taken on trust),
      unknown_ref, ref_entity_mismatch, assistant_source (the assistant's words are not facts about the user),
      secret (credential-like value), duplicate_op.
    """
    by_id = {m["id"]: m for m in memories}
    texts = [squash(m.get("text", "")) for m in messages]
    accepted, rejected, seen = [], [], set()
    for op in ops:
        kind = op["op"]
        if not 1 <= op["src"] <= len(texts):
            rejected.append((op, "bad_src"))
            continue
        if squash(op["evid"]) not in texts[op["src"] - 1]:
            rejected.append((op, "ungrounded_evidence"))
            continue
        if kind in REF_OPS and op["ref"] not in by_id:
            rejected.append((op, "unknown_ref"))
            continue
        if kind in ("update", "conflict") and not same_entity(op["ent"], by_id[op["ref"]]["ent"]):
            rejected.append((op, "ref_entity_mismatch"))
            continue
        if kind in PERSISTENT_OPS:
            if source == "assistant_chat" and str(messages[op["src"] - 1].get("who", "")).lower() == "assistant":
                rejected.append((op, "assistant_source"))
                continue
            if SECRET_RE.search(f"{op['attr']} {op['val']}"):
                rejected.append((op, "secret"))
                continue
        sig = (kind, op.get("ref"), norm(op.get("ent")), norm(op.get("attr")), norm(op.get("val")))
        if kind != "skip" and sig in seen:
            rejected.append((op, "duplicate_op"))
            continue
        seen.add(sig)
        accepted.append(op)
    return accepted, rejected


# ---- JSON Schema for constrained decoding (llama.cpp `json_schema`, outlines, …) ------------------------------
def _op_schema(kind):
    props = {}
    for k in KEY_ORDER:
        if k not in REQUIRED[kind] + OPTIONAL[kind]:
            continue
        if k == "src":
            props[k] = {"type": "integer", "minimum": 1}
        elif k == "op":
            props[k] = {"const": kind}
        elif k == "rel":
            props[k] = {"type": "array", "items": {"type": "string"}, "maxItems": 8}
        elif k == "why":
            props[k] = {"enum": list(WHY[kind])}
        elif k in ENUMS:
            props[k] = {"enum": list(ENUMS[k])}
        elif k == "ref":
            props[k] = {"type": "string", "pattern": "^m[0-9]{1,6}$"}
        elif k == "when":
            props[k] = {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}(-[0-9]{2}(T[0-9]{2}:[0-9]{2})?)?$"}
        elif k == "until":
            props[k] = {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}
        else:
            props[k] = {"type": "string", "minLength": 1, "maxLength": MAXLEN.get(k, 200)}
    return {"type": "object", "properties": props, "required": list(REQUIRED[kind]), "additionalProperties": False}


OUTPUT_SCHEMA = {
    "$id": VERSION,
    "type": "object",
    "properties": {"ops": {"type": "array", "items": {"oneOf": [_op_schema(k) for k in OPS]}}},
    "required": ["ops"],
    "additionalProperties": False,
}
USE_SCHEMA = {
    "type": "object",
    "properties": {"use": {"type": "array", "items": {"type": "string", "pattern": "^m[0-9]{1,6}$"}}},
    "required": ["use"],
    "additionalProperties": False,
}

# ---- mapping to the production Brain (codeply-cli/lib/brain.js, context-schema.js) ----------------------------
BRAIN_KIND = {"fact": "fact", "preference": "preference", "goal": "fact", "decision": "decision", "task": "todo",
              "event": "context", "routine": "routine", "context": "context"}
BRAIN_ACTION = {"add": "insert", "update": "replace", "confirm": "reinforce", "retract": "forget",
                "conflict": "challenge", "skip": "ignored"}
IMPORTANCE = {"high": 0.8, "medium": 0.6, "low": 0.4}


def to_brain(op, memories=()):
    """One accepted op as the production extractor's output would carry it.

    Returns {"action", "observation"?, "plan"?, "target"?}. `observation` has the fields of
    context-schema.js (`kind, slot, value, text, certainty, importance, about, until`); events and dated tasks
    also yield a production `plan` {what, when, who}. Research-only fields ride along under `iris`.
    """
    kind = op["op"]
    out = {"action": BRAIN_ACTION[kind]}
    if kind in REF_OPS:
        out["target"] = op["ref"]
    if kind not in PERSISTENT_OPS:
        if kind == "skip":
            out["reason"] = op["why"]
        return out
    ent = op["ent"]
    about = "user" if ent == "user" else ("project" if op.get("type") == "project" else "person")
    subject = "The user" if ent == "user" else ent
    slot = op["attr"] if ent == "user" else f"{ent} {op['attr']}"
    certainty = "temporary" if op["keep"] == "temp" else ("stated" if op["basis"] == "stated" else "implied")
    obs = {"kind": "context" if op["keep"] == "temp" else BRAIN_KIND[op["kind"]], "slot": norm(slot)[:80],
           "value": op["val"][:200], "text": f"{subject}: {op['attr']} is {op['val']}."[:280], "certainty": certainty,
           "importance": IMPORTANCE[op["conf"]], "about": about}
    if op.get("until"):
        obs["until"] = op["until"]
    out["observation"] = obs
    if op["kind"] in ("event", "task") and op.get("when"):
        out["plan"] = {"what": f"{op['attr']}: {op['val']}" if ent == "user" else f"{ent} {op['attr']}: {op['val']}",
                       "when": op["when"], "who": [x for x in [ent] + list(op.get("rel", [])) if x != "user"]}
    out["iris"] = {k: op[k] for k in ("src", "evid", "ent", "type", "basis", "conf", "sens", "why", "rel", "when") if k in op}
    return out
