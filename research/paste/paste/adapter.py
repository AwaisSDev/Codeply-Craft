"""Experimental adapter (spec §11): segment + Brain rows + temporary state -> proposals + next state.

Pure: no I/O, no Brain access, deterministic (I4, I5). Production code is untouched.
"""
import base64
import copy

import numpy as np
import torch

from .config import MAX_TEMP_DAYS, STATUSES, TTLS, TTYPES, KINDS
from .model import PasteModel, ProfileIn, RecordIn, StepInput, TempIn
from .text import Text, dt_bucket, ev_bucket, rec_age_bucket, resolve_until, segment_text, temp_age_bucket

STATE_VERSION = 1
_DAY = 86400.0


def _b64(t: torch.Tensor) -> str:
    return base64.b64encode(t.detach().to(torch.float32).contiguous().numpy().tobytes()).decode()


def _unb64(s: str, shape) -> torch.Tensor:
    return torch.from_numpy(np.frombuffer(base64.b64decode(s), dtype=np.float32).copy()).reshape(shape)


class PasteAdapter:
    def __init__(self, model: PasteModel, text: Text, thresholds=None):
        self.m, self.text = model.eval(), text
        self.th = thresholds or dict(model.cfg.thresholds)
        # raw segment history is kept in the temporary state only for text-window baselines (M1c+W, FC)
        self.keeps_history = getattr(model, "window", 0) != 0

    # ---- temporary state ------------------------------------------------------------------
    def empty_state(self):
        return {"version": STATE_VERSION, "session_id": None, "last_at": None, "seg_index": 0, "h": None, "items": [], "next_item": 1}

    def serialize(self, st) -> dict:
        out = {k: v for k, v in st.items() if k not in ("h", "items")}
        out["h_b64"] = None if st["h"] is None else _b64(st["h"])
        out["items"] = [{**{k: v for k, v in it.items() if k != "z"}, "vector_b64": _b64(it["z"])} for it in st["items"]]
        return out

    def deserialize(self, d: dict):
        if d.get("version") != STATE_VERSION:
            raise ValueError(f"temp_state version {d.get('version')} != {STATE_VERSION}")
        dm, r = self.m.cfg.d, self.m.cfg.r_mem
        st = {k: v for k, v in d.items() if k not in ("h_b64", "items")}
        st["h"] = None if d.get("h_b64") is None else _unb64(d["h_b64"], (r, dm))
        st["items"] = [{**{k: v for k, v in it.items() if k != "vector_b64"}, "z": _unb64(it["vector_b64"], (dm,))} for it in d["items"]]
        return st

    def _prepare(self, st, seg):
        """Deterministic part of the transition, applied before reading the segment (§5.11-5.12, I3)."""
        st = copy.deepcopy(st)
        now, events = seg["at"], []
        if st["session_id"] is not None and seg["session_id"] != st["session_id"]:
            st["h"] = None                                     # h <- h0: nothing latent crosses a session (RMT too)
            kept = []
            for it in st["items"]:
                (events.append({"op": "T-EXPIRE", "item_id": it["id"], "why": "session ended"}) if it["ttl"] == "SESSION" else kept.append(it))
            st["items"] = kept
        kept = []
        for it in st["items"]:
            if it["ttl"] == "UNTIL" and it.get("until") is not None and now > it["until"]:
                events.append({"op": "T-EXPIRE", "item_id": it["id"], "why": "until passed"})
            elif now - it["created_at"] > MAX_TEMP_DAYS * _DAY:
                events.append({"op": "T-EXPIRE", "item_id": it["id"], "why": "14-day cap"})
            else:
                kept.append(it)
        st["items"] = kept
        return st, events

    # ---- one segment --------------------------------------------------------------------
    def build(self, seg, persistent, st):
        text, _ = segment_text(seg["turns"])
        seg_ids, seg_offs = self.text.encode(text, self.m.cfg.seg_max)
        profiles_meta, pindex = [{"key": "user", "text": "the user"}], {"user": 0}
        for r in persistent:
            if r["entity"] not in pindex:
                pindex[r["entity"]] = len(profiles_meta)
                profiles_meta.append({"key": r["entity"], "text": r.get("profile_text") or r["entity"]})
        profiles = [ProfileIn(*self.text.span(p["text"])) for p in profiles_meta]
        records = []
        for r in persistent:
            ids, att, val = self.text.record(profiles_meta[pindex[r["entity"]]]["text"], r["attribute"], r["value"])
            records.append(RecordIn(ids, att, val, pindex[r["entity"]],
                                    kind=KINDS.index(r["kind"]) if r.get("kind") in KINDS else len(KINDS),
                                    status=STATUSES.index("locked" if r.get("locked") else r.get("status", "confirmed")),
                                    age=rec_age_bucket((seg["at"] - r.get("updated_at", seg["at"])) / _DAY),
                                    ev=ev_bucket(r.get("evidence", 1))))
        temps = [TempIn(*self.text.span(it["text"]), z=it["z"], ttype=TTYPES.index(it["type"]),
                        tage=temp_age_bucket(st["seg_index"] - it["created_seg"])) for it in st["items"]]
        dt = dt_bucket(None if st["last_at"] is None else seg["at"] - st["last_at"])
        history = []
        if self.keeps_history:
            for hseg in st.get("history", []):
                history.append((hseg["session_id"] == seg["session_id"], self.text.encode(hseg["text"], self.m.cfg.seg_max)[0]))
        s = StepInput(seg_ids=seg_ids, profiles=profiles, records=records, temps=temps, h=st["h"], dt=dt, history=history)
        return s, text, seg_offs, profiles_meta

    def step(self, seg, persistent, temp_state, gate_override=None):
        """seg: {turns:[{speaker,text}], at: epoch seconds, session_id}; persistent: Brain rows; temp_state: serialized."""
        st, events = self._prepare(self.deserialize(temp_state) if temp_state else self.empty_state(), seg)
        s, text, offs, profiles_meta = self.build(seg, persistent, st)
        with torch.no_grad():
            enc = self.m.encode([s])[0]

            def seg_text_of(span):
                a, b = span
                chars = [o for o in offs[a:b] if o[1] > o[0]]
                return text[chars[0][0]:chars[-1][1]] if chars else ""

            out = self.m.decide(s, enc, seg_text_of, [{"id": r["id"]} for r in persistent], profiles_meta,
                                st["items"], self.th, gate_override=gate_override)
            # ---- temporary-state transition (§5.11) ----
            h_prev = st["h"] if st["h"] is not None else self.m.h0.detach()
            new_h = self.m.next_h(enc, h_prev)
            items = st["items"]
            touched, gone, temp_ops = set(), set(), list(events)
            for op in out["temp_ops"]:
                if op["op"] == "PROMOTE":
                    gone.add(op["item"]); touched.add(op["item"])
                    temp_ops.append({"op": "PROMOTE", "item_id": items[op["item"]]["id"], "confidence": op["confidence"]})
                elif op["op"] == "T-UPDATE":
                    it = items[op["item"]]
                    it["z"] = self.m.update_item_vector(op["q"], it["z"])
                    it["text"] = " | ".join((it["text"].split(" | ") + [op["text"]])[-2:])[:280]
                    touched.add(op["item"])
                    temp_ops.append({"op": "T-UPDATE", "item_id": it["id"], "text": op["text"], "confidence": op["confidence"]})
            for op in out["temp_ops"]:
                if op["op"] == "T-EXPIRE" and op["item"] not in touched:      # clarification C5: updated items do not expire
                    gone.add(op["item"])
                    temp_ops.append({"op": "T-EXPIRE", "item_id": items[op["item"]]["id"], "why": "learned", "confidence": op["confidence"]})
            items = [it for i, it in enumerate(items) if i not in gone]
            for op in out["temp_ops"]:
                if op["op"] == "T-WRITE":
                    it = {"id": f"t{st['next_item']}", "type": op["ttype"], "ttl": op["ttl"],
                          "until": resolve_until(op["text"], seg["at"]) if op["ttl"] == "UNTIL" else None,
                          "created_at": seg["at"], "created_seg": st["seg_index"], "text": op["text"][:280],
                          "z": self.m.new_item_vector(op["q"])}
                    st["next_item"] += 1
                    items.append(it)
                    temp_ops.append({"op": "T-WRITE", **{k: it[k] for k in ("id", "type", "ttl", "until", "text")}, "confidence": op["confidence"]})
            while len(items) > self.m.cfg.t_max:                             # capacity (§5.11)
                sess = [i for i, it in enumerate(items) if it["ttl"] == "SESSION"]
                victim = min(sess or range(len(items)), key=lambda i: items[i]["created_seg"])
                temp_ops.append({"op": "EVICT", "item_id": items[victim]["id"]})
                items.pop(victim)
        # promoted items carry their text to the Brain proposal
        for op in out["operations"]:
            op.pop("q", None)
        if self.keeps_history:
            st["history"] = (st.get("history", []) + [{"session_id": seg["session_id"], "text": text}])[-64:]
        st.update(h=new_h, items=items, session_id=seg["session_id"], last_at=seg["at"], seg_index=st["seg_index"] + 1)
        return {"operations": out["operations"], "retrieval": out["retrieval"], "temp_ops": temp_ops,
                "units": out["units"], "temp_state": self.serialize(st)}
