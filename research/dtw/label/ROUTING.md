# Routing: Sonnet-only vs hybrid, on Benchmark-520

Computed from the labels both models already made on Benchmark-520 (prompt
of commit `69659eb0`, before the audit fixes): no new API calls, no prompt
change, so this measures routing only. Each routed set is replayed through
the unchanged harness. Routing rule = the pool's: Opus when the example has
known memories or time words (`sources/build.py` TEMPORAL), else Sonnet;
"+ur" also sends Roman Urdu (`lang: ur`) to Opus. 95 % intervals: paired
bootstrap over examples, 2,000 resamples, seed 1.

| Labels | F1 | P | R | Kind | Certainty | False mem. | Memory actions | Temporal | ur F1 | mixed F1 | Cost (520) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Sonnet only | 0.838 | 0.81 | 0.87 | 0.929 | 0.929 | 0.128 | 0.879 | 0.915 | 0.806 | 0.856 | $1.47 |
| Hybrid | 0.831 | 0.77 | 0.90 | 0.923 | 0.931 | 0.128 | 0.905 | 0.957 | 0.812 | 0.849 | $3.29 |
| Hybrid + ur | 0.831 | 0.77 | 0.91 | 0.926 | 0.932 | 0.138 | 0.905 | 0.957 | 0.815 | 0.849 | $3.53 |
| Opus only | 0.844 | 0.76 | 0.95 | 0.937 | 0.931 | 0.143 | 0.930 | 0.979 | 0.815 | 0.852 | $5.36 |

Differences against Sonnet only:

| | F1 (95 % CI) | Memory actions (95 % CI) |
|---|---|---|
| Hybrid | -0.007 (-0.023, +0.008) | +0.025 (+0.005, +0.049) |
| Hybrid + ur | -0.007 (-0.024, +0.009) | +0.025 (+0.002, +0.049) |
| Opus only | +0.006 (-0.016, +0.029) | +0.050 (+0.018, +0.082) |

* The hybrid's gain is in merges / updates and temporary context, as
  intended; extraction F1 does not change measurably.
* Sending Roman Urdu to Opus adds nothing measurable here (65 examples).
  Kept as a separate pilot arm (`pilot1-x-ur-opus`) to measure on real data.
* The benchmark routes 46 % of examples to Opus (it is adversarial: many
  known memories); the real pool routes about 10-15 %.
