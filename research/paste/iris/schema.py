"""Iris memory schema v0 (IRIS-DESIGN.md §2): a superset of the production Brain format.

Production compatibility target (read-only reference, not imported): `codeply-cli/lib/brain.js` (KINDS, CERTAINTY,
SECRET_RE, norm, clip, cleanObservation, the `memories` table) and `codeply-cli/lib/context-schema.js` (observation
fields `importance`, `about`). The constants and `clean_observation` below are line-for-line ports, so that any
research observation turns into exactly what `brain.observe()` would store; `to_brain_observation` drops the research
fields.

Research additions (gaps in production, IRIS-DESIGN §1): `entity` (who / what it is about), `op` + `target` (new,
reinforce, update, contradict, duplicate), `sensitivity` + `sensitivity_category`, `source` (event id, source type,
trust), `evidence_span`, `valid_from` / `valid_to`; plans with a `status`; relations between entities and memories.
"""
import re

# ---- ports of codeply-cli/lib/brain.js (keep in sync; see tests/test_iris_schema.py) ---------------------------
KINDS = ("preference", "fact", "routine", "style", "decision", "idea", "requirement", "todo", "context", "lesson")
PROJECT_KINDS = frozenset(("decision", "idea", "requirement", "todo"))
PERSONAL_KINDS = frozenset(("preference", "fact", "routine", "style"))
CERTAINTY = ("stated", "implied", "temporary", "joking", "hypothetical", "quoting")
IGNORED = frozenset(("joking", "hypothetical", "quoting"))
SECRET_RE = re.compile(r"(api[_ -]?key|password|passwd|passcode|secret|token|bearer|private key|pin code|cvv|card number|iban|ssn)\b"
                       r"|\bsk-[a-z0-9]{8,}", re.I)
DOMAINS = ("calendar", "email", "reminders", "calls", "texts", "research", "code", "social", "health", "money")
ABOUT = ("user", "person", "project")                       # context-schema.js
STATUSES = ("confirmed", "tentative", "temporary")
SCOPE_RE = re.compile(r"^(me|team|project:[a-z0-9-]+)$")


def clip(s, n):
    return re.sub(r"\s+", " ", "" if s is None else str(s)).strip()[:n]


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", str(s or "").lower())).strip()


def clean_observation(o):
    """Port of brain.js cleanObservation (without `until` time parsing, which needs a clock; kept as given)."""
    if not isinstance(o, dict):
        return None
    kind = str(o.get("kind") or "").lower().strip()
    if kind in ("temporary", "live", "now"):
        kind = "context"
    if kind == "preferences":
        kind = "preference"
    if kind not in KINDS:
        kind = "decision" if o.get("project") else "fact"
    certainty = str(o.get("certainty") or o.get("how") or "").lower().strip()
    if certainty in ("sarcastic", "sarcasm", "joke", "teasing"):
        certainty = "joking"
    if certainty in ("explicit", "direct", "said"):
        certainty = "stated"
    if certainty in ("question", "maybe", "wish"):
        certainty = "hypothetical"
    if certainty not in CERTAINTY:
        certainty = "implied"
    if kind == "context":
        certainty = certainty if certainty in IGNORED else "temporary"
    if certainty == "temporary" and kind != "context":
        kind = "context"
    value = clip(o.get("value"), 200)
    slot = norm(o.get("slot"))[:80]
    text = clip(o.get("text") or o.get("fact") or (f"{slot}: {value}" if slot and value else value), 280)
    if not text or len(text) < 3:
        return None
    return {"kind": kind, "certainty": certainty, "slot": slot, "value": value, "text": text,
            "project": clip(o.get("project"), 80), "scope": str(o["scope"]) if o.get("scope") else "",
            "until": o.get("until") or "", "domain": clip(o.get("domain"), 40).lower()}


