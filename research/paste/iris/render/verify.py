"""Deterministic verifier for rendered events (IRIS-DESIGN §3.2 step 3). A render is accepted only if the gold stays
exact: every required anchor occurs verbatim (case-insensitive) in a turn by the right speaker, no forbidden value
occurs anywhere, turn counts and lengths are within bounds. Character spans of anchors are recorded for the gold."""
import re

COMMON = {w.lower() for w in ("Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June "
                              "July August September October November December English Urdu Google Zoom WhatsApp").split()}


def distinctive(v):
    """Only values a model would not produce by accident are enforced as forbidden: they contain a digit, or are
    several words, or are a capitalised name that is not a weekday, month or common product."""
    v = v.strip()
    if any(ch.isdigit() for ch in v) or " " in v:
        return True
    return v[:1].isupper() and v.lower() not in COMMON


def _speaker_ok(turn_speaker, want, participants):
    ts = turn_speaker.strip().lower()
    w = (want or "user").strip().lower()
    if w == "user":
        user_name = participants[0].lower() if participants else "user"
        return ts in ("user", "me", user_name, user_name.split()[0])
    return ts == w or ts.split()[0] == w.split()[0]


def verify(event, turns, bounds=None):
    """turns: [{speaker, text}]. Returns (ok, reasons, spans) where spans = [{anchor, turn, start, end}]."""
    fs = event["fact_sheet"]
    n = fs.get("n_user_turns") or 1
    b = {"min_user_turns": max(1, -(-6 * n // 10)), "max_user_turns": n + 3,
         "max_turn_chars": 2500, "min_total_chars": 40}
    b.update(bounds or {})
    reasons, spans = [], []
    if not isinstance(turns, list) or not turns or not all(isinstance(t, dict) and isinstance(t.get("text"), str) and
                                                            isinstance(t.get("speaker"), str) for t in turns):
        return False, ["malformed turns"], []
    full = "\n".join(t["text"] for t in turns)
    low = full.lower()
    for i, m in enumerate(fs["must_express"]):
        for a in m["anchors"]:
            hit = None
            for ti, t in enumerate(turns):
                j = t["text"].lower().find(a.lower())
                if j >= 0 and (_speaker_ok(t["speaker"], m.get("speaker"), fs.get("participants")) or len(a) <= 2):
                    hit = (ti, j, j + len(a))
                    break
            if hit is None:
                reasons.append(f"anchor missing or wrong speaker: {a!r} (item {i}, speaker {m.get('speaker')})")
            else:
                spans.append({"anchor": a, "item": i, "turn": hit[0], "start": hit[1], "end": hit[2]})
    for v in fs.get("must_not_contain", []):
        if not distinctive(v):
            continue
        if re.search(r"(?<![a-z0-9])" + re.escape(v.lower()) + r"(?![a-z0-9])", low):
            reasons.append(f"forbidden value present: {v!r}")
    if fs["source"] in ("assistant_chat", "personal_chat", "work_chat"):
        n_user = sum(1 for t in turns if _speaker_ok(t["speaker"], "user", fs.get("participants")))
        if not b["min_user_turns"] <= n_user <= b["max_user_turns"]:
            reasons.append(f"user turns {n_user} outside [{b['min_user_turns']}, {b['max_user_turns']}]")
    if any(len(t["text"]) > b["max_turn_chars"] for t in turns):
        reasons.append("a turn is too long")
    if len(full) < b["min_total_chars"]:
        reasons.append("too short")
    return not reasons, reasons, spans
