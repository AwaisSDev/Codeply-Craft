"""Tokenisation with character offsets, field-token selection, and time buckets (spec §2-§4)."""
import math
import re

from tokenizers import Tokenizer

from .config import MAX_TEMP_DAYS, N_DT, N_REC_AGE, N_REC_EV, N_TEMP_AGE

SEP = " · "


class Text:
    def __init__(self, tokenizer_path: str, max_len: int = 256):
        self.tok = Tokenizer.from_file(tokenizer_path)
        self.max_len = max_len

    def encode(self, s: str, max_len: int | None = None):
        """ids with [CLS]..[SEP]; offsets per token ((0,0) for specials). Truncates before [SEP]."""
        e = self.tok.encode(s)
        ids, offs = list(e.ids), list(e.offsets)
        m = max_len or self.max_len
        if len(ids) > m:
            ids, offs = ids[:m - 1] + ids[-1:], offs[:m - 1] + offs[-1:]
        return ids, offs

    @staticmethod
    def tokens_in(offs, a: int, b: int):
        """Indices of non-special tokens overlapping the character span [a, b)."""
        return [i for i, (s, e) in enumerate(offs) if e > s and s < b and e > a]

    def record(self, profile_text: str, attribute: str, value: str):
        """rho_j = '<profile> · <attribute>: <value>' with token indices of the attribute and value fields."""
        s = f"{profile_text}{SEP}{attribute}: {value}"
        a0 = len(profile_text) + len(SEP)
        v0 = a0 + len(attribute) + 2
        ids, offs = self.encode(s)
        att, val = self.tokens_in(offs, a0, a0 + len(attribute)), self.tokens_in(offs, v0, v0 + len(value))
        if not att or not val:
            raise ValueError(f"empty field after tokenisation: {s!r}")
        return ids, att, val

    def span(self, s: str):
        """All non-special token indices of a free text (profile display text, temporary-item text)."""
        ids, offs = self.encode(s)
        idx = [i for i, (a, b) in enumerate(offs) if b > a]
        return ids, idx or [0]

    def char_to_token_span(self, offs, a: int, b: int):
        """Token span [start, end) covering characters [a, b) of a segment."""
        idx = self.tokens_in(offs, a, b)
        if not idx:
            raise ValueError(f"character span {a}:{b} covers no token")
        return idx[0], idx[-1] + 1


def segment_text(turns):
    """Speaker-tagged turns joined with newlines; returns text and the char offset of each turn's text."""
    parts, starts, pos = [], [], 0
    for t in turns:
        head = f"{'User' if t['speaker'] == 'user' else 'Assistant'}: "
        starts.append(pos + len(head))
        parts.append(head + t["text"])
        pos += len(head) + len(t["text"]) + 1
    return "\n".join(parts), starts


# ---- buckets (spec §4.1-4.3; bucket edges are a prototype choice, documented in PHASE3-REPORT) ----
def dt_bucket(seconds):
    """16 log buckets of minutes since the previous segment; bucket 0 = first segment / unknown."""
    if seconds is None:
        return 0
    return min(N_DT - 1, 1 + int(math.log2(1 + max(0.0, seconds) / 60.0)))


def rec_age_bucket(days):
    return min(N_REC_AGE - 1, int(math.log2(1 + max(0.0, days))))


def ev_bucket(evidence):
    return min(N_REC_EV - 1, max(0, int(evidence)))


def temp_age_bucket(segments):
    return min(N_TEMP_AGE - 1, int(math.log2(1 + max(0, segments))))


# ---- UNTIL resolver (spec §5.11 "u = resolve(span)"; the spec does not define it) ----------------
_DAY = 86400.0


def resolve_until(span: str, now: float) -> float:
    """Minimal deterministic resolver. Fallback mirrors brain.js: now + 24 h. Always capped at 14 days.

    Times are interpreted in UTC in this prototype (no user time zone yet).
    """
    s = span.lower()
    day_end = (math.floor(now / _DAY) + 1) * _DAY
    if re.search(r"\b(today|tonight|this evening|this afternoon)\b", s):
        u = day_end
    elif re.search(r"\btomorrow\b", s):
        u = day_end + _DAY
    elif re.search(r"\bnext week\b", s):
        u = now + 14 * _DAY
    elif re.search(r"\b(this week|for a week|for the week)\b", s):
        u = now + 7 * _DAY
    else:
        m = re.search(r"\b(?:until|till|by|at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b", s)
        if m and int(m.group(1)) <= 23:
            h = int(m.group(1)) % 12 + (12 if m.group(3) == "pm" else 0) if m.group(3) else int(m.group(1))
            u = math.floor(now / _DAY) * _DAY + h * 3600 + int(m.group(2) or 0) * 60
            if u <= now:
                u += _DAY
        else:
            u = now + _DAY
    return min(u, now + MAX_TEMP_DAYS * _DAY)
