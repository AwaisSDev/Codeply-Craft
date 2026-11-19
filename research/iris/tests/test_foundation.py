"""Stage-0 tests for the foundation study (2026-11-19): chat backend helpers, prompt v1.1, confidence metrics, the
matcher's behaviour on known examples (including the paraphrase penalty, documented rather than changed), and a
regression check that the modified evaluator reproduces every committed validation result exactly.

    cd research/iris && python -m pytest tests -q
"""
import argparse
import json
import math
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from codeply_iris import confidence, contract, evaluate, metrics, prompt  # noqa: E402
from codeply_iris.infer import ChatServerBackend, split_think  # noqa: E402

V1_SHA256 = "655639bc8f479017bec198bff14bac41a134cbee831c16f8411b840677ab1b00"   # ZERO_SHOT_SYSTEM at commit b8cd2795


# ---------------------------------------------------------------- prompt
def test_prompt_v1_unchanged_and_v11_adds_one_sentence():
    import hashlib
    v1 = prompt.ZERO_SHOT_PROMPTS["v1"]
    assert v1 is prompt.ZERO_SHOT_SYSTEM
    # v1 is the prompt of every earlier zero-shot result; its hash must not move
    assert hashlib.sha256(v1.encode()).hexdigest() == V1_SHA256
    v11 = prompt.ZERO_SHOT_PROMPTS["v1.1"]
    extra = [l for l in v11.splitlines() if l not in v1.splitlines()]
    assert extra == ["Copy the quote from the message text only: never include the [n] number or the speaker name."]
    assert len(v11.splitlines()) == len(v1.splitlines()) + 1


# ---------------------------------------------------------------- think handling
@pytest.mark.parametrize("raw,answer,think,closed", [
    ('{"ops":[]}', '{"ops":[]}', "", True),
    ('<think>\n\n</think>\n\n{"ops":[]}', '{"ops":[]}', "\n\n", True),
    ('  <think>plan</think>{"ops":[]}', '{"ops":[]}', "plan", True),
    ('<think>still thinking', "", "still thinking", False),
    ('{"ops":[]} <think>x</think>', '{"ops":[]} <think>x</think>', "", True),   # only a leading block is removed
])
def test_split_think(raw, answer, think, closed):
    assert split_think(raw) == (answer, think, closed)


def test_chat_request_body_is_greedy_uncached_and_constrained():
    b = ChatServerBackend.__new__(ChatServerBackend)            # no server needed to build a request
    b.template_kwargs, b.logprobs, b.constrain = {"enable_thinking": False}, True, True
    body = b.request_body("SYS", "USER", 900, contract.OUTPUT_SCHEMA)
    assert body["messages"] == [{"role": "system", "content": "SYS"}, {"role": "user", "content": "USER"}]
    assert body["temperature"] == 0.0 and body["top_k"] == 1 and body["seed"] == 0 and body["cache_prompt"] is False
    assert body["chat_template_kwargs"] == {"enable_thinking": False} and body["json_schema"] == contract.OUTPUT_SCHEMA
    assert body["logprobs"] is True and body["max_tokens"] == 900
    b.constrain = False
    assert "json_schema" not in b.request_body("S", "U", 10, contract.OUTPUT_SCHEMA)


# ---------------------------------------------------------------- confidence metrics
def test_op_scores_locate_values_in_order():
    answer = '{"ops":[{"op":"add","val":"Lahore"},{"op":"add","val":"Lahore"},{"op":"confirm","ref":"m1"}]}'
    toks = [[c, -0.1 * (i % 3)] for i, c in enumerate(answer)] + [["\n\n", -9.0]]   # one token per character
    ops = [{"op": "add", "val": "Lahore"}, {"op": "add", "val": "Lahore"}, {"op": "confirm", "ref": "m1"}]
    s = confidence.op_scores(answer, toks, ops)
    assert all(x is not None for x in s)
    first = answer.find("Lahore")
    second = answer.find("Lahore", first + 1)
    exp1 = sum(-0.1 * (i % 3) for i in range(first, first + 6)) / 6
    exp2 = sum(-0.1 * (i % 3) for i in range(second, second + 6)) / 6
    assert math.isclose(s[0], exp1) and math.isclose(s[1], exp2)
    assert confidence.op_scores("not in tokens", toks, ops) == [None, None, None]


def test_precision_at_k_and_f_beta():
    scored = [(-0.1, True), (-0.2, False), (-0.05, True), (None, False), (-3.0, False)]
    assert confidence.precision_at_k(scored, 2) == 1.0
    assert confidence.precision_at_k(scored, 3) == pytest.approx(2 / 3)
    assert confidence.precision_at_k(scored, 6) is None              # under-covering
    curve, area = confidence.risk_coverage(scored)
    assert curve[0] == (1, 1.0) and curve[-1] == (5, 0.4) and 0 < area <= 1
    assert confidence.f_beta(0, 5, 5) == 0.0
    assert confidence.f_beta(5, 10, 5) == pytest.approx(1.25 * 0.5 * 1.0 / (0.25 * 0.5 + 1.0))


