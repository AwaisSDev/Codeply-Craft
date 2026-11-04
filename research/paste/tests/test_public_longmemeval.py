"""tools/public_longmemeval.py conversion and scoring helpers; tools/public_compare.py primary set and bootstrap."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import public_compare as pc  # noqa: E402
import public_longmemeval as pl  # noqa: E402

Q = {"question_id": "q1", "question_type": "single-session-user", "question": "Where do I work?", "answer": "Acme Labs",
     "question_date": "2023/05/02 (Tue) 10:00", "haystack_session_ids": ["s1"], "haystack_dates": ["2023/05/01 (Mon) 09:30"],
     "haystack_sessions": [[{"role": "user", "content": "I started at Acme Labs.", "has_answer": True},
                            {"role": "assistant", "content": "x" * 900},
                            {"role": "user", "content": "Thanks!"}]]}


def test_segments_pair_user_with_assistant_and_mark_evidence():
    segs = list(pl.segments(Q))
    assert [t for _, t, _ in segs] == ["s1#0", "s1#2"]
    assert [e for _, _, e in segs] == [True, False]
    s0 = segs[0][0]
    assert s0["turns"][0]["speaker"] == "user" and len(s0["turns"][1]["text"]) == pl.ASSIST_CHARS
    assert segs[1][0]["at"] == s0["at"] + 2 and len(segs[1][0]["turns"]) == 1


def test_execute_tracks_sources_and_answer_in_memory():
    sim, src, n = pl.BrainSim(), __import__("collections").defaultdict(set), [0]
    pl.execute(sim, [{"op": "WRITE", "entity": "user", "payload": {"attribute": "employer", "value": "Acme Labs", "certainty": "stated"}}], n, src, "s1#0")
    rid = next(iter(sim.records))
    assert src[rid] == {"s1#0"} and pl.answer_in_memory("Acme Labs", sim) and not pl.answer_in_memory("Globex", sim)
    pl.execute(sim, [{"op": "MERGE_INTO", "target": rid, "payload": {"attribute": "employer", "value": "Acme Labs", "certainty": "stated"}}], n, src, "s2#4")
    assert src[rid] == {"s1#0", "s2#4"}


def test_compare_primary_and_bootstrap(tmp_path):
    def write(p, hits):
        with open(p, "w") as f:
            for i, h in enumerate(hits):
                f.write(json.dumps({"question_id": f"q{i}", "question_type": "single-session-assistant" if i == 0 else "multi-session",
                                    "abstention": False, "n_turns": 10, "n_evidence": 1, "n_memories": 5, "evidence_recall@10": h,
                                    "evidence_recall@5": h, "answer_in_memory": h, "evidence_captured": int(h)}) + "\n")
    write(tmp_path / "a.jsonl", [True] * 40); write(tmp_path / "b.jsonl", [False] * 40)
    out = tmp_path / "r.json"
    sys.argv = ["x", "--sys", f"A={tmp_path/'a.jsonl'}", f"B={tmp_path/'b.jsonl'}", "--pairs", "A:B", "--n-boot", "200", "--out", str(out)]
    pc.main()
    r = json.load(open(out))
    assert r["primary_questions"] == 39 and r["pairs"]["A - B"]["evidence_recall@10"]["delta"] == 1.0