def brain_would_store(o):
    """What brain.observe() does with a cleaned observation, ignoring the store's current state:
    'ignored' for secrets and joking / hypothetical / quoting, else 'stored'."""
    c = clean_observation(o)
    if c is None:
        return "invalid"
    if SECRET_RE.search(f"{c['text']} {c['value']} {c['slot']}"):
        return "ignored"
    if c["certainty"] in IGNORED:
        return "ignored"
    return "stored"


# ---- research schema ------------------------------------------------------------------------------------------
OPS = ("new", "reinforce", "update", "contradict", "duplicate", "none")
SENSITIVITY = ("public", "personal", "private", "secret")
SENSITIVITY_CATEGORIES = ("none", "finance", "identity", "health", "credentials", "location", "intimate", "work_confidential")
SOURCE_TYPES = ("assistant_chat", "personal_chat", "work_chat", "email", "calendar", "screen", "document", "call", "task")
TRUST = ("user", "mixed", "external")                     # context-schema.js
PLAN_STATUS = ("confirmed", "tentative", "suggested", "declined", "cancelled", "done")
ENTITY_TYPES = ("user", "person", "organisation", "project", "place", "event")
RELATIONS = ("family", "partner", "friend", "colleague", "manager", "report", "investor", "teacher", "classmate", "client",
             "doctor", "neighbour", "works_at", "studies_at", "member_of", "owns", "leads", "part_of", "located_in", "other")
MEMORY_LINKS = ("same_as", "updates", "contradicts", "part_of")

OBSERVATION_SCHEMA = {                                    # JSON Schema for constrained decoding of model output
    "type": "object",
    "required": ["kind", "slot", "value", "text", "certainty", "importance", "about", "entity", "op", "sensitivity"],
    "additionalProperties": False,
    "properties": {
        "kind": {"enum": list(KINDS)},
        "slot": {"type": "string", "maxLength": 80},
        "value": {"type": "string", "maxLength": 200},
        "text": {"type": "string", "minLength": 3, "maxLength": 280},
        "certainty": {"enum": list(CERTAINTY)},
        "importance": {"type": "number", "minimum": 0, "maximum": 1},
        "about": {"enum": list(ABOUT)},
        "entity": {"type": "string", "maxLength": 80},
        "op": {"enum": list(OPS)},
        "target": {"type": "string", "maxLength": 40},
        "sensitivity": {"enum": list(SENSITIVITY)},
        "sensitivity_category": {"enum": list(SENSITIVITY_CATEGORIES)},
        "project": {"type": "string", "maxLength": 80},
        "until": {"type": "string", "maxLength": 32},
        "valid_from": {"type": "string", "maxLength": 32},
        "valid_to": {"type": "string", "maxLength": 32},
        "evidence": {"type": "string", "maxLength": 300},
    },
}
PLAN_SCHEMA = {
    "type": "object",
    "required": ["what", "status"],
    "additionalProperties": False,
    "properties": {
        "what": {"type": "string", "maxLength": 200}, "when": {"type": "string", "maxLength": 40},
        "where": {"type": "string", "maxLength": 120}, "who": {"type": "array", "items": {"type": "string", "maxLength": 80}, "maxItems": 12},
        "status": {"enum": list(PLAN_STATUS)}, "target": {"type": "string", "maxLength": 40},
        "sensitivity": {"enum": list(SENSITIVITY)},
    },
}
RELATION_SCHEMA = {
    "type": "object",
    "required": ["a", "relation", "b"],
    "additionalProperties": False,
    "properties": {"a": {"type": "string", "maxLength": 80}, "relation": {"enum": list(RELATIONS)},
                   "b": {"type": "string", "maxLength": 80}, "detail": {"type": "string", "maxLength": 80}},
}
EXTRACTION_SCHEMA = {
    "type": "object",
    "required": ["observations", "plans", "relations"],
    "additionalProperties": False,
    "properties": {"observations": {"type": "array", "items": OBSERVATION_SCHEMA, "maxItems": 12},
                   "plans": {"type": "array", "items": PLAN_SCHEMA, "maxItems": 6},
                   "relations": {"type": "array", "items": RELATION_SCHEMA, "maxItems": 8}},
}


