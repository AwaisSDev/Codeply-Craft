"""Deterministic Brain simulator (spec §10.1), mirroring codeply-cli/lib/brain.js `observe` semantics.

PASTE proposes; this executes (invariant I5). Differences from brain.js are deliberate and listed:
  * operations carry an explicit target id (PASTE addresses records) instead of brain.js slot/text matching;
  * CONTRADICTION proposals always take the challenge path; CORRECTION replaces (brain.js `corrected` is a
    hand edit by the user; here it is the model's proposal and goes through the same unlocked/locked rules);
  * every record carries `provenance` (the gold fact id that created it, or "spurious") for evaluation;
  * capacity eviction (lowest evidence, then oldest) stands in for the database having no fixed size.
"""
import copy
import re

from .config import IGNORED_CERTS

SECRET_RE = re.compile(r"(api[_ -]?key|password|passwd|passcode|secret|token|bearer|private key|pin code|cvv|card number|iban|ssn)\b|\bsk-[a-z0-9]{8,}", re.I)
CHALLENGE_TO_SWITCH = 2                                            # brain.js:55


def _norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


class BrainSim:
    def __init__(self, capacity=256):
        self.records, self.log, self.capacity, self._n, self.t = {}, [], capacity, 0, 0

    # ---- helpers ------------------------------------------------------------------------
    def _new_id(self):
        self._n += 1
        return f"m{self._n}"

    def snapshot(self):
        return copy.deepcopy(self.records)

    def _ignored(self, payload):
        if SECRET_RE.search(f"{payload.get('value', '')} {payload.get('attribute', '')}"):
            return "looks like a secret"
        if payload.get("certainty") in IGNORED_CERTS:
            return payload["certainty"]
        return None

    def _evict(self):
        while len(self.records) > self.capacity:
            victim = min(self.records.values(), key=lambda r: (r["evidence"], r["updated"]))
            del self.records[victim["id"]]
            self.log.append(("evicted", victim["id"]))

    # ---- operations -------------------------------------------------------------------------
    def add(self, entity, profile_text, payload, provenance="spurious", locked=False):
        why = self._ignored(payload)
        if why:
            self.log.append(("ignored", why)); return {"action": "ignored", "why": why}
        self.t += 1
        stated = payload.get("certainty") == "stated"
        rid = self._new_id()
        self.records[rid] = {"id": rid, "entity": entity, "profile_text": profile_text, "attribute": payload["attribute"],
                             "value": payload["value"], "kind": payload.get("kind", "fact"),
                             "status": "confirmed" if stated else "tentative", "confidence": 0.8 if stated else 0.5,
                             "evidence": 1, "locked": locked, "challenger": None, "history": [],
                             "provenance": provenance, "created": self.t, "updated": self.t}
        self.log.append(("added", rid)); self._evict()
        return {"action": "added", "id": rid}

    def apply(self, op, provenance="spurious"):
        """Execute one proposal. Returns brain.js-style {action, ...}."""
        kind = op["op"]
        if kind == "WRITE":
            return self.add(op["entity"], op.get("profile_text", op["entity"]), op["payload"], provenance)
        if kind == "FORGET":
            if op["target"] in self.records:
                del self.records[op["target"]]; self.log.append(("forgotten", op["target"]))
                return {"action": "forgotten"}
            return {"action": "ignored", "why": "no such memory"}
        if kind == "FORGET_PROFILE":
            gone = [k for k, r in self.records.items() if r["entity"] == op["entity"]]
            for k in gone:
                del self.records[k]; self.log.append(("forgotten", k))
            return {"action": "forgotten", "count": len(gone)}
        if kind == "MERGE":
            a, b = self.records.get(op["target"]), self.records.get(op["with"])
            if not a or not b:
                return {"action": "ignored", "why": "no such memory"}
            keep, drop = (a, b) if (a["evidence"], a["updated"]) >= (b["evidence"], b["updated"]) else (b, a)
            keep["evidence"] += drop["evidence"]; keep["history"].append({"merged": drop["id"]})
            del self.records[drop["id"]]; self.log.append(("merged", keep["id"], drop["id"]))
            return {"action": "merged", "kept": keep["id"]}
        cur = self.records.get(op.get("target"))
        if cur is None:
            return {"action": "ignored", "why": "no such memory"}
        payload = op["payload"]
        why = self._ignored(payload)
        if why:
            self.log.append(("ignored", why)); return {"action": "ignored", "why": why}
        self.t += 1
        stated = payload.get("certainty") == "stated"
        if kind == "MERGE_INTO" or _norm(payload["value"]) == _norm(cur["value"]):          # brain.js sameValue -> reinforced
            cur["evidence"] += 1
            confirm = cur["status"] == "tentative" and (stated or cur["evidence"] >= 2)
            cur["confidence"] = min(1.0, cur["confidence"] + (0.2 if stated else 0.1))
            cur["status"] = "confirmed" if confirm else cur["status"]
            cur["challenger"], cur["updated"] = None, self.t
            self.log.append(("confirmed" if confirm else "reinforced", cur["id"]))
            return {"action": "reinforced", "confirmed": confirm}
        # UPDATE: a different value for the same thing
        entry = {"value": cur["value"], "status": cur["status"]}
        if cur["locked"]:
            cnt = (cur["challenger"]["count"] if cur["challenger"] and _norm(cur["challenger"]["value"]) == _norm(payload["value"]) else 0) + 1
            cur["challenger"] = {"value": payload["value"], "count": cnt}
            self.log.append(("kept", cur["id"])); return {"action": "kept"}
        if not op.get("challenge") and (stated or cur["status"] == "tentative"):
            cur.update(value=payload["value"], status="confirmed" if stated else "tentative", confidence=0.8 if stated else 0.5,
                       evidence=1, challenger=None, updated=self.t)
            cur["history"].append(entry)
            self.log.append(("replaced", cur["id"])); return {"action": "replaced"}
        ch = cur["challenger"] if cur["challenger"] and _norm(cur["challenger"]["value"]) == _norm(payload["value"]) else None
        count = (ch["count"] if ch else 0) + 1
        if count >= CHALLENGE_TO_SWITCH:
            cur.update(value=payload["value"], status="tentative", confidence=0.55, evidence=count, challenger=None, updated=self.t)
            cur["history"].append(entry)
            self.log.append(("replaced", cur["id"])); return {"action": "replaced", "after_challenges": count}
        cur["challenger"], cur["updated"] = {"value": payload["value"], "count": count}, self.t
        self.log.append(("challenged", cur["id"])); return {"action": "challenged"}
