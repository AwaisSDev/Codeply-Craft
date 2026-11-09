# research/iris-arch: Codeply Iris architecture

Start with [ARCHITECTURE.md](ARCHITECTURE.md). Then [CONTRACT.md](CONTRACT.md) · [DATA.md](DATA.md) ·
[EVAL.md](EVAL.md) · [TRAINING.md](TRAINING.md) · [INTEGRATION.md](INTEGRATION.md) · [DECISIONS.md](DECISIONS.md).

Code (Python 3.10+, no dependencies beyond the existing `research/paste/iris` package; pytest for tests):

```
cd research/iris-arch
python -m pytest -q tests                                  # contract, builder, checks
PYTHONPATH=.:../paste python -m irisarch.build LIVES.jsonl --out EX.jsonl --noise 0.3
PYTHONPATH=.:../paste python -m irisarch.checks TRAIN.jsonl VAL.jsonl
```

Isolated from production, from the PASTE vs M1c central experiment and from `release/memory-model/`. Generated data
is never committed (`data/` is ignored).
