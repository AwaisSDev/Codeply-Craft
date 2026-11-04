"""LongMemEval, memory-level and LLM-free (PUBLIC-BENCHMARK-PLAN.md; secondary, pre-registered 2026-11-04).

For each question: the haystack sessions are replayed in closed loop from an empty store (one segment = a user turn
plus the assistant reply after it, assistant text cut to 600 characters); the system's operations are executed by
BrainSim; each memory keeps the set of turns that wrote, updated, reinforced or merged into it. At question time the
question is a user turn, every memory is scored by the retrieve head (chunks of 32 by recency), and the metrics of
the plan are computed. Thresholds: the run's frozen validation calibration; nothing is tuned here.

    python tools/public_longmemeval.py --run RUN_DIR --data longmemeval_oracle.json --out OUT.jsonl [--limit N]
        [--device cpu|cuda] [--threads 4]
Resumable: questions already in OUT.jsonl are skipped. Data files are read only (untrusted input: JSON only).
"""
import argparse
import collections
import datetime
import json
import os
import sys
import time

import torch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from paste.adapter import PasteAdapter  # noqa: E402
from paste.brain_sim import BrainSim  # noqa: E402
from paste.config import PasteConfig  # noqa: E402
from paste.evaluate import norm_tokens  # noqa: E402
from paste.modernbert import ettin_files  # noqa: E402
from paste.text import Text  # noqa: E402
from paste.train import make_model  # noqa: E402

K_ROWS = 32
ASSIST_CHARS = 600


def parse_date(s):
    return datetime.datetime.strptime(s.split(" (")[0] + " " + s.split(") ")[-1], "%Y/%m/%d %H:%M").replace(
        tzinfo=datetime.timezone.utc).timestamp()


def segments(q):
    """Yield (segment, turn_id, is_evidence) for the question's haystack, in order."""
    for sid, date, sess in zip(q["haystack_session_ids"], q["haystack_dates"], q["haystack_sessions"]):
        t0 = parse_date(date)
        for i, turn in enumerate(sess):
            if turn["role"] != "user":
                continue
            turns = [{"speaker": "user", "text": turn["content"]}]
            if i + 1 < len(sess) and sess[i + 1]["role"] == "assistant":
                turns.append({"speaker": "assistant", "text": sess[i + 1]["content"][:ASSIST_CHARS]})
            yield {"turns": turns, "at": t0 + i, "session_id": sid}, f"{sid}#{i}", bool(turn.get("has_answer"))


def rows_of(sim, k=None):
    recs = sorted(sim.records.values(), key=lambda r: (r["updated"], r["id"]), reverse=True)
    recs = recs if k is None else recs[:k]
    return [{"id": r["id"], "entity": r["entity"], "profile_text": r.get("profile_text") or r["entity"],
             "attribute": r["attribute"], "value": r["value"], "kind": r.get("kind"), "status": r["status"],
             "evidence": r["evidence"], "locked": r.get("locked", False)} for r in recs]


def execute(sim, ops, n_new, sources, turn_id):
    """Run the system's operations in its own store; record which turn touched which memory."""
    before = {k: (r["updated"], r["evidence"]) for k, r in sim.records.items()}
    log_from = len(sim.log)
    for p in ops:
        op = dict(p)
        if op["op"] == "WRITE":
            if op.get("new_entity"):
                n_new[0] += 1
                op["entity"], op["profile_text"] = f"new{n_new[0]}:{op.get('mention') or 'unknown'}", op.get("mention") or "someone"
            else:
                op["profile_text"] = next((r.get("profile_text") for r in sim.records.values() if r["entity"] == op["entity"]), op["entity"])
            sim.add(op["entity"], op["profile_text"], op["payload"])
        else:
            sim.apply(op)
    for e in sim.log[log_from:]:
        if e[0] == "merged":
            sources[e[1]] |= sources.get(e[2], set())
    for k, r in sim.records.items():
        if k not in before or before[k] != (r["updated"], r["evidence"]):
            sources[k].add(turn_id)


