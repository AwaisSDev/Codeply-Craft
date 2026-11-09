"""Baselines for IrisBench, each mapped onto the Iris op contract so one scorer judges them all.

* `nothing`      stores nothing (the reference every precision-oriented system must beat on cost)
* `rules`        production's no-model extractor (rules-v1), via the research port in research/paste
* `production`   production's extraction request as shipped: prompt v2, strict JSON schema, 700 tokens, the
                 production guard, on any local GGUF chat model (production's is LFM3-1.7B)
* `keyword`      retrieval by word overlap, the core of production's ranking (context-retrieval.js)

Production has no ops, entities or evidence. The adapter is deliberately generous to it:
  entity   = `about` plus the first known name found in the observation (else "user")
  op       = what brain.observe() would do: a KNOWN memory with the same slot -> confirm (same value) or
             update (different value); otherwise add
  evidence = not produced, so grounding is not scored against it (ops are marked `_nogound`)
The existing ports are imported read-only; nothing under research/paste is modified.
"""
import datetime
import json
import re
import sys
from pathlib import Path

from . import contract
from .store import same_value, tokens

_PASTE = Path(__file__).resolve().parents[2] / "paste"


def _production():
    if str(_PASTE) not in sys.path:
        sys.path.insert(0, str(_PASTE))
    from iris.baselines import production          # research/paste/iris/baselines/production.py
    return production


def session_event(session):
    """A teacher session as one production event."""
    src = session["source"]
    who = lambda w: "User" if w == "user" else ("Assistant" if w == "assistant" else w)
    if src in ("calendar", "note", "screen"):
        text = "\n".join(m["text"] for m in session["messages"])
    else:
        text = "\n".join(f"{who(m['who'])}: {m['text']}" for m in session["messages"])
    source = {"assistant_chat": "chat", "personal_chat": "texts", "work_chat": "texts", "email": "email",
              "calendar": "calendar", "note": "notes", "screen": "screen"}[src]
    others = any(m["who"] not in ("user", "assistant", "note", "calendar", "email from user") for m in session["messages"])
    trust = "user" if src in ("assistant_chat", "note", "calendar") else ("mixed" if any(
        m["who"] in ("user", "email from user") for m in session["messages"]) and others else "external")
    at = datetime.datetime.fromisoformat(session["now"]).replace(tzinfo=datetime.timezone.utc).timestamp()
    return {"id": "e1", "source": source, "at": at, "trust": trust, "text": text}


def known_for_production(memories):
    """Memories in the form production's prompt lists them (kind · slot: value)."""
    out = []
    for m in memories:
        slot = m["attr"] if m["ent"] == "user" else f"{m['ent']} {m['attr']}"
        out.append({"kind": contract.BRAIN_KIND.get(m.get("kind", "fact"), "fact"), "slot": contract.norm(slot), "value": m["val"],
                    "_id": m["id"]})
    return out


def _entity(obs, names):
    blob = f"{obs.get('slot', '')} {obs.get('text', '')} {obs.get('value', '')}".lower()
    if obs.get("about", "user") == "user":
        return "user"
    hits = [n for n in names if n != "user" and any(t in blob.split() or t in blob for t in contract.norm(n).split() if len(t) > 2)]
    if hits:
        return max(hits, key=lambda n: sum(t in blob for t in contract.norm(n).split()))
    m = re.match(r"\s*([A-Z][\w-]+(?: [A-Z][\w-]+)?)", str(obs.get("text", "")))
    return m.group(1) if m else (obs.get("project") or "person")


def production_to_ops(answer, memories, names):
    """Production observations / plans -> content ops (see module docstring for the mapping)."""
    known = known_for_production(memories)
    by_slot = {k["slot"]: k for k in known}
    by_id = {m["id"]: m for m in memories}
    ops = []
    for o in (answer or {}).get("observations", []) or []:
        if o.get("certainty") in ("joking", "hypothetical", "quoting"):
            continue                                            # the Brain ignores these
        ent = _entity(o, names)
        temp = o.get("kind") == "context" or o.get("certainty") == "temporary"
        base = {"src": 1, "evid": "", "ent": ent, "attr": o.get("slot", "") or "note", "val": o.get("value") or o.get("text", ""),
                "kind": {"todo": "task"}.get(o.get("kind"), o.get("kind") if o.get("kind") in contract.KINDS else "fact"),
                "keep": "temp" if temp else "long", "basis": "stated" if o.get("certainty") == "stated" else "implied",
                "conf": "high" if float(o.get("importance", 0.5)) >= 0.7 else "medium", "sens": "none", "_noground": True}
        hit = by_slot.get(contract.norm(o.get("slot", "")))
        if hit:
            m = by_id[hit["_id"]]
            if same_value(m["val"], base["val"]):
                ops.append({"src": 1, "evid": "", "op": "confirm", "ref": m["id"], "_noground": True})
            else:
                ops.append({**base, "op": "update", "ref": m["id"], "ent": m["ent"], "why": "changed"})
        else:
            ops.append({**base, "op": "add", "type": "user" if ent == "user" else "person"})
    for p in (answer or {}).get("plans", []) or []:
        when = str(p.get("when", ""))[:16]
        ops.append({"src": 1, "evid": "", "op": "add", "ent": "user", "type": "user", "attr": "plan", "val": p.get("what", ""),
                    "kind": "event", "keep": "long", "basis": "stated", "conf": "high", "sens": "none", "_noground": True,
                    **({"when": when} if contract.ISO_WHEN.match(when) else {}), "_plan": True})
    return ops


class Rules:
    name = "rules-v1"

    def ops(self, session, memories, names):
        prod = _production()
        ev = session_event(session)
        return production_to_ops(prod.rules_extract([ev]), memories, names), {"ms": 0, "valid": True}


class Production:
    """Production's extraction request against a local GGUF chat model (llama-cpp-python, strict schema)."""

    def __init__(self, gguf, threads=0, n_ctx=8192):
        import llama_cpp
        self.llm = llama_cpp.Llama(model_path=str(gguf), n_ctx=n_ctx, n_threads=threads or None, verbose=False)
        self.name = f"production-prompt-v2:{Path(gguf).name}"

    def ops(self, session, memories, names):
        import time
        prod = _production()
        ev = session_event(session)
        msgs = prod.production_messages([ev], known=known_for_production(memories), now=ev["at"])
        t = time.time()
        valid = True
        try:
            r = self.llm.create_chat_completion(messages=msgs, temperature=0.0, max_tokens=prod.PROD_MAX_TOKENS,
                                                response_format={"type": "json_object", "schema": prod.PROD_SCHEMA})
            raw = json.loads(r["choices"][0]["message"]["content"])
        except (json.JSONDecodeError, ValueError, KeyError):
            raw, valid = None, False               # an unparseable answer is a production outcome: nothing is kept
        ms = round((time.time() - t) * 1000)
        checked = prod.check_extraction(raw, [ev]) if raw else {"observations": [], "plans": []}
        return production_to_ops(checked, memories, names), {"ms": ms, "valid": valid, "raw": raw}


def keyword_retrieve(memories, query, k=3):
    """Top-k memories by content-word overlap with the query (ties: store order)."""
    q = set(tokens(query))
    scored = []
    for i, m in enumerate(memories):
        t = set(tokens(f"{m['ent']} {m['attr']} {m['val']}"))
        scored.append((len(q & t), -i, m["id"]))
    scored.sort(reverse=True)
    return [mid for s, _, mid in scored[:k] if s > 0]