def _check(obj, schema, path="$"):
    """Minimal JSON-Schema subset validator (type / enum / required / additionalProperties / length / range /
    array items), enough for these schemas without a dependency."""
    errs = []
    t = schema.get("type")
    if "enum" in schema:
        if obj not in schema["enum"]:
            errs.append(f"{path}: {obj!r} not in {schema['enum']}")
        return errs
    if t == "object":
        if not isinstance(obj, dict):
            return [f"{path}: not an object"]
        for k in schema.get("required", []):
            if k not in obj:
                errs.append(f"{path}.{k}: missing")
        props = schema.get("properties", {})
        for k, v in obj.items():
            if k in props:
                errs += _check(v, props[k], f"{path}.{k}")
            elif schema.get("additionalProperties") is False:
                errs.append(f"{path}.{k}: not allowed")
    elif t == "array":
        if not isinstance(obj, list):
            return [f"{path}: not an array"]
        if len(obj) > schema.get("maxItems", 10 ** 9):
            errs.append(f"{path}: more than {schema['maxItems']} items")
        for i, v in enumerate(obj):
            errs += _check(v, schema.get("items", {}), f"{path}[{i}]")
    elif t == "string":
        if not isinstance(obj, str):
            return [f"{path}: not a string"]
        if len(obj) > schema.get("maxLength", 10 ** 9) or len(obj) < schema.get("minLength", 0):
            errs.append(f"{path}: length {len(obj)} outside bounds")
    elif t == "number":
        if not isinstance(obj, (int, float)) or isinstance(obj, bool):
            return [f"{path}: not a number"]
        if not schema.get("minimum", -1e18) <= obj <= schema.get("maximum", 1e18):
            errs.append(f"{path}: {obj} outside range")
    return errs


def validate_extraction(obj):
    """Errors (empty list = valid) of a model's extraction output against EXTRACTION_SCHEMA, plus cross-field rules:
    update / contradict / reinforce / duplicate need a target; personal kinds about another person must be `fact`
    (context-schema.js rule); secret-looking values must be labelled `secret`."""
    errs = _check(obj, EXTRACTION_SCHEMA)
    if errs:
        return errs
    for i, o in enumerate(obj["observations"]):
        if o["op"] in ("update", "contradict", "reinforce", "duplicate") and not o.get("target"):
            errs.append(f"$.observations[{i}]: op {o['op']} needs a target")
        if o["about"] == "person" and o["kind"] in ("preference", "routine", "style", "context"):
            errs.append(f"$.observations[{i}]: kind {o['kind']} about another person must be 'fact'")
        if SECRET_RE.search(f"{o['text']} {o['value']} {o['slot']}") and o["sensitivity"] != "secret":
            errs.append(f"$.observations[{i}]: secret-looking content not labelled secret")
    return errs


def to_brain_observation(o, scope="me"):
    """Research observation -> the dict brain.observe() takes (research fields dropped)."""
    out = {"kind": o["kind"], "text": o["text"], "slot": o.get("slot", ""), "value": o.get("value", ""),
           "certainty": o.get("certainty", "implied"), "scope": scope}
    for k in ("project", "until", "domain"):
        if o.get(k):
            out[k] = o[k]
    return out


BRAIN_COLUMNS = ("id", "kind", "scope", "slot", "value", "text", "status", "confidence", "evidence", "locked", "review",
                 "challenger", "history", "sources", "domain", "expires_at", "created_at", "updated_at", "seen_at")


def to_brain_row(mem):
    """Research memory record -> a `memories` table row (exact production columns; extras dropped)."""
    row = {c: mem.get(c) for c in BRAIN_COLUMNS}
    row["locked"] = 1 if mem.get("locked") else 0
    row["review"] = 1 if mem.get("review") else 0
    return row