def answer_in_memory(answer, sim):
    a = norm_tokens(answer)
    if not a:
        return False
    for r in sim.records.values():
        t = collections.Counter(norm_tokens(f"{r.get('profile_text', '')} {r['attribute']} {r['value']}"))
        if sum((collections.Counter(a) & t).values()) / len(a) >= 0.8:
            return True
    return False


def run_question(q, adapter, ranker):
    sim, state, sources, n_new = BrainSim(capacity=100_000), None, collections.defaultdict(set), [0]
    evidence, n_turns, captured = set(), 0, set()
    for seg, tid, ev in segments(q):
        n_turns += 1
        if ev:
            evidence.add(tid)
        out = adapter.step(seg, rows_of(sim, K_ROWS), state)
        state = out["temp_state"]
        execute(sim, out["operations"], n_new, sources, tid)
        if ev and any(tid in s for s in sources.values()):
            captured.add(tid)
    # question time: score every memory (chunks of K_ROWS by recency) with the retrieve head at threshold 0
    qseg = {"turns": [{"speaker": "user", "text": q["question"]}], "at": parse_date(q["question_date"]),
            "session_id": "__question__"}
    allrows, scores = rows_of(sim), {}
    for i in range(0, len(allrows), K_ROWS):
        out = ranker.step(qseg, allrows[i:i + K_ROWS], state)
        for r in out["retrieval"]:
            scores[r["id"]] = r["score"]
    ranked = sorted(scores, key=lambda k: -scores[k])
    hit = lambda k: any(sources.get(rid, set()) & evidence for rid in ranked[:k])
    return {"question_id": q["question_id"], "question_type": q["question_type"],
            "abstention": q["question_id"].endswith("_abs"), "n_turns": n_turns, "n_evidence": len(evidence),
            "n_memories": len(sim.records), "evidence_recall@10": hit(10), "evidence_recall@5": hit(5),
            "answer_in_memory": answer_in_memory(q["answer"], sim) if not q["question_id"].endswith("_abs") else None,
            "evidence_captured": len(captured)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--calibration", default="calibration-full.json")
    ap.add_argument("--theta-w", type=float, help="exploratory runs of uncalibrated validation checkpoints only (recorded)")
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    if a.device == "cuda":
        torch.set_default_device("cuda")
    conf = json.load(open(os.path.join(a.run, "config.json")))
    cfg = PasteConfig.from_run(conf)
    text = Text(ettin_files(cfg.backbone)[1])
    model = make_model(conf["system"], cfg, text)
    model.load_state_dict(torch.load(os.path.join(a.run, "final.pt"), weights_only=False, map_location="cpu")["model"])
    model.to(torch.device(a.device)).eval()
    cal = os.path.join(a.run, a.calibration)
    thr = dict(cfg.thresholds, **json.load(open(cal))["chosen"]) if os.path.exists(cal) else dict(cfg.thresholds)
    thr = {k: v for k, v in thr.items() if k in cfg.thresholds}
    if a.theta_w is not None:
        if os.path.exists(cal):
            raise SystemExit("--theta-w is only for runs without a frozen calibration")
        thr.update(write=a.theta_w, merge=max(a.theta_w, thr["merge"]))
    adapter = PasteAdapter(model, text, thresholds=thr)
    ranker = PasteAdapter(model, text, thresholds=dict(thr, retrieve=0.0))
    qs = json.load(open(a.data))
    qs = qs[:a.limit] if a.limit else qs
    done = set()
    if os.path.exists(a.out):
        done = {json.loads(l)["question_id"] for l in open(a.out) if l.strip()}
    meta = {"run": a.run, "system": conf["system"], "seed": conf.get("seed"), "thresholds": thr, "data": os.path.basename(a.data),
            "calibrated": os.path.exists(cal)}
    with open(a.out, "a") as fh:
        t = time.time()
        for i, q in enumerate(qs):
            if q["question_id"] in done:
                continue
            with torch.no_grad():
                r = run_question(q, adapter, ranker)
            fh.write(json.dumps({**r, **({"meta": meta} if not done and i == 0 else {})}) + "\n"); fh.flush()
            if i % 25 == 0:
                print(json.dumps({"done": i + 1, "of": len(qs), "s": round(time.time() - t)}), flush=True)


if __name__ == "__main__":
    main()