# ---------------------------------------------------------------- matcher behaviour on known examples
GOLD = {"src": 1, "evid": "haan baji, har mahine ki tarah 300 NZD ghar bhej diye", "op": "add", "ent": "user", "type": "user",
        "attr": "monthly remittance", "val": "sends 300 NZD home every month", "kind": "routine", "keep": "long",
        "basis": "stated", "conf": "high", "sens": "personal", "key": "k1"}


def pred(**kw):
    p = {k: v for k, v in GOLD.items() if k != "key"}
    p.update(kw)
    return p


def score(p, gold=(GOLD,), memories=()):
    c, _ = metrics.score_observe([p], list(gold), list(memories))
    return c


def test_exact_value_matches():
    c = score(pred())
    assert c["tp"] == 1 and c["false_memory"] == 0


def test_paraphrase_below_token_f1_threshold_is_penalised_twice():
    # near_value-03 in the manual sample: the same remittance, judged EQUIVALENT by hand, fails the strict match
    c = score(pred(attr="family money transfer", val="send about $300 NZD to family monthly"))
    assert metrics.value_sim("send about $300 NZD to family monthly", GOLD["val"]) < 0.5
    assert c["tp"] == 0 and c["false_memory"] == 1 and c["gold_content"] == 1      # one false memory + one miss


def test_right_value_wrong_entity_is_misattributed_not_correct():
    g = dict(GOLD, ent="Shoaib Rehman", type="person", attr="dialysis schedule", val="every Friday at 10, user takes him")
    c = score(pred(ent="user", attr="father's health", val="dialysis every Friday at 10"), gold=(g,))
    assert c["value_matched"] == 1 and c["misattributed"] == 1 and c["tp"] == 0 and c["false_memory"] == 1


def test_date_only_agreement_can_value_match_a_wrong_fact():
    # entity-12 in the manual sample: an invented 'dinner' matched a qPCR run through the shared date
    g = dict(GOLD, ent="Danish Gill", attr="first qpcr run", val="9 March 2026, with user supervising", when="2026-03-09")
    p = pred(ent="user", attr="dinner with Danish", val="chow with Danish Gill on 9 March", when="2026-03-09")
    assert metrics.content_score(p, g) > 0


def test_restatement_of_a_stored_memory_is_a_duplicate_not_false():
    mem = {"id": "m1", "ent": "user", "attr": "monthly remittance", "val": "sends 300 NZD home every month"}
    c = score(pred(), gold=(), memories=(mem,))
    assert c["dup_restated"] == 1 and c["false_memory"] == 0


# ---------------------------------------------------------------- regression: committed results reproduce exactly
RUNS = [("results/gpu-r2/val/iris-0.6b-r2", "iris"), ("results/gpu-r2/val/iris-1.7b-r2", "iris"),
        ("results/gpu-r2/val/iris-0.6b-r3", "iris"), ("results/gpu-r2/val/iris-1.7b-r3", "iris"),
        ("results/foundation-2026-11/val24-rules", "rules"), ("results/foundation-2026-11/val24-nothing", "nothing")]


def _same(a, b):
    if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
        return True
    return a == b or (isinstance(a, float) and isinstance(b, (int, float)) and math.isclose(a, b, rel_tol=1e-12))


@pytest.mark.parametrize("run,system", RUNS)
@pytest.mark.parametrize("loop", ["open", "closed"])
def test_modified_evaluator_reproduces_committed_results(tmp_path, run, system, loop):
    src = ROOT / run
    committed = src / f"result-val-{loop}.json"
    if not committed.exists():
        pytest.skip("no committed result for this loop")
    shutil.copy(src / f"preds-val-{loop}.jsonl", tmp_path / f"preds-val-{loop}.jsonl")
    a = argparse.Namespace(data=str(ROOT / "data" / "built"), raw=str(ROOT / "data" / "raw"), split="val", limit=0,
                           system=system, keyword_k=3)
    if loop == "open":
        per_ep, _, _ = evaluate.open_loop(a, None, tmp_path)          # every generation comes from the cache
    else:
        per_ep, _, _ = evaluate.closed_loop(a, None, tmp_path)
    total = metrics.Counter()
    for c in per_ep.values():
        total.update(c)
    now = metrics.summarise(total)
    before = json.loads(committed.read_text())["metrics"]
    diff = {k: (before[k], now.get(k)) for k in before if not _same(before[k], now.get(k))}
    assert not diff
