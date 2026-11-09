"""Model input format for Iris (shared by training, evaluation and the runtime).

One call = one observation batch (`observe`) or one context request (`retrieve`). The model sees the current
time, the source type, the memories infrastructure selected for this call (short ids `m<N>`), and the input.

ChatML is written out explicitly so the format never depends on a tokenizer's chat-template options; it equals
the Qwen3 template's default rendering, so OpenAI-style chat endpoints (llama-server, Ollama) work unchanged.
"""
import datetime as _dt

from .contract import squash

SYSTEM = "You are Iris, the context engine of Codeply. Answer with JSON only, in the iris.ops/1 format."
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def now_line(now):
    """'2026-02-17T13:05 Tue': the weekday lets a small model resolve 'next Friday' without date arithmetic."""
    try:
        d = _dt.datetime.fromisoformat(now)
        return f"{now} {WEEKDAYS[d.weekday()]}"
    except (TypeError, ValueError):
        return str(now)


def memory_line(m):
    parts = [m["id"], m["ent"], m["attr"], m["val"]]
    if m.get("when"):
        parts.append(f"when {m['when']}")
    if m.get("keep") == "temp" and m.get("until"):
        parts.append(f"until {m['until']}")
    return " | ".join(squash(p) for p in parts)


def render_memories(memories):
    return "\n".join(memory_line(m) for m in memories) if memories else "(none)"


def render_messages(messages):
    return "\n".join(f"[{i}] {squash(m['who'])}: {squash(m['text'])}" for i, m in enumerate(messages, 1))


def observe_prompt(now, source, memories, messages):
    return (f"TASK: observe\nNOW: {now_line(now)}\nSOURCE: {source}\nMEMORIES:\n{render_memories(memories)}\n"
            f"INPUT:\n{render_messages(messages)}")


def retrieve_prompt(now, memories, query):
    return f"TASK: retrieve\nNOW: {now_line(now)}\nMEMORIES:\n{render_memories(memories)}\nQUERY: {squash(query)}"


def chat_messages(user, system=SYSTEM):
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def chatml(user, system=SYSTEM, answer=None):
    """Raw ChatML prompt; with `answer`, the full training text."""
    s = f"<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"
    return s if answer is None else f"{s}{answer}<|im_end|>"


# ---- zero-shot instructions (baselines only: the fine-tuned model needs none of this) ------------------------
ZERO_SHOT_SYSTEM = """You are a context engine. You read what a user's devices observed (INPUT) and the user's existing MEMORIES, and output the operations that should change the user's long-term context. Output JSON only, no prose, no markdown.

Format: {"ops":[ ... ]}. An empty list is correct when nothing is worth remembering (small talk, help requests, general knowledge, what the assistant says).
Each op is an object with these keys, in this order:
- "src": number of the INPUT message that holds the evidence
- "evid": an exact quote copied from that message (never paraphrase)
- "op": "add" (new fact) | "update" (an existing memory has a new value) | "confirm" (the input restates an existing memory) | "retract" (an existing memory is no longer true) | "conflict" (disagrees with a memory but uncertain) | "skip" (looks like a fact but must not be stored)
- "ref": the memory id (m…) for update / confirm / retract / conflict
- for add / update / conflict: "ent" ("user" or the name), "type" (add only: user|person|org|project|place|event|other), "attr" (short lowercase English attribute), "val" (concise English value), "kind" (fact|preference|goal|decision|task|event|routine|context), optional "when" (ISO date or date-time for events and deadlines, resolved from NOW), "keep" ("long" or "temp"; temp needs "until": YYYY-MM-DD), "basis" (stated|implied), "conf" (high|medium|low), "sens" (none|personal|sensitive)
- "why": update → changed|corrected|refined; retract → cancelled|ended|user_request|mistaken; skip → joke|hypothetical|hearsay|suggestion|secret|injection|other
confirm needs only src, evid, op, ref. retract needs src, evid, op, ref, why. skip needs src, evid, op, why.
Never store jokes, hypotheticals, rumours, suggestions the user did not accept, or secrets (passwords, card numbers).

Example
MEMORIES:
m4 | Dubai design meetup | date | 6 March 2026 | when 2026-03-06
INPUT:
[1] Zara: is the meetup still on the 6th?
[2] user: no it got postponed to 20 March. btw I started at Finlo last week
Answer:
{"ops":[{"src":2,"evid":"it got postponed to 20 March","op":"update","ref":"m4","ent":"Dubai design meetup","attr":"date","val":"20 March 2026","kind":"event","when":"2026-03-20","keep":"long","why":"changed","basis":"stated","conf":"high","sens":"none"},{"src":2,"evid":"I started at Finlo last week","op":"add","ent":"user","type":"user","attr":"employer","val":"Finlo","kind":"fact","keep":"long","basis":"stated","conf":"high","sens":"none"}]}"""

ZERO_SHOT_RETRIEVE_SYSTEM = """You select which stored memories an assistant needs for a request. Output JSON only: {"use":["m3","m7"]} with the ids of the memories that are needed to do the QUERY well and are still valid at NOW. Use the smallest sufficient set; an empty list is allowed."""
