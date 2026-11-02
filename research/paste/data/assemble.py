"""Tagged turns -> clean segment text + exact character spans (shared by both realizers)."""
import re

from paste.text import segment_text

TAG = re.compile(r"\[\[([um]\d+(?:\+[um]\d+)?)\|(.*?)\]\]")


def strip_tags(s):
    """Returns clean text and {tag: (start, end, text)} in local coordinates."""
    out, spans, pos, last = [], {}, 0, 0
    for m in TAG.finditer(s):
        out.append(s[last:m.start()]); pos += m.start() - last
        text = m.group(2)
        for t in m.group(1).split("+"):
            if t in spans:
                raise ValueError(f"tag {t} appears twice")
            spans[t] = (pos, pos + len(text), text)
        out.append(text); pos += len(text); last = m.end()
    out.append(s[last:])
    clean = "".join(out)
    if "[[" in clean or "]]" in clean:
        raise ValueError("malformed tag")
    return clean, spans


def assemble(turns_tagged):
    """turns_tagged: [{speaker, text}] with tags. Returns (clean turns, segment text, {tag: [a, b, text]})."""
    clean_turns, local = [], []
    for t in turns_tagged:
        c, sp = strip_tags(t["text"])
        clean_turns.append({"speaker": t["speaker"], "text": c}); local.append(sp)
    text, starts = segment_text(clean_turns)
    spans = {}
    for st, sp in zip(starts, local):
        for tag, (a, b, tx) in sp.items():
            if tag in spans:
                raise ValueError(f"tag {tag} appears in two turns")
            spans[tag] = [st + a, st + b, tx]
            assert text[st + a:st + b] == tx
    return clean_turns, text, spans
