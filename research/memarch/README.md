# Memory-architecture research (2026-10-31)

Separate from the DTW experiment branch; nothing in production, the frozen
dataset, the split, the benchmark or the DTW protocol is changed here.

Read in order:

1. `00-STATE-OF-PLAY.md`: what is done, running, failed, pending; the
   dataset and split verified; facts that constrain the research (input
   lengths, no longitudinal data, coverage gaps).
2. `01-LITERATURE-AND-CRITIQUE.md`: PASTE component by component against
   prior art; learned vs explicit memory; dialogue state tracking and memory
   systems; calibration at a 5 % base rate; the brief's assumptions challenged.
3. `02-ARCHITECTURE-PROPOSAL.md`: the Store-Relational Decide Encoder (SRDE):
   three store interfaces (flat + sparse pointer, flat + dense per-record
   readout, cached set store with gated cross-attention), equations, cost,
   what counts as evidence.
4. `03-EXPERIMENT-PLAN.md`: systems, data additions, ablations, metrics,
   statistics, frozen decision rules, compute and cost, Option A vs B.

Short answer to the brief's question: the evidence does not support
conversational memory as a new neural computation at Codeply's input sizes;
the testable open questions are the store readout and supervision, the
operating point under ~95 % negatives, and (with new data) closed-loop
multi-session robustness. PASTE should not be built on the current data.
